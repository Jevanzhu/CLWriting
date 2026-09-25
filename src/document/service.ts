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
 *  （withSaveLocks / journal 锁 / trash 清单锁）；磁盘 IO 用同步原语、锁等待走异步
 *   轮询。移动/重命名带 journal move-pending 兜底（P3-10：pending → snapshot+rename →
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
 * 结构（R0916-7-P3-8，2026-09-25 源码质量评审 P3-8）：
 *   - 本文件 = 公开类型 + 薄门面（DocumentService：构造组装根 + per-docId 串行队列）
 *     + 保存/新建/复制/软删四个操作函数（模块级，显式吃 `(ctx, params)`）；
 *   - 共享设施（锁编排 / 路径安全 / 清单 / journal 路径 / 快照策略 / 每实例缓存）
 *     全部收进 `doc-context.ts` 的 DocContext——组装根即本类构造函数，类上不再有
 *     「剥 private + @internal」的裸露面；
 *   - move/rename 操作在 `service-move.ts`（门面与 service-meta.ts 的单向共享件，
 *     原「兄弟文件反向 import 宿主」的双向耦合随之消除）；
 *   - 原缝 A 转发桥（service-guards 逐名 re-export）随本批删除：消费方直引正本模块。
 *   零行为变化：锁语义、journal 记账时机、快照/版本历史、错误码与错误信封、返回形状
 *   逐位保持（改动限于成员访问路径 this.X → ctx.X 与路径单源化）。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { safeDocId, docJoinKey } from '../fs/safe-path.js'
