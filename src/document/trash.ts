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
import { existsSync, readFileSync, renameSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { atomicWriteFile, linkOrRenameExclusive } from '../fs/atomic.js'
import { resolveWithinRoot, safeDocId } from '../fs/safe-path.js'
import { readManifestStrict, writeManifest, upsertEntry, withManifestLock, withManifestLockAsync, type ManifestEntry } from './manifest.js'
import { VERSIONS_DIR_NAME, encodeDocDirName } from './version.js'
import { queryLockHeld } from '../fs/cross-process-lock.js'
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
  if (!existsSync(trashAbs)) return { ok: false, code: 'NOT_FOUND', reason: '回收站文件已丢失' }
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
      rmSync(trashAbs, { force: true })
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
        renameSync(trashAbs, origAbs)
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
        rmSync(trashAbs, { force: true })
      }
    }
  } catch (e) {
    return { ok: false, code: 'WRITE_ERROR', reason: `恢复失败：${errMsg(e)}` }
  }

  // P2-BE-4：rename 成功后 manifest 更新改 best-effort（与 doTrash 一致——失败不致文件失踪）
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
  } catch (e) {
    // Y-17（第五十七轮）：主清单写失败不阻断恢复（文件已回原位），但 docId 身份断链
    // 并无自动补录——树扫盘的兜底登记只认 legacy: 前缀（adoptLegacyDoc），doc_ 正式
    // ID 无法凭 docId 反查路径。此处 warn 留痕（不再静默）：版本目录 工作区/.版本/<docId>/
    // 与 journal 仍以原 docId 可考，可按 path 对账手工补录清单行。
    log.warn('trash', `恢复 ${id} 后清单登记失败（文件已回 ${entry.originalPath}）：${errMsg(e)}——docId 身份断链，需手工补录`, e instanceof Error ? e : undefined)
  }

  try {
    // Z-5（第五十八轮）：RMW 持锁（同 appendTrashEntry；与上方主清单锁先后串联、不嵌套）
    await withManifestLockAsync(trashManifestPath(bookRoot), () => {
      writeTrashManifest(bookRoot, readTrashManifestStrict(bookRoot).filter((e) => e.id !== id)) // R27-40：RMW strict 读
    })
  } catch { /* trash manifest 写失败：条目残留，下次恢复报 NOT_FOUND，无害 */
  }
  invalidateTreeIndex(bookRoot, true)
  return { ok: true, id, path: entry.originalPath }
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
    if (existsSync(trashAbs)) rmSync(trashAbs, { force: true })
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
        if (verDir && existsSync(verDir)) rmSync(verDir, { recursive: true, force: true })
      }
      // R69-4（十七轮）：分析信封双候选 + journal 双名连删——purge「不可逆」承诺下
      // 此前漏清两处：项目/分析/<docId>.json（review/score 载荷 = 隐私残留，字面+编码
      // 双候选，与版本目录同族）；工作区/.journal/<name>.jsonl（崩溃未结算的 pending
      // 行含全文快照，残留会让 healthCheck 对已删文档永久报 crashedWrite 幽灵红）。
      const analysisCandidates = analysisPathCandidates(bookRoot, entry.id)
      if (analysisCandidates) {
        for (const fp of analysisCandidates) {
          if (existsSync(fp)) rmSync(fp, { force: true })
        }
      }
      for (const name of names) {
        const journalFile = safePathWithin(bookRoot, `工作区/.journal/${name}.jsonl`)
        if (journalFile && existsSync(journalFile)) rmSync(journalFile, { force: true })
        // R76-27（二十四轮 C 域）：同名锁残留连删（best-effort）——purge 删 journal 但留
        // `<journal>.save.lock`/`<journal>.lock`，文档已永久删、该锁再无获取者，孤儿锁
        // 永久堆积。在持（他进程恰在写该 doc）则跳过——删在持锁 = 互斥失效；残留留给
        // 下次 purge 或 healthCheck 的陈锁清扫（atomic.ts sweepAbandonedTmpFiles）。
        for (const suffix of ['.save.lock', '.lock']) {
          const lockResidue = journalFile ? `${journalFile}${suffix}` : null
          if (!lockResidue || !existsSync(lockResidue)) continue
          if (queryLockHeld(lockResidue)) continue
          try {
            rmSync(lockResidue, { force: true })
          } catch {
            /* 占用等跳过 */
          }
        }
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
