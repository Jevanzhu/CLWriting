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
 * 结构性操作（W2A §7：create/move/rename/trash）：
 *   不走 queue（与同 docId 的排队 save 并发时，最坏 save 撞 REVISION_CONFLICT
 *   返回，不损坏数据）。清单/journal/回收站登记的 RMW 原子性由跨进程锁承担
 *  （withManifestLockAsync / journal 锁 / trash 清单锁）——R37-15（三十七轮）注释
 *   如实化：旧称「同步实现（renameSync/mkdirSync + 同步清单写），靠 Node 单线程
 *   微任务不交错保证清单原子性」是 R31-20/R34D-19 异步化与 P3-10/X-5/Z-5 加锁之前
 *   的过时口径（结构性操作现已全异步，磁盘 IO 用同步原语、锁等待走异步轮询）。
 *   移动/重命名带 journal move-pending 兜底（P3-10：pending → snapshot+rename →
 *   清单更新 → settled，窗口内崩溃由进门 healthCheck 确定性收口）；软删按 GG-P2-6
 *   「先登记后移文件」。事务顺序：预检查 → snapshot 留底 → fs 操作
 *  （linkOrRenameExclusive 独占落位）→ 清单同步 → invalidateTreeIndex。结构性操作
 *   触发旧书建清单（W0-1 §4.2）。
 *
 * 冲突 / 能力不足 / 落盘失败 → 不落盘、journal 标 aborted（save）/ 返回 {ok:false,code}。
 * 崩溃恢复面在 state.ts assembleStatus（findUnsettled + healMovePending + crashedWrite
 * 报文）——R34D-17（三十四轮）：本类曾有的 recover() 盘点方法生产零调用且不做
 * healMovePending（与真恢复面行为分叉的假象覆盖），已删；测试改直测 findUnsettled。
 *
 * docId 是稳定 ID（队列/日志/清单 key），relPath 是落盘路径。
 *
 * R0916-5e（2026-09-16，⑤④产品巨件拆分波1）：缝 A/B 纯移动拆分——非 UTF-8 守卫与
 *   四组锁档常量/testableConst getters 迁 service-guards.ts（本文件逐名 re-export，
 *   消费方 import 面不变）；尾部 8 个自由函数（trashBaselineOf 等）迁
 *   service-helpers.ts（原模块私有，本文件内部 import）。零行为变化。
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { safeDocId, resolveWithinRoot, docJoinKey, platformCaseFold, normalizeWinSeparators } from '../fs/safe-path.js'
import { atomicWriteFile, createFileExclusive, linkOrRenameExclusive, renameWithRetry, rmWithRetry } from '../fs/atomic.js'
import { canonicalizeText, bufferNeedsCanonical, toNfcName } from '../fs/text-canonical.js'
import { computeRevision, computeRevisionBytes, type Revision } from './revision.js'
import { layoutOf, isInternalBookPath } from './layout.js'
import { appendAborted, appendMovePending, appendPending, appendSettled } from './journal.js'
import { writeVersion, DEFAULT_VERSION_POLICY, readGlobalSnapshotPolicy, encodeDocDirName, type VersionPolicy } from './version.js'
import { readManifestStrict, writeManifest, upsertEntry, withManifestLockAsync, type ManifestEntry } from './manifest.js'
import { SaveQueue } from './queue.js'
import { generateDocId, legacyId } from './stable-id.js'
import { invalidateTreeIndex, invalidateTreeIndexForContent, scanBookTree } from './tree.js'
import { bodyOf } from '../format/frontmatter.js'
// R42-7（四十二轮）：Z-6 守卫读改 strict——readTrashManifest 容错版只供只读展示面
// （X-P3a：读失败按「无回收站」处理），本文件不再使用容错版。
import { appendTrashEntryAsync, readTrashManifestStrict, removeTrashEntryAsync } from './trash.js'
import { errMsg, log } from '../log/index.js'
import { isUtf8Bytes, NON_UTF8_SAVE_REJECT, getStructSaveLockTimeoutMs, getWiringSaveLockTimeoutMs, saveLockTimeoutMs } from './service-guards.js'
import { trashBaselineOf, isSamePhysicalFile, sanitizeCreateSegment, isSanitizedCreatePath, findByLegacyId } from './service-helpers.js'
// R0916-5j（2026-09-16，⑤④收官补批）缝 C：meta 族四件正本迁 service-meta.ts（宿主
// 参数化非纯移动改写，逐处账本见该文件头注）；公开入口残核原位接线，消费面零改动。
import { updateChapterMetaLocked, updateDocMetaLocked } from './service-meta.js'
import { appendWordsDelta, todayDate } from './words-diary.js'
import { countWords } from '../format/words.js'
// R26-55（二十六轮）：createDocument 的 relPath 逐段消毒同源（sanitizeChapterTitle 是
// 同函数的章标题别名）
import { sanitizeFileNamePart, sanitizeFullFileName } from '../format/filename.js'
import { acquireCrossProcessLockAsync } from '../fs/cross-process-lock.js' // R31-20：meta 链全异步化，同步等待原语已无使用方

// R0916-5e（2026-09-16，⑤④产品巨件拆分波1）缝 A 拆分桥：守卫与锁档常量正本迁
// service-guards.ts，此处逐名 re-export——全库消费方（src/test 一律 import 自本文件）
// 零改动；缝 B 尾部 8 函数原为模块私有，无外部消费方，不入桥（仅上方内部 import）。
export {
  isUtf8Bytes,
  META_SAVE_LOCK_TIMEOUT_MS,
  getMetaSaveLockTimeoutMs,
  __setMetaSaveLockTimeoutForTest,
  getStructSaveLockTimeoutMs,
  __setStructSaveLockTimeoutForTest,
  WIRING_SAVE_LOCK_TIMEOUT_MS,
  getWiringSaveLockTimeoutMs,
  __setWiringSaveLockTimeoutForTest,
  SAVE_LOCK_TIMEOUT_MS,
} from './service-guards.js'

/** 保存输入（W0-1 §5.1）。
 *  R34D-18（三十四轮）：content 扩为 string | Buffer——Buffer 仅恢复端点字节档分支
 *  产生（readVersionRaw 原字节透传），原字节直存闭合 R26-52「字节档恢复不失真」；
 *  文本保存方（编辑器/autosave/外部合并）仍全量 string，行为不变。 */