import { atomicWriteFile, createFileExclusive, linkOrRenameExclusive, rmWithRetry } from '../fs/atomic.js'
import { canonicalizeText, bufferNeedsCanonical } from '../fs/text-canonical.js'
import { computeRevision, computeRevisionBytes, type Revision } from './revision.js'
import { layoutOf } from './layout.js'
import { appendAborted, appendPending, appendSettled } from './journal.js'
import { writeVersion, encodeDocDirName } from './version.js'
import { readManifestStrict, writeManifest, withManifestLockAsync } from './manifest.js'
import { SaveQueue } from './queue.js'
import { generateDocId, legacyId } from './stable-id.js'
import { invalidateTreeIndex, invalidateTreeIndexForContent } from './tree.js'
import { bodyOf } from '../format/frontmatter.js'
import { appendTrashEntryAsync, readTrashManifestStrict, removeTrashEntryAsync } from './trash.js'
import { errMsg, log } from '../log/index.js'
import { isUtf8Bytes, NON_UTF8_SAVE_REJECT, getStructSaveLockTimeoutMs, getWiringSaveLockTimeoutMs, saveLockTimeoutMs, bookMovedGuardFailure, BOOK_MOVED_REASON } from './service-guards.js'
import { trashBaselineOf, sanitizeCreateSegment, isSanitizedCreatePath } from './service-helpers.js'
import { updateChapterMetaLocked, updateDocMetaLocked } from './service-meta.js'
import { doMoveOrRename } from './service-move.js'
import { DocContext } from './doc-context.js'
import { appendWordsDelta, todayDate } from './words-diary.js'
import { countWords } from '../format/words.js'
import { sanitizeFileNamePart, sanitizeFullFileName } from '../format/filename.js'

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
  | {
      ok: true
      revision: `sha256:${string}`
      /** RC 源码重审 A-5（Opus-5.5 轮）：保存前留底（maybeSnapshot）失败但正文已落盘——
       *  留底是兜底不是闸（fail-open），正文照常保存成功；本旗仅在该降级发生时带出，
       *  供上层提示「本次修改前的旧内容未留底、版本历史本笔缺口」。健康路径无此字段
       *  （响应形状零改动）。 */
      snapshotDegraded?: boolean
    }
  | {
      ok: false
      // 0917清库修复批（件1）：新增 BOOK_MOVED——executeSave 落盘前书注册重验失败
      // （rename 微任务残窗二道防线，见 executeSave 内守卫处注）。studio 侧 structStatus
      // 既有 BOOK_MOVED → 409 档，信封与链单元首行重验逐字节一致。
      code: 'REVISION_CONFLICT' | 'PATH_ESCAPE' | 'CAPABILITY_DENIED' | 'WRITE_ERROR' | 'BOOK_MOVED'
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

/** snapshot 策略（W0-1 §7）：restore/external-merge 覆盖前、定稿章首改前留底。
 *  保存前留底走节流（policy.throttleMinutes），结构性操作（改名/删除）不节流。
 *  PM-6（性能与内存专项）：words 形参——调用方已算出的正文确切字数（executeSave
 *  的 oldWords）透传进版本 meta，免版本面板对无字数版本全量读 + 重数兜底
 *  （listVersionEntries 读侧口径，finalize.ts R27-41 同款先例）。 */
function maybeSnapshot(
  ctx: DocContext,
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
    ctx.snapshotsDir,
    docId,
    currentContent,
    { origin: input.origin, reason, baseRevision, words },
    { policy: ctx.snapshotPolicy(), force },
  )
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
// R0912-E-P3-4（2026-09-12 独立重评修复批）：本 async 函数内全部
// `return Promise.resolve({...})` 收敛为 `return {...}`（await 点上等价，逐处改不改语义）。
async function executeSave(
  ctx: DocContext,
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
  const journalPath = ctx.journalPathOf(docId) // R0916-7-P3-8：编码口径单源（doc-context）

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
    registered = await ctx.lookupPathByDocIdAdoptAsync(docId)
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
    trashClaimed = readTrashManifestStrict(ctx.bookRoot).some((t) => t.id === docId)
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
  return ctx.withSaveLocks<SaveResult>({
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
    const registeredNow = await ctx.lookupPathByDocIdAdoptAsync(docId)
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
      readTrashManifestStrict(ctx.bookRoot).some((t) => t.id === docId) &&
      (registeredNow === null || !existsSync(absPath))
    ) {
      return {
        ok: false,
        code: 'REVISION_CONFLICT',
        reason: '文档已删除（在回收站中），拒绝在原路径复活文件；如需恢复请从回收站还原',
      }
    }
    // 0917清库修复批（件1）：rename 微任务残窗二道防线——书注册落盘前重验。单元首行
    // 书注册重验（R1010b-SRV-P2-1 面 A，studio 层 bookMovedFailure）通过到本方法落盘
    // 之间隔着排队/保存锁/清单锁等多个让出点，窗内书被改名/删书（books.ts 五连 drain
    // 快照式，重验后新进单元不被等待）时，appendPending/atomicWriteFile 的 mkdir
    // recursive 会对旧捕获 bookRoot 重建孤儿目录树；且清单随书搬走后 lookupPathByDocId
    // 按「未登记」放行新建语义，上方 strict 读防线被旁路——正是本守卫的缺口面。置于
    // 锁内复核之后、首笔写入（appendPending）之前 = 可达的最后时刻（残窗收窄到
    // 「复核→写盘」毫秒级，对齐 R76-22 既有口径；登记语境缺失/登记读失败放行档见
    // bookMovedGuardFailure 头注）。失败即拒绝不落盘，文案单源 BOOK_MOVED_REASON
    //（与 studio 首行重验同文；入口校验保留为一线快速失败，本守卫为二道防线）。
    if (bookMovedGuardFailure(ctx.bookRoot) !== null) {
      return { ok: false, code: 'BOOK_MOVED', reason: BOOK_MOVED_REASON }
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

    // 步骤 4：journal pending（只记元数据，防丢字）
    // RB-KN-P2-2：pending 记不上就不能继续写（无 journal 兜底的落盘违反崩溃恢复协议），
    // 且失败须走 SaveResult 契约（原在此处直接抛出，save() 变 rejected promise，调用方易 unhandled rejection）
    // R34D-18（原文）：字节档 pending 存空串——journal 全文快照是崩溃提示的恢复材料……
    // P3-9 收窄后 pending 不再含全文，R0916-7-P3-8 连第 4 实参（`byteRestore ? '' : content`）
    // 一并删除（形参收窄的收尾，见 journal.ts appendPending 注；崩溃检测语义不变——
    // crashedWrite 只看 pending 存在性，恢复材料归版本档原件/前端镜像）。
    let opId: string
    try {
      opId = await appendPending(journalPath, docId, currentRev)
    } catch (e) {
      return {
        ok: false,
        code: 'WRITE_ERROR',
        reason: `journal 追加失败，保存未执行：${errMsg(e)}`,
      }
    }

    // RC 源码重审 A-5（Opus-5.5 轮）：留底降级旗（本笔保存是否因快照失败而丢了旧文留底）。
    // 声明在内层 try 之外：快照失败在下方 catch 置位，成功返回分支（正文已落盘）再读它
    // ——失败收口（返回 WRITE_ERROR）不需要该旗：保存没成，留底缺口不是当务之急。
    let snapshotDegraded = false
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
      // ② 旧文 words 走 revision 键控缓存（ctx.docWordsCache）：原每笔保存
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
          // PM-4：rev 键控缓存读取经 ctx 显式 API（rev 比对在 cachedDocWords 内，零陈旧窗口）
          const cached = ctx.cachedDocWords(docId, currentRev)
          if (cached !== undefined) {
            oldWords = cached
          } else {
          oldWords = countWords(bodyOf(diskBytes.toString('utf-8')))
          ctx.rememberDocWords(docId, currentRev, oldWords)
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
      // RC 源码重审 A-5（Opus-5.5 轮）：留底 fail-open——maybeSnapshot 原为裸调用且与
      // 正文原子写同处内层 try，writeVersion 的真落盘段（version.ts 无 try/catch）在
      // `.版本` 目录被同步盘锁住/只读/配额满时抛出，直接落进下方 catch：journal 误记
      // aborted + 返回 WRITE_ERROR——正文一字未动却报失败。更糟的是 listVersions 对
      // 坏目录恒返 [] ⇒ 节流/去重判据永不生效 ⇒ 每笔保存都真去写、每笔都抛，作者陷入
      // 「写不进去且只有状态条一行小字」的永久死锁（autosave 失败不弹 toast），无自愈
      // 路径。留底是兜底不是闸（口径对齐 service-meta.ts R26-51 的 fail-open 先例，
      // 同「写后 best-effort 副作用不得把成功改判失败」的 R75-4/R27-44 家族）：warn
      // 留痕 + 置 snapshotDegraded 旗随结果上抛，正文照常落盘。
      // 不变量（唯一不能碰）：留底成功时其内容恒 === 被覆盖的盘上旧内容（R28-13）——
      // 本改动只在快照抛错时改判据，不触碰写成功路径。
      try {
          maybeSnapshot(
            ctx,
          docId,
          relPath,
          absPath,
          input,
          currentRev,
          diskBytes ?? undefined,
          !byteRestore && oldWords !== null ? oldWords : undefined,
        )
      } catch (e) {
        snapshotDegraded = true
        log.warn(
          'document',
          `保存前版本留底失败（留底是兜底不是闸，fail-open 继续写入，正文已保存）：${errMsg(e)}。本次修改前的旧内容未留底、版本历史本笔缺口；` +
            `多为 工作区/.版本 目录不可写或被占用（同步盘锁定/只读/配额满），请检查该书目录下 工作区/.版本 的权限与占用后重试`,
        )
      }
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
        await ctx.maybeUpdateManifest(docId, relPath)
      } catch (e) {
        log.warn('document', `保存后清单刷新失败（${relPath}，树扫描将自愈收编）：${errMsg(e)}`)
      }
      // R46-8（四十六轮）：保存后树缓存失效统一口径——此前 executeSave 完全不失效
      // （树 wordCount/status 靠 stat 指纹自愈 + 前端 refresh=1 兜底），与 files.ts PUT /
      // draft-pipeline 的「过度失效」两极分叉；三链路统一为单键失效（indexes 重建 +
      // 只清本次改写文件的 probe 键）
      invalidateTreeIndexForContent(ctx.bookRoot, relPath)
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
        appendWordsDelta(ctx.bookRoot, todayDate(), wordDelta, docId)
      } catch {
        // 磁盘满等忽略——保存已成功，字数日记丢失可接受
      }
      // PM-4：成功落盘后回填新文字数缓存——下一笔保存的 oldWords 直接命中
      //（rev 键控：即便此笔回填后文件又被外部改动，rev 不匹配自动失效，无害）。
      if (newWords !== null) ctx.rememberDocWords(docId, newRev, newWords)
      // 步骤 11
      // RC 源码重审 A-5（Opus-5.5 轮）：留底降级旗随成功结果上抛——保存成功与「本笔无
      // 留底」是两件事，正文落盘结论不变，仅把快照缺口如实带给调用方（API 层透出 →
      // 前端一次性提示）；健康路径不带该字段，信封形状与既有消费方零冲突。
      return snapshotDegraded
        ? { ok: true, revision: newRev, snapshotDegraded: true }
        : { ok: true, revision: newRev }
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

/** 新建文档（分配 docId + 落盘 + 清单登记 + invalidate）。
 *  R34D-19（三十四轮）：doCreate 转异步——清单登记锁等待走 withManifestLockAsync
 *  （setTimeout 轮询，事件循环不阻塞）；对外 Promise 契约不变（原本即 Promise 包装）。 */
async function doCreate(ctx: DocContext, input: CreateDocumentInput): Promise<CreateResult> {
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
  if (!ctx.resolveSafePath(input.relPath)) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
  const rel = input.relPath
    .split('/')
    .map((seg) => sanitizeCreateSegment(seg))
    .join('/')
  const safe = ctx.resolveSafePath(rel)
  if (!safe) return { ok: false, code: 'PATH_ESCAPE', reason: '路径越出书仓库' }
  if (existsSync(safe)) return { ok: false, code: 'ALREADY_EXISTS', reason: '文件已存在' }
  if (!layoutOf(rel).capabilities.write) {
    return { ok: false, code: 'CAPABILITY_DENIED', reason: '该位置只读，不可新建' }
  }
  const docId = generateDocId()
  // 平台规范化批：新建内容规范形收口（模板缺省本就 LF，零介入；显式传入内容
  // （API/测试夹具）统一归一——新库生而规范）
  const content = canonicalizeText(input.content ?? defaultContent())
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
    await ctx.upsertManifestEntryAsync(docId, rel)
  } catch (e) {
    registeredDocId = legacyId(rel)
    log.warn('document', `新建后清单登记失败（${rel}，降级返回 legacy id 与树扫描自愈同源）：${errMsg(e)}`)
  }
  invalidateTreeIndex(ctx.bookRoot, true)
  // R47-32（四十七轮）：单写派生（R40-20 executeSave 同族）——刚写入的字节即
  // content（canonicalizeText 产出的 string 经 createFileExclusive utf-8 落盘），
  // 不再落盘后重读全文
  return { ok: true, docId: registeredDocId, path: rel, revision: computeRevisionBytes(Buffer.from(content, 'utf-8')) }
}

/** 复制文档（读源内容 → 落到 relPath → 分配新 docId + 清单登记 + invalidate）。
 *  R34D-19（三十四轮）：doCopy 转异步——清单登记锁等待走 withManifestLockAsync；
 *  对外 Promise 契约不变。R0916-6-P3-14：全程持源 docId save 锁（与 move/rename/
 *  trash 同族——对端保存/结构操作进行中时等待，而非 ENOENT 误报）。 */
async function doCopy(ctx: DocContext, input: CopyDocumentInput): Promise<CopyResult> {
  // R0916-6-P3-14：源 save 锁——copy 此前无锁直读源清单/源文件，与并发结构操作
  // （move/rename/trash 皆持源 save 锁，R0912-2 全程持锁）交错时：lookup 命中旧
  // path → 对端改名/软删落位 → readFileSync 旧路径 ENOENT 落「复制失败：ENOENT」
  // 误导信封（作者无从知晓系并发结构操作）。取锁后与结构操作互斥：要么复制完成，
  // 要么等对方完成后再 lookup（读到新身份/按 NOT_FOUND 人话拒绝）。锁序 save → 清单
  // 与全仓单向嵌套一致（body 内 lookup/upsert 皆清单锁）。journal 路径含 docId，
  // 入口 safeDocId 校验同 doMoveOrRename（manifest 属可篡改数据面，防穿越同口径）。
  if (!safeDocId(input.docId)) return { ok: false, code: 'PATH_ESCAPE', reason: '文档 ID 非法' }
  const journalPath = ctx.journalPathOf(input.docId) // R68-3：文件名编码口径单源（doc-context）
  // 取锁/释放编排单源 withSaveLocks（结构操作族同款 5s 结构锁超时口径）。复制无
  // 布线文件，不传 wiring。
  return ctx.withSaveLocks<CopyResult>({
    journalPath,
    saveTimeoutMs: getStructSaveLockTimeoutMs(),
    onSaveLockThrown: (e) => ({ ok: false, code: 'WRITE_ERROR', reason: `复制保存锁获取失败（未执行复制，可重试）：${errMsg(e)}` }),
    onSaveLockTimeout: () => ({ ok: false, code: 'WRITE_ERROR', reason: '复制等待超时：另一进程正在保存或移动此文档（5 秒未让出），请重试' }),
    body: async () => {
      // R0912-3：lookup strict 读失败收口 WRITE_ERROR（未执行复制、可重试），不裸穿
      let srcPath: string | null
      try {
        srcPath = await ctx.lookupPathByDocIdAdoptAsync(input.docId)
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
        existsSync(join(ctx.bookRoot, ...relSegs.slice(0, idx + 1))) ? seg : sanitizeFileNamePart(seg),
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
      const srcSafe = ctx.resolveSafePath(srcPath)
      const dstSafe = ctx.resolveSafePath(copyRelPath)
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
        await ctx.upsertManifestEntryAsync(newDocId, copyRelPath)
      } catch (e) {
        registeredDocId = legacyId(copyRelPath)
        log.warn('document', `复制后清单登记失败（${copyRelPath}，降级返回 legacy id 与树扫描自愈同源）：${errMsg(e)}`)
      }
      invalidateTreeIndex(ctx.bookRoot, true)
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
async function doTrash(ctx: DocContext, docId: string): Promise<TrashResult> {
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
  const journalPath = ctx.journalPathOf(docId) // R68-3：文件名编码口径单源（doc-context）
  // 复审-0914-优化修复批 P1-1（2026-09-14 修复批）：取锁/释放编排单源化至 withSaveLocks
  //（R0912-2 全程持锁 + R48-6 获取抛出收口随迁）。软删段无布线文件，不传 wiring。
  return ctx.withSaveLocks<TrashResult>({
    journalPath,
    saveTimeoutMs: getStructSaveLockTimeoutMs(),
    onSaveLockThrown: (e) => ({ ok: false, code: 'WRITE_ERROR', reason: `删除保存锁获取失败（未执行删除，可重试）：${errMsg(e)}` }),
    onSaveLockTimeout: () => ({ ok: false, code: 'WRITE_ERROR', reason: '删除等待超时：另一进程正在保存或删除此文档（5 秒未让出），请重试' }),
    body: async () => {
  // R0912-3：lookup 命中读 strict 化后的收口——瞬态读失败按 WRITE_ERROR 拒删
  //（文件未动、可重试），不裸穿 TrashResult 契约。
  let oldPath: string | null
  try {
    oldPath = await ctx.lookupPathByDocIdAdoptAsync(docId)
  } catch (e) {
    return { ok: false, code: 'WRITE_ERROR', reason: `删除前清单查询失败（未执行删除，可重试）：${errMsg(e)}` }
  }
  if (!oldPath) return { ok: false, code: 'NOT_FOUND', reason: `文档 ${docId} 未在清单登记` }
  if (!layoutOf(oldPath).capabilities.trash) {
    return { ok: false, code: 'CAPABILITY_DENIED', reason: '该文档不可删除（系统文档）' }
  }
  const oldSafe = ctx.resolveSafePath(oldPath)
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
    writeVersion(ctx.snapshotsDir, docId, content, {
      origin: 'manual',
      reason: '删除前留底',
      baseRevision: baseRev,
    }, { policy: ctx.snapshotPolicy(), force: true })
    // 移到 工作区/.trash/<docId>-<basename>
    const trashAbs = ctx.resolveSafePath(trashedRel)
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
      const suffixedAbs = ctx.resolveSafePath(finalTrashRel)
      if (!suffixedAbs) return { ok: false, code: 'PATH_ESCAPE', reason: '回收站路径越出书仓库' }
      finalTrashAbs = suffixedAbs
    }
    // W-P2-1：软删前抓取定稿基线随 TrashEntry 落账（主清单条目稍后删除，不先抓就找不回）
    let priorFinalized: ReturnType<typeof trashBaselineOf> = {}
    try {
      if (existsSync(ctx.manifestPath)) {
        // R27-46（二十七轮）：strict 读——瞬态读失败不再静默降级「从未定稿」（还原后
        // 防覆盖闸失守且零留痕），warn 后仍按无基线落账（软删主流程不因基线读失败
        // 中止；真正的 fail-closed 由下方 appendTrashEntryAsync 的 strict 读把守——trash
        // 清单读得失败时登记不成则删不成，GG-P2-6）。
        const prior = readManifestStrict(ctx.manifestPath).entries.get(docId)
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
      await appendTrashEntryAsync(ctx.bookRoot, { ...entryBase, ...priorFinalized, trashedPath: finalTrashRel })
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
      const retryAbs = ctx.resolveSafePath(finalTrashRel)
      if (!retryAbs) return { ok: false, code: 'PATH_ESCAPE', reason: '回收站路径越出书仓库' }
      mkdirSync(dirname(retryAbs), { recursive: true })
      finalTrashAbs = retryAbs
      try {
        await appendTrashEntryAsync(ctx.bookRoot, { ...entryBase, ...priorFinalized, trashedPath: finalTrashRel })
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
        await removeTrashEntryAsync(ctx.bookRoot, docId)
      } catch (rollbackErr) {
        log.warn('document', `软删删源失败且回收站回滚不净（${oldPath}，源文件未删、回收站有残留，重试软删将按时间戳后缀保双份）：${errMsg(rollbackErr)}`)
      }
      throw new Error(`正文文件被占用无法删除（可能正被编辑器/同步盘打开），文件未动请重试：${errMsg(rmErr)}`)
    }
    // P1-S3：rename 成功后 manifest 更新改 best-effort——失败不阻断（文件已实质删除，
    // 回收站 manifest / 主清单不一致不影响数据安全，下次操作自然修复）
    try {
      if (existsSync(ctx.manifestPath)) {
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
        await withManifestLockAsync(ctx.manifestPath, async () => {
          const m = readManifestStrict(ctx.manifestPath) // R27-40：RMW strict 读——读失败拒删，保住全书登记
          const fresh = m.entries.get(docId)
          if (fresh) {
            const freshBaseline = trashBaselineOf(fresh)
            // R0916-6-nano：stringify 全串比较在此成立——两侧皆 trashBaselineOf 同源
            // 投影（键集与插入序恒同，非任意对象字面量），串不同 = 内容真异；误判
            // 不同也只多一次幂等基线回填，无引入逐字段比较的维护面。
            if (JSON.stringify(freshBaseline) !== JSON.stringify(priorFinalized)) {
              priorFinalized = freshBaseline
              await appendTrashEntryAsync(ctx.bookRoot, { ...entryBase, ...priorFinalized, trashedPath: finalTrashRel })
            }
          }
          m.entries.delete(docId)
          writeManifest(ctx.manifestPath, m)
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
  invalidateTreeIndex(ctx.bookRoot, true)
  return { ok: true, docId, trashedPath: finalTrashRel }
    },
  })
}

/** 新建文档的默认内容（最小 frontmatter；具体字段由作者编辑或 batch 流程填）。 */
function defaultContent(): string {
  return '---\n---\n\n'
}

/** 文档保存服务（绑定 bookRoot）：组装 DocContext + per-docId 串行队列的薄门面，
 *  各操作本体在模块函数（见模块头注「结构」段）。 */
export class DocumentService {
  /** 文档层组装根产出的共享设施容器（R0916-7-P3-8）——所有权与生命周期见
   *  doc-context.ts 头注：一 ctx 绑一书、随本实例存活，外部只经其显式 API 使用，
   *  不得改写其状态（可变状态一律 private）。 */
  readonly ctx: DocContext
  /** 注入队列（测试桩）；默认新建 per-docId 串行队列。 */
  private readonly queue: SaveQueue<SaveResult>

  constructor(opts: DocumentServiceOptions) {
    this.ctx = new DocContext({ bookRoot: opts.bookRoot, userDataPath: opts.userDataPath ?? null })
    this.queue = opts.queue ?? new SaveQueue<SaveResult>()
  }

  /** 保存文档（W0-1 §5.2）。docId 稳定 ID，relPath 书仓库相对路径。 */
  save(docId: string, relPath: string, input: SaveDocumentInput): Promise<SaveOutcome> {
    // 预校验（入队前，不依赖并发状态）
    const safe = this.ctx.resolveSafePath(relPath)
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
      .enqueue({ docId, run: () => executeSave(this.ctx, docId, relPath, safe, input) })
      .then((qr) => ({ ...qr.result, superseded: qr.superseded }))
  }

  /** docId → relPath（含 legacy 兜底：旧文件首次访问时扫盘反查并补登记清单，
   *  stable-id.ts「首次结构性操作时落盘」）。未登记且非 legacy / 无匹配 → null。
   *  残留清偿批（三十四轮）：legacy 收编链全异步（upsertManifestEntryAsync，
   *  withManifestLockAsync 等待）——同步版 resolvePath/lookupPathByDocId/
   *  adoptLegacyDoc/upsertManifestEntry 已删，服务端点不再以同步 withManifestLock
   *  （Atomics.wait）落在事件循环。 */
  async resolvePathAsync(docId: string): Promise<string | null> {
    // R0916-7-P3-8：收编链本体（含同步孪生删除记账）迁 doc-context.ts，本处为门面转发。
    return this.ctx.lookupPathByDocIdAdoptAsync(docId)
  }

  /** 在途/排队中的保存任务数（跨全部 docId；删书/改名前 drain 探询用，第五轮）。 */
  inFlightSaves(): number {
    return this.queue.inFlight()
  }

  // R34D-17（三十四轮）：recover() 盘点方法已删——生产零调用（真恢复面 = state.ts
  // assembleStatus：findUnsettled + healMovePending + crashedWrite 报文），且它不做
  // healMovePending 与真恢复面行为分叉，「类上有 recover」的假象覆盖了真实恢复链。
  // 未结算断言请直测 journal.findUnsettled（journal.ts 生产原语）。

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
    return doCreate(this.ctx, input)
  }

  /** 移动文档到新目录（章号/文件名不变，只改卷归属）。 */
  moveDocument(input: MoveDocumentInput): Promise<MoveResult> {
    return doMoveOrRename(this.ctx, input.docId, { kind: 'move', toDir: input.toDir })
  }

  /** 重命名文档（改文件名，目录不变）。 */
  renameDocument(input: RenameDocumentInput): Promise<MoveResult> {
    return doMoveOrRename(this.ctx, input.docId, { kind: 'rename', newName: input.newName })
  }

  /** 更新章节元数据（标题/章号）。
   *  - 长篇 chapter：写 fm + 文件名同步 rename（章号4位-标题.md，docId 不变）。
   *  - 短篇 piece-body：写 fm + 文件名同步 rename（章号3位-标题.md，docId 不变）+ 章纲同名跟随。 */
  // R31-20（三十一轮）：同进程同 docId meta 操作串行链——锁等待让出事件循环后，
  // 同文档第二请求会撞跨进程锁文件的同进程 pid 自锁语义（等满超时 fail-closed）。
  // promise 链串行保持旧同步版「单线程无交错」行为等价（跨进程互斥仍由文件锁承担）。
  // R0916-7-P3-8：串行链本体迁 DocContext.chainDocMetaOp（每 ctx 实例状态，严禁提为
  // 模块级单例——多服务实例会跨实例串态，见 doc-context.ts 头注）。
  updateChapterMeta(docId: string, meta: { 标题?: string; 章号?: number }): Promise<MoveResult> {
    return this.ctx.chainDocMetaOp(docId, () => updateChapterMetaLocked(this.ctx, docId, meta))
  }

  /** 更新文档 frontmatter 字段（通用，不联动文件名；卷纲/总纲用）。
   *  与 updateChapterMeta 的区别：不改文件名（卷纲/总纲文件名不按 章号-标题）。 */
  // R31-20（三十一轮）：同 updateChapterMeta——锁获取异步化；本方法锁内段纯
  // 同步 FS（read/patch/write，无嵌套锁），链串行与 chapter 面统一（同 docId
  // 双 meta 请求不再撞同进程 pid 自锁窗口）。
  updateDocMeta(docId: string, meta: Record<string, unknown>): Promise<MoveResult> {
    return this.ctx.chainDocMetaOp(docId, () => updateDocMetaLocked(this.ctx, docId, meta))
  }

  /** 复制文档（读源内容 → 落到 relPath → 分配新 docId + 清单登记 + invalidate）。
   *  R34D-19（三十四轮）：doCopy 转异步——清单登记锁等待走 withManifestLockAsync；
   *  对外 Promise 契约不变。R0916-6-P3-14：全程持源 docId save 锁（与 move/rename/
   *  trash 同族——对端保存/结构操作进行中时等待，而非 ENOENT 误报）。 */
  async copyDocument(input: CopyDocumentInput): Promise<CopyResult> {
    return doCopy(this.ctx, input)
  }

  /** 软删文档（snapshot + 回收站登记 + 移 .trash + 清单 removeEntry + invalidate；
   *  GG-P2-6：登记不成则删不成——先写登记成功再移文件）。
   *  R34D-19（三十四轮）：doTrash 转异步——回收站登记锁（appendTrashEntryAsync）与
   *  尾段清单 RMW 锁（withManifestLockAsync）等待均不阻塞服务事件循环，补齐 trash.ts
   *  同文件 restore/purge 已异步化（R33D-21）的「半异步」残留；对外 Promise 契约不变。 */
  async trashDocument(input: { docId: string }): Promise<TrashResult> {
    return doTrash(this.ctx, input.docId)
  }
}
