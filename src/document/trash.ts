/**
 * 回收站（W2A §12）—— 工作区/.trash/ 软删恢复缓冲。
 *
 * - 软删：DocumentService.trashDocument 移文件到 .trash/<docId>-<basename> + 记 manifest
 *   + 清单 removeEntry + snapshot 留底 + invalidate（trashDocument 在 service.ts）。
 * - 恢复：restoreTrash 移回 originalPath（原位占用 → OCCUPIED，不自动改，§17 决策④）+
 *   清单恢复 entry + 移除 trash 条目 + invalidate。
 * - 永久删：purgeTrash 物理删 .trash 文件 + 移除 trash 条目（不可逆）。
 *
 * .trash-manifest.jsonl：每行一 TrashEntry，容错解析（同 manifest.ts 风格，非法行跳过）。
 * git 入账（软删 git 跟踪文件 → rebook）走既有 state.ts，本模块只管 .trash 缓冲（W0 §8）。
 *
 * 路径安全（P1 修复）：originalPath/trashedPath 来自 manifest 文件，须经 safePathWithin 校验，
 * 防 manifest 被篡改后 restore/purge 的 rename/rmSync 越出 bookRoot。
 */
import { existsSync, readFileSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { atomicWriteFile, linkOrRenameExclusive, renameWithRetry, rmWithRetry } from '../fs/atomic.js'
import { resolveWithinRoot, safeDocId } from '../fs/safe-path.js'
import { readManifestStrict, writeManifest, upsertEntry, withManifestLock, withManifestLockAsync, type ManifestEntry } from './manifest.js'
import { VERSIONS_DIR_NAME, encodeDocDirName } from './version.js'
import { analysisPathCandidates } from './analysis.js'
import { type DocumentRole } from './layout.js'
import { invalidateTreeIndex } from './tree.js'
import { log } from '../log/index.js'

/** 回收站条目。 */
export interface TrashEntry {
  /** 原 docId（清单身份保留，恢复时回到此 id）。 */
  id: string
  /** 软删前路径（恢复目标）。 */
  originalPath: string
  /** 工作区/.trash/<docId>-<basename> 实际落点（相对 bookRoot）。 */
  trashedPath: string
  trashedAt: string
  role: DocumentRole
  /** W-P2-1：软删前的定稿基线（无 = 从未定稿）。恢复时带回清单——丢了基线，
   *  已定稿章恢复后被当草稿态续写，ensureChapterNotFinalized 失守，AI 可覆盖曾定稿内容。 */
  finalizedRevision?: string
  finalizedAt?: string
  /** R27-47（二十七轮）：软删前的清单投影字段（manifest 承诺承载「身份/排序/状态/标签
   *  投影」）——原 TrashEntry 不携带，软删删条目、还原按字面重建，用户 tags 与自由区
   *  order 在「删→还原」一轮后不可逆清零（W-P2-1 为 finalizedRevision 补过同型，
   *  tags/order 是同族漏项：status 可派生故不带）。 */
  tags?: string[]
  order?: number
}

export type RestoreResult =
  | { ok: true; id: string; path: string }
  | { ok: false; code: 'NOT_FOUND' | 'OCCUPIED' | 'WRITE_ERROR'; reason: string }

export type PurgeResult =
  | { ok: true; id: string }
  | { ok: false; code: 'NOT_FOUND' | 'WRITE_ERROR'; reason: string }

const TRASH_DIR_REL = '工作区/.trash'
const TRASH_MANIFEST_REL = '工作区/.trash/.trash-manifest.jsonl'

/** R65-36（第六十五轮）：恢复目标位与回收站源的内容比对——上次「linkSync 成功 →
 *  删源」之间崩溃的续跑形态（目标位与 .trash 双份硬链同 inode），比对一致视为上次
 *  已完成，继续走清理不再报 OCCUPIED；比对优先 readFileSync 逐字节相等；任一侧非
 *  普通文件（目录恢复走原子 rename 无此窗口）→ different。
 *  R72-6（二十轮 B-3）：读失败退 size+mtime 指纹不再返回「相等」——指纹巧合相等时
 *  续跑删源会把回收站唯一副本删掉而原位并非恢复内容。三态区分：byte-equal 可安全
 *  续跑删源；fingerprint-equal（比对不可定）交调用方保守 OCCUPIED。 */
function sameRestoreCopy(a: string, b: string): 'byte-equal' | 'fingerprint-equal' | 'different' {
  try {
    if (!statSync(a).isFile() || !statSync(b).isFile()) return 'different'
  } catch {
    return 'different'
  }
  try {
    return readFileSync(a).equals(readFileSync(b)) ? 'byte-equal' : 'different'
  } catch {
    /* 读失败（权限）退 size+mtime 指纹 */
  }
  try {
    const sa = statSync(a)
    const sb = statSync(b)
    return sa.size === sb.size && Math.floor(sa.mtimeMs) === Math.floor(sb.mtimeMs)
      ? 'fingerprint-equal'
      : 'different'
  } catch {
    return 'different'
  }
}

function trashManifestPath(bookRoot: string): string {
  return join(bookRoot, TRASH_MANIFEST_REL)
}

/** 读 trash manifest（容错，非法行跳过）。无文件 → 空。读失败 → 空（X-P3a：只读
 *  消费面——列表展示/存在性探测按「无回收站」处理，不阻断）。 */
export function readTrashManifest(bookRoot: string): TrashEntry[] {
  const p = trashManifestPath(bookRoot)
  if (!existsSync(p)) return []
  const entries: TrashEntry[] = []
  // X-P3a：existsSync 与 read 之间有竞态（并发删/权限变化），读失败按无 manifest 处理
  let raw: string
  try {
    raw = readFileSync(p, 'utf-8')
  } catch {
    return []
  }
  return parseTrashText(raw, entries)
}

/** R27-40（二十七轮）P1：RMW 写路径专用 strict 版——appendTrashEntry/restore/purge
 *  的「读全量→改→整文件重写」在瞬态读失败（EBUSY/EACCES/EIO）下原会以空表重写，
 *  全部回收站条目一次性丢失（同 readManifestStrict 根因）。ENOENT = 合法空；
 *  其余上抛，由调用方既有收口（GG-P2-6 中止软删 / best-effort catch）拒写保旧。 */
export function readTrashManifestStrict(bookRoot: string): TrashEntry[] {
  const p = trashManifestPath(bookRoot)
  if (!existsSync(p)) return []
  const entries: TrashEntry[] = []
  let raw: string
  try {
    raw = readFileSync(p, 'utf-8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    throw new Error(`回收站清单读取失败（${code ?? '未知错误'}）：${p}——已拒绝以空清单重写整文件（R27-40 防丢条目）`)
  }
  return parseTrashText(raw, entries)
}

/** 文本 → TrashEntry[]（容错/strict 两版共用解析体） */
function parseTrashText(raw: string, entries: TrashEntry[]): TrashEntry[] {
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t) as Partial<TrashEntry>
      if (o.id && o.originalPath && o.trashedPath) {
        entries.push({
          id: o.id,
          originalPath: o.originalPath,
          trashedPath: o.trashedPath,
          trashedAt: o.trashedAt ?? '',
          // R27-47：可选投影字段透传（旧清单无此字段 → undefined，行为不变）
          ...(Array.isArray(o.tags) && o.tags.every((t) => typeof t === 'string') && o.tags.length > 0
            ? { tags: o.tags as string[] }
            : {}),
          ...(typeof o.order === 'number' ? { order: o.order } : {}),
          role: (o.role as DocumentRole) ?? 'note',
          // W-P2-1：定稿基线随条目落账/读回（旧条目无此字段 → undefined，按从未定稿处理）
          ...(o.finalizedRevision ? { finalizedRevision: o.finalizedRevision, finalizedAt: o.finalizedAt } : {}),
        })
      }
    } catch {
      continue // 非法行跳过（损坏降级）
    }
  }
  return entries
}

