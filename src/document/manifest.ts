/**
 * 项目清单（W0-1 §4.2）—— `项目/文档清单.jsonl`。
 *
 * 只存身份/排序/状态/标签投影，不存正文/标题。行序无语义，按 id 幂等合并。
 * - 读：jsonl 解析，header 取 version，entry 按 id 存 Map（后写覆盖）；非法行跳过降级。
 * - 写：原子重写整文件（追加 + 重写，atomicWriteFile）。
 * - order：章由文件名编号派生顺序，**省略 order 字段**；自由区文档与文件夹才有 order。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { acquireCrossProcessLockWithTimeout, acquireCrossProcessLockAsync } from '../fs/cross-process-lock.js'
import { platformCaseFold } from '../fs/safe-path.js'

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

// ── R47-8（四十七轮）：文档清单指纹缓存 ──────────────────────────────────────────
// 所有 docId 端点（check/review/rewrite/analyze/snapshots/documents 保存等）每请求
// 全量读盘 + O(N) 解析（自动保存 ≥5s 一次链内 2-3 遍，2000 文档 ≈数百 KB）。stat
// 指纹（size:mtimeMs）缓存——写必 bump mtime 自然失效，writeManifest 仍主动清一道
// 双保险；命中零 IO 零解析。**拷贝出仓**：RMW 消费方原位改 entry（maybeUpdateManifest
// 改 path、upsert 改 tags 等），共享引用会污染缓存——Map + entry 浅拷（tags 数组
// 随拷，唯一嵌套面）。strict 读失败上抛语义保留：stat 非 ENOENT 失败时绕过缓存走
// 原路径（其 readFileSync 同族失败会上抛，R27-40 防丢闸不受缓存影响）。
const MANIFEST_CACHE_MAX = 32
const manifestCache = new Map<string, { sig: string; manifest: Manifest }>()

/** stat 签名：ENOENT → 'absent'（合法空态可缓存）；其他 stat 失败 → null（绕过缓存，
 *  交原路径判读——读失败面与 stat 失败面同族）。
 *  R53-D-1（五十三轮）：mtimeMs（毫秒浮点）→ mtimeNs（bigint stat）——FAT/exFAT 的
 *  mtime 2 秒粒度 + 同尺寸他进程写（外部编辑器改清单）此前指纹不变 → 缓存陈旧命中
 *  → 后续 RMW 以旧表整文件回写把外部修改回滚。ns 粒度消同尺寸窗口；非 ns 原生的
 *  文件系统上 Node 以低精度值填充 bigint 字段，不劣于现状（chapters.ts Z-21 /
 *  tree.ts probeCache 同口径先例）。 */
function manifestStatSig(filePath: string): string | null {
  try {
    const st = statSync(filePath, { bigint: true })
    return `${st.size}:${st.mtimeNs}`
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : null
  }
}

/** R47-8：拷贝出仓（主本驻留缓存，调用方各拿独立副本）。 */
function copyManifest(m: Manifest): Manifest {
  const entries = new Map<string, ManifestEntry>()
  for (const [k, e] of m.entries) {
    entries.set(k, e.tags ? { ...e, tags: [...e.tags] } : { ...e })
  }
  return { version: m.version, entries }
}

function manifestCacheSet(filePath: string, sig: string, manifest: Manifest): void {
  if (!manifestCache.has(filePath) && manifestCache.size >= MANIFEST_CACHE_MAX) {
    const oldest = manifestCache.keys().next().value
    if (oldest !== undefined) manifestCache.delete(oldest)
  }
  manifestCache.set(filePath, { sig, manifest })
}

/** R47-8：清单指纹缓存测试钩子（生产零调用；口径同 rebuild.ts __testHooks）。 */
export const __manifestCacheTestHooks = {
  clear(): void {
    manifestCache.clear()
  },
}

