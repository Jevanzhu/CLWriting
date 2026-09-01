/**
 * 项目清单（W0-1 §4.2）—— `项目/文档清单.jsonl`。
 *
 * 只存身份/排序/状态/标签投影，不存正文/标题。行序无语义，按 id 幂等合并。
 * - 读：jsonl 解析，header 取 version，entry 按 id 存 Map（后写覆盖）；非法行跳过降级。
 * - 写：原子重写整文件（追加 + 重写，atomicWriteFile）。
 * - order：章由文件名编号派生顺序，**省略 order 字段**；自由区文档与文件夹才有 order。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { acquireCrossProcessLockWithTimeout, acquireCrossProcessLockAsync } from '../fs/cross-process-lock.js'

/** 清单条目：身份 + 排序投影。folder 无 status。 */
export interface ManifestEntry {
  id: string
  nodeType: 'document' | 'folder'
  path: string
  parentId: string | null
  /** 排序值；编号派生文档（章）省略此字段（order 与编号不双真相）。 */
  order?: number
  /** 文档状态投影（folder 无）；可从磁盘 + git 重建。 */
  status?: string
  tags?: string[]
  // ── 定稿基线（去 git 版本系统用）──────────────
  /** 最后一次定稿的内容指纹（`sha256:xxx`）；无/不存在 = 从未定稿。 */
  finalizedRevision?: string
  /** 最后一次定稿时间（ISO 时间戳）。 */
  finalizedAt?: string
}

/** 清单：version + 按 id 幂等合并的条目集。 */
export interface Manifest {
  version: number
  entries: Map<string, ManifestEntry>
}

const HEADER_TYPE = 'header'
const DEFAULT_VERSION = 1

/** jsonl 一行的宽松形状（解析后逐字段校验）。 */
type RawLine = { [k: string]: unknown }

/** 读清单（W0-1 §4.2）——读侧容错版（树扫描/查询/哨兵等只读消费面用）。
 *  - 文件不存在 → 空清单（version 默认 1）。
 *  - 非法 JSON 行 / 缺关键字段的行跳过（损坏降级，不阻断）。
 *  - 读失败（EACCES/EBUSY/EIO 瞬态）→ 空清单（M-13：读侧哨兵/全量兜底承接）。 */
export function readManifest(filePath: string): Manifest {
  const entries = new Map<string, ManifestEntry>()
  if (!existsSync(filePath)) return { version: DEFAULT_VERSION, entries }
  let text: string
  try {
    text = readFileSync(filePath, 'utf-8')
  } catch {
    return { version: DEFAULT_VERSION, entries }
  }
  return parseManifestText(text, entries)
}

/** R27-40（二十七轮）P1：读清单——RMW 写路径专用 strict 版。
 *  根因：readManifest 把「读失败」与「文件不存在」混同为空清单，所有持锁读改写点
 *  （doTrash 删条目 / finalize 补建基线 / upsert / restore 回写 / 迁移 RMW）在
 *  readFileSync 撞瞬态读失败（win 杀软/索引器/网盘的 EBUSY/EACCES/EIO）时拿到空
 *  entries 照常走写分支，writeManifest 用空表原子替换整文件——全书 docId↔path 登记、
 *  finalizedRevision 定稿基线、回收站条目一次性物理丢失（防覆盖闸随之失守）。
 *  语义：ENOENT（含 existsSync 与 read 之间被并发删的竞态）= 合法空态，与无清单同；
 *  其余读错误上抛——调用方的既有 catch（WRITE_ERROR 信封 / best-effort warn /
 *  GG-P2-6 登记不成则删不成）自然收口为「拒写保旧文件」。解析级损坏（坏行跳过）
 *  维持降级不变——那是内容问题不是可读性问题，与既有口径一致。 */
export function readManifestStrict(filePath: string): Manifest {
  const entries = new Map<string, ManifestEntry>()
  if (!existsSync(filePath)) return { version: DEFAULT_VERSION, entries }
  let text: string
  try {
    text = readFileSync(filePath, 'utf-8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { version: DEFAULT_VERSION, entries }
    throw new Error(`文档清单读取失败（${code ?? '未知错误'}）：${filePath}——已拒绝以空清单重写整文件（R27-40 防丢登记）`)
  }
  return parseManifestText(text, entries)
}

/** 文本 → Manifest（readManifest/readManifestStrict 共用解析体） */
function parseManifestText(text: string, entries: Map<string, ManifestEntry>): Manifest {
  let version = DEFAULT_VERSION
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let obj: RawLine
    try {
      obj = JSON.parse(line) as RawLine
    } catch {
      continue // 非法行跳过（损坏降级）
    }
    if (obj.type === HEADER_TYPE && typeof obj.version === 'number') {
      version = obj.version
      continue
    }
    if (typeof obj.id === 'string' && (obj.nodeType === 'document' || obj.nodeType === 'folder')) {
      entries.set(obj.id, parseEntry(obj))
    }
  }
  return { version, entries }
}