/** 原子写 trash manifest（全量重写，atomicWriteFile）。 */
function writeTrashManifest(bookRoot: string, entries: TrashEntry[]): void {
  mkdirSync(join(bookRoot, TRASH_DIR_REL), { recursive: true })
  const text = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '')
  // P2-BE-5：加 fsync——回收站 manifest 是「删除可还原」的承诺，掉电丢失即永久丢还原入口
  atomicWriteFile(trashManifestPath(bookRoot), text, { fsync: true })
}

/** 追加 trash 条目（DocumentService.trashDocument 用；同 id 替换，幂等）。 */
export function appendTrashEntry(bookRoot: string, entry: TrashEntry): void {
  // Z-5（第五十八轮）：RMW 持锁（X-5 同型漏网）——GUI 与 CLI/他实例并发软删时，
  // 裸「读全量→改→整文件重写」后写者吞掉先者条目（回收站 UI 失明）。锁文件
  // <trash-manifest>.lock 独立于主清单锁，全程不与主清单锁嵌套（无获取序环路）。
  // R34D-19（三十四轮）：服务进程链改走异步孪生（下方 appendTrashEntryAsync）——
  // 本同步版保留供 CLI 迁移脚本（migrate-layout-v3）等合法同步面。
  withManifestLock(trashManifestPath(bookRoot), () => {
    // R27-40：RMW strict 读——读失败上抛 → GG-P2-6「登记不成则删不成」中止软删，
    // 不再以空表重写吞掉全部回收站条目
    const entries = readTrashManifestStrict(bookRoot)
    const idx = entries.findIndex((e) => e.id === entry.id)
    if (idx >= 0) entries[idx] = entry
    else entries.push(entry)
    writeTrashManifest(bookRoot, entries)
  })
}