/** 读清单（W0-1 §4.2）——读侧容错版（树扫描/查询/哨兵等只读消费面用）。
 *  - 文件不存在 → 空清单（version 默认 1）。
 *  - 非法 JSON 行 / 缺关键字段的行跳过（损坏降级，不阻断）。
 *  - 读失败（EACCES/EBUSY/EIO 瞬态）→ 空清单（M-13：读侧哨兵/全量兜底承接）。
 *  R47-8：stat 指纹缓存命中零读零解析（返回副本）。 */
export function readManifest(filePath: string): Manifest {
  const sig = manifestStatSig(filePath)
  if (sig !== null) {
    const hit = manifestCache.get(filePath)
    if (hit && hit.sig === sig) return copyManifest(hit.manifest)
  }
  const r = readManifestCore(filePath)
  // 读失败（ok:false）不落缓存——防毒化 strict 版（见 readManifestCore 注）
  if (r.ok && sig !== null) manifestCacheSet(filePath, sig, r.manifest)
  return r.ok
    ? copyManifest(r.manifest)
    : { version: DEFAULT_VERSION, entries: new Map<string, ManifestEntry>() }
}

/** R47-8：读核心（容错/strict 共用）——ok:false = 读失败（非 ENOENT），两版分立处理
 *  （容错→空清单不落缓存；strict→上抛不落缓存），防「容错版的降级空表」经共享缓存
 *  毒化 strict 版的防丢闸（R27-40）。ENOENT（含 existsSync 与 read 间竞态删）两版
 *  同为合法空态，可缓存。 */
type ManifestCoreResult = { ok: true; manifest: Manifest } | { ok: false; code?: string }

