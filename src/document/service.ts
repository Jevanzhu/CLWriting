/**
 * DocumentService —— 文档保存协议编排（W0-1 §5）+ 结构性操作（W2A §7）。
 *
 * 统一文档写入入口：UI / AI / CLI 一律经此，保证并发安全 + 崩溃可恢复。
 *
 * save 编排（§5.2，每文档串行队列内执行）：
 *   预校验路径（拒 symlink/`..` 越出）+ 能力（只读文档拒写）
 *   → 入 per-docId 串行队列 → 队列内串行执行：
 *     revision 校验 → journal pending → 按策略 snapshot → atomic write+fsync
 *     → 算新 revision → 条件性更新清单 → journal settled
 *
 * 结构性操作（W2A §7：create/move/rename）：
 *   同步实现（renameSync/mkdirSync + 同步清单写），靠 Node 单线程微任务不交错保证
 *   清单原子性；不走 queue（与同 docId 的 save 并发时，最坏 save 撞 REVISION_CONFLICT
 *   返回，不损坏数据）。事务顺序：预检查 → snapshot 留底 → fs 操作 → 清单同步 →
 *   invalidateTreeIndex。结构性操作触发旧书建清单（W0-1 §4.2）。
 *
 * 冲突 / 能力不足 / 落盘失败 → 不落盘、journal 标 aborted（save）/ 返回 {ok:false,code}。
 * recover() 启动扫 journal，报 pending 无 settled/aborted（崩溃未结算）提示作者恢复。
 *
 * docId 是稳定 ID（队列/日志/清单 key），relPath 是落盘路径。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { safeDocId, resolveWithinRoot } from '../fs/safe-path.js'
import { atomicWriteFile, createFileExclusive, linkOrRenameExclusive } from '../fs/atomic.js'
import { computeRevision, type Revision } from './revision.js'
import { layoutOf, roleOf, isInternalBookPath } from './layout.js'
import { appendAborted, appendMovePending, appendPending, appendSettled, findUnsettled, type JournalAnyPending } from './journal.js'
import { writeSnapshot, DEFAULT_SNAPSHOT_POLICY, readGlobalSnapshotPolicy, type SnapshotPolicy } from './snapshot.js'
import { readManifest, readManifestStrict, writeManifest, upsertEntry, withManifestLock, withManifestLockAsync, type ManifestEntry } from './manifest.js'
import { SaveQueue } from './queue.js'
import { generateDocId, legacyId } from './stable-id.js'
import { invalidateTreeIndex, scanBookTree, type TreeNode } from './tree.js'
import { readFile as readDoc, parseFlat, patchFlatFm, splitFrontMatter, joinFrontMatter, bodyOf } from '../format/frontmatter.js'
import { appendTrashEntry, readTrashManifest } from './trash.js'
import { log } from '../log/index.js'
import { appendWordsDelta, todayDate } from './words-diary.js'
import { countWords, chapterFilePrefix } from '../format/words.js'
// R26-55（二十六轮）：createDocument 的 relPath 逐段消毒同源（sanitizeChapterTitle 是
// 同函数的章标题别名）
import { sanitizeChapterTitle, sanitizeFileNamePart } from '../format/filename.js'
import { encodeDocDirName, decodeDocDirName } from './version.js'
import { acquireCrossProcessLockAsync } from '../fs/cross-process-lock.js' // R31-20：meta 链全异步化，同步等待原语已无使用方
import { readBookConfig } from '../format/yaml.js'

/** 第五轮：非 UTF-8（GBK 等）文件的元数据写回统一拒绝——utf-8 读入产生 U+FFFD 替换
 *  符，元数据路径会把乱码正文原子覆盖回原文件（原始字节永久丢失，且无快照留底，
 *  用户没碰正文却被「盲改」）。检出即拒，先转码再改。 */
const NON_UTF8_REJECT = {
  ok: false as const,
  code: 'WRITE_ERROR' as const,
  reason: '检测到非 UTF-8 编码（正文含 U+FFFD 替换字符）：为防写回损坏原文，请先将该文件转为 UTF-8 再修改元数据',
}

/** M-5（第六轮）：save 主路径同款防线（含 autosave）——编辑器打开 GBK 文件显示乱码后
 *  autosave 存回，乱码正文同样原子覆盖原文件；且设定/大纲等非 chapter 文档无快照
 *  兜底（maybeSnapshot 只留底章文档），一旦覆盖原始字节无版本可恢复。
 *  判据用「盘上字节是否合法 UTF-8」（fatal 解码探测）而非「盘上是否已含 U+FFFD」：
 *  GBK 文件以 utf-8 读入本就产生 U+FFFD，后者会把最该拦的场景判成放行。盘上为合法
 *  UTF-8（含作者真实键入的 � 字符）时不受影响——那是普通编辑，无字节可毁。 */