/** R34D-19（三十四轮）：appendTrashEntry 的异步孪生——锁等待走 withManifestLockAsync
 *  （setTimeout 轮询，事件循环不阻塞），服务进程软删链（DocumentService.doTrash）专用，
 *  补齐 R33D-21 只迁 restore/purge 的「半异步」残留；RMW 本体（strict 读/幂等替换/
 *  fsync 写回）与同步版逐位同源。 */
export async function appendTrashEntryAsync(bookRoot: string, entry: TrashEntry): Promise<void> {
  await withManifestLockAsync(trashManifestPath(bookRoot), () => {
    const entries = readTrashManifestStrict(bookRoot)
    const idx = entries.findIndex((e) => e.id === entry.id)
    if (idx >= 0) entries[idx] = entry
    else entries.push(entry)
    writeTrashManifest(bookRoot, entries)
  })
}

/** R37-14（三十七轮）：按 id 移除回收站条目（doTrash 删源失败回滚专用）——软删链
 *  「先登记后移文件」的反向收口：删源失败时须把刚写入的条目摘掉，否则残留
 *  「回收站有条目但源文件还在」的双份状态（restore 撞源位 OCCUPIED、purge 把仍在
 *  原位的文件按不可逆语义清掉）。RMW 持锁同 appendTrashEntryAsync（Z-5 同源：
 *  <trash-manifest>.lock + strict 读 + fsync 写回），幂等（无该 id 条目时写回等价
 *  空操作）；条目以 id 为键，同 id 至多一条（append 即替换），按 id 移除即精确移除
 *  本次写入者。 */
export async function removeTrashEntryAsync(bookRoot: string, id: string): Promise<void> {
  await withManifestLockAsync(trashManifestPath(bookRoot), () => {
    writeTrashManifest(bookRoot, readTrashManifestStrict(bookRoot).filter((e) => e.id !== id))
  })
}

/** 列回收站。 */
export function listTrash(bookRoot: string): TrashEntry[] {
  return readTrashManifest(bookRoot)
}

/**
 * 恢复：移回 originalPath + 清单恢复 entry + 移除 trash 条目 + invalidate。
 * 原位占用 → OCCUPIED（不自动重命名，§17 决策④）；trash 文件丢失 → NOT_FOUND。
 */