export interface SaveDocumentInput {
  content: string | Buffer
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

/** 保存出队结果（含旧响应标记）。联合分配：保留 ok: 判别标签，可正常 narrow。 */
export type SaveOutcome = SaveResult & { superseded: boolean }

/** 新建文档输入（W2A §7）。 */
interface CreateDocumentInput {
  /** 目标相对路径（含 .md 后缀）。 */
  relPath: string
  /** 初始内容；缺省生成最小 frontmatter。 */
  content?: string
}

/** 新建结果。 */
export type CreateResult =
  | { ok: true; docId: string; path: string; revision: `sha256:${string}` }
  | { ok: false; code: 'PATH_ESCAPE' | 'CAPABILITY_DENIED' | 'ALREADY_EXISTS' | 'WRITE_ERROR' | 'BAD_INPUT'; reason: string }

/** 复制文档输入（E3.3）。relPath 由前端算好章号 +「副本」标题；后端复制源内容到该 path。 */
interface CopyDocumentInput {
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
interface MoveDocumentInput {
  docId: string
  /** 目标目录（相对 bookRoot，无尾斜杠）。 */
  toDir: string
}

/** 重命名文档输入。 */
interface RenameDocumentInput {
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
 *  R66-5 同族后果）；先归一再按 '/' 口径统一校验，'\\server\\x' 伪 UNC 也被前导斜杠拒绝。
 *  R0912-3（2026-09-12 全量重评 P2-1）：'..'/'.' 段拒绝——下方 safeSegs「已存在则原样
 *  保留」分支对 '..' 恒命中（existsSync(join(root,'a','..')) 即 root），'..' 原文直拼进
 *  manifest 而物理落位经 resolveSafePath 词法消解落在别处 → 登记与盘上路径分裂、docId
 *  身份分裂、保存恒 REVISION_CONFLICT（R66-5/R71-23 同族；口径对齐 doCopy R51-D-3）。
 *  复审-0913-mac适配 P3-2：`\` 归一收编 normalizeWinSeparators（win32-only）——win 侧
 *  R71-23 动机（path.resolve 视 `\` 为分隔符）与历史遗留兼容不变；posix 上 `\` 是合法
 *  文件名字符，含 `\` 的 toDir 按字面单段目录处理（不再扭曲为子目录）。 */
function normalizeMoveToDir(toDir: string): string | null {
  const normalized = normalizeWinSeparators(toDir).replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  if (normalized.startsWith('/') || normalized === '') return null
  const segs = normalized.split('/')
  if (segs.includes('..') || segs.includes('.')) return null
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
  /** @internal —— 缝C meta 族参数化（R0916-5j）：MetaHost 结构化消费面，剥 private（本体零触碰）。 */
  readonly bookRoot: string
  private readonly userDataPath: string | null
  private readonly queue: SaveQueue<SaveResult>
  /** @internal —— 缝C meta 族参数化（R0916-5j）：MetaHost 结构化消费面，剥 private（本体零触碰）。 */
  readonly journalDir: string
  /** @internal —— 缝C meta 族参数化（R0916-5j）：MetaHost 结构化消费面，剥 private（本体零触碰）。 */
  readonly snapshotsDir: string
  /** @internal —— 缝C meta 族参数化（R0916-5j）：MetaHost 结构化消费面，剥 private（本体零触碰）。 */
  readonly manifestPath: string

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
   *  stable-id.ts「首次结构性操作时落盘」）。未登记且非 legacy / 无匹配 → null。
   *  残留清偿批（三十四轮）：legacy 收编链全异步（upsertManifestEntryAsync，
   *  withManifestLockAsync 等待）——同步版 resolvePath/lookupPathByDocId/
   *  adoptLegacyDoc/upsertManifestEntry 已删，服务端点不再以同步 withManifestLock
   *  （Atomics.wait）落在事件循环。 */
  async resolvePathAsync(docId: string): Promise<string | null> {
    return this.lookupPathByDocIdAdoptAsync(docId)
  }

  /** 在途/排队中的保存任务数（跨全部 docId；删书/改名前 drain 探询用，第五轮）。 */
  inFlightSaves(): number {
    return this.queue.inFlight()
  }

  // R34D-17（三十四轮）：recover() 盘点方法已删——生产零调用（真恢复面 = state.ts
  // assembleStatus：findUnsettled + healMovePending + crashedWrite 报文），且它不做
  // healMovePending 与真恢复面行为分叉，「类上有 recover」的假象覆盖了真实恢复链。
  // 未结算断言请直测 journal.findUnsettled（journal.ts 生产原语）。

  // ── 串行执行体（§5.2 步骤 4-11，队列内调用）─────────

  // R30-6（三十轮）：本保存链上的全部锁等待已异步化（save 锁 / 布线锁 /
  // 清单锁均走 setTimeout 轮询原语 acquireCrossProcessLockAsync / withManifestLockAsync），
  // 事件循环不被阻塞——服务进程承载 SSE/全部接口，双进程争用窗口（最坏 5s+5s+2×5s 档）
  // 内不再出现可感知冻结；读改写/落盘本身仍为同步 FS 调用（毫秒级，无妨）。
  // 队列串行语义核实：SaveQueue.pump 以 run 的 promise 决议驱动下一项（queue.ts），
  // executeSave await 化不改变 per-docId 串行保证。
  // R30-5（三十轮）锁序：save 锁 → 布线锁 → 清单锁（全仓统一，含 finalize 链——
  // 定稿入口已改为进清单锁前预取布线锁，save↔finalize 的 ABBA 交叉对已消除）。
  // R0912-E-P3-4（2026-09-12 独立重评修复批）：本 async 函数内全部
  // `return Promise.resolve({...})` 收敛为 `return {...}`（await 点上等价，逐处改不改语义）。
  /** 复审-0914-优化修复批 P1-1（2026-09-14 修复批）：保存链锁编排单源——「save 锁
   *  （`<journalPath>.save.lock`：获取自身抛出→收口 WRITE_ERROR，等待超时 null→fail-closed
   *  收口）→ 布线锁（wiringFileLockKey 非空时；异常/超时先释放 save 锁防泄漏再收口）→
   *  body → finally 逆序 release（release 幂等）」。此前 executeSave /
   *  updateChapterMetaLocked / updateDocMetaLocked / doMoveOrRename / doTrash 五处各持
   *  一份 ~50 行同构编排；锁序（全仓 save → 布线 → 清单）与失败语义逐位不变：
   *  - holdSaveLock=false（doMoveOrRename 调用方已持同 docId save 锁）：跳过取锁与释放；
   *  - wiring 缺省（结构性操作段）：不取布线锁，零开销（布线判定 wiringFileLockKey
   *    仍在 helper 内单源执行，与旧各处就地判定同位同序）；
   *  - 失败收口文案各调用面专属（超时/异常文案逐字保留），由回调注入。
   *  R72-1（save 锁动机）/R48-6（获取抛出收口）/R29-7+R30-5（布线锁与锁序）/
   *  R30-6（等待异步化）的机制本体自本批起单源此处，动机沿革见各调用面注释。 */
  /** @internal —— 缝C meta 族参数化（R0916-5j）：MetaHost 结构化消费面，剥 private（本体零触碰）。 */
  async withSaveLocks<T>(args: {
    journalPath: string
    /** 调用方已持同 docId save 锁时 false（锁基建禁同进程嵌套同路径锁，重取必超时）。 */
    holdSaveLock?: boolean
    saveTimeoutMs: number
    onSaveLockThrown: (e: unknown) => T
    onSaveLockTimeout: () => T
    wiring?: { relPath: string; timeoutMs: number; onThrown: (e: unknown) => T; onTimeout: () => T }
    body: () => Promise<T>
  }): Promise<T> {
    let docSaveLock: (() => void) | null = null
    if (args.holdSaveLock ?? true) {
      try {
        docSaveLock = await acquireCrossProcessLockAsync(`${args.journalPath}.save.lock`, args.saveTimeoutMs)
      } catch (e) {
        return args.onSaveLockThrown(e)
      }
      if (!docSaveLock) return args.onSaveLockTimeout()
    }
    let wiringLock: (() => void) | null = null
    if (args.wiring) {
      const wiringKey = this.wiringFileLockKey(args.wiring.relPath)
      if (wiringKey) {
        try {
          wiringLock = await acquireCrossProcessLockAsync(wiringKey, args.wiring.timeoutMs)
        } catch (e) {
          docSaveLock?.()
          return args.wiring.onThrown(e)
        }
        if (!wiringLock) {
          docSaveLock?.()
          return args.wiring.onTimeout()
        }
      }
    }
    try {
      return await args.body()
    } finally {
      // R29-7：布线文件锁先于 save 锁释放（逆获取序），release 幂等
      if (wiringLock) wiringLock()
      if (docSaveLock) docSaveLock()
    }
  }

  private async executeSave(
    docId: string,
    relPath: string,
    absPath: string,
    input: SaveDocumentInput,
  ): Promise<SaveResult> {
    // P1-SEC-A：journal 路径含 docId，显式校验防穿越（与 version.ts/analysis.ts 对齐）
    if (!safeDocId(docId)) return { ok: false, code: 'PATH_ESCAPE', reason: '文档 ID 非法' }
    // R68-3（十六轮）：文件名编码（`:`→`_`）——legacy docId 的字面名在 win 上非法
    // （EINVAL/NTFS ADS），appendPending 记不上 = 保存链路永久 WRITE_ERROR。读侧
    // 文件名编码（R68-3，win legacy 冒号防线）；未结算读侧反解见 journal/state 消费面。
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
    // 残留清偿批（三十四轮）：前段收编迁异步孪生——原同步 lookupPathByDocId 的
    // legacy 收编段走 withManifestLock 同步睡，在保存链前段重新引入事件循环阻塞。
    let registered: string | null
    try {
      registered = await this.lookupPathByDocIdAdoptAsync(docId)
    } catch (e) {
      return {
        ok: false,
        code: 'WRITE_ERROR',
        reason: `保存前清单查询失败（未执行保存，可重试）：${errMsg(e)}`,
      }
    }
    if (registered !== null && docJoinKey(registered) !== docJoinKey(relPath)) { // R38-14 win 折叠 + R41-2 NFC 归一
      return {
        ok: false,
        code: 'REVISION_CONFLICT',
        reason: `文档已移动或重命名（现路径 ${registered}），本次保存目标 ${relPath} 已失效，请刷新后重试`,
      }
    }
    // Z-6（第五十八轮）：双条件复活守卫——doTrash 尾段（rename 后清单删除前）崩溃/写失败
    // 会残留指向旧路径的清单条目，旧判定「registered === null 才查回收站」被残留绕过
    //（expectedRevision=null 的保存按「文件不存在=新建」通过基线校验 → 旧路径复活已删文件，
    // 且随后 restoreTrash 报 OCCUPIED 还原受阻）。改为：回收站认领该 docId 且
    //（未登记 或 目标文件不在盘）即拒。
    // R42-7（四十二轮）：守卫读换 readTrashManifestStrict（trash.ts R27-40，restoreTrash
    // 入口先例）——原容错版读失败按空表（X-P3a 只读展示面口径）= 判定面静默放行复活窗；
    // strict 读失败上抛，此处按保守拒绝收口（fail-closed：WRITE_ERROR、未落盘、可重试，
    // 对齐本文件错误信封），ENOENT 仍合法空（无回收站的新书不受影响）。
    let trashClaimed: boolean
    try {
      trashClaimed = readTrashManifestStrict(this.bookRoot).some((t) => t.id === docId)
    } catch (e) {
      return {
        ok: false,
        code: 'WRITE_ERROR',
        reason: `回收站清单读取失败（复活守卫按保守拒绝，未执行保存，可重试）：${errMsg(e)}`,
      }
    }
    if (trashClaimed && (registered === null || !existsSync(absPath))) {
      return {
        ok: false,
        code: 'REVISION_CONFLICT',
        reason: '文档已删除（在回收站中），拒绝在原路径复活文件；如需恢复请从回收站还原',
      }
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
    // 语义不变。R48-6（四十八轮）：锁获取自身抛出（锁文件创建 ENOSPC/EACCES 等瞬态）
    // 收口 WRITE_ERROR。
    // R29-7/R30-5：布线文件在 save 锁内再取同名文件锁（与 lead-finalize 回写临界段互斥，
    // 超时/获取异常 fail-closed 拒绝并先释放 save 锁防泄漏）。锁序：save → 布线 → 清单。
    // 复审-0914-优化修复批 P1-1（2026-09-14 修复批）：取锁/释放编排单源化至 withSaveLocks，
    // 锁序与失败语义逐位不变；本处保留调用面专属文案与锁档。
    return this.withSaveLocks<SaveResult>({
      journalPath,
      saveTimeoutMs: saveLockTimeoutMs,
      onSaveLockThrown: (e) => ({
        ok: false,
        code: 'WRITE_ERROR',
        reason: `保存锁获取失败（未执行保存，可重试）：${errMsg(e)}`,
      }),
      onSaveLockTimeout: () => ({
        ok: false,
        code: 'WRITE_ERROR',
        reason: '保存等待超时：另一进程正在保存此文档（5 秒未让出），请重试',
      }),
      wiring: {
        relPath,
        timeoutMs: getWiringSaveLockTimeoutMs(),
        onThrown: (e) => ({
          ok: false,
          code: 'WRITE_ERROR',
          reason: `布线文件锁获取失败（未执行保存，可重试）：${errMsg(e)}`,
        }),
        onTimeout: () => ({
          ok: false,
          code: 'WRITE_ERROR',
          reason: '保存等待超时：另一进程正在回写此布线文件（5 秒未让出），请重试',
        }),
      },
      body: async () => {
      // R28-5 外层 catch（下方）原挂在取锁后的 try 上——主体迁入本闭包后由本内层 try
      // 承接同一收口语义（R76-22 复核与落盘段的意外抛出统一 WRITE_ERROR）。
      try {
      // R76-22（二十四轮 C 域）：锁内复核——路径登记/回收站认领守卫原先只在取锁前判
      // 一次，5s 等锁窗口内他进程 doTrash/doMoveOrRename 后，出队保存仍按旧世界落盘
      //（旧路径复活已删文件/写错位，内容重复非丢失、低危）。取锁后重判把窗口收窄到
      // 复核→写盘的毫秒级；结构性操作不持 save 锁，残余窗口如实记档。
      // R31-19（三十一轮）：legacy 收编链改走异步清单锁孪生（R30-6 全异步化口径的
      // 残留收口——非 legacy docId 行为不变，仅清单命中读）
      const registeredNow = await this.lookupPathByDocIdAdoptAsync(docId)
      if (registeredNow !== null && docJoinKey(registeredNow) !== docJoinKey(relPath)) { // R38-14 + R41-2
        return {
          ok: false,
          code: 'REVISION_CONFLICT',
          reason: `文档已移动或重命名（现路径 ${registeredNow}），本次保存目标 ${relPath} 已失效，请刷新后重试`,
        }
      }
      // R42-7（四十二轮）：锁内复核同款 strict 读——读失败上抛走外层 catch 的
      // WRITE_ERROR「未落盘，可重试」（R28-5 既有收口；此刻尚未 appendPending，
      // 无孤儿可标 aborted），fail-closed 拒绝复活窗，不静默放行。
      if (
        readTrashManifestStrict(this.bookRoot).some((t) => t.id === docId) &&
        (registeredNow === null || !existsSync(absPath))
      ) {
        return {
          ok: false,
          code: 'REVISION_CONFLICT',
          reason: '文档已删除（在回收站中），拒绝在原路径复活文件；如需恢复请从回收站还原',
        }
      }
      // 步骤 2：revision 校验（串行内执行，保证并发一致）
      // R39-11（三十九轮）：单读派生——对齐 R73-40/R27-45 手法，锁内一次整读 Buffer，
      // rev（computeRevisionBytes）/ UTF-8 闸（isUtf8Bytes）/ wordDelta 旧文 / 快照
      // 留底（maybeSnapshot diskContent）四产物同源。此前 4 次独立整读（rev/UTF-8 闸/
      // 旧文/快照各读一次），结构性操作不持 save 锁的窗口内文件被替换时判据与写回
      // 错源（微 TOCTOU），且 2MB 章每笔保存 4× 全文 IO。读失败（win 瞬时锁等）走
      // 外层 catch WRITE_ERROR「未落盘，可重试」，与原 computeRevision 抛错同语义。
      const existing = existsSync(absPath)
      const diskBytes: Buffer | null = existing ? readFileSync(absPath) : null
      const currentRev: Revision = diskBytes ? computeRevisionBytes(diskBytes) : null
      if (input.expectedRevision !== currentRev) {
        const reason = existing
          ? `基线不符（期望 ${input.expectedRevision ?? 'null'}，磁盘 ${currentRev}）`
          : `期望基线 ${input.expectedRevision} 但文件不存在`
        return { ok: false, code: 'REVISION_CONFLICT', reason }
      }

      // M-5（第六轮）：非 UTF-8 覆写防线（save 主路径含 autosave）——新内容含 U+FFFD 且
      // 盘上字节不是合法 UTF-8（fatal 解码探测）时拒绝：GBK 文件被错误编码打开后 autosave
      // 把乱码原子覆盖回原文件，设定/大纲等非 chapter 文档无快照兜底（maybeSnapshot 只留
      // 底章），原始字节永久丢失。盘上为合法 UTF-8 时放行（含真实 � 字符的普通编辑）。
      // R75-3（二十三轮）：条件缺口收口——原仅拦「新内容含 U+FFFD 且盘上非 UTF-8」，
      // 新内容干净时静默放行覆写，而 maybeSnapshot 以 utf-8 读盘留底的是失真快照（假
      // 留底，覆写后原字节任何形式不可恢复）。对齐 draft-pipeline R66-1 / lead-finalize
      // M-9 的无条件口径：盘上非 UTF-8 一律拒绝，先转码再保存。
      // R34D-18（三十四轮）：Buffer 内容放行——该防线的威胁模型是「文本往返失真覆写」，
      // 字节档恢复（readVersionRaw 原字节透传）正是把原始字节写回盘上的反悔通道，
      // 拦它等于剥夺 GBK 档唯一的无损恢复路径。
      const content =
        typeof input.content === 'string' ? canonicalizeText(input.content) : input.content
      const byteRestore = Buffer.isBuffer(content)
      // R39-11：UTF-8 闸改判单读字节（原 :438 二次 readFileSync）
      if (diskBytes !== null && !byteRestore && !isUtf8Bytes(diskBytes)) {
        return NON_UTF8_SAVE_REJECT
      }

      // 步骤 4：journal pending（含全文快照，防丢字）
      // RB-KN-P2-2：pending 记不上就不能继续写（无 journal 兜底的落盘违反崩溃恢复协议），
      // 且失败须走 SaveResult 契约（原在此处直接抛出，save() 变 rejected promise，调用方易 unhandled rejection）
      // R34D-18：字节档 pending 存空串——journal 全文快照是崩溃提示的恢复材料，存失真
      // 文本视图（U+FFFD）会在作者按提示「恢复」时写回失真内容；字节档的恢复材料就是
      // 版本档原件（恢复操作不动它），空串 pending 仍完整承担崩溃检测（crashedWrite 提示）
      let opId: string
      try {
        opId = await appendPending(journalPath, docId, currentRev, byteRestore ? '' : content)
      } catch (e) {
        return {
          ok: false,
          code: 'WRITE_ERROR',
          reason: `journal 追加失败，保存未执行：${errMsg(e)}`,
        }
      }

      try {
        // P2-BE-1：wordDelta 计算移入 try——readFileSync 失败时 journal 标 aborted（而非孤儿 pending 误报崩溃）
        // 步骤 4.5：算字数 delta（E4）——须在 atomicWrite 前读旧内容；strip fm 口径（与前端 updateWordCount 一致）
        // R34D-18：字节档不记增量——GBK 字节无安全文本视图，失真视图的字数是伪值，
        // 字数日记宁缺毋错（delta 0）
        // PM-4（性能与内存专项·2026-09-05）：保存链副本收敛三连（200 万字书每笔保存
        // 峰值副本 15-25× → 显著回落）——
        // ① 新内容单次 Buffer 化（contentBytes）：写盘（atomicWriteFile/createFileExclusive）
        //    与新 revision（computeRevisionBytes）共用同一份字节。原 :568 在落盘后
        //    `Buffer.from(content, 'utf-8')` 为算 revision 再编码一次全文副本，纯属浪费。
        // ② 旧文 words 走 revision 键控缓存（this.docWordsCache）：原每笔保存
        //    `diskBytes.toString('utf-8')` 物化整篇旧文（2MB 章 ≈4MB 瞬时字符串）只为
        //    countWords 一次。以 currentRev（diskBytes 的 sha256）为键——同字节 ⇒ 同
        //    字数（countWords 对内容确定性），外部编辑器/他窗写入必变 rev ⇒ 缓存自动
        //    失效重算，零陈旧窗口；未命中（首笔/外部改动后）才物化一次并回填。
        // ③ oldBodyText 整体消除：maybeSnapshot 改吃 diskBytes 字节直存（UTF-8 闸已
        //    保证非字节档路径盘上为合法 UTF-8，Buffer 直存与 utf-8 往返字节一致，
        //    R28-13 同款论证）；快照 meta.words 顺带用 oldWords（PM-6：免版本面板
        //    对无字数版本的全量读 + 重数兜底，finalize.ts R27-41 同款先例）。
        const contentBytes = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content
        const newWords = byteRestore ? null : countWords(bodyOf(content))
        let oldWords: number | null = null
        if (diskBytes !== null && !byteRestore) {
          const cached = this.docWordsCache.get(docId)
          if (cached !== undefined && cached.rev === currentRev) {
            oldWords = cached.words
          } else {
            oldWords = countWords(bodyOf(diskBytes.toString('utf-8')))
            this.rememberDocWords(docId, currentRev, oldWords)
          }
        }
        const wordDelta = byteRestore ? 0 : (newWords ?? 0) - (oldWords ?? 0)

        // 步骤 5：按策略建 snapshot（修改前版本留底）
        // R35-4：byteRestore 是非 UTF-8 档唯一合法覆写通道，留底须传原始字节——缺省
        // utf-8 文本读会把 GBK 盘上内容解码成 U+FFFD 写入 .版本（假留底，原字节此后
        // 无任何副本；同 doMoveOrRename/doTrash 的原字节直存口径）
        // R39-11：留底同源单读——byteRestore 传原始字节（口径不变）；普通保存传单读
        // 文本（原 :473 再读一次 / :596 兜底读消除）。连带修复：原 `byteRestore ?
        // readFileSync(absPath) : undefined` 在「字节档恢复到尚不存在路径」时参数求值
        // 即 ENOENT 抛 WRITE_ERROR（maybeSnapshot 的 !existsSync 自守够不到），改传
        // diskBytes（不存在时 null→undefined）后该路径落 P5-数据层注释宣称的「无底可
        // 留，跳过快照正常新建落盘」语义。
        // PM-4：普通保存也改传 diskBytes 字节直存（见上方 ③），oldBodyText 消除后
        // 两分支合一；words 传 exact 口径（byteRestore 无安全文本视图不传，面板对
        // 稀疏字节档回落全量读兜底）。
        this.maybeSnapshot(
          docId,
          relPath,
          absPath,
          input,
          currentRev,
          diskBytes ?? undefined,
          !byteRestore && oldWords !== null ? oldWords : undefined,
        )
        // 步骤 6-7：atomic write + fsync + rename + fsync 父目录
        // R26-49（二十六轮）：新建路径（expectedRevision=null）不再裸 rename——基线校验
        // （文件不存在）与落盘之间无互斥，他进程并发新建同名文件时 atomicWriteFile 的
        // rename 会静默覆盖先到者内容且本方返回成功（lost update）。改 createFileExclusive
        // 独占创建（link 不覆盖，R26-7 起自带非 NTFS 卷 rename 降级）：'exists' = 落位时
        // 目标已被并发创建，按既有 REVISION_CONFLICT 口径拒绝（「世界已变，请刷新重试」，
        // 同 V-P2-1 出队守卫的语义，不新增错误码），journal pending 补 aborted 后返回。
        if (existing) {
          atomicWriteFile(absPath, contentBytes, { fsync: true })
        } else {
          // R40-24（四十轮）：新建路径消毒闸——save 新建分支（expectedRevision=null 且文件
          // 不在盘）此前不经单源消毒器（词法越界已被 resolveSafePath 拦，但 win 保留设备
          // 名/尾点/尾空格/控制字符/非法字符段直落盘：win 上 EINVAL 裸 WRITE_ERROR 或读写
          // 名不一致），create/copy/rename 均已收编单源（R26-55/R33-9/R2W-5），本分支为
          // R33-9 同族漏网点。弃暗拒明（fail-closed）：任一待建段「消毒后会改写」即拒
          // ——不静默改写落盘（docId↔relPath 由调用方绑定，改写即造「清单≠盘上名」分裂，
          // 正是 R33-9 当年修的缺陷形态）；已存在文件的覆写不铸新名，不走本闸。
          if (!isSanitizedCreatePath(relPath)) {
            try {
              await appendAborted(journalPath, opId, '新建路径段不合消毒规则（保留名/尾点/尾空格/非法字符）')
            } catch {
              // journal 留痕失败吞掉（best-effort）：必须保住 {ok:false} 契约
            }
            return {
              ok: false,
              code: 'PATH_ESCAPE',
              reason: `新建路径 ${relPath} 含不合消毒规则的段（Windows 保留设备名/尾点/尾空格/控制字符/非法字符），已拒绝——请改用合法文件名（或经新建文档入口，将自动消毒）`,
            }
          }
          const created = createFileExclusive(absPath, contentBytes, { fsync: true })
          if (created === 'exists') {
            try {
              await appendAborted(journalPath, opId, '新建落位时目标已被并发创建（REVISION_CONFLICT）')
            } catch {
              // journal 留痕失败吞掉（best-effort）：必须保住 {ok:false} 契约
            }
            return {
              ok: false,
              code: 'REVISION_CONFLICT',
              reason: `预期新建，但落位时 ${relPath} 已被并发创建（另一进程先到）——请刷新后基于最新内容重试`,
            }
          }
        }
        // 步骤 8：新 revision
        // R40-20（四十轮）：单写派生（R39-10/11 单读派生同族）——此前 computeRevision(absPath)
        // 落盘后再读一次盘：写完成与快照读之间他窗并发写（同 docId 保存已被队列/save 锁
        // 串行，但结构性操作/外部编辑器不持 save 锁）读到的可能是别窗内容，revision 代际
        // 标注短暂失真（journal 可对账自愈，影响面=快照标注）；且每笔保存多一次全文 IO。
        // 刚写入的字节即 content（string→utf8 / Buffer 原样，atomicWriteFile 零转换），
        // 直接 computeRevisionBytes 派生，与盘上最终态恒等。
        // PM-4：直接复用 contentBytes（与写盘同一份字节，不再二次编码；字符串分支
        // 的 Buffer 化已在上文完成且与写盘字节同源恒等）。
        const newRev = computeRevisionBytes(contentBytes)
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
          log.warn('document', `保存后清单刷新失败（${relPath}，树扫描将自愈收编）：${errMsg(e)}`)
        }
        // R46-8（四十六轮）：保存后树缓存失效统一口径——此前 executeSave 完全不失效
        // （树 wordCount/status 靠 stat 指纹自愈 + 前端 refresh=1 兜底），与 files.ts PUT /
        // draft-pipeline 的「过度失效」两极分叉；三链路统一为单键失效（indexes 重建 +
        // 只清本次改写文件的 probe 键）
        invalidateTreeIndexForContent(this.bookRoot, relPath)
        // 步骤 10：journal settled。
        // R27-44（二十七轮）：settled 失败不误报——此刻正文已原子落盘、清单已刷新，
        // 原裸调用落入下方 catch 会返回 WRITE_ERROR（编辑器误报失败、重试必撞
        // REVISION_CONFLICT，journal 悬置 pending 误报 crashedWrite），与 R75-4 对清单
        // 刷新的定性完全同型。改 best-effort：warn 留痕 + 按成功收口。
        try {
          await appendSettled(journalPath, opId, newRev)
        } catch (e) {
          log.warn('document', `保存已落盘但 journal settled 写失败（${docId}，恢复链下次启动将按 pending 自愈复核）：${errMsg(e)}`)
        }
        // P2-BE-4：字数增量 best-effort（settled 后失败不影响保存结果——否则文件已落盘但返回 WRITE_ERROR 误报失败）
        try {
          appendWordsDelta(this.bookRoot, todayDate(), wordDelta, docId)
        } catch {
          // 磁盘满等忽略——保存已成功，字数日记丢失可接受
        }
        // PM-4：成功落盘后回填新文字数缓存——下一笔保存的 oldWords 直接命中
        //（rev 键控：即便此笔回填后文件又被外部改动，rev 不匹配自动失效，无害）。
        if (newWords !== null) this.rememberDocWords(docId, newRev, newWords)
        // 步骤 11
        return { ok: true, revision: newRev }
      } catch (e) {
        // 失败：journal 标 aborted（atomicWriteFile 失败已自清 tmp，未落盘）
        try {
          await appendAborted(journalPath, opId, errMsg(e))
        } catch {
          // journal 写失败忽略（best-effort，不影响返回）
        }
        return {
          ok: false,
          code: 'WRITE_ERROR',
          reason: `保存失败：${errMsg(e)}`,
        }
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
      return {
        ok: false,
        code: 'WRITE_ERROR',
        reason: `保存失败（未落盘，可重试）：${errMsg(e)}`,
      }
    }
      },
    })
  }

  /** snapshot 策略（W0-1 §7）：restore/external-merge 覆盖前、定稿章首改前留底。
   *  保存前留底走节流（policy.throttleMinutes），结构性操作（改名/删除）不节流。
   *  PM-6（性能与内存专项）：words 形参——调用方已算出的正文确切字数（executeSave
   *  的 oldWords）透传进版本 meta，免版本面板对无字数版本全量读 + 重数兜底
   *  （listVersionEntries 读侧口径，finalize.ts R27-41 同款先例）。 */
  private maybeSnapshot(
    docId: string,
    relPath: string,
    absPath: string,
    input: SaveDocumentInput,
    baseRevision: Revision,
    // R35-4：Buffer = 调用方已按原始字节整读（byteRestore 恢复链）——字节保真留底
    diskContent?: string | Buffer,
    words?: number,
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
    writeVersion(
      this.snapshotsDir,
      docId,
      currentContent,
      { origin: input.origin, reason, baseRevision, words },
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

  /** PM-4（性能与内存专项）：docId → 盘上整文件 revision 与其正文字数的缓存。
   *  以 revision（整文件 sha256）为键控：同字节 ⇒ 同正文字数（countWords 确定性），
   *  外部编辑器/他窗写入必变 rev ⇒ 命中判据自动失效重算，零陈旧窗口；命中时保存链
   *  免 diskBytes.toString('utf-8') 整篇旧文物化（2MB 章 ≈4MB 瞬时字符串）。
   *  上限防御（AA-P1-1 口径）：超限整体清空，最坏重算一次（条目仅 ~50B/文档）。 */
  private docWordsCache = new Map<string, { rev: Revision; words: number }>()

  /** PM-4：字数缓存写入（executeSave 旧文侧回填 + 成功落盘后新文侧回填共用）。 */
  private rememberDocWords(docId: string, rev: Revision, words: number): void {
    if (this.docWordsCache.size >= 4096) this.docWordsCache.clear()
    this.docWordsCache.set(docId, { rev, words })
  }

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

  /** @internal —— 缝C meta 族参数化（R0916-5j）：MetaHost 结构化消费面，剥 private（本体零触碰）。 */
  snapshotPolicy(): VersionPolicy {
    const global = this.readGlobalPolicyCached()
    return {
      maxDays: global.maxDays ?? DEFAULT_VERSION_POLICY.maxDays,
      maxCount: global.maxCount ?? DEFAULT_VERSION_POLICY.maxCount,
      throttleMinutes: DEFAULT_VERSION_POLICY.throttleMinutes,
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
  /** @internal —— 缝C meta 族参数化（R0916-5j）：MetaHost 结构化消费面，剥 private（本体零触碰）。 */
  resolveSafePath(relPath: string): string | null {
    const safe = resolveWithinRoot(this.bookRoot, relPath)
    if (!safe) return null
    // 复审-0913-mac适配 P3-2：词法面归一 win32-only（与 safe.rel 同委托单源）——
    // posix 上字面 `\` 不再被当分隔符，两侧口径对齐后跳板形态判定不劈叉
    const lexical = normalizeWinSeparators(relPath)
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
    // 复审-0913-mac适配 P3-2：前缀门归一 win32-only——真实布线文件（`布线/`、
    // `大纲/关系线/` 前缀）两种形态下判定一致、键字节用原始 relPath 不受影响；
    // files.ts wiringLockKeyForPut（范围外）暂保留无条件归一，可达路径上判定与键逐位一致
    const p = normalizeWinSeparators(relPath)
    if (p.startsWith('布线/') || p.startsWith('大纲/关系线/')) {
      const key = `${join(this.bookRoot, relPath)}.lock`
      // R38-14（三十八轮）：win32 大小写折叠（对齐 manifestLockKey R33-54）——外部
      // case-only 改名后 save 链与 lead-finalize 链此前会取不同锁文件，互斥静默失效
      // R40-15（四十轮）：lead-finalize 侧锁键已同口径折叠（wiringFileLockKeyOf）——
      // 本侧此前单侧折叠构成不对称，现两侧逐位一致（回归测试锚定同键；不为收口单一
      // 真相源引入 service↔lead-finalize 循环 import——后者已反向 import isUtf8Bytes）
      // R45-2（四十五轮）：折叠改委托 safe-path platformCaseFold 单源——safe-path 为
      // 底层叶子模块，委托不引入循环 import；前缀过滤/join/'.lock' 管线不变，键字节不变
      // 重评-0912-2 P2-3（2026-09-12 全量重评修复批）：折叠前补 toNfcName（先 NFC 后
      // 大小写折叠，与文档身份键 docJoinKey = relPathKey(toNfcName(p)) 同序并齐）——
      // mac 上清单登记路径（NFC 为主）与磁盘扫描路径（NFD，外源工具常产）此前对同一
      // 布线文件派生两个不同 .lock 文件名，保存链与终稿链（锁内重读-合并-写回）互斥
      // 静默失效（丢失更新窗）。join(bookRoot, relPath) 后整段 NFC 安全：分隔符 / 不受
      // 组合字符影响（docJoinKey 注释同口径）；NFC 输入键字节不变（与 R45-2 字节稳定
      // 不变量相容），仅 NFD 输入键变化；lead-finalize 侧（wiringFileLockKeyOf）与
      // files.ts PUT 侧（wiringLockKeyForPut）同批同式，三侧仍逐位一致
      return platformCaseFold(toNfcName(key))
    }
    return null
  }

  // ── 结构性操作（W2A §7）──────────────────
  // R37-15（三十七轮）注释如实化：旧分隔注释「同步实现」是 R31-20/R34D-19 异步化之前
  // 的过时口径——本区 create/move/rename/copy/trash 已全异步（磁盘 IO 用同步原语，
  // 清单/journal/回收站锁等待走 withManifestLockAsync 等异步轮询），原子性由跨进程锁
  // 与独占落位（createFileExclusive / linkOrRenameExclusive）承担，不靠「单线程微任务
  // 不交错」（模块头注同轮同款收口）。

  /** 新建文档（分配 docId + 落盘 + 清单登记 + invalidate）。
   *  R34D-19（三十四轮）：doCreate 转异步——清单登记锁等待走 withManifestLockAsync
   *  （setTimeout 轮询，事件循环不阻塞）；对外 Promise 契约不变（原本即 Promise 包装）。 */
  async createDocument(input: CreateDocumentInput): Promise<CreateResult> {
    return this.doCreate(input)
  }

  private async doCreate(input: CreateDocumentInput): Promise<CreateResult> {
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
    // 平台规范化批：新建内容规范形收口（模板缺省本就 LF，零介入；显式传入内容
    // （API/测试夹具）统一归一——新库生而规范）
    const content = canonicalizeText(input.content ?? this.defaultContent())
    try {
      mkdirSync(dirname(safe), { recursive: true })
      // B-6（第六十轮）：tmp + linkSync 独占创建——上方 existsSync 与落盘之间无跨进程
      // 互斥，双进程同 relPath 并发新建时 atomicWriteFile 的 rename 静默覆盖后到者
      // 内容且双方返回成功（两个 docId 先后 upsert 成同路径双认领态）；link 遇
      // EEXIST → ALREADY_EXISTS，双方各自明确。R0916-6-P3-14 无锁论证：create 目标
      // 的 docId 尚不存在（无既有身份可挂 save 锁），并发同路径新建的互斥正由本独占
      // 探测承担——无锁可取，亦无需取。
      const created = createFileExclusive(safe, content, { fsync: true })
      if (created === 'exists') return { ok: false, code: 'ALREADY_EXISTS', reason: '文件已存在' }
    } catch (e) {
      // R0913-win P3（预算面，2026-09-13 全库源码重评 win 适配修复批）：深层多段
      // relPath 超 MAX_PATH/卷上限此前落裸 errno 的 WRITE_ERROR——ENAMETOOLONG 分诊
      // 为 BAD_INPUT 人话（客户端可修：缩短标题或减少层级；对照 doInit 的「换更短的
      // 书名或更浅的书库位置」同口径）。长路径启用的卷（libuv \\?\ 前缀）不触本分支，
      // 行为不变；逐段消毒 120B 预算不动（books.ts BOOK_NAME_MAX_BYTES 单源口径）。
      if ((e as NodeJS.ErrnoException).code === 'ENAMETOOLONG') {
        return { ok: false, code: 'BAD_INPUT', reason: '路径过长（超出文件系统上限），请缩短标题或减少目录层级' }
      }
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
      await this.upsertManifestEntryAsync(docId, rel)
    } catch (e) {
      registeredDocId = legacyId(rel)
      log.warn('document', `新建后清单登记失败（${rel}，降级返回 legacy id 与树扫描自愈同源）：${errMsg(e)}`)
    }
    invalidateTreeIndex(this.bookRoot, true)
    // R47-32（四十七轮）：单写派生（R40-20 executeSave 同族）——刚写入的字节即
    // content（canonicalizeText 产出的 string 经 createFileExclusive utf-8 落盘），
    // 不再落盘后重读全文
    return { ok: true, docId: registeredDocId, path: rel, revision: computeRevisionBytes(Buffer.from(content, 'utf-8')) }
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
  // 取锁等待走 acquireCrossProcessLockAsync（setTimeout 轮询）；同进程同 docId 并发
  // PATCH 经 chainDocMetaOp promise 链串行（锁等待让出事件循环后，第二请求会撞同进程
  // pid 自锁语义——链串行保持旧同步版「单线程无交错」行为等价）。跨进程互斥
  // 仍由文件锁承担，锁序「save → 布线 → 清单」不变。
  // R37-12（三十七轮）注释如实化：旧称「锁内临界段保持全同步 FS（与 executeSave
  // 锁内段同纪律）」不实——本方法锁内尾部 await doMoveOrRename/syncRenamePieceList
  //（内部再取 journal/清单锁），executeSave 锁内段同样含 await 点（appendPending/
  // appendSettled 的 journal 锁等待、maybeUpdateManifest 的清单锁等待）与多次磁盘
  // 写。两侧共同的真实纪律是：磁盘 IO 全走同步 FS 原语（毫秒级，事件循环只让出在
  // 嵌套锁等待上），嵌套锁方向单向（save → 布线 → journal/清单）无环。
  updateChapterMeta(docId: string, meta: { 标题?: string; 章号?: number }): Promise<MoveResult> {
    return this.chainDocMetaOp(docId, () => updateChapterMetaLocked(this, docId, meta))
  }

  /** 更新文档 frontmatter 字段（通用，不联动文件名；卷纲/总纲用）。
   *  与 updateChapterMeta 的区别：不改文件名（卷纲/总纲文件名不按 章号-标题）。 */
  // R31-20（三十一轮）：同 updateChapterMeta——锁获取异步化；本方法锁内段纯
  // 同步 FS（read/patch/write，无嵌套锁），链串行与 chapter 面统一（同 docId
  // 双 meta 请求不再撞同进程 pid 自锁窗口）。
  updateDocMeta(docId: string, meta: Record<string, unknown>): Promise<MoveResult> {
    return this.chainDocMetaOp(docId, () => updateDocMetaLocked(this, docId, meta))
  }

  /** move/rename 共用：查清单 oldPath → 算 newPath → 能力校验 → snapshot → rename → 清单更新。 */
  // R31-20（三十一轮）：doMoveOrRename 改异步——尾部清单 path 更新走
  // updateManifestPath 的异步清单锁（等待期不阻塞事件循环）。
  // R0912-2（2026-09-11 重评-0911c 修复批）：落位段补 per-doc save 锁——原「本方法
  // 不取 save 锁，由调用方 save 锁内 await」留下双向复活窗：他进程 executeSave 过锁内
  // 守卫（registered/trash 复核）后、落盘前，本方法把文件 rename 走并删源，他进程的
  // atomicWriteFile/createFileExclusive 会在旧路径复活已移走文件（expectedRevision=null
  // 的新建语义尤其如此：文件不在盘 ⇒ 基线校验通过 ⇒ 独占创建复活）。现取
  // `<journal>.save.lock` 覆盖「pending → snapshot → 落位 → 删源 → 清单 path 更新 →
  // settled」整段：本方持锁时他进程 save 在取锁处等待（锁内复核看到新世界后按
  // REVISION_CONFLICT 拒绝）；他进程 save 持锁时本方等待（落位发生在其保存完成后，
  // 语义为「保存后移动/删除」，无复活）。锁序严格沿用全仓「save → 布线 → 清单」：
  // 本锁最先取（save），其后 journal 锁（appendMovePending）与清单锁
  // （updateManifestPath/upsertManifestEntryAsync 收编链）均为既有单向嵌套，无环。
  // opts.holdSaveLock：调用方已持同 docId save 锁时传 false（updateChapterMetaLocked
  // ——锁基建禁同进程嵌套同路径锁，重取必 5s 超时 fail-closed）；缺省 true（安全默认，
  // 新调用方漏声明时 fail-loud 而非静默无锁）。syncRenamePieceList 对章纲 docId 走
  // 缺省 true：章纲 save 锁与正文 save 锁是不同路径锁，正文→章纲为单向下行
  //（章纲 rename 不反带正文），无 ABBA 环。
  /** @internal —— 缝C meta 族参数化（R0916-5j）：MetaHost 结构化消费面，剥 private（本体零触碰）。 */
  async doMoveOrRename(
    docId: string,
    op: { kind: 'move'; toDir: string } | { kind: 'rename'; newName: string },
    opts?: { holdSaveLock?: boolean },
  ): Promise<MoveResult> {
    // N1（五十九轮）：journal 路径含 docId，入口显式 safeDocId 校验防穿越——executeSave
    // 已有 P1-SEC-A 守卫，此处同型构造漏校验；manifest 是可篡改数据面，构造
    // id:"../../evil" 条目后 PATCH move/rename 可把 .jsonl 写出书仓库外。
    if (!safeDocId(docId)) return { ok: false, code: 'PATH_ESCAPE', reason: '文档 ID 非法' }
    const journalPath = join(this.journalDir, `${encodeDocDirName(docId)}.jsonl`) // R68-3：同 executeSave 编码口径
    // 复审-0914-优化修复批 P1-1（2026-09-14 修复批）：取锁/释放编排单源化至 withSaveLocks
    //（R0912-2 holdSaveLock 防同进程嵌套自锁语义随迁：false = 调用方已持同 docId
    // save 锁；R48-6 获取抛出收口随迁）。结构落位段无布线文件，不传 wiring。
    return this.withSaveLocks<MoveResult>({
      journalPath,
      holdSaveLock: opts?.holdSaveLock ?? true,
      saveTimeoutMs: getStructSaveLockTimeoutMs(),
      onSaveLockThrown: (e) => ({ ok: false, code: 'WRITE_ERROR', reason: `移动/重命名保存锁获取失败（未执行操作，可重试）：${errMsg(e)}` }),
      onSaveLockTimeout: () => ({ ok: false, code: 'WRITE_ERROR', reason: '移动/重命名等待超时：另一进程正在保存或移动此文档（5 秒未让出），请重试' }),
      body: async () => {
    // R0912-3（2026-09-11 重评-0911c 修复批）：lookup 命中读已随 lookupPathByDocIdAdoptAsync
    // 收敛 strict（R27-40 口径）——瞬态读失败上抛不再落「未登记」，此处收口 WRITE_ERROR
    //（未执行操作、可重试），不裸穿 MoveResult 契约。
    let oldPath: string | null
    try {
      oldPath = await this.lookupPathByDocIdAdoptAsync(docId)
    } catch (e) {
      return { ok: false, code: 'WRITE_ERROR', reason: `移动/重命名前清单查询失败（未执行操作，可重试）：${errMsg(e)}` }
    }
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
        return { ok: false, code: 'BAD_INPUT', reason: '目标目录非法（前导斜杠、空目录或「.」「..」相对段不被接受）' }
      }
      // R33-9（三十三轮）：toDir 逐段消毒（补 doCreate/updateChapterMeta 单源纪律缺口）——
      // 段已存在则保持原样（不破坏既有目录身份，mac 存量 '备注.' 类名不受影响）；
      // 不存在（本次 mkdir 将创建）过 sanitizeFileNamePart，防 win 尾点/尾空格落盘自动剥
      // 致盘上名 ≠ manifest path（REVISION_CONFLICT 族）与保留设备名/非法字符裸 errno。
      const segs = toDir.split('/')
      const safeSegs = segs.map((seg, idx) =>
        existsSync(join(this.bookRoot, ...segs.slice(0, idx + 1))) ? seg : sanitizeFileNamePart(seg),
      )
      newPath = `${safeSegs.join('/')}/${basename(oldPath)}`
    } else {
      // C-3（二十九轮）：newName 消毒同 create 路径单源口径（format/filename.ts 单一
      // 真相源）——此前只挡路径分隔符，Windows 非法字符/控制字符/尾点尾空格/保留
      // 设备名/超长名直落盘（跨平台拷贝被拒或读写名不一致），与 create 的静默消毒
      // 行为漂移。分隔符仍由上方守卫显式拒绝，其余非法形态按 create 同款静默调整后
      // 落盘（落盘真实路径是唯一身份，返回 path 即消毒后路径）；整段（含 'NNNN-' 前缀）
      // 共用 120 字节预算，与 createDocument 同源（B-3 双封顶锚定）。
      //（win 线 R33-9 同因修复：尾点/尾空格剥离、保留设备名避让经 sanitizeFileNamePart
      // → winCompatNamePart 单源已含；其 sanitizeFullFileName 变体不做整段封顶，与本处
      // 「create 同源整段预算」口径冲突——同标题 create/rename 落名不一致属身份漂移，
      // 合并取本侧；copy 路径目标名镜像盘上既有名（预算已在原创建时付过），仍用
      // sanitizeFullFileName 扩展名感知变体。）
      // 重评-0914-三轮 P2-2（2026-09-14）：根级文档（如脚手架必落的 简介.md）dirname
      // 为 '.'——直拼产出 './新名.md' 清单键，而 docJoinKey/树扫描/保存守卫均不剥 './'
      // → 登记与盘面分裂：docId 退化 legacyId（.版本/.journal 关联断裂）+ 前端按树
      // 路径保存恒 REVISION_CONFLICT。move（normalizeMoveToDir 拒 '.'/'..'）与 copy
      // （doCopy 双拒 '.'/'..'）同族均已修，唯 rename 的 dirname()==='.' 形态漏网。
      const dir = dirname(oldPath)
      newPath = dir === '.' ? sanitizeCreateSegment(op.newName) : `${dir}/${sanitizeCreateSegment(op.newName)}`
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
    // R2W-1（win 平台专项复审 R2）：纯大小写改名在大小写不敏感 FS（win NTFS/mac APFS）
    // 上 newSafe 与 oldSafe 是**同一物理文件**——恒走 ALREADY_EXISTS，作者无法只改标题
    // 大小写。对齐书级改名 R71-8 口径：目标存在但与源 dev+ino 相等 → 放行（落位侧走
    // 原位 renameSync 大小写变体）；inode 不等才是真冲突，照常 409。
    if (existsSync(newSafe) && !isSamePhysicalFile(oldSafe, newSafe)) {
      return { ok: false, code: 'ALREADY_EXISTS', reason: '目标已存在' }
    }

    // P3-10：journal 兜底移动/重命名的非原子窗口——pending → snapshot+rename → 清单更新 → settled。
    // 窗口内崩溃：进门 healthCheck 按磁盘现状确定性收口（new 在 old 不在 → 补清单；old 在 new 不在 → abort）。
    // （R0912-2：journalPath 已上提到取锁处。）
    // ee-P1-5：pending 写入收进 try——appendMovePending 同步抛（磁盘满/权限）此前在 try 外
    // 裸穿，而调用方以 Promise.resolve 包裹本方法（不捕获同步 throw），拿到的是裸异常而非
    // {ok:false} 契约（save 路径同类已修 RB-KN-P2-2，此处对齐）。pending 仍先于
    // snapshot+rename，P3-10 崩溃恢复语义不变。
    // R0912-7（2026-09-11 重评-0911c 修复批）：settled 复用移动前单读派生的 baseRev——
    // 移动/重命名内容不变（同 inode 落位），newSafe 的盘上指纹与 oldContent 恒等，原
    // computeRevision(newSafe) 在 settled 处再整读全文属重复 IO（R47-32 单读派生同族
    // 收口）。行为零变更。防御回落仅在「readFileSync(oldSafe) 未执行即失败」的不可达
    // 路径兜底（此刻早已走上方 catch 返回，到不了 settled）。
    let opId: string | undefined
    let baseRev: `sha256:${string}` | undefined
    try {
      opId = await appendMovePending(journalPath, docId, oldPath, newPath)
      // snapshot 留底（移动/重命名前，W0-1 §7）
      // R26-52（二十六轮）：留底读原始字节——utf-8 文本读入会把 GBK 等非 UTF-8 源变
      // U+FFFD 失真快照（假留底：移动覆盖后原字节任何形式不可恢复）。writeVersion 支持
      // 原字节直存（front matter utf-8 + 原字节拼接），快照即字节档。
      // R47-32（四十七轮）：baseRev 单读派生——快照反正要整读原字节，rev 从同份
      // 字节派生（computeRevision(oldSafe) 此前独立再读一遍全文）
      const oldContent = readFileSync(oldSafe)
      baseRev = computeRevisionBytes(oldContent) // R47-32：单读派生（同份字节，免独立重读）；R0912-7：settled 复用
      // R46-39（四十六轮）：留底补传 policy（this.snapshotPolicy()）——此前缺省走
      // DEFAULT_VERSION_POLICY（14 天/30 个），global.json 的 snapMax* 覆盖对移动/重命名
      // 前留底不生效，与同文件 maybeSnapshot/updateChapterMeta/updateDocMeta 写法漂移；
      // 留底是"必须留"时刻，force 与既有缺省（true）一致，显式写明。
      writeVersion(this.snapshotsDir, docId, oldContent, {
        origin: 'manual',
        reason: op.kind === 'move' ? '移动前留底' : '重命名前留底',
        baseRevision: baseRev,
      }, { policy: this.snapshotPolicy(), force: true })
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
      // R2W-1：目标位已有文件时——预检已放行「同一物理文件」（纯大小写变体），此处
      // 复核防 TOCTOU 窗内被换成语义不同的他文件（inode 不等 → 与 link-EEXIST 同语义
      // 收口）；原位 renameSync 落大小写变体（win MoveFileEx/mac APFS 均支持；posix 上
      // 同 dev+ino 仅硬链接形态可达，rename 合并同名链接同数据无损）。
      if (existsSync(newSafe)) {
        if (!isSamePhysicalFile(oldSafe, newSafe)) {
          throw Object.assign(new Error('目标已存在'), { code: 'ALREADY_EXISTS' })
        }
        renameWithRetry(oldSafe, newSafe)
      } else {
        const placed = linkOrRenameExclusive(oldSafe, newSafe)
        if (placed === 'exists') {
          throw Object.assign(new Error('目标已存在'), { code: 'ALREADY_EXISTS' })
        }
        // R33-43（三十三轮）：删源撞 EBUSY（win 文件被占用）时回收已落位的新位硬链接，
        // 恢复「源在旧位、目标位空」的预操作状态——否则本次按 WRITE_ERROR 收口后重试
        // 恒 ALREADY_EXISTS，需手工清理。回收失败仍留孤儿副本（硬链接同数据，无丢失）。
        // R42-10（四十二轮）：删源收编 rmWithRetry（fs/atomic.ts R40-19，trash.ts :287
        // 先例）——瞬时锁退避后仍失败才走既有回收+报错链，语义不变（默认 rm 即
        // rmSync(p,{force:true})，与原裸调逐位同源）。
        try {
          rmWithRetry(oldSafe)
        } catch (rmErr) {
          try {
            // 重评-13（全库代码重评审 2026-09-05）：回滚删新位硬链接收编 rmWithRetry
            //（同上 :1137 处）——瞬时锁退避自愈，退避后仍失败照旧吞错留孤儿副本
            rmWithRetry(newSafe)
          } catch { /* 新位残留孤儿副本：内容无损，重试前需手工清理 */ }
          throw rmErr
        }
      }
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
    // R48-48（四十八轮）：拆两段各给真实后果文案——原一刀切「清单更新失败」会把
    // appendSettled（journal 落账）失败也标成清单问题，误导诊断方向（清单可能已更新成功）
    try {
      await this.updateManifestPath(docId, newPath)
    } catch (e) {
      return {
        ok: false,
        code: 'WRITE_ERROR',
        reason: `文件已移动到新路径，但清单更新失败（下次打开本书时自动对齐）：${errMsg(e)}`,
      }
    }
    try {
      // R0912-7：内容未变，settled 复用移动前单读派生的指纹（不再整读 newSafe 全文）
      await appendSettled(journalPath, opId, baseRev ?? computeRevision(newSafe))
    } catch (e) {
      return {
        ok: false,
        code: 'WRITE_ERROR',
        reason: `文件已移动到新路径，但 journal settled 落账失败（pending 悬置，恢复链下次进门收口）：${errMsg(e)}`,
      }
    }
    invalidateTreeIndex(this.bookRoot, true)
    return { ok: true, docId, path: newPath }
      },
    })
  }

  // 残留清偿批（三十四轮）：同步收编链三函数已删——lookupPathByDocId / adoptLegacyDoc /
  // upsertManifestEntry（同步版）。全部调用方（端点 resolvePathAsync / executeSave 前段 /
  // updateChapterMeta·updateDocMeta·doMoveOrRename·doCopy·doTrash）已迁
  // lookupPathByDocIdAdoptAsync 异步孪生；legacy 收编语义（清单命中无锁读 → miss 且
  // legacy 前缀时扫盘反查 → 异步清单锁登记）见下方孪生。同步 withManifestLock 自此
  // 退出 service 写链（R34D-19 登记的「adoptLegacyDoc 冷路径残留」闭合）。

  /** R31-19（三十一轮）：upsertManifestEntry 的异步孪生——executeSave 锁内复核的
   *  legacy 收编链专用。等待期 withManifestLockAsync（setTimeout 轮询，事件循环不
   *  阻塞），RMW 本体与同步版逐位对齐（strict 读/同错误/同锁文件）。R34D-19（三十
   *  四轮）：doCreate/doCopy 登记亦迁本异步孪生；残留清偿批：同步版随 adoptLegacyDoc
   *  链删除——本函数成为清单登记唯一实现。 */
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
   *  2×5s 的事件循环阻塞。残留清偿批（三十四轮）：全调用面（含端点侧
   *  resolvePathAsync）已迁本孪生，同步链删除——本函数为 docId 收编唯一实现。 */
  /** @internal —— 缝C meta 族参数化（R0916-5j）：MetaHost 结构化消费面，剥 private（本体零触碰）。 */
  async lookupPathByDocIdAdoptAsync(docId: string): Promise<string | null> {
    if (existsSync(this.manifestPath)) {
      // R0912-3（2026-09-11 重评-0911c 修复批）：命中读改 readManifestStrict（与 RMW 链
      // upsertManifestEntryAsync/updateManifestPath 的 R27-40 口径对齐）——容错版对瞬态
      // 读失败（EBUSY/EACCES）返空表，守卫把「登记在册」误判「未登记」：save 走新建语义
      // 在旧路径落盘（同内容双文件/复活窗），trash/move 的「未登记」分支同样静默失效。
      // strict 读失败上抛，由各调用方既有 WRITE_ERROR 信封收口（fail-closed：未落盘、
      // 可重试）——executeSave 前段/锁内复核本就有 catch，本函数的直调方（meta/结构性
      // 操作）已随 R0912-2/3 各自补 catch。
      const path = readManifestStrict(this.manifestPath).entries.get(docId)?.path
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

  /** 复制文档（读源内容 → 落到 relPath → 分配新 docId + 清单登记 + invalidate）。
   *  R34D-19（三十四轮）：doCopy 转异步——清单登记锁等待走 withManifestLockAsync；
   *  对外 Promise 契约不变。R0916-6-P3-14：全程持源 docId save 锁（与 move/rename/
   *  trash 同族——对端保存/结构操作进行中时等待，而非 ENOENT 误报）。 */
  async copyDocument(input: CopyDocumentInput): Promise<CopyResult> {
    return this.doCopy(input)
  }

  private async doCopy(input: CopyDocumentInput): Promise<CopyResult> {
    // R0916-6-P3-14：源 save 锁——copy 此前无锁直读源清单/源文件，与并发结构操作
    // （move/rename/trash 皆持源 save 锁，R0912-2 全程持锁）交错时：lookup 命中旧
    // path → 对端改名/软删落位 → readFileSync 旧路径 ENOENT 落「复制失败：ENOENT」
    // 误导信封（作者无从知晓系并发结构操作）。取锁后与结构操作互斥：要么复制完成，
    // 要么等对方完成后再 lookup（读到新身份/按 NOT_FOUND 人话拒绝）。锁序 save → 清单
    // 与全仓单向嵌套一致（body 内 lookup/upsert 皆清单锁）。journal 路径含 docId，
    // 入口 safeDocId 校验同 doMoveOrRename（manifest 属可篡改数据面，防穿越同口径）。
    if (!safeDocId(input.docId)) return { ok: false, code: 'PATH_ESCAPE', reason: '文档 ID 非法' }
    const journalPath = join(this.journalDir, `${encodeDocDirName(input.docId)}.jsonl`) // R68-3：同 executeSave 编码口径
    // 取锁/释放编排单源 withSaveLocks（结构操作族同款 5s 结构锁超时口径）。复制无
    // 布线文件，不传 wiring。
    return this.withSaveLocks<CopyResult>({
      journalPath,
      saveTimeoutMs: getStructSaveLockTimeoutMs(),
      onSaveLockThrown: (e) => ({ ok: false, code: 'WRITE_ERROR', reason: `复制保存锁获取失败（未执行复制，可重试）：${errMsg(e)}` }),
      onSaveLockTimeout: () => ({ ok: false, code: 'WRITE_ERROR', reason: '复制等待超时：另一进程正在保存或移动此文档（5 秒未让出），请重试' }),
      body: async () => {
        // R0912-3：lookup strict 读失败收口 WRITE_ERROR（未执行复制、可重试），不裸穿
        let srcPath: string | null
        try {
          srcPath = await this.lookupPathByDocIdAdoptAsync(input.docId)
        } catch (e) {
          return { ok: false, code: 'WRITE_ERROR', reason: `复制前清单查询失败（未执行复制，可重试）：${errMsg(e)}` }
        }
        if (!srcPath) return { ok: false, code: 'NOT_FOUND', reason: `源文档 ${input.docId} 未在清单登记` }
        // R33-9（三十三轮）：目标文件段过 sanitizeFileNamePart（补单源纪律缺口——目录段
        // 既有身份不动，只净化本次创建的文件名；win 尾点/尾空格/保留设备名同族收口）
        // R2W-5（win 平台专项复审 R2）：目录段补 R33-9 同族纪律——仅对「当前不存在（本次
        // mkdir 将创建）」的段过 sanitizeFileNamePart（既有段保持身份不动，与 move 侧
        // 1146 行口径一致），防 win 非法字符/尾点尾空格/保留设备名目录段 mkdir EINVAL 裸 500。
        const relSegs = input.relPath.split('/')
        // R51-D-3（五十一轮）：`..` 目录段前置拒绝——下方目录段「已存在则原样保留」分支对
        // `a/..` 恒命中（existsSync(join(root,'a','..')) 即 root 本身），`..` 原文进入
        // copyRelPath 且原文登记清单（doCreate 侧有原始 relPath 的 PATH_ESCAPE 前置 +
        // sanitizeCreateSegment 洗段，copy 侧两道皆无），物理落位（resolveSafePath 归一）
        // 与清单登记（原文）路径不一致 → docId 身份分裂、保存恒 REVISION_CONFLICT。
        // 口径对齐 doCreate 主评审核销注：位置合法化不放宽，复制无合法用例需要 `..` 段。
        // 全库重评-0914 P2-2：`.` 段一并拒绝——同「已存在则原样保留」分支对 `a/./b.md`
        // 恒命中（existsSync(join(root,'a','.')) 即 `a` 本身），`.` 原文进 copyRelPath 登记
        // 而物理落位经 resolveSafePath 词法折叠在 `a/b.md`，登记与盘上路径分裂 → docId
        // 身份分裂（R51-D-3 同族终点）；口径对齐 normalizeMoveToDir 的 `..`/`.` 双拒。
        if (relSegs.includes('..') || relSegs.includes('.')) {
          return { ok: false, code: 'PATH_ESCAPE', reason: '路径段非法：不允许 . 或 .. 目录段' }
        }
        const safeDirSegs = relSegs.slice(0, -1).map((seg, idx) =>
          existsSync(join(this.bookRoot, ...relSegs.slice(0, idx + 1))) ? seg : sanitizeFileNamePart(seg),
        )
        const copyRelPath = [...safeDirSegs, sanitizeFullFileName(relSegs[relSegs.length - 1]!)].join('/')
        // 能力：源 copy + 目标 write。R37-15（三十七轮）注释如实化：旧括注「与 create
        // 同步实现，靠单线程微任务不交错」失实——create/copy 均已异步（R34D-19），本方法
        // 前段即有 await（lookupPathByDocIdAdoptAsync 的清单锁等待）。能力闸交错安全的
        // 真实依据：layoutOf 是纯路径→布局查表（无 IO、无共享可变状态），前段 await 让出
        // 事件循环不改变其判定；后续落位并发由 createFileExclusive 独占探测兜底（:1394）。
        if (!layoutOf(srcPath).capabilities.copy) {
          return { ok: false, code: 'CAPABILITY_DENIED', reason: '该文档不可复制' }
        }
        if (!layoutOf(copyRelPath).capabilities.write) {
          return { ok: false, code: 'CAPABILITY_DENIED', reason: '目标位置只读' }
        }
        const srcSafe = this.resolveSafePath(srcPath)
        const dstSafe = this.resolveSafePath(copyRelPath)
        if (!srcSafe || !dstSafe) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
        if (!existsSync(srcSafe)) return { ok: false, code: 'NOT_FOUND', reason: '源文件不存在' }
        // R61-11（第六十一轮）：existsSync 预检与 atomicWriteFile 落盘之间无互斥（TOCTOU），
        // rename 静默覆盖并发建到的目标；改 createFileExclusive（link 不覆盖，EEXIST →
        // ALREADY_EXISTS，同 doCreate B-6 口径）——预检保留仅作快路
        if (existsSync(dstSafe)) return { ok: false, code: 'ALREADY_EXISTS', reason: '目标已存在' }

        // R47-32：落盘字节引用（try 内赋值；成功路径恒有值）
        let payloadBytes: Buffer | undefined
        try {
          // P5-数据层（第七轮）：按原始字节复制——原 utf-8 文本读写在非 UTF-8 源上会产出
          // 乱码副本（M-5 同族防线未覆盖复制路径；原件无损但副本即损坏）
          // 平台规范化批：合法 UTF-8 源按规范形复制（CRLF/BOM 归一——副本是新建文件，
          // 生而规范）；非 UTF-8 源维持字节级复制（P5 防线不动）
          const raw = readFileSync(srcSafe)
          const payload = isUtf8Bytes(raw) && bufferNeedsCanonical(raw) ? canonicalizeText(raw.toString('utf-8')) : raw
          // R47-32（四十七轮）：落盘字节留引用——返回 revision 单写派生（R40-20 同族），
          // 不再落盘后重读全文（canonicalizeText 的 string 经 createFileExclusive utf-8 落盘）
          payloadBytes = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload
          const created = createFileExclusive(dstSafe, payload, { fsync: true })
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
          //（合并注：登记/回退/返回统一用净化后 copyRelPath——落盘的是 dstSafe（其源即
          // copyRelPath），登记 input.relPath 会复现 R33-9 的「清单 ≠ 盘上名」缺陷；
          // 异步登记 + legacy 降级取 dev 线 R31-24/R34D-19 口径。）
          await this.upsertManifestEntryAsync(newDocId, copyRelPath)
        } catch (e) {
          registeredDocId = legacyId(copyRelPath)
          log.warn('document', `复制后清单登记失败（${copyRelPath}，降级返回 legacy id 与树扫描自愈同源）：${errMsg(e)}`)
        }
        invalidateTreeIndex(this.bookRoot, true)
        // R47-32（四十七轮）：单写派生（payloadBytes 即刚写入字节；防御回落盘读）
        return {
          ok: true,
          docId: registeredDocId,
          path: copyRelPath,
          revision: payloadBytes ? computeRevisionBytes(payloadBytes) : computeRevision(dstSafe),
        }
      },
    })
  }

  /** 软删文档（snapshot + 回收站登记 + 移 .trash + 清单 removeEntry + invalidate；
   *  GG-P2-6：登记不成则删不成——先写登记成功再移文件）。
   *  R34D-19（三十四轮）：doTrash 转异步——回收站登记锁（appendTrashEntryAsync）与
   *  尾段清单 RMW 锁（withManifestLockAsync）等待均不阻塞服务事件循环，补齐 trash.ts
   *  同文件 restore/purge 已异步化（R33D-21）的「半异步」残留；对外 Promise 契约不变。 */
  async trashDocument(input: { docId: string }): Promise<TrashResult> {
    return this.doTrash(input.docId)
  }

  private async doTrash(docId: string): Promise<TrashResult> {
    // R67-11（十五轮）：入口补 safeDocId——与 saveDocument/executeSave 同口径的纵深
    // 一致性：manifest 属可篡改数据面，带恶意 docId 的登记可经 lookup 命中后进入
    // snapshot 留底/trash 路径拼接（下游 resolveSafePath 两层已挡穿越，此处挡在
    // 更早，非法 ID 不进后续链）
    if (!safeDocId(docId)) return { ok: false, code: 'PATH_ESCAPE', reason: '文档 ID 非法' }
    // R0912-2（2026-09-11 重评-0911c 修复批）：软删全程持 per-doc save 锁——原「落位
    // （linkOrRenameExclusive）与删源（rmWithRetry）全程无 save 锁」留下双向复活窗：
    // 他进程 executeSave 过锁内守卫后、落盘前，本方法把文件 rename 进 .trash 并删源，
    // 他进程 atomicWriteFile 在旧路径复活已删文件（绕过回收站、清单无登记）。现取
    // `<journal>.save.lock` 覆盖「lookup → 登记 → 落位 → 删源 → 清单删除」整段：
    // 本方持锁时他进程 save 在取锁处等待，锁内复核（R76-22）看到「回收站认领 + 文件
    // 不在盘」后按 REVISION_CONFLICT 拒绝；他进程 save 持锁时本方等待（删的是其保存后
    // 内容，快照/回收站留底，无复活）。锁序沿用全仓「save → 布线 → 清单」单向嵌套：
    // 其后 journal 锁 / trash 清单锁 / 主清单锁均无反向取 save 锁者，无环。
    // （executeSave Z-6 的回收站复活守卫本可兜「删源后清单未删」窗，但兜不住「守卫
    // 已过、atomicWrite 在旧路径复活」的毫秒窗——本锁闭合后者。）
    const journalPath = join(this.journalDir, `${encodeDocDirName(docId)}.jsonl`) // R68-3：同 executeSave 编码口径
    // 复审-0914-优化修复批 P1-1（2026-09-14 修复批）：取锁/释放编排单源化至 withSaveLocks
    //（R0912-2 全程持锁 + R48-6 获取抛出收口随迁）。软删段无布线文件，不传 wiring。
    return this.withSaveLocks<TrashResult>({
      journalPath,
      saveTimeoutMs: getStructSaveLockTimeoutMs(),
      onSaveLockThrown: (e) => ({ ok: false, code: 'WRITE_ERROR', reason: `删除保存锁获取失败（未执行删除，可重试）：${errMsg(e)}` }),
      onSaveLockTimeout: () => ({ ok: false, code: 'WRITE_ERROR', reason: '删除等待超时：另一进程正在保存或删除此文档（5 秒未让出），请重试' }),
      body: async () => {
    // R0912-3：lookup 命中读 strict 化后的收口——瞬态读失败按 WRITE_ERROR 拒删
    //（文件未动、可重试），不裸穿 TrashResult 契约。
    let oldPath: string | null
    try {
      oldPath = await this.lookupPathByDocIdAdoptAsync(docId)
    } catch (e) {
      return { ok: false, code: 'WRITE_ERROR', reason: `删除前清单查询失败（未执行删除，可重试）：${errMsg(e)}` }
    }
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
      // R48-43（四十八轮）：单读派生——原 computeRevision + readFileSync 对全文双读
      //（doMoveOrRename 已是单读 computeRevisionBytes 口径），win 瞬态占用下两次读
      // 失败概率翻倍；快照留底与基线指纹同源于同一次读取
      const content = readFileSync(oldSafe)
      const baseRev = computeRevisionBytes(content)
      // R26-52（二十六轮）：留底读原始字节（同 doMoveOrRename，R48-43 单读既出）——
      // utf-8 文本读入对 GBK 等非 UTF-8 源产出失真快照，删除落位后原字节不可恢复；
      // writeVersion 支持原字节直存，快照即字节档。
      // R46-39（四十六轮）：同 doMoveOrRename——删除前留底补传 policy，global.json 的
      // snapMax* 覆盖此前对软删留底不生效（缺省 14 天/30 个硬编码）；force 显式 true
      // （留底必留，与缺省一致）。
      writeVersion(this.snapshotsDir, docId, content, {
        origin: 'manual',
        reason: '删除前留底',
        baseRevision: baseRev,
      }, { policy: this.snapshotPolicy(), force: true })
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
      let priorFinalized: ReturnType<typeof trashBaselineOf> = {}
      try {
        if (existsSync(this.manifestPath)) {
          // R27-46（二十七轮）：strict 读——瞬态读失败不再静默降级「从未定稿」（还原后
          // 防覆盖闸失守且零留痕），warn 后仍按无基线落账（软删主流程不因基线读失败
          // 中止；真正的 fail-closed 由下方 appendTrashEntryAsync 的 strict 读把守——trash
          // 清单读得失败时登记不成则删不成，GG-P2-6）。
          const prior = readManifestStrict(this.manifestPath).entries.get(docId)
          if (prior) {
            priorFinalized = trashBaselineOf(prior)
          }
        }
      } catch (e) {
        log.warn('document', `软删 ${docId} 前读定稿基线失败（按无基线落账，还原后该章不带定稿态）：${errMsg(e)}`)
      }
      // GG-P2-6：回收站登记先于移文件，且登记写失败即中止整个软删（宁删失败）——
      // 原实现「先 rename 进 .trash、后补登记」，登记失败（磁盘满/登记路径被占）被
      // catch {} 静默吞掉，结果是文件已删而回收站无记录，作者永远无法还原（静默丢稿）。
      // 登记失败 → WRITE_ERROR（API 层 structStatus 映射 500），文件原地未动、清单条目保留。
      // 反向残留（登记成功而 rename 失败）留下指向不存在 trashedPath 的孤儿条目——无害：
      // 源文件未动，restore 报 NOT_FOUND、purge 可清。
      // R26-48：换名重试链里 trashedPath 变化须重登记（条目记的是真实落位），条目
      // 基座（id/originalPath/role）抽出共用；基线字段不在基座里、各登记点随用随拼
      //（R0912-3：priorFinalized 可被删除 RMW 锁内回填覆盖，拼入时取当次值）。
      const entryBase = {
        id: docId,
        originalPath: oldPath,
        trashedAt: new Date().toISOString(),
        role: layoutOf(oldPath).role,
      }
      try {
        await appendTrashEntryAsync(this.bookRoot, { ...entryBase, ...priorFinalized, trashedPath: finalTrashRel })
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
          await appendTrashEntryAsync(this.bookRoot, { ...entryBase, ...priorFinalized, trashedPath: finalTrashRel })
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
      // R37-14（三十七轮）/ R1W-3（win 平台专项复审 R1）双线同旨合并：删源失败（win
      // 编辑器/同步盘占用正文文件 → EBUSY/EPERM 瞬时占用）回滚回收站侧——对齐
      // doMoveOrRename R33-43 删源失败回收新位的范式：此刻回收站已落位 + 条目已写入，
      // 不回滚会留下「回收站有条目但源文件还在」的双份状态（restore 撞源位 OCCUPIED、
      // purge 会把仍在原位的文件按不可逆语义清掉，恢复/清空语义被污染）。回滚 = 删已
      // 落位的 finalTrashAbs + 移除刚写入的回收站条目（条目以 id 为键，同 id 旧条目已
      // 被本次 appendTrashEntryAsync 替换，按 id 移除即移除本次写入者）。回滚自身失败
      // 只 warn：此时确有双份残留，但源未删、数据无损（硬链接同 inode），重试软删按
      // R73-34 后缀链继续保双份。收口：throw 经外层 catch 统一 WRITE_ERROR（R37-14
      // 形状），文案取 R1W-3 人话「被占用」（原错误信息保留在尾部，win 真机臂断言）。
      try {
        // R42-10（四十二轮）：删源收编 rmWithRetry（fs/atomic.ts R40-19，trash.ts :287
        // 先例）——win 编辑器/同步盘瞬时锁（EPERM/EBUSY）下裸 rmSync 直败会误触发下方
        // 回收站回滚（软删无谓失败）；退避后仍失败才走既有回滚+报错链（R37-14/R1W-3
        // 语义不变）。
        rmWithRetry(oldSafe)
      } catch (rmErr) {
        try {
          // 重评-13（全库代码重评审 2026-09-05）：回滚删回收站副本收编 rmWithRetry
          //（同 :1137 处）——瞬时锁退避自愈，退避后仍失败照走 catch warn（回滚不净
          // 双份残留留痕，语义不变）
          rmWithRetry(finalTrashAbs)
          await removeTrashEntryAsync(this.bookRoot, docId)
        } catch (rollbackErr) {
          log.warn('document', `软删删源失败且回收站回滚不净（${oldPath}，源文件未删、回收站有残留，重试软删将按时间戳后缀保双份）：${errMsg(rollbackErr)}`)
        }
        throw new Error(`正文文件被占用无法删除（可能正被编辑器/同步盘打开），文件未动请重试：${errMsg(rmErr)}`)
      }
      // P1-S3：rename 成功后 manifest 更新改 best-effort——失败不阻断（文件已实质删除，
      // 回收站 manifest / 主清单不一致不影响数据安全，下次操作自然修复）
      try {
        if (existsSync(this.manifestPath)) {
          // X-5：RMW 持清单锁（跨进程互斥）
          // R34D-19（三十四轮）：锁等待异步化（withManifestLockAsync，R30-6 原语）——
          // best-effort 语义不变（P1-S3 失败不阻断，文件已实质删除）
          // R0912-3（2026-09-12 全量重评 P2-2）：TrashEntry 落账与清单删除收进同一清单锁
          // 临界段——上方 priorFinalized 是无锁快照（本方法只持 per-doc save 锁，finalize
          // 不持该锁），快照后、本删除前并发 finalize 写入的基线（finalize 持清单锁落盘）
          // 若随整条 delete 丢弃，TrashEntry 记的还是快照旧值 → 还原后该章无定稿基线，
          // ensureChapterNotFinalized 防覆盖闸失守（tags/order 同窗同失）。现锁内 strict
          // 新鲜读条目，基线投影与快照不一致时先按当次值回填 TrashEntry（append 同 id
          // 替换）再 delete；回填写取 trash 清单锁与主清单锁仍单向（全仓无「持 trash
          // 清单锁再取主清单锁」路径，无环）。无并发时新鲜读与快照恒等 → 不重写条目，
          // 行为逐字节不变。
          await withManifestLockAsync(this.manifestPath, async () => {
            const m = readManifestStrict(this.manifestPath) // R27-40：RMW strict 读——读失败拒删，保住全书登记
            const fresh = m.entries.get(docId)
            if (fresh) {
              const freshBaseline = trashBaselineOf(fresh)
              // R0916-6-nano：stringify 全串比较在此成立——两侧皆 trashBaselineOf 同源
              // 投影（键集与插入序恒同，非任意对象字面量），串不同 = 内容真异；误判
              // 不同也只多一次幂等基线回填，无引入逐字段比较的维护面。
              if (JSON.stringify(freshBaseline) !== JSON.stringify(priorFinalized)) {
                priorFinalized = freshBaseline
                await appendTrashEntryAsync(this.bookRoot, { ...entryBase, ...priorFinalized, trashedPath: finalTrashRel })
              }
            }
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
      },
    })
  }
}