export function isUtf8Bytes(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

const NON_UTF8_SAVE_REJECT = {
  ok: false as const,
  code: 'WRITE_ERROR' as const,
  reason: '目标文件不是合法 UTF-8（可能是编辑器以错误编码打开本文件，或外部工具写入了 GBK 等编码）：为防原始内容被乱码覆盖后不可恢复，已拒绝保存——请先将文件转为 UTF-8 再编辑',
}

/** R76-1（二十四轮）：元数据 PATCH 双路径（updateChapterMeta/updateDocMeta）的跨进程
 *  保存锁等待（毫秒）——与 executeSave 的 5s 同档；测试注入缩短保快（生产零调用），
 *  同 draft-pipeline DRAFT_SAVE_LOCK_TIMEOUT_MS 惯例。
 *  R30-18（三十轮）：常量化——export let 可被任一 import 方静默改写（同 events/store.ts
 *  R26-105 的收口认定），改 const + 内部可变生效值；测试只能经注入钩子改档，生产恒用常量。 */
export const META_SAVE_LOCK_TIMEOUT_MS = 5_000

/** 生效值（模块内可变）：初值 = 常量；仅注入钩子可改。 */
let metaSaveLockTimeoutMs = META_SAVE_LOCK_TIMEOUT_MS

/** 测试注入钩子（生产零调用）。 */
export function __setMetaSaveLockTimeoutForTest(ms: number): void {
  metaSaveLockTimeoutMs = ms
}

/** R29-7（二十九轮）：布线文件写路径的第二道跨进程锁（`<布线文件绝对路径>.lock`，
 *  与 lead-finalize.ts applyLeadUpdates 同名锁）等待档（毫秒）——与 save 锁的 5s
 *  同档（测试注入缩短保快，生产零调用）。
 *  R30-18（三十轮）：常量化——同 META_SAVE_LOCK_TIMEOUT_MS 的收口口径。 */
export const WIRING_SAVE_LOCK_TIMEOUT_MS = 5_000

/** 生效值（模块内可变）：初值 = 常量；仅注入钩子可改。 */
let wiringSaveLockTimeoutMs = WIRING_SAVE_LOCK_TIMEOUT_MS

/** 测试注入钩子（生产零调用）。 */
export function __setWiringSaveLockTimeoutForTest(ms: number): void {
  wiringSaveLockTimeoutMs = ms
}

/** 保存输入（W0-1 §5.1）。 */
export interface SaveDocumentInput {
  content: string
  /** 期望基线 revision；null = 新建（撞已有文件 → 冲突）。 */
  expectedRevision: Revision
  /** 幂等去重 id。 */
  operationId: string
  origin: 'manual' | 'autosave' | 'restore' | 'external-merge'
  reason?: string
}

export type SaveResult =
  | { ok: true; revision: `sha256:${string}` }
  | {
      ok: false
      code: 'REVISION_CONFLICT' | 'PATH_ESCAPE' | 'CAPABILITY_DENIED' | 'WRITE_ERROR'
      reason: string
    }

/** 保存出队结果（含旧响应标记）。联合分配：保留 ok 判别标签，可正常 narrow。 */
export type SaveOutcome = SaveResult & { superseded: boolean }

/** 崩溃恢复报告：docId → 未结算的 pending 列表（保存类含全文快照 / 移动类含新旧路径）。 */
export interface UnsettledReport {
  docId: string
  pending: JournalAnyPending[]
}

/** 新建文档输入（W2A §7）。 */
export interface CreateDocumentInput {
  /** 目标相对路径（含 .md 后缀）。 */
  relPath: string
  /** 初始内容；缺省生成最小 frontmatter。 */
  content?: string
}

/** 新建结果。 */
export type CreateResult =
  | { ok: true; docId: string; path: string; revision: `sha256:${string}` }
  | { ok: false; code: 'PATH_ESCAPE' | 'CAPABILITY_DENIED' | 'ALREADY_EXISTS' | 'WRITE_ERROR'; reason: string }

/** 复制文档输入（E3.3）。relPath 由前端算好章号 +「副本」标题；后端复制源内容到该 path。 */
export interface CopyDocumentInput {
  /** 源文档 docId（须在清单登记）。 */
  docId: string
  /** 目标相对路径（含 .md 后缀）。 */
  relPath: string
}

/** 复制结果（结构同 CreateResult，错误码多 NOT_FOUND：源未登记或文件缺失）。 */
export type CopyResult =
  | { ok: true; docId: string; path: string; revision: `sha256:${string}` }
  | { ok: false; code: 'PATH_ESCAPE' | 'CAPABILITY_DENIED' | 'NOT_FOUND' | 'ALREADY_EXISTS' | 'WRITE_ERROR'; reason: string }

/** 移动文档输入（章号不变，文件名保持——§11）。 */
export interface MoveDocumentInput {
  docId: string
  /** 目标目录（相对 bookRoot，无尾斜杠）。 */
  toDir: string
}

/** 重命名文档输入。 */
export interface RenameDocumentInput {
  docId: string
  /** 新文件名（含 .md 后缀）。 */
  newName: string
}

/** 移动/重命名结果。 */
export type MoveResult =
  | { ok: true; docId: string; path: string }
  | {
      ok: false
      code: 'PATH_ESCAPE' | 'CAPABILITY_DENIED' | 'NOT_FOUND' | 'ALREADY_EXISTS' | 'WRITE_ERROR' | 'BAD_INPUT'
      reason: string
    }

/** R66-5（十四轮）：move 目标目录归一——拒绝前导 '/'（绝对路径逃逸）与归一后为空
 *  （根目录/纯斜杠），折叠连续斜杠、剥全部尾斜杠；'a/b/'、'a/b//'、'a//b' 归一到
 *  同一键 'a/b'，防畸形 toDir 直拼进 manifest 造成目录身份分裂。返回 null = 非法。
 *  R71-23（十九轮）：'\' 归一在前——win32 path.resolve 视 '\' 为分隔符，含反斜杠的
 *  toDir 会被 resolveSafePath 放行并真实建目录，但混合分隔符串直拼进 manifest 后，
 *  posix 口径的树扫描/前端全链 miss（docId 身份分裂 + 保存恒 REVISION_CONFLICT，
 *  R66-5 同族后果）；先归一再按 '/' 口径统一校验，'\\server\\x' 伪 UNC 也被前导斜杠拒绝。 */
function normalizeMoveToDir(toDir: string): string | null {
  const normalized = toDir.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  if (normalized.startsWith('/') || normalized === '') return null
  return normalized
}

/** 软删结果。 */
export type TrashResult =
  | { ok: true; docId: string; trashedPath: string }
  | { ok: false; code: 'PATH_ESCAPE' | 'CAPABILITY_DENIED' | 'NOT_FOUND' | 'WRITE_ERROR'; reason: string }

export interface DocumentServiceOptions {
  bookRoot: string
  /** APP 级数据目录（Electron userData）：写时清理读 global.json 全局保留策略（版本保留三层链）。 */
  userDataPath?: string | null
  /** 注入队列（测试桩）；默认新建 per-docId 串行队列。 */
  queue?: SaveQueue<SaveResult>
}

/** 文档保存服务（绑定 bookRoot）。 */
export class DocumentService {
  private readonly bookRoot: string
  private readonly userDataPath: string | null
  private readonly queue: SaveQueue<SaveResult>
  private readonly journalDir: string
  private readonly snapshotsDir: string
  private readonly manifestPath: string

  constructor(opts: DocumentServiceOptions) {
    this.bookRoot = opts.bookRoot
    this.userDataPath = opts.userDataPath ?? null
    this.queue = opts.queue ?? new SaveQueue<SaveResult>()
    this.journalDir = join(this.bookRoot, '工作区', '.journal')
    this.snapshotsDir = join(this.bookRoot, '工作区', '.版本')
    this.manifestPath = join(this.bookRoot, '项目', '文档清单.jsonl')
  }

  /** 保存文档（W0-1 §5.2）。docId 稳定 ID，relPath 书仓库相对路径。 */
  save(docId: string, relPath: string, input: SaveDocumentInput): Promise<SaveOutcome> {
    // 预校验（入队前，不依赖并发状态）
    const safe = this.resolveSafePath(relPath)
    if (!safe) {
      return Promise.resolve({ ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库', superseded: false })
    }
    if (!layoutOf(relPath).capabilities.write) {
      return Promise.resolve({
        ok: false,
        code: 'CAPABILITY_DENIED',
        reason: '该文档只读，不可保存',
        superseded: false,
      })
    }
    return this.queue
      .enqueue({ docId, run: () => this.executeSave(docId, relPath, safe, input) })
      .then((qr) => ({ ...qr.result, superseded: qr.superseded }))
  }

  /** docId → relPath（含 legacy 兜底：旧文件首次访问时扫盘反查并补登记清单，
   *  stable-id.ts「首次结构性操作时落盘」）。未登记且非 legacy / 无匹配 → null。 */
  resolvePath(docId: string): string | null {
    return this.lookupPathByDocId(docId)
  }

  /** 在途/排队中的保存任务数（跨全部 docId；删书/改名前 drain 探询用，第五轮）。 */
  inFlightSaves(): number {
    return this.queue.inFlight()
  }

  /** 启动扫 journal，报 pending 无 settled/aborted（崩溃未结算）。 */
  recover(): UnsettledReport[] {
    if (!existsSync(this.journalDir)) return []
    const out: UnsettledReport[] = []
    for (const name of readdirSync(this.journalDir)) {
      if (name.startsWith('._') || !name.endsWith('.jsonl')) continue
      // R68-3：写侧已改编码文件名（win legacy 冒号防线）——此处反解回真实 docId
      //（mac 存量字面名原样通过，decodeDocDirName 幂等）。
      const docId = decodeDocDirName(name.slice(0, -'.jsonl'.length))
      const pending = findUnsettled(join(this.journalDir, name))
      if (pending.length > 0) out.push({ docId, pending })
    }
    return out
  }

  // ── 串行执行体（§5.2 步骤 4-11，队列内调用）─────────

  // R30-6（三十轮）：本保存链上的全部锁等待已异步化（save 锁 / 布线锁 /
  // 清单锁均走 setTimeout 轮询原语 acquireCrossProcessLockAsync / withManifestLockAsync），
  // 事件循环不被阻塞——服务进程承载 SSE/全部接口，双进程争用窗口（最坏 5s+5s+2×5s 档）
  // 内不再出现可感知冻结；读改写/落盘本身仍为同步 FS 调用（毫秒级，无妨）。
  // 队列串行语义核实：SaveQueue.pump 以 run 的 promise 决议驱动下一项（queue.ts），
  // executeSave await 化不改变 per-docId 串行保证。
  // R30-5（三十轮）锁序：save 锁 → 布线锁 → 清单锁（全仓统一，含 finalize 链——
  // 定稿入口已改为进清单锁前预取布线锁，save↔finalize 的 ABBA 交叉对已消除）。
  private async executeSave(
    docId: string,
    relPath: string,
    absPath: string,
    input: SaveDocumentInput,
  ): Promise<SaveResult> {
    // P1-SEC-A：journal 路径含 docId，显式校验防穿越（与 version.ts/analysis.ts 对齐）
    if (!safeDocId(docId)) return Promise.resolve({ ok: false, code: 'PATH_ESCAPE', reason: '文档 ID 非法' })
    // R68-3（十六轮）：文件名编码（`:`→`_`）——legacy docId 的字面名在 win 上非法
    // （EINVAL/NTFS ADS），appendPending 记不上 = 保存链路永久 WRITE_ERROR。读侧
    // recover() 反解见 decodeDocDirName。
    const journalPath = join(this.journalDir, `${encodeDocDirName(docId)}.jsonl`)

    // V-P2-1：结构性操作（rename/move/trash）同步执行、不排队，与入队 save 存在竞态窗口——
    // 新建档（expectedRevision=null）的排队 save 若在移动/删除后出队，会在旧路径复活
    // 已移走/已删文件（trash 场景绕过回收站）。出队时按清单核对保存目标仍是该 docId
    // 的登记路径；已删（清单除名 + 回收站在案）同样拒绝。REVISION_CONFLICT 语义 =
    // 「世界已变，请刷新重试」，前端既有冲突处理会重新同步路径。
    // R27-43（二十七轮）：前段收编——lookupPathByDocId 的 legacy 收编链（adoptLegacyDoc
    // → upsertManifestEntry → withManifestLock 超时 throw）此前在契约 try 之外裸穿：
    // queue reject → save() 变 rejected promise / API 500（manifest.ts 注释宣称的
    // 「executeSave 内 catch → WRITE_ERROR」对前段不实）。现同款收编为 SaveResult。
    let registered: string | null
    try {
      registered = this.lookupPathByDocId(docId)
    } catch (e) {
      return Promise.resolve({
        ok: false,
        code: 'WRITE_ERROR',
        reason: `保存前清单查询失败（未执行保存，可重试）：${e instanceof Error ? e.message : String(e)}`,
      })
    }
    if (registered !== null && registered !== relPath) {
      return Promise.resolve({
        ok: false,
        code: 'REVISION_CONFLICT',
        reason: `文档已移动或重命名（现路径 ${registered}），本次保存目标 ${relPath} 已失效，请刷新后重试`,
      })
    }
    // Z-6（第五十八轮）：双条件复活守卫——doTrash 尾段（rename 后清单删除前）崩溃/写失败
    // 会残留指向旧路径的清单条目，旧判定「registered === null 才查回收站」被残留绕过
    //（expectedRevision=null 的保存按「文件不存在=新建」通过基线校验 → 旧路径复活已删文件，
    // 且随后 restoreTrash 报 OCCUPIED 还原受阻）。改为：回收站认领该 docId 且
    //（未登记 或 目标文件不在盘）即拒。
    if (readTrashManifest(this.bookRoot).some((t) => t.id === docId) && (registered === null || !existsSync(absPath))) {
      return Promise.resolve({
        ok: false,
        code: 'REVISION_CONFLICT',
        reason: '文档已删除（在回收站中），拒绝在原路径复活文件；如需恢复请从回收站还原',
      })
    }

    // R72-1（二十轮 B-1）：保存临界段跨进程锁——per-docId 串行队列只防进程内并发；
    // 本仓把「CLI 与 GUI 双进程同书」当支持场景（manifest/journal/analysis/task-gate
    // 四套跨进程锁皆为此而建），唯独「revision 校验 → atomicWrite → settled」正文写段
    // 原先不在任何跨进程锁内：journal append 自身的 `<journal>.lock`（N4/J7）只串行化
    // pending 行写入，护不住「校验通过 → 文件落盘」窗口——双进程各持相同 expectedRevision
    // 并发保存时双双通过校验、后写者静默覆盖先写者（lost update）。现套 per-doc 保存锁，
    // 路径 `<journal>.save.lock` 与 journal 锁同目录不同名（锁基建禁同进程嵌套同路径锁，
    // appendPending 在锁内会再拿 `<journal>.lock`，构成单向嵌套 save→journal；compact
    // 只持 journal 锁，无反向环，无死锁）。拿不到锁（他进程在写且 5s 未让出）按
    // WRITE_ERROR 拒绝——保存未执行、无数据损伤、调用方可重试，不做降级裸写（裸写
    // 正是本锁要闭合的丢更新形态）。同进程同 docId 由 queue 串行保证不会自锁
    // （appendPending 嵌套拿的是另一路径的 journal 锁）。
    // R30-6：取锁等待异步化（setTimeout 轮询），事件循环不阻塞；超时档与 fail-closed
    // 语义不变。
    const docSaveLock = await acquireCrossProcessLockAsync(`${journalPath}.save.lock`, 5_000)
    if (!docSaveLock) {
      return Promise.resolve({
        ok: false,
        code: 'WRITE_ERROR',
        reason: '保存等待超时：另一进程正在保存此文档（5 秒未让出），请重试',
      })
    }
    // R29-7（二十九轮）：布线文件在 save 锁内再取同名文件锁（`<布线文件绝对路径>.lock`，
    // 与 lead-finalize 回写临界段互斥）——超时按 WRITE_ERROR 拒绝保存（fail-closed 不降级
    // 裸写：裸写正是本锁要闭合的覆盖形态）；获取自身抛出（权限等）同样拒绝并先释放
    // save 锁防泄漏。非布线文件 wiringLock 为 null，零开销。
    // R30-5（三十轮）锁序注释如实化：本侧顺序为 save 锁 → 布线锁 → 清单锁（maybeUpdate
    // Manifest）。lead-finalize/finalize 侧经 R30-5 已统一为「布线锁 → 清单锁」（定稿在进
    // 清单锁前预取布线锁）——旧序「定稿持清单锁内再取布线锁」与保存链的 ABBA 交叉对
    // 已消除，双侧注释旧称「单向无环」只覆盖各自侧序、未覆盖交叉对的缺口由本轮收口。
    // R30-6：等待异步化。
    const wiringKey = this.wiringFileLockKey(relPath)
    let wiringLock: (() => void) | null = null
    if (wiringKey) {
      try {
        wiringLock = await acquireCrossProcessLockAsync(wiringKey, wiringSaveLockTimeoutMs)
      } catch (e) {
        docSaveLock()
        return Promise.resolve({
          ok: false,
          code: 'WRITE_ERROR',
          reason: `布线文件锁获取失败（未执行保存，可重试）：${e instanceof Error ? e.message : String(e)}`,
        })
      }
      if (!wiringLock) {
        docSaveLock()
        return Promise.resolve({
          ok: false,
          code: 'WRITE_ERROR',
          reason: '保存等待超时：另一进程正在回写此布线文件（5 秒未让出），请重试',
        })
      }
    }
    try {
      // R76-22（二十四轮 C 域）：锁内复核——路径登记/回收站认领守卫原先只在取锁前判
      // 一次，5s 等锁窗口内他进程 doTrash/doMoveOrRename 后，出队保存仍按旧世界落盘
      //（旧路径复活已删文件/写错位，内容重复非丢失、低危）。取锁后重判把窗口收窄到
      // 复核→写盘的毫秒级；结构性操作不持 save 锁，残余窗口如实记档。
      // R31-19（三十一轮）：legacy 收编链改走异步清单锁孪生（R30-6 全异步化口径的
      // 残留收口——非 legacy docId 行为不变，仅清单命中读）
      const registeredNow = await this.lookupPathByDocIdAdoptAsync(docId)
      if (registeredNow !== null && registeredNow !== relPath) {
        return Promise.resolve({
          ok: false,
          code: 'REVISION_CONFLICT',
          reason: `文档已移动或重命名（现路径 ${registeredNow}），本次保存目标 ${relPath} 已失效，请刷新后重试`,
        })
      }
      if (
        readTrashManifest(this.bookRoot).some((t) => t.id === docId) &&
        (registeredNow === null || !existsSync(absPath))
      ) {
        return Promise.resolve({
          ok: false,
          code: 'REVISION_CONFLICT',
          reason: '文档已删除（在回收站中），拒绝在原路径复活文件；如需恢复请从回收站还原',
        })
      }
      // 步骤 2：revision 校验（串行内执行，保证并发一致）
      const existing = existsSync(absPath)
      const currentRev: Revision = existing ? computeRevision(absPath) : null
      if (input.expectedRevision !== currentRev) {
        const reason = existing
          ? `基线不符（期望 ${input.expectedRevision ?? 'null'}，磁盘 ${currentRev}）`
          : `期望基线 ${input.expectedRevision} 但文件不存在`
        return Promise.resolve({ ok: false, code: 'REVISION_CONFLICT', reason })
      }

      // M-5（第六轮）：非 UTF-8 覆写防线（save 主路径含 autosave）——新内容含 U+FFFD 且
      // 盘上字节不是合法 UTF-8（fatal 解码探测）时拒绝：GBK 文件被错误编码打开后 autosave
      // 把乱码原子覆盖回原文件，设定/大纲等非 chapter 文档无快照兜底（maybeSnapshot 只留
      // 底章），原始字节永久丢失。盘上为合法 UTF-8 时放行（含真实 � 字符的普通编辑）。
      // R75-3（二十三轮）：条件缺口收口——原仅拦「新内容含 U+FFFD 且盘上非 UTF-8」，
      // 新内容干净时静默放行覆写，而 maybeSnapshot 以 utf-8 读盘留底的是失真快照（假
      // 留底，覆写后原字节任何形式不可恢复）。对齐 draft-pipeline R66-1 / lead-finalize
      // M-9 的无条件口径：盘上非 UTF-8 一律拒绝，先转码再保存。
      if (existing && !isUtf8Bytes(readFileSync(absPath))) {
        return Promise.resolve(NON_UTF8_SAVE_REJECT)
      }

      // 步骤 4：journal pending（含全文快照，防丢字）
      // RB-KN-P2-2：pending 记不上就不能继续写（无 journal 兜底的落盘违反崩溃恢复协议），
      // 且失败须走 SaveResult 契约（原在此处直接抛出，save() 变 rejected promise，调用方易 unhandled rejection）
      let opId: string
      try {
        opId = await appendPending(journalPath, docId, currentRev, input.content)
      } catch (e) {
        return Promise.resolve({
          ok: false,
          code: 'WRITE_ERROR',
          reason: `journal 追加失败，保存未执行：${e instanceof Error ? e.message : String(e)}`,
        })
      }

      try {
        // P2-BE-1：wordDelta 计算移入 try——readFileSync 失败时 journal 标 aborted（而非孤儿 pending 误报崩溃）
        // 步骤 4.5：算字数 delta（E4）——须在 atomicWrite 前读旧内容；strip fm 口径（与前端 updateWordCount 一致）
        const wordDelta =
          countWords(bodyOf(input.content)) -
          countWords(existing ? bodyOf(readFileSync(absPath, 'utf-8')) : '')

        // 步骤 5：按策略建 snapshot（修改前版本留底）
        this.maybeSnapshot(docId, relPath, absPath, input, currentRev)
        // 步骤 6-7：atomic write + fsync + rename + fsync 父目录
        // R26-49（二十六轮）：新建路径（expectedRevision=null）不再裸 rename——基线校验
        // （文件不存在）与落盘之间无互斥，他进程并发新建同名文件时 atomicWriteFile 的
        // rename 会静默覆盖先到者内容且本方返回成功（lost update）。改 createFileExclusive
        // 独占创建（link 不覆盖，R26-7 起自带非 NTFS 卷 rename 降级）：'exists' = 落位时
        // 目标已被并发创建，按既有 REVISION_CONFLICT 口径拒绝（「世界已变，请刷新重试」，
        // 同 V-P2-1 出队守卫的语义，不新增错误码），journal pending 补 aborted 后返回。
        if (existing) {
          atomicWriteFile(absPath, input.content, { fsync: true })
        } else {
          const created = createFileExclusive(absPath, input.content, { fsync: true })
          if (created === 'exists') {
            try {
              await appendAborted(journalPath, opId, '新建落位时目标已被并发创建（REVISION_CONFLICT）')
            } catch {
              // journal 留痕失败吞掉（best-effort）：必须保住 {ok:false} 契约
            }
            return Promise.resolve({
              ok: false,
              code: 'REVISION_CONFLICT',
              reason: `预期新建，但落位时 ${relPath} 已被并发创建（另一进程先到）——请刷新后基于最新内容重试`,
            })
          }
        }
        // 步骤 8：新 revision
        const newRev = computeRevision(absPath)
        // 步骤 9：条件性更新清单（书已有清单才更新；保存不建清单，W0-1 §4.2）
        // R75-4（二十三轮）：清单刷新转 best-effort——此时文件已原子落盘，清单只是可
        // 重建索引（树扫盘/repairBooks 自愈收编）；此前它抛（清单锁超时/磁盘满）会落
        // 进下方 catch：journal 误记 aborted + 返回 WRITE_ERROR——保存实际成功却报失
        // 败（编辑器误报、重试撞 REVISION_CONFLICT）。对齐 appendWordsDelta 的 P2-BE-4
        // 口径：warn 留痕后照常 settled + 返回成功。
        try {
          // R30-6：清单锁等待异步化（withManifestLockAsync）
          await this.maybeUpdateManifest(docId, relPath)
        } catch (e) {
          log.warn('document', `保存后清单刷新失败（${relPath}，树扫描将自愈收编）：${e instanceof Error ? e.message : String(e)}`)
        }
        // 步骤 10：journal settled。
        // R27-44（二十七轮）：settled 失败不误报——此刻正文已原子落盘、清单已刷新，
        // 原裸调用落入下方 catch 会返回 WRITE_ERROR（编辑器误报失败、重试必撞
        // REVISION_CONFLICT，journal 悬置 pending 误报 crashedWrite），与 R75-4 对清单
        // 刷新的定性完全同型。改 best-effort：warn 留痕 + 按成功收口。
        try {
          await appendSettled(journalPath, opId, newRev)
        } catch (e) {
          log.warn('document', `保存已落盘但 journal settled 写失败（${docId}，恢复链下次启动将按 pending 自愈复核）：${e instanceof Error ? e.message : String(e)}`)
        }
        // P2-BE-4：字数增量 best-effort（settled 后失败不影响保存结果——否则文件已落盘但返回 WRITE_ERROR 误报失败）
        try {
          appendWordsDelta(this.bookRoot, todayDate(), wordDelta, docId)
        } catch {
          // 磁盘满等忽略——保存已成功，字数日记丢失可接受
        }
        // 步骤 11
        return Promise.resolve({ ok: true, revision: newRev })
      } catch (e) {
        // 失败：journal 标 aborted（atomicWriteFile 失败已自清 tmp，未落盘）
        try {
          await appendAborted(journalPath, opId, e instanceof Error ? e.message : String(e))
        } catch {
          // journal 写失败忽略（best-effort，不影响返回）
        }
        return Promise.resolve({
          ok: false,
          code: 'WRITE_ERROR',
          reason: `保存失败：${e instanceof Error ? e.message : String(e)}`,
        })
      }
    } catch (e) {
      // R28-5（二十八轮）：锁内段裸穿收编——R27-43（:279-287）只收编了取锁**前段**的
      // 同款 lookupPathByDocId（注释自称「前段」），锁内段漏修：临界段内 :333
      // lookupPathByDocId（legacy 收编链 adoptLegacyDoc → upsertManifestEntry →
      // withManifestLock 2×5s 超时 throw，manifest.ts 锁尾 fail-closed）、:353
      // computeRevision、:369 readFileSync（win 杀软 EBUSY/EACCES）任一抛出都裸穿
      // 本 try/finally → SaveQueue reject → save() 变 rejected promise / API 500，
      // 与 manifest.ts RMW 段注释宣称的「executeSave 内 catch → WRITE_ERROR」不符
      //（manifest.ts 本轮文件互斥不动，对齐点以其宣称口径为准，由本 catch 兑现）。
      // 外层 catch 只兜 appendPending **之前**落盘前同步段的意外抛出：此刻尚未写
      // journal pending（无 opId，无孤儿可标 aborted），保存未执行、无数据损伤；
      // appendPending 之后的失败各有专属内层 catch 契约（journal 追加 :379、落盘段
      // :451），全部显式 return 不会流入本 catch，落盘成功后的失败语义原样保留。
      return Promise.resolve({
        ok: false,
        code: 'WRITE_ERROR',
        reason: `保存失败（未落盘，可重试）：${e instanceof Error ? e.message : String(e)}`,
      })
    } finally {
      // R29-7：布线文件锁先于 save 锁释放（逆获取序），release 幂等
      if (wiringLock) wiringLock()
      docSaveLock()
    }
  }

  /** snapshot 策略（W0-1 §7）：restore/external-merge 覆盖前、定稿章首改前留底。
   *  保存前留底走节流（policy.throttleMinutes），结构性操作（改名/删除）不节流。 */
  private maybeSnapshot(
    docId: string,
    relPath: string,
    absPath: string,
    input: SaveDocumentInput,
    baseRevision: Revision,
    diskContent?: string,
  ): void {
    let reason: string | undefined
    if (input.origin === 'restore' || input.origin === 'external-merge') {
      reason = `${input.origin} 覆盖前留底`
    } else if (existsSync(absPath) && input.expectedRevision !== null) {
      // R76-2（二十四轮 C 域）：非章节文档补留底——README 宣称「保存前自动留快照」，
      // 此前仅章节（+restore/merge 覆盖）留底，设定/大纲/布线/关系线的普通保存零快照：
      // journal pending 只含新内容，settled+compact 后旧内容零副本，误存/外部删除无底
      // 可回。非章节与章节同口径：同 origin 节流（5 分钟窗）+ 分层保留 + maxCount/maxDays
      // 策略约束磁盘增量（高频 autosave 至多 5 分钟一版、每文档封顶 maxCount）。
      reason = layoutOf(relPath).role === 'chapter' ? '定稿章修改前留底（§6）' : '修改前留底（R76-2）'
    }
    if (!reason) return
    // P5-数据层（第七轮）：restore/external-merge 到尚不存在的文件（expectedRevision=null
    // 过基线校验）→ 无底可留，跳过快照正常新建落盘——原 readFileSync ENOENT 抛走
    // WRITE_ERROR，本可成功的恢复被拒
    if (!existsSync(absPath)) return
    // snapshot = 修改前的当前磁盘内容（R33D-18：调用方已整读时透传，免二次读盘）
    const currentContent = diskContent !== undefined ? diskContent : readFileSync(absPath, 'utf-8')
    // restore/external-merge 是"真要反悔"的时刻，必留；autosave 走节流
    const force = input.origin === 'restore' || input.origin === 'external-merge'
    writeSnapshot(
      this.snapshotsDir,
      docId,
      currentContent,
      { origin: input.origin, reason, baseRevision },
      { policy: this.snapshotPolicy(), force },
    )
  }

  /** 快照保留策略（2026-08-19 起只走全局）：global.json snapMax* → 硬编码默认；book.yaml snapshots 已砍书级。
   *  R30-20（三十轮）：global.json 解析结果走 stat 缓存——每次 save 都 existsSync+readFileSync
   *  改为 statSync 一次（stat 远廉价于读盘，与 version.ts 指纹缓存同款「缓存命中免读盘」口径）。
   *  失效条件：global.json 的 mtimeMs（取整毫秒）或 size 任一变化即重读重解析——作者手工
   *  编辑 global.json 后**下一次 save 即生效**（无需重启）；stat 失败（文件不存在/不可读）
   *  不缓存负条目，直接回落空策略；进程重启缓存自然失效（实例字段）。 */
  private globalPolicyCache: { statKey: string; value: { maxDays?: number; maxCount?: number } } | null = null

  /** R30-20：global.json 的 stat 键控缓存读取（见 snapshotPolicy 注释）。 */
  private readGlobalPolicyCached(): { maxDays?: number; maxCount?: number } {
    if (!this.userDataPath) return {}
    const p = join(this.userDataPath, 'global.json')
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(p)
    } catch {
      return {}
    }
    const statKey = `${Math.floor(st.mtimeMs)}:${st.size}`
    if (this.globalPolicyCache?.statKey === statKey) return this.globalPolicyCache.value
    const value = readGlobalSnapshotPolicy(this.userDataPath)
    this.globalPolicyCache = { statKey, value }
    return value
  }

  private snapshotPolicy(): SnapshotPolicy {
    const global = this.readGlobalPolicyCached()
    return {
      maxDays: global.maxDays ?? DEFAULT_SNAPSHOT_POLICY.maxDays,
      maxCount: global.maxCount ?? DEFAULT_SNAPSHOT_POLICY.maxCount,
      throttleMinutes: DEFAULT_SNAPSHOT_POLICY.throttleMinutes,
    }
  }

  /** 条件性更新清单：书已有清单 + 条目已存在 → 刷新 path；否则 no-op（保存不建清单）。
   *  X-5：RMW 全程持清单锁（跨进程互斥）。
   *  R30-6：锁等待异步化（withManifestLockAsync）——读改写文件操作本身仍是同步 FS
   *  调用（毫秒级无妨），仅锁争用等待期不阻塞事件循环；超时档与 fail-closed 语义不变。 */
  private async maybeUpdateManifest(docId: string, relPath: string): Promise<void> {
    if (!existsSync(this.manifestPath)) return
    await withManifestLockAsync(this.manifestPath, () => {
      const m = readManifestStrict(this.manifestPath) // R27-40：RMW strict 读——读失败拒写保旧清单
      const entry = m.entries.get(docId)
      if (!entry || entry.path === relPath) return
      entry.path = relPath
      writeManifest(this.manifestPath, m)
    })
  }

  /** 路径安全：批 6 统一委托 resolveWithinRoot（symlink 防越出 + fail-closed，
   *  目标存在时返回 realpath；此前本方法为各变体中语义最全的一份，canonical 即取自它）。
   *  R27-42（二十七轮）：realpath 反查内部簿记（仅跳板形态）——capabilitiesOf 只按
   *  **词法** relPath fail-closed 内部路径（layout.ts P-1），书内 symlink（如
   *  设定/x.md → 项目/book.yaml）使能力判定按词法放行、落写却命中 realpath 的系统
   *  文件。判定限定「词法非内部 && realpath 内部」的跳板形态：词法内部路径（doTrash
   *  的 .trash 落点等合法内部用法）仍放行交能力层拒绝，错误码口径不变。仅覆盖
   *  「目标已存在」面（resolveWithinRoot 对存在目标才 realpath）；不存在目标的中间
   *  目录 symlink 窗口是 Y-5 已认账取舍，不在此扩面。 */
  private resolveSafePath(relPath: string): string | null {
    const safe = resolveWithinRoot(this.bookRoot, relPath)
    if (!safe) return null
    const lexical = relPath.replace(/\\/g, '/')
    if (!isInternalBookPath(lexical) && isInternalBookPath(safe.rel)) return null
    return safe.abs
  }

  /** R29-7（二十九轮）：布线线索文件的跨进程文件锁键（非布线文件 → null 不加锁）。
   *  背景：lead-finalize.ts 对单个布线文件的「读旧→补履历→writeLead」临界段持
   *  `<文件绝对路径>.lock`，与本服务按 journal 命名的 save 锁互不感知——R26-6 注释宣称
   *  防住了「作者经 executeSave 保存同一布线文件」，实际没防住（lost update：保存的新正文
   *  被回写的旧正文整文件覆盖）。本服务三个写路径（executeSave/updateChapterMeta/
   *  updateDocMeta）在 save 锁内对本文件再取**同名锁**，双侧同名锁互斥后覆盖窗口真正
   *  闭合。键必须与 lead-finalize 同构造（join(bookRoot, relPath) 词法路径，不经
   *  realpath）——resolveSafePath 对存在目标返回 realpath，在 symlink 根（macOS tmp
   *  /var→/private/var）下会拼出不同键名使互斥失效。关系线按 lead-finalize 同口径位于
   *  大纲/关系线/（同为布线族回写点），一并覆盖。
   *  R30-5（三十轮）锁序：全仓统一「save 锁 → 布线锁 → 清单锁」——定稿链原
   *  「持清单锁内取布线锁」的反向交叉对已由 finalize 入口预取布线锁消除。 */
  private wiringFileLockKey(relPath: string): string | null {
    const p = relPath.replace(/\\/g, '/')
    if (p.startsWith('布线/') || p.startsWith('大纲/关系线/')) {
      return `${join(this.bookRoot, relPath)}.lock`
    }
    return null
  }

  // ── 结构性操作（W2A §7，同步实现）──────────────────

  /** 新建文档（分配 docId + 落盘 + 清单登记 + invalidate）。 */
  createDocument(input: CreateDocumentInput): Promise<CreateResult> {
    return Promise.resolve(this.doCreate(input))
  }

  private doCreate(input: CreateDocumentInput): CreateResult {
    // R26-55（二十六轮）：relPath 逐段过 sanitizeFileNamePart（format/filename.ts 单一
    // 真相源）——win 保留设备名（CON.md 等）拷至 Windows 被拒、尾点/尾空格 win 落盘被
    // 自动剖（读写名不一致），非法字符直落盘时炸或产生跨平台歧义名。先消毒再走既有
    // 校验链（resolveSafePath 的越界/symlink 防线对消毒后路径照常生效），登记与返回
    // path 一律用消毒后路径（落盘真实路径是唯一身份）。文件段带 .md 扩展名时只消毒
    // 标题段再拼回扩展名——截断预算不吞扩展名（sanitizeFileNamePart 的码位/字节封顶
    // 是整段预算，扩段整段消毒会把长标题的 .md 截掉）。
    // 主评审核销修正：消毒前先对**原始 relPath** 做越界校验——`../etc/passwd` 这类
    // 穿越路径若先消毒（`..` 段被洗成普通名）就永远到不了 PATH_ESCAPE，越界防线
    // 被消毒静默吞掉（service-struct PATH_ESCAPE 用例锁定的安全契约）。口径：原始
    // 路径必须先在书仓库内（穿越/绝对路径拒绝），消毒只放宽「名字合法化」不放宽
    // 「位置合法化」，消毒后再校验一次兜底消毒引入的意外形态。
    if (!this.resolveSafePath(input.relPath)) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
    const rel = input.relPath
      .split('/')
      .map((seg) => sanitizeCreateSegment(seg))
      .join('/')
    const safe = this.resolveSafePath(rel)
    if (!safe) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
    if (existsSync(safe)) return { ok: false, code: 'ALREADY_EXISTS', reason: '文件已存在' }
    if (!layoutOf(rel).capabilities.write) {
      return { ok: false, code: 'CAPABILITY_DENIED', reason: '该位置只读，不可新建' }
    }
    const docId = generateDocId()
    const content = input.content ?? this.defaultContent()
    try {
      mkdirSync(dirname(safe), { recursive: true })
      // B-6（第六十轮）：tmp + linkSync 独占创建——上方 existsSync 与落盘之间无跨进程
      // 互斥，双进程同 relPath 并发新建时 atomicWriteFile 的 rename 静默覆盖后到者
      // 内容且双方返回成功（两个 docId 先后 upsert 成同路径双认领态）；link 遇
      // EEXIST → ALREADY_EXISTS，双方各自明确
      const created = createFileExclusive(safe, content, { fsync: true })
      if (created === 'exists') return { ok: false, code: 'ALREADY_EXISTS', reason: '文件已存在' }
    } catch (e) {
      return { ok: false, code: 'WRITE_ERROR', reason: `新建失败：${errMsg(e)}` }
    }
    // 结构性操作触发建清单（W0-1 §4.2）：无清单则建，加 entry
    // R70-17（十八轮）：登记收编——文件已落盘后登记抛（磁盘满/权限）此前裸穿破坏
    // CreateResult 契约且调用方误判完全失败（重试撞 ALREADY_EXISTS）；半成品态由树
    // legacyId 首次结构性操作 adoptLegacyDoc 自愈，warn 留痕即可（ee-P1-5 同型漏网点）
    // R31-24（三十一轮）：登记失败时降级返回 legacyId(rel)——树扫描自愈产物是
    // legacy:<hash>，返回原 doc_xxx 会让前端持有的身份与磁盘自愈身份分裂
    //（.版本/journal 以旧 id 孤儿化，历史面板失联）；与自愈同 id 即身份连续。
    let registeredDocId = docId
    try {
      this.upsertManifestEntry(docId, rel)
    } catch (e) {
      registeredDocId = legacyId(rel)
      log.warn('document', `新建后清单登记失败（${rel}，降级返回 legacy id 与树扫描自愈同源）：${errMsg(e)}`)
    }
    invalidateTreeIndex(this.bookRoot, true)
    return { ok: true, docId: registeredDocId, path: rel, revision: computeRevision(safe) }
  }

  /** 移动文档到新目录（章号/文件名不变，只改卷归属）。 */
  moveDocument(input: MoveDocumentInput): Promise<MoveResult> {
    return this.doMoveOrRename(input.docId, { kind: 'move', toDir: input.toDir })
  }

  /** 重命名文档（改文件名，目录不变）。 */
  renameDocument(input: RenameDocumentInput): Promise<MoveResult> {
    return this.doMoveOrRename(input.docId, { kind: 'rename', newName: input.newName })
  }

  /** 更新章节元数据（标题/章号）。
   *  - 长篇 chapter：写 fm + 文件名同步 rename（章号4位-标题.md，docId 不变）。
   *  - 短篇 piece-body：写 fm + 文件名同步 rename（章号3位-标题.md，docId 不变）+ 章纲同名跟随。 */
  // R31-20（三十一轮）：同进程同 docId meta 操作串行链——锁等待让出事件循环后，
  // 同文档第二请求会撞跨进程锁文件的同进程 pid 自锁语义（等满超时 fail-closed）。
  // promise 链串行保持旧同步版「单线程无交错」行为等价（跨进程互斥仍由文件锁承担）。
  private metaOpChains = new Map<string, Promise<unknown>>()
  private chainDocMetaOp<T>(docId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.metaOpChains.get(docId) ?? Promise.resolve()
    const p = prev.then(fn, fn)
    this.metaOpChains.set(docId, p)
    void p.catch(() => {}).finally(() => {
      if (this.metaOpChains.get(docId) === p) this.metaOpChains.delete(docId)
    })
    return p
  }

  // R31-20（三十一轮）：meta PATCH 异步化——R30-6 只异步化了 executeSave/finalize，
  // 本方法与 updateDocMeta 的 save/布线/清单锁等待仍为 Atomics.wait 同步睡（最坏
  // ≈20s 冻结服务进程事件循环，与 R30-6 的异步化理由正面冲突）。改异步孪生：
  // 取锁等待走 acquireCrossProcessLockAsync（setTimeout 轮询），锁内临界段保持
  // 全同步 FS（与 executeSave 锁内段同纪律）；同进程同 docId 并发 PATCH 经
  // chainDocMetaOp promise 链串行（锁等待让出事件循环后，第二请求会撞同进程
  // pid 自锁语义——链串行保持旧同步版「单线程无交错」行为等价）。跨进程互斥
  // 仍由文件锁承担，锁序「save → 布线 → 清单」不变。
  updateChapterMeta(docId: string, meta: { 标题?: string; 章号?: number }): Promise<MoveResult> {
    return this.chainDocMetaOp(docId, () => this.updateChapterMetaLocked(docId, meta))
  }

  private async updateChapterMetaLocked(docId: string, meta: { 标题?: string; 章号?: number }): Promise<MoveResult> {
    const path = this.lookupPathByDocId(docId)
    if (!path) return { ok: false, code: 'NOT_FOUND', reason: `文档 ${docId} 未在清单登记` }
    const abs = this.resolveSafePath(path)
    if (!abs) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
    // Z-13（第五十八轮）：能力校验补齐（与 save() 同防线）——定稿/摘要 等只读区
    // 此前可经 PATCH op=meta 改写其 fm
    if (!layoutOf(path).capabilities.write) {
      return { ok: false, code: 'CAPABILITY_DENIED', reason: '该文档只读，不可改元数据' }
    }
    // R76-1（二十四轮 C 域）：保存协议收口——本路径 read→patch→写回原先全程不持
    // per-doc save 锁，GUI(dev:app) 与 dev:api 双进程同书时：进程 A executeSave 刚落盘
    // 的新正文 C2，会被进程 B 在此路径读到的旧正文 C1 以「新 fm + 旧正文」整篇覆盖回去
    //（B 的 read→write 毫秒窗），终态 C2 永久不可恢复（本路径又无快照留底）。取与
    // executeSave 同款跨进程保存锁（`<journal>.save.lock`，5s fail-closed，拿不到=
    // 未执行可重试，不降级裸写）。锁覆盖到尾部 doMoveOrRename：其内部嵌套拿
    // manifest/journal 锁，方向与 executeSave 内 maybeUpdateManifest 相同（单向无环）；
    // 同进程同 docId 不会自锁（executeSave 锁内临界段全同步，JS 单线程不与本同步方法
    // 交错；doMoveOrRename 不取 save 锁）。
    const journalPath = join(this.journalDir, `${encodeDocDirName(docId)}.jsonl`)
    const docSaveLock = await acquireCrossProcessLockAsync(`${journalPath}.save.lock`, metaSaveLockTimeoutMs)
    if (!docSaveLock) {
      return { ok: false, code: 'WRITE_ERROR', reason: '元数据保存等待超时：另一进程正在保存此文档（5 秒未让出），请重试' }
    }
    // R29-7（二十九轮）：同 executeSave——布线文件在 save 锁内再取同名文件锁（与
    // lead-finalize 回写互斥），超时/获取异常按 WRITE_ERROR 拒绝（fail-closed，先释放
    // save 锁防泄漏）；非布线文件不加锁。R30-5（三十轮）锁序如实化：全仓统一
    // 「save 锁 → 布线锁 → 清单锁」，finalize 侧已同步改为进清单锁前预取布线锁。
    // R31-20：两处锁获取均异步化（等待期不阻塞事件循环）。
    const wiringKey = this.wiringFileLockKey(path)
    let wiringLock: (() => void) | null = null
    if (wiringKey) {
      try {
        wiringLock = await acquireCrossProcessLockAsync(wiringKey, wiringSaveLockTimeoutMs)
      } catch (e) {
        docSaveLock()
        return { ok: false, code: 'WRITE_ERROR', reason: `布线文件锁获取失败（未执行保存，可重试）：${errMsg(e)}` }
      }
      if (!wiringLock) {
        docSaveLock()
        return { ok: false, code: 'WRITE_ERROR', reason: '元数据保存等待超时：另一进程正在回写此布线文件（5 秒未让出），请重试' }
      }
    }
    try {
      // R27-45（二十七轮）：单次 Buffer 读派生文本与判据（照抄 R73-40 updateDocMeta 修法）
      // ——原 readDoc（610）与 readFileSync（619）两次独立读盘，两读之间文件被并发替换
      // （他进程改名/移动不持 save 锁）时判据与写回内容错源（微 TOCTOU）；且第二次读
      // 无守卫，ENOENT 裸穿 MoveResult 契约（ee-P1-5 同族）。
      let fileBytes: Buffer
      try {
        fileBytes = readFileSync(abs)
      } catch (e) {
        return { ok: false, code: 'WRITE_ERROR', reason: `元数据读取失败：${e instanceof Error ? e.message : String(e)}` }
      }
      // readFile(filePath, content) 形参直喂单读文本——fmRaw/body 与 readDoc(abs) 同源派生
      const r = readDoc(abs, fileBytes.toString('utf-8'))
      if (!r.ok) return { ok: false, code: 'WRITE_ERROR', reason: `元数据读取失败：${r.error.message}` }
      // 第五轮：非 UTF-8（GBK 等）防线——utf-8 读入产生 U+FFFD 替换符，元数据写回会把
      // 乱码正文原子覆盖回原文件，原始字节永久丢失（本路径无快照留底，用户没碰正文却
      // 被「盲改」）。检出即拒绝，先转码再改。
      // 低级项（第六轮）：判据从「body 含 U+FFFD」升级为「盘上字节非合法 UTF-8」（fatal
      // 解码探测，与 save 主路径 M-5 同口径）——原判据对 fm 区（GBK 标题等）是盲区，且 fm
      // 往返依赖 parse/stringify 非无损；盘上合法 UTF-8 时读出的 FFFD 是用户自粘内容，
      // body 原样透传不构成损坏。
      if (!isUtf8Bytes(fileBytes)) return NON_UTF8_REJECT
      const map = parseFlat(r.fmRaw)
      if (meta.标题 !== undefined) map.set('标题', meta.标题)
      // piece-body / chapter 统一写「章号」字段
      // 缓存 isPieceBody 结果（一次 readBookConfig，避免同方法内两次磁盘读）
      const isPiece = isPieceBody(path, this.bookRoot)
      if (meta.章号 !== undefined) map.set('章号', meta.章号)
      // R65-1（十三轮）：写侧改文本级补丁——parseFlat→stringifyFlat 整体重排会把手写
      // 嵌套段/块标量变体压平（同 updateDocMeta 的境界体系问题），补丁只换目标键行
      const fmUpdates: Record<string, unknown> = {}
      if (meta.标题 !== undefined) fmUpdates['标题'] = meta.标题
      if (meta.章号 !== undefined) fmUpdates['章号'] = meta.章号
      const patched = patchFlatFm(r.fmRaw, fmUpdates)
      if (!patched.ok) return { ok: false, code: 'BAD_INPUT', reason: patched.reason }
      // R26-51（二十六轮）：覆盖前留底（对齐 R26-9 files.ts PUT 覆盖留底同款，fail-open
      // 不阻断）——meta PATCH 的「读旧→patch→整文件写回」此前零快照，写入失败之外的
      // 误改（如 patch 错键行）无底可回；本路径已有非 UTF-8 拒写防线（上方），此处
      // utf-8 读入必然无损。快照失败（磁盘满/权限）只 log.warn，元数据修改照常落盘
      // （留底是兜底不是闸，与 lead-update-draft R74-4 取舍一致）。
      try {
        // R28-13（二十八轮）：同源派生对齐 R27-45——本函数上方 R27-45 已把两次读盘收敛
        // 为单次 fileBytes 读且已过 isUtf8Bytes 判据（合法 UTF-8 时 Buffer 直存与
        // utf-8 往返字节一致），R26-51 快照却又第二次 readFileSync 再读盘：两读之间文件
        // 被并发替换（他进程结构性操作不持 save 锁的毫秒窗）时「覆盖前留底」存档的不是
        // 被覆盖内容（错档非丢失），且多一次全文读。改直喂 fileBytes（writeSnapshot 形参
        // string | Buffer，R26-52 Buffer 透传字节档），words 口径不受影响（本路径不产
        // words，meta 无字数段）。
        writeSnapshot(
          this.snapshotsDir,
          docId,
          fileBytes,
          { origin: 'meta-overwrite', reason: '章节元数据修改前留底（R26-51）' },
          { policy: this.snapshotPolicy(), force: true },
        )
      } catch (e) {
        log.warn('document', `章节元数据修改前快照失败（fail-open 继续写入）：${errMsg(e)}`)
      }
      try {
        // 元数据写入走原子写（P1-6A：防 writeFileSync 半截损坏不可恢复）
        atomicWriteFile(abs, joinFrontMatter(patched.text, r.body), { fsync: true })
      } catch (e) {
        return { ok: false, code: 'WRITE_ERROR', reason: `元数据写入失败：${errMsg(e)}` }
      }
      // R71-22（十九轮）：标题三级回落——显式传标题（meta.标题）→ fm 标题 → 现有文件名
      // 标题段（剥章号数字前缀与 .md）。此前章号-only PATCH 且 fm 缺标题时直落「未命名」，
      // 作者手建的 `0001-我的章节.md` 改一次章号就被静默改成 `000N-未命名.md`（用户自选
      // 标题丢失）。X-P3a「未命名」兜底语义保留给显式传空标题的编辑路径；回落链产物
      // 非空（文件名无标题段时退回旧行为）。
      const explicitTitle = meta.标题 !== undefined ? String(map.get('标题') ?? '') : null
      const 标题 =
        explicitTitle !== null
          ? explicitTitle
          : String(map.get('标题') ?? '') || (basename(path).match(/^(?:\d+-)?(.+)\.md$/)?.[1] ?? '')
      invalidateTreeIndex(this.bookRoot, true)

      if (isPiece) {
        // 短篇：rename 文件名（章号3位-标题.md）+ 同步章纲同名文件
        const no = normalizeChapterNo(map.get('章号'))
        const numPrefix =
          no !== null
            ? chapterFilePrefix(no, 'piece')
            : (basename(path).match(/^(\d+-)/)?.[1] ?? '')
        // X-P3a：标题缺失/空白时兜底「未命名」——否则文件名劣化成 `001-.md`
        // B-3（第六十轮）：消毒走 sanitizeChapterTitle 单源（控制字符含 \n / Windows
        // 非法字符 :*?"<>| / 码位 60/字节 120 双封顶）——此前仅替换 \\ / 两字符，
        // 「改标题→重命名」路径消毒族口径漂移（同族 draft.ts 新建章、style-entry Y-27 已单源）
        const safeTitle = sanitizeChapterTitle(标题) || '未命名'
        const newName = `${numPrefix}${safeTitle}.md`
        if (basename(path) !== newName) {
          const result = await this.doMoveOrRename(docId, { kind: 'rename', newName })
          if (result.ok) await this.syncRenamePieceList(path, newName)
          else this.rollbackMetaOnRenameFail(abs, r)
          return result
        }
        return { ok: true, docId, path }
      }

      // 长篇 chapter：文件名按 章号4位-标题.md（B-3：消毒同 piece 分支单源口径）
      const no = normalizeChapterNo(map.get('章号'))
      const safeTitle = sanitizeChapterTitle(标题) || '未命名'
      const newName =
        no !== null ? `${chapterFilePrefix(no, 'chapter')}${safeTitle}.md` : basename(path)
      if (basename(path) !== newName) {
        const result = await this.doMoveOrRename(docId, { kind: 'rename', newName })
        if (!result.ok) this.rollbackMetaOnRenameFail(abs, r)
        return result
      }
      return { ok: true, docId, path }
    } finally {
      // R29-7：布线文件锁先于 save 锁释放（逆获取序），release 幂等
      if (wiringLock) wiringLock()
      docSaveLock()
    }
  }

  /** M-2（第十一轮）：updateChapterMeta rename 失败回写旧 fm——两步非原子（先原子写 fm
   *  新章号/标题，后 rename 文件名），rename 失败不回写会留「fm 章号≠文件名章号」孤儿态
   *  （仅靠机检 fm-chapter-mismatch 报红兜底，按章号三口径定位会 miss）。按进入本方法时
   *  读入的快照（r.fmRaw + r.body）原样回写，恢复 fm 与文件名一致；文件已不在原路径
   *  （doMoveOrRename 的「清单更新失败」路径——文件已 rename，新 fm 与新文件名一致）不
   *  回写，回写反而制造错配；回写自身失败维持 mismatch，机检兜底，不吞 rename 失败原因。 */
  private rollbackMetaOnRenameFail(abs: string, original: { fmRaw: string; body: string }): void {
    if (!existsSync(abs)) return
    try {
      atomicWriteFile(abs, joinFrontMatter(original.fmRaw, original.body), { fsync: true })
      invalidateTreeIndex(this.bookRoot, true)
    } catch {
      // 回写失败维持现状：fm-chapter-mismatch 由机检兜底
    }
  }

  /** 短篇章纲同步重命名（章纲/Old.md → 章纲/New.md）：
   *  正文已 rename，章纲同名文件跟随。章纲不存在时静默跳过（不阻断正文 rename）。
   *  N-7（第十二轮）：章纲已入清单（对其做过任何结构性操作即落）时委托 doMoveOrRename
   *  ——裸 renameSync 既不更新 项目/文档清单.jsonl 也不写 move-pending journal，清单残留
   *  指向旧路径的孤儿条目；tree 按旧 path 匹配 miss → docId 退化为 legacyId(新 path)，
   *  编辑器按 docId 挂的标签页/分析信封/工作区/.版本/<docId>/ 版本历史全断链。委托后
   *  journal + snapshot + 清单 path 更新 + 树索引失效与正文改名同一纪律。未登记（从未
   *  做过结构性操作）时无条目可孤儿，保留裸 rename 回落。 */
  private async syncRenamePieceList(oldBodyRel: string, newName: string): Promise<void> {
    const oldListRel = `大纲/章纲/${basename(oldBodyRel)}`
    const newListRel = `大纲/章纲/${newName}`
    const oldSafe = this.resolveSafePath(oldListRel)
    const newSafe = this.resolveSafePath(newListRel)
    if (!oldSafe || !newSafe) return
    if (!existsSync(oldSafe)) return
    if (existsSync(this.manifestPath)) {
      const hit = [...readManifest(this.manifestPath).entries].find(([, e]) => e.path === oldListRel)
      if (hit) {
        const r = await this.doMoveOrRename(hit[0], { kind: 'rename', newName })
        if (r.ok) return
        // 失败（含「文件已移、清单更新失败」半程态）不阻断正文 rename：前者落回裸
        // rename 兜底配对，后者 healthCheck 按悬置 pending 收口（P3-10 语义）
      }
    }
    try {
      mkdirSync(dirname(newSafe), { recursive: true })
      // R70-18（十八轮）：目标已存在（手工副本/网盘副本）时不静默覆盖——POSIX rename
      // 对已存在目标静默替换会无留底毁掉同名章纲；改名保双份（L-P6 同款时间戳后缀）
      let dst = newSafe
      if (existsSync(newSafe)) {
        dst = newSafe.replace(/\.md$/, `-旧稿-${Date.now()}.md`)
      }
      renameSync(oldSafe, dst)
      invalidateTreeIndex(this.bookRoot, true)
    } catch {
      // 清单同步失败不阻断正文 rename
    }
  }

  /** 更新文档 frontmatter 字段（通用，不联动文件名；卷纲/总纲用）。
   *  与 updateChapterMeta 的区别：不改文件名（卷纲/总纲文件名不按 章号-标题）。 */
  // R31-20（三十一轮）：同 updateChapterMeta——锁获取异步化；本方法锁内段纯
  // 同步 FS（read/patch/write，无嵌套锁），链串行与 chapter 面统一（同 docId
  // 双 meta 请求不再撞同进程 pid 自锁窗口）。
  updateDocMeta(docId: string, meta: Record<string, unknown>): Promise<MoveResult> {
    return this.chainDocMetaOp(docId, () => this.updateDocMetaLocked(docId, meta))
  }

  private async updateDocMetaLocked(docId: string, meta: Record<string, unknown>): Promise<MoveResult> {
    const path = this.lookupPathByDocId(docId)
    if (!path) return { ok: false, code: 'NOT_FOUND', reason: `文档 ${docId} 未在清单登记` }
    const abs = this.resolveSafePath(path)
    if (!abs) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
    // Z-13（第五十八轮）：同 updateChapterMeta——能力校验补齐
    if (!layoutOf(path).capabilities.write) {
      return { ok: false, code: 'CAPABILITY_DENIED', reason: '该文档只读，不可改元数据' }
    }
    // R76-1（二十四轮 C 域）：保存协议收口——同 updateChapterMeta，本路径 read→patch→
    // 写回原先不持 per-doc save 锁，双进程同书时他进程 executeSave 的新正文会被本路径
    // 的「旧正文+新 fm」覆盖回去（跨进程丢正文窗）。取 executeSave 同款跨进程保存锁
    //（5s fail-closed）；锁内无嵌套锁获取（纯 read/patch/write），与 executeSave 的
    // save→journal/manifest 单向序无环。
    const journalPath = join(this.journalDir, `${encodeDocDirName(docId)}.jsonl`)
    const docSaveLock = await acquireCrossProcessLockAsync(`${journalPath}.save.lock`, metaSaveLockTimeoutMs)
    if (!docSaveLock) {
      return { ok: false, code: 'WRITE_ERROR', reason: '元数据保存等待超时：另一进程正在保存此文档（5 秒未让出），请重试' }
    }
    // R29-7（二十九轮）：同 executeSave/updateChapterMeta——布线文件（含 大纲/关系线/）
    // 在 save 锁内再取同名文件锁（与 lead-finalize 回写互斥），超时/获取异常按
    // WRITE_ERROR 拒绝（fail-closed，先释放 save 锁防泄漏）。R30-5（三十轮）锁序如实化：
    // 全仓统一「save 锁 → 布线锁 → 清单锁」，finalize 侧已同步改为进清单锁前预取布线锁。
    const wiringKey = this.wiringFileLockKey(path)
    let wiringLock: (() => void) | null = null
    if (wiringKey) {
      try {
        wiringLock = await acquireCrossProcessLockAsync(wiringKey, wiringSaveLockTimeoutMs)
      } catch (e) {
        docSaveLock()
        return { ok: false, code: 'WRITE_ERROR', reason: `布线文件锁获取失败（未执行保存，可重试）：${errMsg(e)}` }
      }
      if (!wiringLock) {
        docSaveLock()
        return { ok: false, code: 'WRITE_ERROR', reason: '元数据保存等待超时：另一进程正在回写此布线文件（5 秒未让出），请重试' }
      }
    }
    try {
      // R73-40（二十一轮）：两次独立 readFileSync 收敛为单次读（finalize.ts R72-5 单读
      // 同源先例）——「utf-8 读文本」与「字节级 UTF-8 判据」原先各读一次盘，两读之间文件
      // 被并发替换（他进程保存/改名）时判据与写回内容错源（微 TOCTOU）。Buffer 一读，
      // 判据与写回同源派生。
      let raw: string
      try {
        const buf = readFileSync(abs)
        // 非 UTF-8 防线（第五轮引入；DA-1·第七轮升级字节级判据，同 updateChapterMeta 口径）——
        // 原字符串 FFFD 判据有 fm 区 GBK 盲区：部分 GBK 双字节对恰好构成合法 UTF-8，读入
        // 无 U+FFFD 即放行，fm 往返把乱码原子覆盖回原文件，原始字节永久丢失
        if (!isUtf8Bytes(buf)) return NON_UTF8_REJECT
        raw = buf.toString('utf-8')
      } catch (e) {
        return { ok: false, code: 'WRITE_ERROR', reason: `元数据读取失败：${errMsg(e)}` }
      }
      // 容错：裸 md 无 fm（旧书卷纲/总纲）→ 整体当 body，新建 fm
      const split = splitFrontMatter(raw)
      const body = split ? split.body : raw
      // R65-1（十三轮）：写侧改文本级补丁——parseFlat→stringifyFlat 整体重排会摧毁
      // fm 内唯一嵌套结构（设定/境界体系.md 的 体系:/- 名称:/序列: 被压平成伪平铺键
      // 且同名键互相覆盖，回写后 parseRealmSystems 永远解析失败 → 成长线机检静默失明，
      // 多体系时仅最后一组内容存活）。补丁只换目标键行，其余行逐字节保留；目标键自带
      // 嵌套子行时 fail-loud 拒绝。
      const fmUpdates: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(meta)) {
        if (v !== undefined) fmUpdates[k] = v
      }
      const patched = patchFlatFm(split ? split.fmRaw : '', fmUpdates)
      if (!patched.ok) return { ok: false, code: 'BAD_INPUT', reason: patched.reason }
      // R26-51（二十六轮）：覆盖前留底（同 updateChapterMeta——R26-9 同款，fail-open）。
      // raw 是上方单次 Buffer 读出的原文件文本（R73-40 同源），字节级忠实。
      try {
        writeSnapshot(
          this.snapshotsDir,
          docId,
          raw,
          { origin: 'meta-overwrite', reason: '元数据修改前留底（R26-51）' },
          { policy: this.snapshotPolicy(), force: true },
        )
      } catch (e) {
        log.warn('document', `元数据修改前快照失败（fail-open 继续写入）：${errMsg(e)}`)
      }
      try {
        atomicWriteFile(abs, joinFrontMatter(patched.text, body), { fsync: true })
      } catch (e) {
        return { ok: false, code: 'WRITE_ERROR', reason: `元数据写入失败：${errMsg(e)}` }
      }
      invalidateTreeIndex(this.bookRoot, true)
      return { ok: true, docId, path }
    } finally {
      // R29-7：布线文件锁先于 save 锁释放（逆获取序），release 幂等
      if (wiringLock) wiringLock()
      docSaveLock()
    }
  }

  /** move/rename 共用：查清单 oldPath → 算 newPath → 能力校验 → snapshot → rename → 清单更新。 */
  // R31-20（三十一轮）：doMoveOrRename 改异步——尾部清单 path 更新走
  // updateManifestPath 的异步清单锁（等待期不阻塞事件循环）；锁序不变（本方法
  // 不取 save 锁，由调用方 save 锁内 await，见 updateChapterMetaLocked）。
  private async doMoveOrRename(
    docId: string,
    op: { kind: 'move'; toDir: string } | { kind: 'rename'; newName: string },
  ): Promise<MoveResult> {
    // N1（五十九轮）：journal 路径含 docId，入口显式 safeDocId 校验防穿越——executeSave
    // 已有 P1-SEC-A 守卫，此处同型构造漏校验；manifest 是可篡改数据面，构造
    // id:"../../evil" 条目后 PATCH move/rename 可把 .jsonl 写出书仓库外。
    if (!safeDocId(docId)) return { ok: false, code: 'PATH_ESCAPE', reason: '文档 ID 非法' }
    const oldPath = this.lookupPathByDocId(docId)
    if (!oldPath) return { ok: false, code: 'NOT_FOUND', reason: `文档 ${docId} 未在清单登记` }

    // R64-16（十二轮）：rename 的 newName 直拼 `${dirname}/${newName}`——含 `/`/`\`
    // 的名字不越根也会变成跨目录移动（`../x` 越层、`a/b` 进子目录），NNN-标题 文件名
    // 解析口径随之失效。basename 单源守卫：newName 必须是纯文件名。
    if (op.kind === 'rename' && basename(op.newName) !== op.newName) {
      return { ok: false, code: 'PATH_ESCAPE', reason: '新文件名不能包含路径分隔符' }
    }
    let newPath: string
    if (op.kind === 'move') {
      // R66-5（十四轮）：toDir 此前只剥一个尾斜杠——'写作/正文//' 会把 '写作/正文//0001-x.md'
      // 直拼记入 manifest，目录身份分裂致该文档永久 REVISION_CONFLICT（registered !==
      // relPath）且 finalizedPathSet 失配（文风重扫/导出/学习链把已定稿章当草稿）；
      // 入层归一：拒绝前导 '/'（绝对路径逃逸）与归一后为空、折叠连续斜杠、剥全部尾斜杠，
      // 让 'a/b/'、'a/b//'、'a//b' 归一到同一键。
      const toDir = normalizeMoveToDir(op.toDir)
      if (toDir === null) {
        return { ok: false, code: 'BAD_INPUT', reason: '目标目录非法（前导斜杠或空目录不被接受）' }
      }
      newPath = `${toDir}/${basename(oldPath)}`
    } else {
      // C-3（二十九轮）：newName 消毒同 create 路径单源口径（sanitizeCreateSegment →
      // format/filename.ts 单一真相源）——此前只挡路径分隔符，Windows 非法字符/控制
      // 字符/尾点尾空格/保留设备名/超长名直落盘（跨平台拷贝被拒或读写名不一致），
      // 与 create 的静默消毒行为漂移。分隔符仍由上方守卫显式拒绝，其余非法形态按
      // create 同款静默调整后落盘（落盘真实路径是唯一身份，返回 path 即消毒后路径）。
      newPath = `${dirname(oldPath)}/${sanitizeCreateSegment(op.newName)}`
    }
    if (newPath === oldPath) return { ok: true, docId, path: newPath } // 无变化，幂等

    // 能力校验：source rename+move，target write（§7.2）
    const srcCaps = layoutOf(oldPath).capabilities
    if (!srcCaps.rename || !srcCaps.move) {
      return { ok: false, code: 'CAPABILITY_DENIED', reason: '该文档不可移动/重命名' }
    }
    if (!layoutOf(newPath).capabilities.write) {
      return { ok: false, code: 'CAPABILITY_DENIED', reason: '目标位置只读' }
    }

    const oldSafe = this.resolveSafePath(oldPath)
    const newSafe = this.resolveSafePath(newPath)
    if (!oldSafe || !newSafe) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
    if (!existsSync(oldSafe)) return { ok: false, code: 'NOT_FOUND', reason: '源文件不存在' }
    if (existsSync(newSafe)) return { ok: false, code: 'ALREADY_EXISTS', reason: '目标已存在' }

    // P3-10：journal 兜底移动/重命名的非原子窗口——pending → snapshot+rename → 清单更新 → settled。
    // 窗口内崩溃：进门 healthCheck 按磁盘现状确定性收口（new 在 old 不在 → 补清单；old 在 new 不在 → abort）。
    const journalPath = join(this.journalDir, `${encodeDocDirName(docId)}.jsonl`) // R68-3：同 executeSave 编码口径
    // ee-P1-5：pending 写入收进 try——appendMovePending 同步抛（磁盘满/权限）此前在 try 外
    // 裸穿，而调用方以 Promise.resolve 包裹本方法（不捕获同步 throw），拿到的是裸异常而非
    // {ok:false} 契约（save 路径同类已修 RB-KN-P2-2，此处对齐）。pending 仍先于
    // snapshot+rename，P3-10 崩溃恢复语义不变。
    let opId: string | undefined
    try {
      opId = await appendMovePending(journalPath, docId, oldPath, newPath)
      // snapshot 留底（移动/重命名前，W0-1 §7）
      const baseRev = computeRevision(oldSafe)
      // R26-52（二十六轮）：留底读原始字节——utf-8 文本读入会把 GBK 等非 UTF-8 源变
      // U+FFFD 失真快照（假留底：移动覆盖后原字节任何形式不可恢复）。writeVersion 支持
      // 原字节直存（front matter utf-8 + 原字节拼接），快照即字节档。
      const oldContent = readFileSync(oldSafe)
      writeSnapshot(this.snapshotsDir, docId, oldContent, {
        origin: 'manual',
        reason: op.kind === 'move' ? '移动前留底' : '重命名前留底',
        baseRevision: baseRev,
      })
      mkdirSync(dirname(newSafe), { recursive: true })
      // R71-7（十九轮）：existsSync→renameSync 的 TOCTOU 窗口内目标位被跨进程并发落位
      // → POSIX rename / win MOVEFILE(REPLACE_EXISTING) 均静默覆盖（双方调用都返回成功，
      // 先到者正文从工作区消失，仅存快照留底）。文件改 linkSync 原子探测（R64-21 回收站
      // 还原同款）：EEXIST → ALREADY_EXISTS（link 失败即占用，无窗口）；成功 → 内容已借
      // 硬链接落位，再删源（同一 inode，无复制窗口）。删源失败 → 旧位仍在、清单未动，
      // 按失败收口（新位成孤儿副本，语义同下方「清单更新失败」：不丢数据）。本方法只
      // 处理文档文件；目录结构性操作走 books.ts，无目录分支。
      // EEXIST 判定只认 link 这一步（转成哨兵码再统一收口）——journal/snapshot 的
      // mkdirSync 撞同名文件同样抛 EEXIST，混入外层 catch 会把 WRITE_ERROR 误判成
      // 「目标已存在」（ee-P1-5 用例：.journal 槽位被普通文件占用）。
      // R26-7（二十六轮）：接入 linkOrRenameExclusive——EPERM/ENOSYS/EACCES（exFAT/
      // FAT32/部分 SMB 不支持硬链接）降级 rename 落位（'exists' 判定语义不变），非
      // NTFS 卷上移动/重命名不再全线失败。
      const placed = linkOrRenameExclusive(oldSafe, newSafe)
      if (placed === 'exists') {
        throw Object.assign(new Error('目标已存在'), { code: 'ALREADY_EXISTS' })
      }
      rmSync(oldSafe, { force: true })
    } catch (e) {
      // pending 本身没写进去（opId 未赋值）时无从 abort——journal 里没有悬置记录
      // 低-4（第十轮）：appendAborted 自身失败（journal 目录被删/磁盘满/权限）不再穿透——
      // 此处已在失败善后路径上，留痕失败只降级（悬置 pending 由进门 healthCheck 收口），
      // 必须保住 {ok:false} 契约，不能把调用方换成吃裸异常
      if (opId !== undefined) {
        try {
          await appendAborted(journalPath, opId, errMsg(e))
        } catch { /* 留痕失败吞掉：journal 无 aborted 行 → 悬置 pending 待恢复链收口 */ }
      }
      // R71-7：linkSync 的 EEXIST = 目标位在预检后被并发占用——按 ALREADY_EXISTS 收口
      // （此时什么都没动：源在旧位、清单未改，journal 已 abort）
      if ((e as NodeJS.ErrnoException).code === 'ALREADY_EXISTS') {
        return { ok: false, code: 'ALREADY_EXISTS', reason: '目标已存在' }
      }
      return { ok: false, code: 'WRITE_ERROR', reason: `移动/重命名失败：${errMsg(e)}` }
    }

    // 清单 path 更新（docId 不变，只改 path）——在 journal 保护段内：
    // 此步失败/崩溃 → pending 悬置（文件已在新路径），下次进门 healthCheck 自动对齐清单
    try {
      await this.updateManifestPath(docId, newPath)
      await appendSettled(journalPath, opId, computeRevision(newSafe))
    } catch (e) {
      return {
        ok: false,
        code: 'WRITE_ERROR',
        reason: `文件已移动到新路径，但清单更新失败（下次打开本书时自动对齐）：${errMsg(e)}`,
      }
    }
    invalidateTreeIndex(this.bookRoot, true)
    return { ok: true, docId, path: newPath }
  }

  /** 查清单 docId → path；无清单或未登记 → null（旧书需先建清单）。 */
  private lookupPathByDocId(docId: string): string | null {
    if (existsSync(this.manifestPath)) {
      const path = readManifest(this.manifestPath).entries.get(docId)?.path
      if (path) return path
    }
    return this.adoptLegacyDoc(docId)
  }

  /**
   * legacy 临时 ID 兜底：旧书文件无清单登记时，树用 legacyId(path) 当运行期 ID，
   * 清单里查不到 → 结构性操作一律 NOT_FOUND。此处扫盘反查同 ID 的文件并补登记
   * （stable-id.ts「首次结构性操作时落盘」）。非 legacy 前缀 / 无匹配 → null。
   */
  private adoptLegacyDoc(docId: string): string | null {
    if (!docId.startsWith('legacy:')) return null
    const hit = findByLegacyId(scanBookTree(this.bookRoot), docId)
    if (!hit) return null
    this.upsertManifestEntry(docId, hit)
    return hit
  }

  /** 清单登记/upsert（无清单则建——结构性操作触发，W0-1 §4.2）。X-5：RMW 持清单锁。 */
  private upsertManifestEntry(docId: string, relPath: string): void {
    withManifestLock(this.manifestPath, () => {
      // R27-40：RMW strict 读——读失败（EBUSY/EACCES）上抛走调用方 WRITE_ERROR 信封，
      // 不再以空清单整文件重写吞掉全部登记
      const m = existsSync(this.manifestPath) ? readManifestStrict(this.manifestPath) : { version: 1, entries: new Map<string, ManifestEntry>() }
      upsertEntry(m, { id: docId, nodeType: 'document', path: relPath, parentId: null })
      mkdirSync(dirname(this.manifestPath), { recursive: true })
      writeManifest(this.manifestPath, m)
    })
  }

  /** R31-19（三十一轮）：upsertManifestEntry 的异步孪生——executeSave 锁内复核的
   *  legacy 收编链专用。等待期 withManifestLockAsync（setTimeout 轮询，事件循环不
   *  阻塞），RMW 本体与同步版逐位对齐（strict 读/同错误/同锁文件）。其余同步
   *  调用方（doCreate/doCopy/adoptLegacyDoc）保持同步版不动。 */
  private async upsertManifestEntryAsync(docId: string, relPath: string): Promise<void> {
    await withManifestLockAsync(this.manifestPath, () => {
      const m = existsSync(this.manifestPath) ? readManifestStrict(this.manifestPath) : { version: 1, entries: new Map<string, ManifestEntry>() }
      upsertEntry(m, { id: docId, nodeType: 'document', path: relPath, parentId: null })
      mkdirSync(dirname(this.manifestPath), { recursive: true })
      writeManifest(this.manifestPath, m)
    })
  }

  /** R31-19（三十一轮）：lookupPathByDocId 的异步收编孪生（executeSave 锁内复核用）。
   *  清单命中读与同步版同口径（无锁读）；miss 且 legacy 前缀时扫盘反查后经异步清单锁
   *  登记——原路径 adoptLegacyDoc → upsertManifestEntry 用同步 withManifestLock
   *  （Atomics.wait），双进程争用窗口内在 save 锁等待异步化的保存链上重新引入最长
   *  2×5s 的事件循环阻塞。 */
  private async lookupPathByDocIdAdoptAsync(docId: string): Promise<string | null> {
    if (existsSync(this.manifestPath)) {
      const path = readManifest(this.manifestPath).entries.get(docId)?.path
      if (path) return path
    }
    if (!docId.startsWith('legacy:')) return null
    const hit = findByLegacyId(scanBookTree(this.bookRoot), docId)
    if (!hit) return null
    await this.upsertManifestEntryAsync(docId, hit)
    return hit
  }

  /** 清单 path 更新（move/rename 用，docId 不变）。X-5：RMW 持清单锁。 */
  private async updateManifestPath(docId: string, newPath: string): Promise<void> {
    if (!existsSync(this.manifestPath)) return
    // R31-20（三十一轮）：清单锁等待异步化（withManifestLockAsync，R30-6 原语）——
    // RMW 本体仍全程同步 FS，语义与同步版逐位对齐
    await withManifestLockAsync(this.manifestPath, () => {
      const m = readManifestStrict(this.manifestPath) // R27-40：RMW strict 读
      const entry = m.entries.get(docId)
      if (!entry) return
      entry.path = newPath
      writeManifest(this.manifestPath, m)
    })
  }

  /** 新建文档的默认内容（最小 frontmatter；具体字段由作者编辑或 batch 流程填）。 */
  private defaultContent(): string {
    return '---\n---\n\n'
  }

  /** 复制文档（读源内容 → 落到 relPath → 分配新 docId + 清单登记 + invalidate）。 */
  copyDocument(input: CopyDocumentInput): Promise<CopyResult> {
    return Promise.resolve(this.doCopy(input))
  }

  private doCopy(input: CopyDocumentInput): CopyResult {
    const srcPath = this.lookupPathByDocId(input.docId)
    if (!srcPath) return { ok: false, code: 'NOT_FOUND', reason: `源文档 ${input.docId} 未在清单登记` }
    // 能力：源 copy + 目标 write（与 create 同步实现，靠单线程微任务不交错）
    if (!layoutOf(srcPath).capabilities.copy) {
      return { ok: false, code: 'CAPABILITY_DENIED', reason: '该文档不可复制' }
    }
    if (!layoutOf(input.relPath).capabilities.write) {
      return { ok: false, code: 'CAPABILITY_DENIED', reason: '目标位置只读' }
    }
    const srcSafe = this.resolveSafePath(srcPath)
    const dstSafe = this.resolveSafePath(input.relPath)
    if (!srcSafe || !dstSafe) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
    if (!existsSync(srcSafe)) return { ok: false, code: 'NOT_FOUND', reason: '源文件不存在' }
    // R61-11（第六十一轮）：existsSync 预检与 atomicWriteFile 落盘之间无互斥（TOCTOU），
    // rename 静默覆盖并发建到的目标；改 createFileExclusive（link 不覆盖，EEXIST →
    // ALREADY_EXISTS，同 doCreate B-6 口径）——预检保留仅作快路
    if (existsSync(dstSafe)) return { ok: false, code: 'ALREADY_EXISTS', reason: '目标已存在' }

    try {
      // P5-数据层（第七轮）：按原始字节复制——原 utf-8 文本读写在非 UTF-8 源上会产出
      // 乱码副本（M-5 同族防线未覆盖复制路径；原件无损但副本即损坏）
      const raw = readFileSync(srcSafe)
      const created = createFileExclusive(dstSafe, raw, { fsync: true })
      if (created === 'exists') return { ok: false, code: 'ALREADY_EXISTS', reason: '目标已存在' }
    } catch (e) {
      return { ok: false, code: 'WRITE_ERROR', reason: `复制失败：${errMsg(e)}` }
    }
    // 新 docId + 清单登记（结构性操作触发建清单，W0-1 §4.2）
    const newDocId = generateDocId()
    // R70-17（十八轮）：登记收编（同 doCreate——半成品由树扫描自愈，不误报完全失败）
    // R31-24（三十一轮）：登记失败降级返回 legacyId(rel)（同 doCreate，身份连续）
    let registeredDocId = newDocId
    try {
      this.upsertManifestEntry(newDocId, input.relPath)
    } catch (e) {
      registeredDocId = legacyId(input.relPath)
      log.warn('document', `复制后清单登记失败（${input.relPath}，降级返回 legacy id 与树扫描自愈同源）：${errMsg(e)}`)
    }
    invalidateTreeIndex(this.bookRoot, true)
    return { ok: true, docId: registeredDocId, path: input.relPath, revision: computeRevision(dstSafe) }
  }

  /** 软删文档（snapshot + 回收站登记 + 移 .trash + 清单 removeEntry + invalidate；
   *  GG-P2-6：登记不成则删不成——先写登记成功再移文件）。 */
  trashDocument(input: { docId: string }): Promise<TrashResult> {
    return Promise.resolve(this.doTrash(input.docId))
  }

  private doTrash(docId: string): TrashResult {
    // R67-11（十五轮）：入口补 safeDocId——与 saveDocument/executeSave 同口径的纵深
    // 一致性：manifest 属可篡改数据面，带恶意 docId 的登记可经 lookup 命中后进入
    // snapshot 留底/trash 路径拼接（下游 resolveSafePath 两层已挡穿越，此处挡在
    // 更早，非法 ID 不进后续链）
    if (!safeDocId(docId)) return { ok: false, code: 'PATH_ESCAPE', reason: '文档 ID 非法' }
    const oldPath = this.lookupPathByDocId(docId)
    if (!oldPath) return { ok: false, code: 'NOT_FOUND', reason: `文档 ${docId} 未在清单登记` }
    if (!layoutOf(oldPath).capabilities.trash) {
      return { ok: false, code: 'CAPABILITY_DENIED', reason: '该文档不可删除（系统文档）' }
    }
    const oldSafe = this.resolveSafePath(oldPath)
    if (!oldSafe) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
    if (!existsSync(oldSafe)) return { ok: false, code: 'NOT_FOUND', reason: '源文件不存在' }

    // C-3（二十九轮）：回收站落名消毒同 create/rename 单源口径——basename 含 win
    // 非法字符/尾点/控制字符时直拼 .trash 落名（跨平台同步盘/拷贝歧义或写失败）。
    // 消毒只影响落名；TrashEntry.trashedPath 记录消毒后的真实落位，还原语义不变。
    const cleanBase = sanitizeCreateSegment(basename(oldPath))
    const trashedRel = `工作区/.trash/${encodeDocDirName(docId)}-${cleanBase}`
    // R73-34（二十一轮）：确定性命名残留防线的落位路径（函数域声明——成功返回值也要用）。
    // 上次软删「清单条目删除失败」残留后，同 docId 的文件经编辑器保存合法复活
    //（executeSave Z-6 对「文件在盘」放行）再被再次软删时，同名 .trash 目标会被
    // renameSync 静默覆盖，上一版回收站内容无痕丢失。目标已存在 → 追加时间戳后缀保
    // 双份（lead-update-draft L-P6 / syncRenamePieceList R70-18 同款先例）；后缀须在
    // 回收站登记**之前**定——条目 trashedPath 记的是真实落位。
    let finalTrashRel = trashedRel
    try {
      // snapshot 留底（删除前，W0-1 §7）
      const baseRev = computeRevision(oldSafe)
      // R26-52（二十六轮）：留底读原始字节（同 doMoveOrRename）——utf-8 文本读入对
      // GBK 等非 UTF-8 源产出失真快照，删除落位后原字节不可恢复；writeVersion 支持
      // 原字节直存，快照即字节档。
      const content = readFileSync(oldSafe)
      writeSnapshot(this.snapshotsDir, docId, content, {
        origin: 'manual',
        reason: '删除前留底',
        baseRevision: baseRev,
      })
      // 移到 工作区/.trash/<docId>-<basename>
      const trashAbs = this.resolveSafePath(trashedRel)
      if (!trashAbs) return { ok: false, code: 'PATH_ESCAPE', reason: '回收站路径越出书仓库' }
      mkdirSync(dirname(trashAbs), { recursive: true })
      let finalTrashAbs = trashAbs
      const trashStemExt = (): { stem: string; ext: string } => {
        // C-3：与落名同源——从消毒后的 cleanBase 拆 stem/ext，时间戳后缀重试链产物
        // 同为消毒名
        const name = cleanBase
        const dot = name.lastIndexOf('.')
        return {
          stem: dot > 0 ? name.slice(0, dot) : name,
          ext: dot > 0 ? name.slice(dot) : '',
        }
      }
      if (existsSync(trashAbs)) {
        const { stem, ext } = trashStemExt()
        finalTrashRel = `工作区/.trash/${encodeDocDirName(docId)}-${stem}-${Date.now()}${ext}`
        const suffixedAbs = this.resolveSafePath(finalTrashRel)
        if (!suffixedAbs) return { ok: false, code: 'PATH_ESCAPE', reason: '回收站路径越出书仓库' }
        finalTrashAbs = suffixedAbs
      }
      // W-P2-1：软删前抓取定稿基线随 TrashEntry 落账（主清单条目稍后删除，不先抓就找不回）
      let priorFinalized: { finalizedRevision?: string; finalizedAt?: string; tags?: string[]; order?: number } = {}
      try {
        if (existsSync(this.manifestPath)) {
          // R27-46（二十七轮）：strict 读——瞬态读失败不再静默降级「从未定稿」（还原后
          // 防覆盖闸失守且零留痕），warn 后仍按无基线落账（软删主流程不因基线读失败
          // 中止；真正的 fail-closed 由下方 appendTrashEntry 的 strict 读把守——trash
          // 清单读得失败时登记不成则删不成，GG-P2-6）。
          const prior = readManifestStrict(this.manifestPath).entries.get(docId)
          if (prior) {
            // R27-47：tags/order 一并随 TrashEntry 落账（还原时带回清单）
            priorFinalized = {
              ...(prior.finalizedRevision ? { finalizedRevision: prior.finalizedRevision, finalizedAt: prior.finalizedAt } : {}),
              ...(prior.tags && prior.tags.length > 0 ? { tags: prior.tags } : {}),
              ...(typeof prior.order === 'number' ? { order: prior.order } : {}),
            }
          }
        }
      } catch (e) {
        log.warn('document', `软删 ${docId} 前读定稿基线失败（按无基线落账，还原后该章不带定稿态）：${e instanceof Error ? e.message : String(e)}`)
      }
      // GG-P2-6：回收站登记先于移文件，且登记写失败即中止整个软删（宁删失败）——
      // 原实现「先 rename 进 .trash、后补登记」，登记失败（磁盘满/登记路径被占）被
      // catch {} 静默吞掉，结果是文件已删而回收站无记录，作者永远无法还原（静默丢稿）。
      // 登记失败 → WRITE_ERROR（API 层 structStatus 映射 500），文件原地未动、清单条目保留。
      // 反向残留（登记成功而 rename 失败）留下指向不存在 trashedPath 的孤儿条目——无害：
      // 源文件未动，restore 报 NOT_FOUND、purge 可清。
      // R26-48：换名重试链里 trashedPath 变化须重登记（条目记的是真实落位），条目
      // 基座（id/originalPath/role/基线）抽出共用。
      const entryBase = {
        id: docId,
        originalPath: oldPath,
        trashedAt: new Date().toISOString(),
        role: layoutOf(oldPath).role,
        ...priorFinalized,
      }
      try {
        appendTrashEntry(this.bookRoot, { ...entryBase, trashedPath: finalTrashRel })
      } catch (e) {
        return {
          ok: false,
          code: 'WRITE_ERROR',
          reason: `回收站登记写入失败，已中止删除（文件未动，请检查磁盘后重试）：${errMsg(e)}`,
        }
      }
      // R26-48（二十六轮）：软删落位改 linkOrRenameExclusive 独占探测——原
      // existsSync 预检 + renameSync 之间存在跨进程窄窗：他进程并发落位同名回收站
      // 目标时 POSIX rename / win MOVEFILE(REPLACE_EXISTING) 静默覆盖，上一版回收站
      // 内容无痕丢失。'exists' 时沿用 R73-34 时间戳后缀重试链（换名 → 重登记 → 再落
      // 位，有界 3 次——毫秒级窄窗连撞 3 个时间戳的形态只剩目录被塞满的病态卷）；
      // 重试耗尽按 WRITE_ERROR 收口（文件原地未动，孤儿条目无害如上）。EPERM 降级
      // rename 由 linkOrRenameExclusive 内部处理（非 NTFS 卷软删可用性）。
      let landed = linkOrRenameExclusive(oldSafe, finalTrashAbs)
      for (let attempt = 0; landed === 'exists' && attempt < 3; attempt++) {
        const { stem, ext } = trashStemExt()
        finalTrashRel = `工作区/.trash/${encodeDocDirName(docId)}-${stem}-${Date.now()}-${attempt + 2}${ext}`
        const retryAbs = this.resolveSafePath(finalTrashRel)
        if (!retryAbs) return { ok: false, code: 'PATH_ESCAPE', reason: '回收站路径越出书仓库' }
        mkdirSync(dirname(retryAbs), { recursive: true })
        finalTrashAbs = retryAbs
        try {
          appendTrashEntry(this.bookRoot, { ...entryBase, trashedPath: finalTrashRel })
        } catch (e) {
          return {
            ok: false,
            code: 'WRITE_ERROR',
            reason: `回收站登记写入失败，已中止删除（文件未动，请检查磁盘后重试）：${errMsg(e)}`,
          }
        }
        landed = linkOrRenameExclusive(oldSafe, finalTrashAbs)
      }
      if (landed === 'exists') {
        return {
          ok: false,
          code: 'WRITE_ERROR',
          reason: '回收站落位失败：目标名被持续并发占用（含时间戳后缀重试 3 次），文件未删除，请重试',
        }
      }
      // link 落位后源仍在原位（同 inode 硬链接）——删源完成软删；降级 rename 落位时
      // 源已搬走，rmSync force 为 no-op。
      rmSync(oldSafe, { force: true })
      // P1-S3：rename 成功后 manifest 更新改 best-effort——失败不阻断（文件已实质删除，
      // 回收站 manifest / 主清单不一致不影响数据安全，下次操作自然修复）
      try {
        if (existsSync(this.manifestPath)) {
          // X-5：RMW 持清单锁（跨进程互斥）
          withManifestLock(this.manifestPath, () => {
            const m = readManifestStrict(this.manifestPath) // R27-40：RMW strict 读——读失败拒删，保住全书登记
            m.entries.delete(docId)
            writeManifest(this.manifestPath, m)
          })
        }
      } catch {
        // Z-6（第五十八轮）：注释如实化——并无「树重建自动清理」机制（removeEntry 零生产
        // 调用方、buildTree 只读不修剪）。残留形态=清单条目指向已不存在路径：树不受影响
        // （按盘扫描），executeSave 的回收站复活守卫已按「回收站认领+文件不在盘」双条件
        // 拦截（见下），作者经回收站还原即自愈（rename 回原位 + 清单 upsert + 条目清除）。
      }
    } catch (e) {
      return { ok: false, code: 'WRITE_ERROR', reason: `删除失败：${errMsg(e)}` }
    }
    invalidateTreeIndex(this.bookRoot, true)
    return { ok: true, docId, trashedPath: finalTrashRel }
  }
}

/** 错误信息提取（避免重复 try/catch 样板）。 */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** R26-55（二十六轮）：createDocument 的单段消毒——文件段带 .md 扩展名时只消毒标题段
 *  再原样拼回扩展名（大小写保留），目录段/无扩展名段整体消毒。sanitizeFileNamePart
 *  对空段兜底「未命名」，故 `/.md` 形态落为 `未命名.md`，不产生空段。 */
function sanitizeCreateSegment(seg: string): string {
  if (seg.toLowerCase().endsWith('.md')) {
    return sanitizeFileNamePart(seg.slice(0, -3)) + seg.slice(-3)
  }
  return sanitizeFileNamePart(seg)
}

/** 短篇正文（写作/正文/ + 书级 kind=short）——标题编辑联动文件名 rename + 清单同步。 */
function isPieceBody(relPath: string, bookRoot: string): boolean {
  if (roleOf(relPath) !== 'chapter') return false
  const cfg = readBookConfig(join(bookRoot, 'book.yaml'))
  return cfg.ok ? (cfg.config.kind ?? 'long') === 'short' : false
}

/** N-11（第十二轮）：fm 章号归一——引号包裹的纯数字串（作者手写/外部工具写回的
 *  `章号: "12"`）与数字同等参与文件名派生；此前 typeof === 'number' 判不过就回落
 *  basename 前缀提取，改标题后章号段静默劣化。非数字（含小数/空/杂串）→ null 走
 *  原回落；仅用于文件名派生，fm 原值不回写（M-2 字节级忠实口径）。 */
function normalizeChapterNo(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim())
  return null
}

/** 深度优先找 legacyId(path) === docId 的叶子，返回其 relPath；无匹配 null。 */
function findByLegacyId(nodes: TreeNode[], docId: string): string | null {
  for (const n of nodes) {
    if (!n.isDirectory && legacyId(n.path) === docId) return n.path
    if (n.children.length) {
      const hit = findByLegacyId(n.children, docId)
      if (hit) return hit
    }
  }
  return null
}