export async function restoreTrash(bookRoot: string, id: string): Promise<RestoreResult> {
  // R27-40：入口 strict 读——读失败上抛走调用方 500 信封（比「当无回收站」的 NOT_FOUND
  // 诚实）；下方 264 行条目移除的 RMW 同样 strict，读失败拒写保旧
  const entries = readTrashManifestStrict(bookRoot)
  const entry = entries.find((e) => e.id === id)
  if (!entry) return { ok: false, code: 'NOT_FOUND', reason: `回收站无 ${id}` }

  // Y-18（第五十七轮）：trashedPath 必须落在 工作区/.trash/ 内——trash-manifest 是
  // 可篡改数据面，此前的「不出书仓库」校验挡不住书内横向搬文件（trashedPath 填正文
  // 路径 + originalPath 填目标 → restore 把正文 rename 走）。fail-closed 拒绝整条。
  // R27-49（二十七轮）：排除清单自身——`工作区/.trash/.trash-manifest.jsonl` 同样满足
  // `.trash/` 前缀，篡改条目可借 restore/purge 把清单本体搬离回收站（随后 writeTrashManifest
  // 以空读结果重建空清单，全部条目丢失）。Y-18 威胁模型（trash-manifest 是可篡改数据面）
  // 的残余缺口。
  if (
    !entry.trashedPath.replace(/\\/g, '/').startsWith(`${TRASH_DIR_REL}/`) ||
    entry.trashedPath.replace(/\\/g, '/') === TRASH_MANIFEST_REL
  ) {
    return { ok: false, code: 'NOT_FOUND', reason: '回收站条目路径非法（不在 .trash 目录内）' }
  }

  const origAbs = safePathWithin(bookRoot, entry.originalPath)
  const trashAbs = safePathWithin(bookRoot, entry.trashedPath)
  if (!origAbs || !trashAbs) {
    return { ok: false, code: 'NOT_FOUND', reason: '回收站条目路径非法（越出书仓库）' }
  }
  if (!existsSync(trashAbs)) {
    // R41-9（四十一轮）：R33-10 承诺的续传闭环堵漏——上次「文件已回原位 + 删 .trash
    // 成功 + 清单 upsert 失败」的中间态，重试在原入口恒 NOT_FOUND（回收站文件已
    // 丢失），条目永久悬置、docId 身份断链无法自愈。原位文件在 → 物理恢复已完成
    //（.trash 侧已无物可比对/可搬），跳过搬运直走清单补录 + 条目移除收口。
    if (!existsSync(origAbs)) {
      return { ok: false, code: 'NOT_FOUND', reason: '回收站文件已丢失' }
    }
    await finishRestoreBookkeeping(bookRoot, entry)
    invalidateTreeIndex(bookRoot, true)
    return { ok: true, id, path: entry.originalPath }
  }
  // R65-36：目标位已占用先比对内容——上次「link 成功 → 删源」之间崩溃的续跑（目标位
  // 与 .trash 双份），一致则视为已完成恢复，跳过搬运继续走删源+清单收口；不一致才是
  // 真占用（作者另建了文件），仍报 OCCUPIED（不自动改，§17 决策④）
  const alreadyLinked = existsSync(origAbs)
  if (alreadyLinked) {
    // R65-36：目标位已占用先比对内容——一致（字节级）= 上次 link 已完成的续跑形态，
    // 跳过搬运继续走删源+清单收口。R72-6（二十轮 B-3）：字节比对不可行（读失败退指纹）
    // 的巧合一致不再删源（会把回收站唯一副本删掉而原位并非恢复内容），保守 OCCUPIED
    // 交作者人工处置；确定不同才是真占用（作者另建了文件），同样 OCCUPIED（§17 决策④）
    const verdict = sameRestoreCopy(origAbs, trashAbs)
    if (verdict !== 'byte-equal') {
      return {
        ok: false,
        code: 'OCCUPIED',
        reason:
          verdict === 'fingerprint-equal'
            ? `原位 ${entry.originalPath} 已被占用（内容逐字节比对不可定，指纹巧合一致），请人工确认后重命名或删除现有文件`
            : `原位 ${entry.originalPath} 已被占用，请先重命名或删除现有文件`,
      }
    }
  }

  try {
    mkdirSync(dirname(origAbs), { recursive: true })
    if (alreadyLinked) {
      // R65-36：续跑补删源（目标位内容已比对一致 = 上次 link 已完成）
      // R40-19（四十轮）：删源收编 rmWithRetry——win 杀软/索引器瞬时锁（EPERM/EBUSY）
      // 下裸 rmSync 直败（MP2-3 只收编了本文件 rename 面，rm 面漏网）；退避后仍失败
      // 上抛走既有 WRITE_ERROR 收口（语义不变：作者重试经 byte-equal 幂等续跑）
      rmWithRetry(trashAbs)
    } else {
      // R64-21（十二轮）：existsSync→renameSync 的 TOCTOU 窗口内原位被跨进程新建 →
      // POSIX rename 静默覆盖占位文件（不可逆）。文件改 linkSync 原子探测：EEXIST →
      // OCCUPIED（link 失败即占用，无窗口）；成功 → 内容已借硬链接落位，再删 .trash
      // 侧（同一 inode，无复制窗口）。目录不支持硬链接，保留 rename 路径（目录 rename
      // 对非空目标报 ENOTEMPTY，无静默覆盖面）。
      let origIsDir = false
      try {
        origIsDir = statSync(trashAbs).isDirectory()
      } catch {
        return { ok: false, code: 'WRITE_ERROR', reason: '恢复失败：回收站文件已丢失' }
      }
      if (origIsDir) {
        // MP2-3（专项重评二轮修复批）：目录 rename 同样吃 win 瞬时锁（杀软/索引器
        // EPERM/EBUSY），收编 renameWithRetry（R77-3 同款 3×50ms 退避；确定性错误
        // 原样上抛走 WRITE_ERROR 语义不变）
        renameWithRetry(trashAbs, origAbs)
      } else {
        // R26-7（二十六轮）：落位改 linkOrRenameExclusive——EPERM/ENOSYS/EACCES
        // （exFAT/FAT32/部分 SMB 不支持硬链接）降级 rename 还原（'exists' 判定语义
        // 不变），非 NTFS 卷上回收站还原不再全线失败；EEXIST → OCCUPIED 口径不变。
        const placed = linkOrRenameExclusive(trashAbs, origAbs)
        if (placed === 'exists') {
          return {
            ok: false,
            code: 'OCCUPIED',
            reason: `原位 ${entry.originalPath} 已被占用，请先重命名或删除现有文件`,
          }
        }
        // R40-19：删源退避（同 :273 口径——退避后仍失败上抛走 WRITE_ERROR，重试幂等续跑）
        rmWithRetry(trashAbs)
      }
    }
  } catch (e) {
    return { ok: false, code: 'WRITE_ERROR', reason: `恢复失败：${errMsg(e)}` }
  }

  // R41-9：主路径收尾提取共用（续传分支同款）——清单补录 best-effort + 成功后移除条目
  await finishRestoreBookkeeping(bookRoot, entry)
  invalidateTreeIndex(bookRoot, true)
  return { ok: true, id, path: entry.originalPath }
}