function parseEntry(obj: RawLine): ManifestEntry {
  const entry: ManifestEntry = {
    id: obj.id as string,
    nodeType: obj.nodeType as 'document' | 'folder',
    path: typeof obj.path === 'string' ? obj.path : '',
    parentId: typeof obj.parentId === 'string' ? obj.parentId : null,
  }
  if (typeof obj.order === 'number') entry.order = obj.order
  if (typeof obj.status === 'string') entry.status = obj.status
  if (typeof obj.finalizedRevision === 'string') entry.finalizedRevision = obj.finalizedRevision
  if (typeof obj.finalizedAt === 'string') entry.finalizedAt = obj.finalizedAt
  if (Array.isArray(obj.tags)) {
    const tags = obj.tags.filter((t): t is string => typeof t === 'string')
    if (tags.length > 0) entry.tags = tags
  }
  return entry
}

/** 幂等合并：同 id 后写覆盖（清单行序无语义）。 */
/** 已定稿路径集合（V-P2-2 导出 / learn 收割 H-1 / overview 时间线共用的单一判定）：
 *  文档条目且有 finalizedRevision（曾定稿）→ 其 path 入集合。
 *  旧书无清单 → null（无法判定，调用方保持全量，与历史行为一致）。
 *  M-2（第十轮）：读失败（EACCES/EBUSY 瞬态）→ null 走全量兜底，不再与「零文档条目」
 *  混同——readManifest 吞掉读失败返空清单，此前 docs=0 一律 null；清单在册可读但零
 *  文档条目（脚手架新书）改返**空集**（判定成立：无一定稿，PL-2 同口径——草稿不再
 *  混进导出/文风样本/候选池）。路径为 manifest 口径的正斜杠相对路径。 */
export function finalizedPathSet(bookRoot: string): Set<string> | null {
  const fp = join(bookRoot, '项目', '文档清单.jsonl')
  if (!existsSync(fp)) return null
  try {
    readFileSync(fp)
  } catch {
    return null
  }
  const entries = [...readManifest(fp).entries.values()]
  const docs = entries.filter((e) => e.nodeType === 'document')
  if (docs.length === 0) return new Set()
  const set = new Set<string>()
  for (const e of docs) if (e.finalizedRevision) set.add(e.path)
  return set
}

/** 已定稿章号集合（低级项·第六轮：assembleStatus currentChapter 口径收口的共享判定）：
 *  文档条目且有 finalizedRevision（曾定稿）→ 按文件名前缀数值取章号（定稿改名 3/4 位
 *  补零均命中，与 state.ts skipFinalizedChapters 同一口径）。 */
export function finalizedChapterNumbers(m: Manifest): Set<number> {
  const out = new Set<number>()
  for (const e of m.entries.values()) {
    if (e.nodeType !== 'document' || !e.finalizedRevision) continue
    const base = e.path.split('/').pop() ?? ''
    const g = base.match(/^(\d+)-/)
    if (g) out.add(Number(g[1]))
  }
  return out
}

/** PL-2（第七轮）：书级定稿章号集合——清单缺失 → undefined（无清单的旧书/测试夹具
 *  保持全量口径），清单在册 → 实际集合（可为空集 = 新书零定稿，assembleStatus 据此
 *  得 currentChapter=0，不再回落「含草稿全量」——此前空集与缺省同走全量分支，
 *  清单在册零定稿的新书会把写作中草稿计进「已定稿最新章号」）。
 *  M-13（第八轮）：读失败（EACCES/EBUSY 瞬态）也返 undefined 走全量兜底——readManifest
 *  吞掉读失败返空清单，哨兵会把「读不到」误判成「真 0 章」，成熟书 currentChapter=0、
 *  近况复述「已写到第 0 章」。与 finalizedPathSet 对损坏返 null 的降级哲学对齐；
 *  解析级损坏（个别行跳过）保持按已解析行给集合，不重开 PL-2。 */