function readManifestCore(filePath: string): ManifestCoreResult {
  const entries = new Map<string, ManifestEntry>()
  if (!existsSync(filePath)) return { ok: true, manifest: { version: DEFAULT_VERSION, entries } }
  let text: string
  try {
    text = readFileSync(filePath, 'utf-8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: true, manifest: { version: DEFAULT_VERSION, entries } }
    return { ok: false, code }
  }
  return { ok: true, manifest: parseManifestText(text, entries) }
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
 *  维持降级不变——那是内容问题不是可读性问题，与既有口径一致。
 *  R47-8：stat 指纹缓存命中返回副本（零读零解析）；stat 非 ENOENT 失败绕过缓存走
 *  原路径保抛错（'absent' 与容错版共用签名词汇，无互踩）。 */
export function readManifestStrict(filePath: string): Manifest {
  const sig = manifestStatSig(filePath)
  if (sig !== null) {
    const hit = manifestCache.get(filePath)
    if (hit && hit.sig === sig) return copyManifest(hit.manifest)
  }
  const r = readManifestCore(filePath)
  if (r.ok) {
    if (sig !== null) manifestCacheSet(filePath, sig, r.manifest)
    return copyManifest(r.manifest)
  }
  throw new Error(`文档清单读取失败（${r.code ?? '未知错误'}）：${filePath}——已拒绝以空清单重写整文件（R27-40 防丢登记）`)
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
  // R48-44（四十八轮）：单读——原 readFileSync 全文探测 + readManifest 二读对全文
  // 双读；改消费 readManifestCore 结果（读失败 → null 走全量兜底，M-2 语义不变）
  const r = readManifestCore(fp)
  if (!r.ok) return null
  const docs = [...r.manifest.entries.values()].filter((e) => e.nodeType === 'document')
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
    // R43-13（四十三轮）：16+ 位数字名 Number() 解析成超 2^53 的失真值（1e20 级
    // 浮点）不入定稿章号集合——Number.isSafeInteger 守卫，对齐 format/words.ts
    // parseChapterFileName 的 R64-20 口径
    if (g) {
      const no = Number(g[1])
      if (Number.isSafeInteger(no)) out.add(no)
    }
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
  // R48-44（四十八轮）：单读——同 finalizedPathSet 同编号注（读失败 → undefined
  // 全量兜底，M-13 语义不变）
  const r = readManifestCore(fp)
  if (!r.ok) return undefined
  return finalizedChapterNumbers(r.manifest)
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
      // R43-6（四十三轮）：.bak 影子写删 `{ fsync: false }`（回 atomicWriteFile 默认
      // fsync:true）——.bak 是主清单损坏后的恢复源，掉电撕裂恰在兜底场景失守（R34D-4
      // 落地时按「高频低价值写」口径关了 fsync，但 .bak 低频〔随主写一次〕高价值〔唯一
      // 恢复源〕，该口径在此不成立）。
      atomicWriteFile(`${filePath}.bak`, previous)
    }
  } catch {
    /* R34D-4：.bak 影子失败不阻断主写（best-effort） */
  }
  const lines: string[] = [JSON.stringify({ version: manifest.version, type: HEADER_TYPE })]
  for (const e of manifest.entries.values()) {
    lines.push(JSON.stringify(e))
  }
  atomicWriteFile(filePath, lines.join('\n') + '\n', { fsync: true })
  // R47-8：写后清指纹缓存（双保险——写必 bump mtime，指纹本会自然失配）
  manifestCache.delete(filePath)
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

/** 进程内已持锁登记（manifestPath → 重入计数 + release + 异步排队链尾）——计数式
 *  可重入防自锁：嵌套获取（如持锁段内再触发清单登记的调用链）只加深计数不再抢锁，
 *  最外层返回时释放。
 *  重评2-P2-2（2026-09-09 全量重评 GLM-5.3）：登记项增设 tail——异步孪生
 *  （withManifestLockAsync）重入 async fn 的排队链尾（首节 = 持锁 fn 的执行 promise，
 *  持锁 finally 在跨进程锁 release 前循环排空，见其函数头注）。同步版
 *  withManifestLock 的临界段全同步、无排队语义，登记恒 tail:null（异步重入撞上时
 *  惰性建空链——该形态属声明边界，不获锁覆盖）。 */
const heldManifestLocks = new Map<string, { depth: number; release: () => void; tail: Promise<void> | null }>()

/** 重评2-P2-2（2026-09-09 全量重评 GLM-5.3）：async fn 形态判定（不调用 fn）——
 *  Object.prototype.toString 对 async 关键字函数（声明/箭头/方法/bind 产物）给
 *  '[object AsyncFunction]'（Node ≥14 内建标签，跨 realm 稳定，胜过 constructor.name
 *  的可被改名/跨 realm 失效）。排队判定必须发生在「调用 fn」之前：一旦调用，fn 的
 *  同步前缀立即执行，延迟即失去意义（非 async 关键字却返回 thenable 的 fn 只能执行后
 *  兜底，见重入分支注释）。 */
function isAsyncFunction(fn: unknown): boolean {
  return Object.prototype.toString.call(fn) === '[object AsyncFunction]'
}

/** R33-54（三十三轮）：锁键归一化——重入计数原以原始路径字符串为键，同一锁文件经
 *  大小写（win 不敏感 FS）或分隔符漂移的等价路径再入时会被当「他锁」抢锁，同步
 *  Atomics.wait 自持锁等待至超时 fail-closed（而非复用持锁计数）。resolve + 分隔符
 *  归一 + win32 大小写折叠，让等价路径命中同一条目。
 *  R45-2（四十五轮）：折叠改委托 safe-path platformCaseFold 单源（resolve/分隔符
 *  归一管线不变，键字节不变）。 */
function manifestLockKey(manifestPath: string): string {
  let p = manifestPath
  try {
    p = resolve(manifestPath)
  } catch { /* resolve 失败保原值（畸形路径本就会在 acquire 处失败） */ }
  p = p.replace(/[\\/]+/g, '/')
  return platformCaseFold(p)
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
      // 重评2-P2-2：登记项增设 tail 字段（恒 null——同步临界段无排队语义，见
      // heldManifestLocks 声明注）；本函数执行语义零变更。
      heldManifestLocks.set(lockKey, { depth: 1, release, tail: null })
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
 * 进程内重入沿用 heldManifestLocks 计数，重入键同同步版走 manifestLockKey 归一
 *（R35-26：原实现以原始路径串为键，等价路径变体再入被误判「他锁」抢物理锁自锁）。
 * R35-25：fn 允许 async（T | Promise<T>），执行器在锁内 await fn()——原 `return fn()`
 * 在 fn 返回 promise 即触发 finally 释放锁，async fn 的互斥静默失效；await 后跨进程
 * 锁覆盖 fn 整个执行期。同进程并发同 key 调用在首个 fn await 期间仍按重入计数放行
 * （与同步版一致，进程内串行化仍是调用方责任）。
 * 其余不在异步链上的调用方保持同步版不动。
 * R43-10（四十三轮）不变量声明（注释收口，未装断言）〔重评2-P2-2（2026-09-09
 *  全量重评 GLM-5.3）已机制化收口——本段纪律声明废止，同进程互斥改由下段排队机制
 *  承担，不再依赖「fn 体零 await」纪律；原文留档沿革〕：**重入分支（含正常分支）的
 * 同进程互斥要求 fn 体零 await（同步返回）**——fn 一旦返回 Promise，其在途期间
 * heldManifestLocks 仍登记在册（重入计数未清），同进程同 key 的并发调用会按「重入」
 * 放行并在 fn 的 await 点交错执行，同进程互斥静默失效（跨进程锁仍覆盖 fn 整个执行期，
 * R35-25）。原拟装「fn 返回值 thenable 即抛错」的 fail-loud dev 断言，但 grep 核实
 * 现有调用方并非全部同步返回——test/document/r35-manifest-lock-async.test.ts 的
 * R35-25 回归用例显式传入 async fn（断言锁覆盖 fn 整个执行期），断言会推翻既有裁定；
 * 生产调用方（service/trash/state/finalize/draft-pipeline）经 grep 全部为同步 fn。
 * 重评2-P2-2（2026-09-09 全量重评 GLM-5.3）修复——重入分支机制化分道（现行契约）：
 * ① **同步 fn**（返回非 thenable）：depth++ 立即执行——与同步版完全同形，零语义
 *   变更、零额外微任务跳数（全部既有同步调用方行为不变）。② **async fn**（async
 *   关键字形态，isAsyncFunction 调用前判定）：**排队**到持锁者执行链尾 held.tail——
 *   链首节 = 持锁 fn 的执行 promise，重入调用 turn = held.tail.then(() => fn())，
 *   同进程同 key 的并发 async 调用由此串行化（修复前直接执行，fn 含 await 时在持锁
 *   者 await 间隙交错、同进程互斥静默失效）；持锁 finally 在跨进程锁 release 前**循环
 *   排空** tail（排水期间新到的重入调用会延长链尾：async 继续排队、同步走快道；循环
 *   至链尾稳定，「稳定判定 → delete → release」三步同步无 await，无判定后插入窗口），
 *   排队者始终执行在跨进程锁覆盖内。链尾吞前序异常（turn 失败不阻断后序排队者与
 *   释放，错误只递给该调用方）。③ **非 async 关键字却返回 thenable 的 fn**（如箭头
 *   包 async 调用）：调用前无法识别、同步前缀已先行执行（不可回退），完成挂入 tail
 *   保住「跨进程锁释放等它 / 后续排队者等它」；前缀交错无法追回——此类调用方应改用
 *   async fn 形态（声明边界）。
 * **防真递归死锁边界（本修复的有意边界；grep 核实现有调用方后声明）**：同一次 fn
 * 执行体内再次重入同 key 且 await 其结果（真递归；含排队 fn 内再排队自等、排队 fn
 * await 持锁者自身完成）会排队自等死锁——现有生产调用方（service/trash/state/
 * finalize/draft-pipeline）经 grep 全为同步 fn、无递归形态（trash 主清单/回收站锁
 * 先后串联不嵌套，R34D-19）；**真递归调用方须维持同步 fn 形态**（同步快道立即执行
 * 不排队，天然无此死锁；回归钉死见 test/document/re2-manifest-lock-reentry-async.test.ts）。
 * 同版 withManifestLock 持锁段内发起的异步孪生调用（同步段内无法 await，必为
 * fire-and-forget）不获排队保护：惰性空链上的排队轮次在同步临界段结束后才执行
 * （彼时锁已释放，修复前该形态同样无保护）——同步持锁段内不得派生 async 重入。
 */
export async function withManifestLockAsync<T>(manifestPath: string, fn: () => T | Promise<T>): Promise<T> {
  const lockKey = manifestLockKey(manifestPath)
  const held = heldManifestLocks.get(lockKey)
  if (held) {
    // 重评2-P2-2（2026-09-09 全量重评 GLM-5.3）：重入分支机制化分道（契约见函数头
    // 注）——async fn 排队到持锁者执行链尾串行化（修复 R43-10 注释纪律下的同进程
    // 互斥静默失效）；同步 fn 维持现状（depth++ 立即执行，零语义变更、零额外微
    // 任务跳数）。惰性建链：撞上同步版登记项（tail:null）时建空链——该形态属
    // 声明边界（排队轮次在同步临界段后执行，不获锁覆盖）。
    if (!held.tail) held.tail = Promise.resolve()
    if (isAsyncFunction(fn)) {
      const invoke = fn as () => Promise<T>
      // 调用本身挂链尾轮次（不能先调用再排队：同步前缀一旦先行执行，延迟即失效）
      const turn = held.tail.then(() => invoke())
      // 链尾吞前序异常：本排队者失败不阻断后序排队者与持锁释放，错误只递给本调用方
      held.tail = turn.then(() => {}, () => {})
      return await turn
    }
    held.depth++
    try {
      const r = fn()
      if (r !== null && r !== undefined && typeof (r as PromiseLike<unknown>).then === 'function') {
        // 非 async 关键字却返回 thenable（箭头包 async 调用等）：同步前缀已先行
        //（不可回退），完成挂入 tail——保住释放/后续排队者等它（声明边界，函数头注③）
        const settle = r as Promise<T>
        const gated = held.tail.then(() => settle)
        held.tail = gated.then(() => {}, () => {})
        return await gated
      }
      return await r
    } finally {
      held.depth--
    }
  }
  const lockPath = `${manifestPath}.lock`
  for (let attempt = 0; ; attempt++) {
    const release = await acquireCrossProcessLockAsync(lockPath, manifestLockTimeoutMs)
    if (release) {
      const held: { depth: number; release: () => void; tail: Promise<void> | null } = { depth: 1, release, tail: null }
      heldManifestLocks.set(lockKey, held)
      // 重评2-P2-2：临界段首节——fn 的执行 promise 即重入排队链（tail）的头节；
      // async IIFE 保持 fn 调用时机与旧实现逐位一致（同步前缀立即执行；fn 同步前缀
      // 内发起的 fire-and-forget 异步重入属声明边界，见函数头注）。
      const run = (async () => fn())()
      held.tail = run.then(() => {}, () => {})
      try {
        return await run
      } finally {
        // 重评2-P2-2：释放前循环排空重入排队链——排队中的 async fn 仍是本进程临界
        // 段的一部分，必须先于跨进程锁 release 执行完毕（否则排队者跑在锁外，跨进程
        // 互斥失守）。排水期间新到的重入调用会延长链尾（登记项仍在册：async 重入继续
        // 排队、同步重入走快道），循环等至链尾稳定；「稳定判定 → delete → release」
        // 三步同步无 await，不存在判定后的插入窗口。
        for (let t = held.tail; ; t = held.tail) {
          await t
          if (held.tail === t) break
        }
        heldManifestLocks.delete(lockKey)
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