/** R41-9（四十一轮）：恢复收尾——主路径（搬运/删源完成后）与续传补录路径
 *  （R33-10 中间态：文件已在原位、.trash 侧已清）共用。逻辑自原 restoreTrash
 *  尾段原样提取：清单 upsert best-effort（Y-17 断链 warn）→ 成功才移除回收站
 *  条目（R33-10 自愈通道）。 */
async function finishRestoreBookkeeping(bookRoot: string, entry: TrashEntry): Promise<void> {
  const id = entry.id

  // P2-BE-4：rename 成功后 manifest 更新改 best-effort（与 doTrash 一致——失败不致文件失踪）
  let manifestUpserted = false
  try {
    const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
    // X-5：RMW 持清单锁（跨进程互斥，与 service/finalize 同锁）
    await withManifestLockAsync(manifestPath, () => {
      const m = existsSync(manifestPath)
        ? readManifestStrict(manifestPath) // R27-40：RMW strict 读（读失败走本 best-effort catch，warn 保旧清单）
        : { version: 1, entries: new Map<string, ManifestEntry>() }
      upsertEntry(m, {
        id: entry.id,
        nodeType: 'document',
        path: entry.originalPath,
        parentId: null,
        // W-P2-1：恢复时带回定稿基线，还原定稿态（防线/状态机/手改检测都依赖它）
        ...(entry.finalizedRevision
          ? { finalizedRevision: entry.finalizedRevision, ...(entry.finalizedAt ? { finalizedAt: entry.finalizedAt } : {}) }
          : {}),
        // R27-47：tags/order 随还原带回清单（删→还原一轮不再静默清零用户标注/排序）
        ...(entry.tags && entry.tags.length > 0 ? { tags: entry.tags } : {}),
        ...(typeof entry.order === 'number' ? { order: entry.order } : {}),
      })
      mkdirSync(dirname(manifestPath), { recursive: true })
      writeManifest(manifestPath, m)
    })
    manifestUpserted = true
  } catch (e) {
    // Y-17（第五十七轮）：主清单写失败不阻断恢复（文件已回原位），但 docId 身份断链
    // 并无自动补录——树扫盘的兜底登记只认 legacy: 前缀（adoptLegacyDoc），doc_ 正式
    // ID 无法凭 docId 反查路径。此处 warn 留痕（不再静默）：版本目录 工作区/.版本/<docId>/
    // 与 journal 仍以原 docId 可考，可按 path 对账手工补录清单行。
    log.warn('trash', `恢复 ${id} 后清单登记失败（文件已回 ${entry.originalPath}）：${errMsg(e)}——docId 身份断链，需手工补录`, e instanceof Error ? e : undefined)
  }

  // R33-10（三十三轮）：条目移除收进 upsert 成功分支——此前无论清单登记成败都删条目，
  // 失败态（清单锁超时/磁盘满）唯一的自愈通道（R65-36 byte-equal 幂等重跑：跳过搬运
  // 直补清单 upsert）被一并摧毁，doc_ 正式 ID 无法反查 → 版本目录与 journal 永久孤儿。
  // upsert 失败时保留条目：restore 天然幂等，作者重试即续跑直补清单（断链提示由上方
  // Y-17 warn 承担，不再重复留痕）。
  if (manifestUpserted) {
    try {
      // Z-5（第五十八轮）：RMW 持锁（同 appendTrashEntry；与上方主清单锁先后串联、不嵌套）
      await withManifestLockAsync(trashManifestPath(bookRoot), () => {
        writeTrashManifest(bookRoot, readTrashManifestStrict(bookRoot).filter((e) => e.id !== id)) // R27-40：RMW strict 读
      })
    } catch { /* trash manifest 写失败：条目残留，下次恢复报 NOT_FOUND，无害 */
    }
  }
}