export function finalizedChapterSetOfBook(bookRoot: string): Set<number> | undefined {
  const fp = join(bookRoot, '项目', '文档清单.jsonl')
  if (!existsSync(fp)) return undefined
  try {
    readFileSync(fp)
  } catch {
    return undefined
  }
  return finalizedChapterNumbers(readManifest(fp))
}

export function upsertEntry(manifest: Manifest, entry: ManifestEntry): void {
  manifest.entries.set(entry.id, entry)
}

/** 按 id 删除条目。 */
export function removeEntry(manifest: Manifest, id: string): boolean {
  return manifest.entries.delete(id)
}

/** 原子写回整文件（追加 + 重写整文件原子替换，W0-1 §4.2）。
 *  R34D-4（三十四轮）：写前 `.bak` 影子——清单「在册可读但零条可解析」读侧三防线
 *  （finalizedPathSet/finalizedChapterSetOfBook → ensureChapterNotFinalized）fail-open
 *  当空集，且坏清单的下次写会把空表物理落盘**永久化**。本写点在替换前把将被覆盖的
 *  旧内容原子写一份 `文档清单.jsonl.bak`（同目录 tmp+rename，失败 best-effort 不阻断
 *  主写、已有 .bak 直接覆盖），外部（编辑器/云同步）把清单搞坏后总有上一份好内容可恢复。 */
export function writeManifest(filePath: string, manifest: Manifest): void {
  try {
    if (existsSync(filePath)) {
      // 字节级快照旧内容（不解析——坏行也原样留底，恢复口径最全）
      const previous = readFileSync(filePath)
      atomicWriteFile(`${filePath}.bak`, previous, { fsync: false })
    }
  } catch {
    /* R34D-4：.bak 影子失败不阻断主写（best-effort） */
  }
  const lines: string[] = [JSON.stringify({ version: manifest.version, type: HEADER_TYPE })]
  for (const e of manifest.entries.values()) {
    lines.push(JSON.stringify(e))
  }
  atomicWriteFile(filePath, lines.join('\n') + '\n', { fsync: true })
}

// ── X-5（第五十六轮）：清单 RMW 跨进程互斥 ────────────────────────

/**
 * 清单锁等待超时（毫秒）。
 * N7（五十九轮）：2s → 5s，对齐 ai-calls 口径（AI_CALLS_LOCK_TIMEOUT_MS=5s）——
 * 超时降级裸写后，双进程同时降级时后写者会吞掉先写者的清单更新（正是 X-5 要防的
 * 事故在争用高峰复现）。持锁段为「读清单 + 整写」的文件 IO 级毫秒，但争用可排队
 * （多 contender），5s 与全仓锁基建的最长等待档一致（busy_timeout 5000 同源）。
 * 测试注入缩短保快。
 * R30-18（三十轮）：常量化——export let 可被任一 import 方静默改写（同 events/store.ts
 * R26-105 的收口认定），改 const + 内部可变生效值；测试只能经注入钩子改档，生产恒用常量。
 */
export const MANIFEST_LOCK_TIMEOUT_MS = 5_000

/** 生效值（模块内可变）：初值 = 常量；仅注入钩子可改。 */
let manifestLockTimeoutMs = MANIFEST_LOCK_TIMEOUT_MS

/** 测试注入钩子（生产零调用）。 */
export function __setManifestLockTimeoutForTest(ms: number): void {
  manifestLockTimeoutMs = ms
}

/** 进程内已持锁登记（manifestPath → 重入计数 + release）——计数式可重入防自锁：
 *  嵌套获取（如持锁段内再触发清单登记的调用链）只加深计数不再抢锁，最外层返回时释放。 */
const heldManifestLocks = new Map<string, { depth: number; release: () => void }>()

/** R33-54（三十三轮）：锁键归一化——重入计数原以原始路径字符串为键，同一锁文件经
 *  大小写（win 不敏感 FS）或分隔符漂移的等价路径再入时会被当「他锁」抢锁，同步
 *  Atomics.wait 自持锁等待至超时 fail-closed（而非复用持锁计数）。resolve + 分隔符
 *  归一 + win32 大小写折叠，让等价路径命中同一条目。 */