/** 永久删：物理删 .trash 文件 + 移除 trash 条目（不可逆，前端二次确认）。
 *  R33D-21（三十三轮）：restore/purge 锁等待异步化（withManifestLockAsync，R30-3
 *  服务进程纪律）——端点本就 async，同步 Atomics.wait 最坏 2×5s 冻结事件循环。 */
export async function purgeTrash(bookRoot: string, id: string): Promise<PurgeResult> {
  const entries = readTrashManifest(bookRoot)
  const entry = entries.find((e) => e.id === id)
  if (!entry) return { ok: false, code: 'NOT_FOUND', reason: `回收站无 ${id}` }
  // Y-18：与 restoreTrash 同款 .trash 前缀校验（防篡改清单借 purge 删书内任意文件）
  // R27-49（二十七轮）：排除清单自身——`工作区/.trash/.trash-manifest.jsonl` 同样满足
  // `.trash/` 前缀，篡改条目可借 restore/purge 把清单本体搬离回收站（随后 writeTrashManifest
  // 以空读结果重建空清单，全部条目丢失）。Y-18 威胁模型（trash-manifest 是可篡改数据面）
  // 的残余缺口。
  if (
    !entry.trashedPath.replace(/\\/g, '/').startsWith(`${TRASH_DIR_REL}/`) ||
    entry.trashedPath.replace(/\\/g, '/') === TRASH_MANIFEST_REL
  ) {
    return { ok: false, code: 'NOT_FOUND', reason: '回收站条目路径非法（不在 .trash 目录内）' }
  }
  try {
    const trashAbs = safePathWithin(bookRoot, entry.trashedPath)
    if (!trashAbs) return { ok: false, code: 'NOT_FOUND', reason: '回收站条目路径非法（越出书仓库）' }
    // R40-19：永久删主文件同款退避（purge 不可逆承诺下退避后仍失败须如实报错，
    // 不静默留 .trash 残迹——R64-13 隐私残留口径）
    if (existsSync(trashAbs)) rmWithRetry(trashAbs)
    // R64-13（十二轮）：版本目录连删——purge 语义是「永久删（不可逆）」，此前只删
    // .trash 文件，工作区/.版本/<docId>/ 快照残留（pinned 定稿版永久保留），内容仍可
    // 经版本 API 读出，与 UI 的不可逆承诺冲突（隐私残留）。docId 走 safeDocId 同守卫
    // （与 listVersions 一致，防篡改清单借 purge 删版本目录外文件）。
    // R68-2（十六轮）：双候选连删（与 version.ts docVersionDirs 同口径：字面在前、
    // 编码在后、同名去重）——此前只拼字面 entry.id，win 上字面含 `:` 永不存在、
    // mac 上新写版本全在编码目录，两种平台都残留。
    if (safeDocId(entry.id)) {
      const names = entry.id === encodeDocDirName(entry.id) ? [entry.id] : [entry.id, encodeDocDirName(entry.id)]
      for (const name of names) {
        const verDir = safePathWithin(bookRoot, `工作区/${VERSIONS_DIR_NAME}/${name}`)
        // R42-40（四十二轮）记档：此递归删未收编 rmWithRetry——fs/atomic.ts 现签名默认
        // rm 为 rmSync(p, {force:true})（非递归，目录删需 recursive，误收编会恒抛
        // ERR_FS_EISDIR 直败），rm 注入口的文档口径是测试注入不动生产语义；待 rmWithRetry
        // 增设 recursive 档后，此处随 :411 主文件 / 分析信封 / journal 一并收编。
        if (verDir && existsSync(verDir)) rmSync(verDir, { recursive: true, force: true })
      }
      // R69-4（十七轮）：分析信封双候选 + journal 双名连删——purge「不可逆」承诺下
      // 此前漏清两处：项目/分析/<docId>.json（review/score 载荷 = 隐私残留，字面+编码
      // 双候选，与版本目录同族）；工作区/.journal/<name>.jsonl（崩溃未结算的 pending
      // 行含全文快照，残留会让 healthCheck 对已删文档永久报 crashedWrite 幽灵红）。
      const analysisCandidates = analysisPathCandidates(bookRoot, entry.id)
      if (analysisCandidates) {
        for (const fp of analysisCandidates) {
          // R42-40（四十二轮）：删源收编 rmWithRetry（:411 主文件同款先例）——退避后
          // 仍失败上抛走既有 WRITE_ERROR 收口（不可逆承诺下如实报错，不静默留隐私残迹）
          if (existsSync(fp)) rmWithRetry(fp)
        }
      }
      for (const name of names) {
        const journalFile = safePathWithin(bookRoot, `工作区/.journal/${name}.jsonl`)
        // R42-40：同上收编（journal 清理与主文件/分析信封同族删源点）
        if (journalFile && existsSync(journalFile)) rmWithRetry(journalFile)
        // R76-27（二十四轮 C 域）登记的孤儿锁堆积改由陈锁清扫统一收口——R39-12（三十九轮）：
        // 此前 purge 侧「queryLockHeld → rmSync」自删存在 µs 级 TOCTOU（判「不在持」与删
        // 之间他进程恰完成取锁复核 → 删掉在持锁 = 互斥失效，lost update 形态），且与
        // sweepAbandonedTmpFiles 的 .lock 分支功能重复（后者为确定性判据：合法锁指纹 JSON
        // + 持有 pid 已死 + 10min 超龄，atomic.ts；healthCheck 已接线 state.ts）。文档已
        // 永久删、该锁再无获取者——残留交下一次 healthCheck 清扫，宁慢勿错。
      }
    }
  } catch (e) {
    return { ok: false, code: 'WRITE_ERROR', reason: `永久删失败：${errMsg(e)}` }
  }
  // 低级项（第六轮）：条目写回 best-effort——主文件已物理删除（不可逆动作已成），
  // manifest 写失败（磁盘满/权限）不应把整端点打成 500；残留条目只是多余展示，无害
  try {
    // Z-5：RMW 持锁（同上）
    await withManifestLockAsync(trashManifestPath(bookRoot), () => {
      writeTrashManifest(bookRoot, readTrashManifestStrict(bookRoot).filter((e) => e.id !== id)) // R27-40：RMW strict 读
    })
  } catch { /* 条目残留：下次对该 id 操作报 NOT_FOUND，自愈 */ }
  return { ok: true, id }
}

/** 路径安全：rel 须相对 bookRoot 且不越出（防 trash-manifest 篡改后 restore/purge 越出书仓库）。
 *  批 6 统一：委托 resolveWithinRoot（防穿越 + symlink 双侧 realpath，fail-closed）。
 *  返回绝对路径或 null（非法）。 */
function safePathWithin(bookRoot: string, rel: string): string | null {
  return resolveWithinRoot(bookRoot, rel)?.abs ?? null
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