function manifestLockKey(manifestPath: string): string {
  let p = manifestPath
  try {
    p = resolve(manifestPath)
  } catch { /* resolve 失败保原值（畸形路径本就会在 acquire 处失败） */ }
  p = p.replace(/[\\/]+/g, '/')
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/**
 * 清单 RMW 互斥段（X-5）：J7 已锁 journal/账本/task-gate，清单的 read→mutate→write
 * 此前全程无互斥——CLI 与 GUI 双进程同书并发时后写者整文件重写吞掉先写者的更新。
 * 锁文件 `<manifestPath>.lock`（复用 fs/cross-process-lock）。
 *
 * R73-33（二十一轮 C-2）：锁超时**不再降级裸写**，改 fail-closed——原「超时降级 + warn
 * 留痕」在双进程同时降级时后写者整文件覆盖先写者，finalizedRevision/清单条目丢行
 * （正是 X-5 要防的事故在超时窗口复现；清单整文件重写不是 append-only，journal 那套
 * 「降级裸写有兜底」的理由在这里不成立）。现对齐 service.ts 保存锁「超时拒绝不降级」
 * 纪律：每轮等待 MANIFEST_LOCK_TIMEOUT_MS，有界重试 1 次（间隔 50ms，吸收恰在超时后
 * 释放的持有者）后仍拿不到 → 抛错拒绝写。调用方语义核查：请求层有统一错误出口
 * （executeSave 内 catch → WRITE_ERROR；doTrash/doMoveOrRename catch → {ok:false}；
 * install 迁移链逐书 try/catch；finalize/trash 持锁段为毫秒级 IO，抛错即上层 500/失败信封），
 * 宁拒绝不覆盖。进程内重入走计数（同进程嵌套获取不死锁）；跨进程嵌套（他进程持锁）正常等待。
 */
export function withManifestLock<T>(manifestPath: string, fn: () => T): T {
  const lockKey = manifestLockKey(manifestPath)
  const held = heldManifestLocks.get(lockKey)
  if (held) {
    held.depth++
    try {
      return fn()
    } finally {
      held.depth--
    }
  }
  // R73-33：有界重试（共 2 轮 × 5s）后 fail-closed 抛错
  const lockPath = `${manifestPath}.lock`
  for (let attempt = 0; ; attempt++) {
    const release = acquireCrossProcessLockWithTimeout(lockPath, manifestLockTimeoutMs)
    if (release) {
      heldManifestLocks.set(lockKey, { depth: 1, release })
      try {
        return fn()
      } finally {
        heldManifestLocks.delete(lockKey)
        release()
      }
    }
    if (attempt >= 1) {
      throw new Error(
        `清单锁获取超时（另一进程持锁 ${manifestLockTimeoutMs}ms × 2 轮未让出：${manifestPath}）——已拒绝本次清单写入以防并发覆盖丢失，请稍后重试`,
      )
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
}

/**
 * R30-6（三十轮）：清单 RMW 互斥段的异步孪生——等待期改 setTimeout 轮询（事件循环
 * 不阻塞），供承载 SSE/全部接口的服务进程保存链（executeSave → maybeUpdateManifest）
 * 在双进程争用窗口内保持可响应。语义与同步版逐位对齐：超时档（2 轮 × 生效档 + 50ms
 * 间隔）不变、fail-closed 抛错不变、错误文案同源、锁文件同源（同步/异步获取者互通互斥）。
 * 进程内重入沿用 heldManifestLocks 计数：持锁后执行的 fn 与同步版同样**全程同步无
 * await**（读改写为同步 FS 调用），单线程下持锁段不会与他调用交错，重入计数语义不变；
 * await 只出现在取锁等待期（此刻未持锁、未登记 map，不产生伪重入）。
 * 其余不在异步链上的调用方保持同步版不动。
 */
export async function withManifestLockAsync<T>(manifestPath: string, fn: () => T): Promise<T> {
  const held = heldManifestLocks.get(manifestPath)
  if (held) {
    held.depth++
    try {
      return fn()
    } finally {
      held.depth--
    }
  }
  const lockPath = `${manifestPath}.lock`
  for (let attempt = 0; ; attempt++) {
    const release = await acquireCrossProcessLockAsync(lockPath, manifestLockTimeoutMs)
    if (release) {
      heldManifestLocks.set(manifestPath, { depth: 1, release })
      try {
        return fn()
      } finally {
        heldManifestLocks.delete(manifestPath)
        release()
      }
    }
    if (attempt >= 1) {
      throw new Error(
        `清单锁获取超时（另一进程持锁 ${manifestLockTimeoutMs}ms × 2 轮未让出：${manifestPath}）——已拒绝本次清单写入以防并发覆盖丢失，请稍后重试`,
      )
    }
    // 同步版的 50ms 吸收间隔对应改异步睡（不阻塞事件循环）
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
}
