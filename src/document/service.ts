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
 *   轮询。移动/重命名带 journal move-pending 兜底（pending → snapshot+rename →
 *   清单更新 → settled，窗口内崩溃由进门 healthCheck 确定性收口）；软删按
 *   「先登记后移文件」。事务顺序：预检查 → snapshot 留底 → fs 操作
 *  （linkOrRenameExclusive 独占落位）→ 清单同步 → invalidateTreeIndex。结构性操作
 *   触发旧书建清单（W0-1 §4.2）。
 *
 * 冲突 / 能力不足 / 落盘失败 → 不落盘、journal 标 aborted（save）/ 返回 {ok:false,code}。
 * 崩溃恢复面在 state.ts assembleStatus（findUnsettled + healMovePending + crashedWrite
 * 报文）；未结算断言直测 journal.findUnsettled——本类不提供盘点方法。
 *
 * docId 是稳定 ID（队列/日志/清单 key），relPath 是落盘路径。
 *
 * 结构：
 *   - 本文件 = 公开类型 + 薄门面（DocumentService：构造组装根 + per-docId 串行队列）
 *     + 保存/新建/复制/软删四个操作函数（模块级，显式吃 `(ctx, params)`）；
 *   - 共享设施（锁编排 / 路径安全 / 清单 / journal 路径 / 快照策略 / 每实例缓存）
 *     全部收进 `doc-context.ts` 的 DocContext（组装根即本类构造函数）；
 *   - move/rename 操作在 `service-move.ts`。
 *   现行契约：锁语义、journal 记账时机、快照/版本历史、错误码与错误信封、返回形状。
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
 *  content 为 string | Buffer：Buffer 仅「恢复端点原字节档」分支产生（readVersionRaw
 *  原字节透传），原字节直存保证非 UTF-8 档恢复不失真；文本保存方（编辑器/autosave/
 *  外部合并）仍全量 string。 */
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
      /** 保存前留底（maybeSnapshot）失败但正文已落盘时带出——留底是兜底不是闸
       *  （fail-open），正文照常保存成功；供上层提示「本次修改前的旧内容未留底、
       *  版本历史本笔缺口」。健康路径无此字段。 */
      snapshotDegraded?: boolean
    }
  | {
      ok: false
      // BOOK_MOVED = executeSave 落盘前书注册重验失败（rename 微任务残窗二道防线，
      // 见 executeSave 内守卫处注）；studio 侧 structStatus 映射 409 档。
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

/** snapshot 策略（W0-1 §7）：restore/external-merge 覆盖前、定稿章首改前留底，其余
 *  文档改前留底。保存前留底走节流（policy.throttleMinutes），结构性操作（改名/删除）
 *  不节流。
 *  diskContent / words：调用方已整读的原始字节与已算出的旧文字数——透传免二次读盘与
 *  重数兜底（listVersionEntries 读侧口径）。 */
function maybeSnapshot(
  ctx: DocContext,
  docId: string,
  relPath: string,
  absPath: string,
  input: SaveDocumentInput,
  baseRevision: Revision,
  // Buffer = 调用方已按原始字节整读（byteRestore 恢复链）——字节保真留底
  diskContent?: string | Buffer,
  words?: number,
): void {
  let reason: string | undefined
  if (input.origin === 'restore' || input.origin === 'external-merge') {
    reason = `${input.origin} 覆盖前留底`
  } else if (existsSync(absPath) && input.expectedRevision !== null) {
    // 非章节文档同章节口径留底——设定/大纲/布线/关系线的普通保存同样需要可回滚的底
    //（journal pending 只含新内容，settled+compact 后旧内容零副本）。
    reason = layoutOf(relPath).role === 'chapter' ? '定稿章修改前留底（§6）' : '修改前留底（R76-2）'
  }
  if (!reason) return
  // 目标文件尚不存在时无底可留，跳过快照正常新建落盘（原 ENOENT 抛走 WRITE_ERROR，
  // 本可成功的 restore/external-merge 被拒）。
  if (!existsSync(absPath)) return
  // snapshot = 修改前的当前磁盘内容（调用方已整读时透传，免二次读盘）
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

// 本保存链上的全部锁等待均异步化（setTimeout 轮询），事件循环不被阻塞——服务进程
// 承载 SSE/全部接口；读改写/落盘本身仍为同步 FS 调用（毫秒级）。
// 队列串行语义：SaveQueue.pump 以 run 的 promise 决议驱动下一项，await 化不改变
// per-docId 串行保证。
// 锁序（全仓统一）：save 锁 → 布线锁 → 清单锁（含 finalize 链）。
async function executeSave(
  ctx: DocContext,
  docId: string,
  relPath: string,
  absPath: string,
  input: SaveDocumentInput,
): Promise<SaveResult> {
  // journal 路径含 docId，显式校验防穿越（与 version.ts/analysis.ts 对齐）
  if (!safeDocId(docId)) return { ok: false, code: 'PATH_ESCAPE', reason: '文档 ID 非法' }
  // 文件名编码（`:`→`_`）：legacy docId 的字面名在 win 上非法（EINVAL/NTFS ADS），
  // 不编码则 appendPending 记不上 = 保存链路永久 WRITE_ERROR。编码口径单源在
  // doc-context.journalPathOf；未结算读侧反解见 journal/state 消费面。
  const journalPath = ctx.journalPathOf(docId)

  // 结构性操作（rename/move/trash）同步执行、不排队，与入队 save 存在竞态窗口——
  // 新建档（expectedRevision=null）的排队 save 若在移动/删除后出队，会在旧路径复活
  // 已移走/已删文件（trash 场景绕过回收站）。出队时按清单核对保存目标仍是该 docId
  // 的登记路径；已删（清单除名 + 回收站在案）同样拒绝。REVISION_CONFLICT 语义 =
  // 「世界已变，请刷新重试」，前端既有冲突处理会重新同步路径。
  // 清单查询与 legacy 收编链（adoptLegacyDoc → upsertManifestEntry → withManifestLock
  // 超时 throw）的失败一律收编为 SaveResult.WRITE_ERROR，不裸穿成 rejected promise /
  // API 500。
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
  // 双条件复活守卫——doTrash 尾段（rename 后清单删除前）崩溃/写失败会残留指向旧路径的
  // 清单条目，旧判定「registered === null 才查回收站」被残留绕过（expectedRevision=null
  // 的保存按「文件不存在=新建」通过基线校验 → 旧路径复活已删文件，且随后 restoreTrash
  // 报 OCCUPIED 还原受阻）。判据：回收站认领该 docId 且（未登记 或 目标文件不在盘）即拒。
  // 回收站清单用 strict 读（restoreTrash 同款）：读失败上抛按保守拒绝收口（fail-closed：
  // WRITE_ERROR、未落盘、可重试），ENOENT 仍合法空（无回收站的新书不受影响）。
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

  // 保存临界段跨进程锁——per-docId 串行队列只防进程内并发；本仓把「CLI 与 GUI 双进程
  // 同书」当支持场景，唯独「revision 校验 → atomicWrite → settled」正文写段原先不在任何
  // 跨进程锁内：journal 自身的 `<journal>.lock` 只串行化 pending 行写入，护不住「校验
  // 通过 → 文件落盘」窗口——双进程各持相同 expectedRevision 并发保存时双双通过校验、
  // 后写者静默覆盖先写者（lost update）。现套 per-doc 保存锁，路径
  // `<journal>.save.lock` 与 journal 锁同目录不同名（锁基建禁同进程嵌套同路径锁，
  // appendPending 在锁内会再拿 `<journal>.lock`，构成单向嵌套 save→journal；compact
  // 只持 journal 锁，无反向环，无死锁）。拿不到锁（他进程在写且 5s 未让出）按
  // WRITE_ERROR 拒绝——保存未执行、无数据损伤、可重试，不做降级裸写（裸写正是本锁
  // 要闭合的丢更新形态）。同进程同 docId 由 queue 串行保证不会自锁。
  // 布线文件在 save 锁内再取同名文件锁（与 lead-finalize 回写临界段互斥，超时/获取
  // 异常 fail-closed 拒绝并先释放 save 锁防泄漏）。锁序：save → 布线 → 清单。
  // 取锁/释放编排（含锁获取自身抛出的收口）单源在 withSaveLocks，锁序与失败语义不变。
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
    // 承接同一收口语义（锁内复核与落盘段的意外抛出统一 WRITE_ERROR）。
    try {
    // 锁内复核：路径登记/回收站认领守卫在取锁前已判一次，但等锁窗口内他进程
    // doTrash/doMoveOrRename 后仍会按旧世界落盘（旧路径复活已删文件/写错位）。取锁后
    // 重判把窗口收窄到「复核→写盘」的毫秒级（结构性操作不持 save 锁，残余窗口存在）。
    const registeredNow = await ctx.lookupPathByDocIdAdoptAsync(docId)
    if (registeredNow !== null && docJoinKey(registeredNow) !== docJoinKey(relPath)) { // win 折叠 + NFC 归一
      return {
        ok: false,
        code: 'REVISION_CONFLICT',
        reason: `文档已移动或重命名（现路径 ${registeredNow}），本次保存目标 ${relPath} 已失效，请刷新后重试`,
      }
    }
    // 锁内复核同款 strict 读——读失败走外层 catch 的 WRITE_ERROR「未落盘，可重试」
    //（此刻尚未 appendPending，无孤儿可标 aborted），fail-closed 拒绝复活窗，不静默放行。
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
    // 书注册二道防线——单元首行书注册重验通过到本方法落盘之间隔着排队/保存锁/清单锁
    // 等多个让出点，窗内书被改名/删书（books.ts 五连 drain 快照式，重验后新进单元不被
    // 等待）时，appendPending/atomicWriteFile 的 mkdir recursive 会对旧捕获 bookRoot
    // 重建孤儿目录树；且清单随书搬走后 lookupPathByDocId 按「未登记」放行新建语义，
    // 上方 strict 读防线被旁路。置于锁内复核之后、首笔写入（appendPending）之前 =
    // 可达的最后时刻。失败即拒绝不落盘，文案单源 BOOK_MOVED_REASON（与 studio 首行
    // 重验同文；入口校验保留为一线快速失败）。登记语境缺失/登记读失败放行档见
    // bookMovedGuardFailure 头注。
    if (bookMovedGuardFailure(ctx.bookRoot) !== null) {
      return { ok: false, code: 'BOOK_MOVED', reason: BOOK_MOVED_REASON }
    }
    // 步骤 2：revision 校验（串行内执行，保证并发一致）
    // 单读派生：锁内一次整读 Buffer，rev（computeRevisionBytes）/ UTF-8 闸（isUtf8Bytes）
    // / wordDelta 旧文 / 快照留底（maybeSnapshot diskContent）四产物同源——多次独立整读
    // 会在结构性操作窗口内判据与写回错源（微 TOCTOU），且 2MB 章每笔保存多份全文 IO。
    // 读失败（win 瞬时锁等）走外层 catch WRITE_ERROR「未落盘，可重试」，与 computeRevision
    // 抛错同语义。
    const existing = existsSync(absPath)
    const diskBytes: Buffer | null = existing ? readFileSync(absPath) : null
    const currentRev: Revision = diskBytes ? computeRevisionBytes(diskBytes) : null
    if (input.expectedRevision !== currentRev) {
      const reason = existing
        ? `基线不符（期望 ${input.expectedRevision ?? 'null'}，磁盘 ${currentRev}）`
        : `期望基线 ${input.expectedRevision} 但文件不存在`
      return { ok: false, code: 'REVISION_CONFLICT', reason }
    }

    // 非 UTF-8 覆写防线（含 autosave）——盘上字节不是合法 UTF-8 时一律拒绝（先转码再保
    // 存）：GBK 文件被错误编码打开后 autosave 把乱码原子覆盖回原文件，且 maybeSnapshot
    // 以 utf-8 读盘留底的是失真快照（假留底，覆写后原字节任何形式不可恢复）。盘上为合法
    // UTF-8 时放行（含真实 U+FFFD 字符的普通编辑）。
    // Buffer 内容放行：该防线的威胁模型是「文本往返失真覆写」，字节档恢复（readVersionRaw
    // 原字节透传）正是把原始字节写回盘上的反悔通道，拦它等于剥夺 GBK 档唯一的无损恢复
    // 路径。
    const content =
      typeof input.content === 'string' ? canonicalizeText(input.content) : input.content
    const byteRestore = Buffer.isBuffer(content)
    if (diskBytes !== null && !byteRestore && !isUtf8Bytes(diskBytes)) {
      return NON_UTF8_SAVE_REJECT
    }

    // 步骤 4：journal pending（只记元数据，防丢字）
    // pending 记不上就不能继续写（无 journal 兜底的落盘违反崩溃恢复协议），且失败须走
    // SaveResult 契约而非直接抛出（抛出会让 save() 变 rejected promise，调用方易
    // unhandled rejection）。崩溃检测只看 pending 存在性；恢复材料归版本档原件/前端镜像。
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

    // 留底降级旗（本笔保存是否因快照失败而丢了旧文留底）。声明在内层 try 之外：快照失败
    // 在下方 catch 置位，成功返回分支（正文已落盘）再读它——失败收口（返回 WRITE_ERROR）
    // 不需要该旗：保存没成，留底缺口不是当务之急。
    let snapshotDegraded = false
    try {
      // wordDelta 计算须在 atomicWrite 前读旧内容；readFileSync 失败走本内层 catch →
      // journal 标 aborted（而非孤儿 pending 误报崩溃）。strip fm 口径（与前端
      // updateWordCount 一致）。
      // 步骤 4.5：算字数 delta（E4）——字节档不记增量：GBK 字节无安全文本视图，失真视图
      // 的字数是伪值，字数日记宁缺毋错（delta 0）。
      // 保存链副本收敛（200 万字书每笔保存峰值副本 15-25× → 显著回落）：
      // ① 新内容单次 Buffer 化（contentBytes）：写盘与 computeRevisionBytes 共用同一份
      //    字节，不再为算 revision 二次编码全文副本。
      // ② 旧文 words 走 revision 键控缓存（ctx.docWordsCache）：原每笔保存都物化整篇旧文
      //    只为 countWords 一次。以 currentRev（diskBytes 的 sha256）为键——同字节 ⇒ 同
      //    字数（countWords 确定性），外部写入必变 rev ⇒ 缓存自动失效重算，零陈旧窗口。
      // ③ maybeSnapshot 吃 diskBytes 字节直存（UTF-8 闸已保证非字节档路径盘上为合法
      //    UTF-8，Buffer 直存与 utf-8 往返字节一致）；快照 meta.words 用 oldWords。
      const contentBytes = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content
      const newWords = byteRestore ? null : countWords(bodyOf(content))
      let oldWords: number | null = null
      if (diskBytes !== null && !byteRestore) {
          // rev 键控缓存读取经 ctx 显式 API（rev 比对在 cachedDocWords 内，零陈旧窗口）
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
      // 留底传 diskBytes 原字节：缺省 utf-8 文本读会把 GBK 盘上内容解码成 U+FFFD 写入
      // .版本（假留底，原字节此后无任何副本）；byteRestore 是非 UTF-8 档唯一合法覆写通道，
      // 恢复链同样走原字节。diskBytes 为 null（文件不存在）时传 undefined，落到 maybeSnapshot
      // 的「无底可留，跳过快照正常新建落盘」分支。
      // 留底 fail-open：maybeSnapshot 与正文原子写同处内层 try，writeVersion 落盘段
      //（`.版本` 目录被同步盘锁住/只读/配额满）抛出若落进下方 catch，会 journal 误记
      // aborted + 返回 WRITE_ERROR——正文一字未动却报失败；且 listVersions 对坏目录恒返 []
      // ⇒ 节流/去重判据永不生效 ⇒ 每笔保存都真去写、每笔都抛，作者陷入「写不进去且只有
      // 状态条一行小字」的永久死锁（autosave 失败不弹 toast），无自愈路径。留底是兜底不是
      // 闸（同「写后 best-effort 副作用不得把成功改判失败」家族）：warn 留痕 + 置
      // snapshotDegraded 旗随结果上抛，正文照常落盘。
      // 不变量（唯一不能碰）：留底成功时其内容恒 === 被覆盖的盘上旧内容——本降级只在
      // 快照抛错时改判据，不触碰写成功路径。
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
      // 新建路径（expectedRevision=null）不裸 rename——基线校验（文件不存在）与落盘之间
      // 无互斥，他进程并发新建同名文件时 atomicWriteFile 的 rename 会静默覆盖先到者内容
      // 且本方返回成功（lost update）。改 createFileExclusive 独占创建（link 不覆盖，
      // 非 NTFS 卷自带 rename 降级）：'exists' = 落位时目标已被并发创建，按既有
      // REVISION_CONFLICT 口径拒绝（「世界已变，请刷新重试」，不新增错误码），
      // journal pending 补 aborted 后返回。
      if (existing) {
        atomicWriteFile(absPath, contentBytes, { fsync: true })
      } else {
        // 新建路径消毒闸：词法越界已被 resolveSafePath 拦，但 win 保留设备名/尾点/尾空格/
        // 控制字符/非法字符段直落盘会 EINVAL 裸 WRITE_ERROR 或读写名不一致；create/copy/
        // rename 均已收编单源消毒器，本分支是漏网点。弃暗拒明（fail-closed）：任一待建段
        // 「消毒后会改写」即拒——不静默改写落盘（docId↔relPath 由调用方绑定，改写即造
        // 「清单≠盘上名」分裂）；已存在文件的覆写不铸新名，不走本闸。
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
      // 单写派生：落盘后再读盘会读到并发写的别窗内容（结构性操作/外部编辑器不持 save
      // 锁），revision 代际标注短暂失真（journal 可对账自愈），且每笔保存多一次全文 IO。
      // 刚写入的字节即 content（string→utf8 / Buffer 原样，atomicWriteFile 零转换），
      // computeRevisionBytes 派生与盘上最终态恒等。
      const newRev = computeRevisionBytes(contentBytes)
      // 步骤 9：条件性更新清单（书已有清单才更新；保存不建清单，W0-1 §4.2）
      // 清单刷新转 best-effort——此时文件已原子落盘，清单只是可重建索引（树扫盘/
      // repairBooks 自愈收编）；它抛（清单锁超时/磁盘满）若落进下方 catch 会返回
      // WRITE_ERROR：保存实际成功却报失败（编辑器误报、重试撞 REVISION_CONFLICT）。
      // warn 留痕后照常 settled + 返回成功。
      try {
        // 清单锁等待异步化（withManifestLockAsync）
        await ctx.maybeUpdateManifest(docId, relPath)
      } catch (e) {
        log.warn('document', `保存后清单刷新失败（${relPath}，树扫描将自愈收编）：${errMsg(e)}`)
      }
      // 保存后树缓存失效：单键失效（indexes 重建 + 只清本次改写文件的 probe 键），
      // 与 files.ts PUT / draft-pipeline 同口径（树 wordCount/status 另有 stat 指纹自愈 +
      // 前端 refresh=1 兜底）。
      invalidateTreeIndexForContent(ctx.bookRoot, relPath)
      // 步骤 10：journal settled。
      // settled 失败不误报——此刻正文已原子落盘、清单已刷新，若返回 WRITE_ERROR 会致
      // 编辑器误报失败、重试必撞 REVISION_CONFLICT，journal 悬置 pending 误报 crashedWrite。
      // best-effort：warn 留痕 + 按成功收口。
      try {
        await appendSettled(journalPath, opId, newRev)
      } catch (e) {
        log.warn('document', `保存已落盘但 journal settled 写失败（${docId}，恢复链下次启动将按 pending 自愈复核）：${errMsg(e)}`)
      }
      // 字数增量 best-effort（settled 后失败不影响保存结果——否则文件已落盘但返回
      // WRITE_ERROR 误报失败）
      try {
        appendWordsDelta(ctx.bookRoot, todayDate(), wordDelta, docId)
      } catch {
        // 磁盘满等忽略——保存已成功，字数日记丢失可接受
      }
      // 成功落盘后回填新文字数缓存——下一笔保存的 oldWords 直接命中
      //（rev 键控：即便此笔回填后文件又被外部改动，rev 不匹配自动失效，无害）。
      if (newWords !== null) ctx.rememberDocWords(docId, newRev, newWords)
      // 步骤 11
      // 留底降级旗随成功结果上抛——保存成功与「本笔无留底」是两件事，正文落盘结论不变，
      // 仅把快照缺口如实带给调用方（API 层透出 → 前端一次性提示）；健康路径不带该字段。
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
    // 外层 catch 只兜 appendPending **之前**落盘前同步段的意外抛出（锁内清单/回收站读、
    // computeRevision、readFileSync 等：win 杀软 EBUSY/EACCES 或清单锁超时 throw）：
    // 此刻尚未写 journal pending（无 opId，无孤儿可标 aborted），保存未执行、无数据损伤。
    // appendPending 之后的失败各有专属内层 catch 契约，全部显式 return，不流入本 catch。
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
 *  清单登记锁等待走异步孪生（事件循环不阻塞）；对外 Promise 契约不变。 */
async function doCreate(ctx: DocContext, input: CreateDocumentInput): Promise<CreateResult> {
  // relPath 逐段过 sanitizeFileNamePart（format/filename.ts 单一真相源）——win 保留设备名
  // （CON.md 等）拷至 Windows 被拒、尾点/尾空格落盘被自动剖（读写名不一致），非法字符直
  // 落盘时炸或产生跨平台歧义名。消毒前先对**原始 relPath** 做越界校验：`../etc/passwd`
  // 这类穿越路径若先消毒（`..` 段被洗成普通名）就永远到不了 PATH_ESCAPE，越界防线被消毒
  // 静默吞掉。口径：原始路径必须先在书仓库内（穿越/绝对路径拒绝），消毒只放宽「名字合法
  // 化」不放宽「位置合法化」，消毒后再校验一次兜底。文件段带 .md 扩展名时只消毒标题段再
  // 拼回扩展名——截断预算是整段预算，整段消毒会把长标题的 .md 截掉。
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
  // 新建内容规范形收口（模板缺省本就 LF，零介入；显式传入内容（API/测试夹具）统一
  // 归一——新库生而规范）
  const content = canonicalizeText(input.content ?? defaultContent())
  try {
    mkdirSync(dirname(safe), { recursive: true })
    // tmp + linkSync 独占创建——上方 existsSync 与落盘之间无跨进程互斥，双进程同 relPath
    // 并发新建时 atomicWriteFile 的 rename 静默覆盖后到者内容且双方返回成功（两个 docId
    // 先后 upsert 成同路径双认领态）；link 遇 EEXIST → ALREADY_EXISTS，双方各自明确。
    // create 目标的 docId 尚不存在（无既有身份可挂 save 锁），并发同路径新建的互斥正由
    // 本独占探测承担——无锁可取，亦无需取。
    const created = createFileExclusive(safe, content, { fsync: true })
    if (created === 'exists') return { ok: false, code: 'ALREADY_EXISTS', reason: '文件已存在' }
  } catch (e) {
    // 深层多段 relPath 超 MAX_PATH/卷上限分诊为 BAD_INPUT 人话（客户端可修：缩短标题或
    // 减少层级；对照 doInit 的「换更短的书名或更浅的书库位置」同口径）。长路径启用的卷
    // （libuv \\?\ 前缀）不触本分支；逐段消毒 120B 预算单源在 books.ts BOOK_NAME_MAX_BYTES。
    if ((e as NodeJS.ErrnoException).code === 'ENAMETOOLONG') {
      return { ok: false, code: 'BAD_INPUT', reason: '路径过长（超出文件系统上限），请缩短标题或减少目录层级' }
    }
    return { ok: false, code: 'WRITE_ERROR', reason: `新建失败：${errMsg(e)}` }
  }
  // 结构性操作触发建清单（W0-1 §4.2）：无清单则建，加 entry
  // 登记失败不误报完全失败（文件已落盘，半成品态由树 legacyId 首次结构性操作
  // adoptLegacyDoc 自愈）：warn 留痕 + 降级返回 legacyId(rel)——树扫描自愈产物是
  // legacy:<hash>，返回原 doc_xxx 会让前端持有的身份与磁盘自愈身份分裂（.版本/journal
  // 以旧 id 孤儿化，历史面板失联）。
  let registeredDocId = docId
  try {
    await ctx.upsertManifestEntryAsync(docId, rel)
  } catch (e) {
    registeredDocId = legacyId(rel)
    log.warn('document', `新建后清单登记失败（${rel}，降级返回 legacy id 与树扫描自愈同源）：${errMsg(e)}`)
  }
  invalidateTreeIndex(ctx.bookRoot, true)
  // 单写派生：刚写入的字节即 content（canonicalizeText 产出的 string 经
  // createFileExclusive utf-8 落盘），不再落盘后重读全文
  return { ok: true, docId: registeredDocId, path: rel, revision: computeRevisionBytes(Buffer.from(content, 'utf-8')) }
}

/** 复制文档（读源内容 → 落到 relPath → 分配新 docId + 清单登记 + invalidate）。
 *  登记锁等待走异步孪生；全程持源 docId save 锁（与 move/rename/trash 同族——对端
 *  保存/结构操作进行中时等待，而非 ENOENT 误报）。 */
async function doCopy(ctx: DocContext, input: CopyDocumentInput): Promise<CopyResult> {
  // 源 save 锁：copy 原无锁直读源清单/源文件，与并发结构操作（move/rename/trash 皆持源
  // save 锁）交错时会 lookup 命中旧 path → 对端改名/软删落位 → readFileSync 旧路径
  // ENOENT 落「复制失败：ENOENT」误导信封。取锁后与结构操作互斥：要么复制完成，要么等
  // 对方完成后再 lookup（读到新身份/按 NOT_FOUND 人话拒绝）。锁序 save → 清单与全仓单向
  // 嵌套一致（body 内 lookup/upsert 皆清单锁）。journal 路径含 docId，入口 safeDocId 校验
  // 同 doMoveOrRename（manifest 属可篡改数据面，防穿越同口径）。
  if (!safeDocId(input.docId)) return { ok: false, code: 'PATH_ESCAPE', reason: '文档 ID 非法' }
  const journalPath = ctx.journalPathOf(input.docId) // 文件名编码口径单源（doc-context）
  // 取锁/释放编排单源 withSaveLocks（结构操作族同款 5s 结构锁超时口径）。复制无布线
  // 文件，不传 wiring。
  return ctx.withSaveLocks<CopyResult>({
    journalPath,
    saveTimeoutMs: getStructSaveLockTimeoutMs(),
    onSaveLockThrown: (e) => ({ ok: false, code: 'WRITE_ERROR', reason: `复制保存锁获取失败（未执行复制，可重试）：${errMsg(e)}` }),
    onSaveLockTimeout: () => ({ ok: false, code: 'WRITE_ERROR', reason: '复制等待超时：另一进程正在保存或移动此文档（5 秒未让出），请重试' }),
    body: async () => {
      // lookup strict 读失败收口 WRITE_ERROR（未执行复制、可重试），不裸穿
      let srcPath: string | null
      try {
        srcPath = await ctx.lookupPathByDocIdAdoptAsync(input.docId)
      } catch (e) {
        return { ok: false, code: 'WRITE_ERROR', reason: `复制前清单查询失败（未执行复制，可重试）：${errMsg(e)}` }
      }
      if (!srcPath) return { ok: false, code: 'NOT_FOUND', reason: `源文档 ${input.docId} 未在清单登记` }
      // 目标文件段过 sanitizeFileNamePart（只净化本次创建的文件名，目录段身份不动）；
      // 目录段仅对「当前不存在（本次 mkdir 将创建）」的段消毒（既有段保持身份不动，与
      // move 侧同口径），防 win 非法字符/尾点尾空格/保留设备名目录段 mkdir EINVAL 裸 500。
      const relSegs = input.relPath.split('/')
      // `..`/`.` 目录段前置拒绝——下方目录段「已存在则原样保留」分支对 `a/..`/`a/.` 恒命中
      // （existsSync(join(root,'a','..')) 即 root/`a` 本身），原文进入 copyRelPath 且原文登记
      // 清单，而物理落位（resolveSafePath 归一）与清单登记路径不一致 → docId 身份分裂、
      // 保存恒 REVISION_CONFLICT。口径对齐 doCreate：位置合法化不放宽，复制无合法用例需要
      // `..`/`.` 段（normalizeMoveToDir 同款双拒）。
      if (relSegs.includes('..') || relSegs.includes('.')) {
        return { ok: false, code: 'PATH_ESCAPE', reason: '路径段非法：不允许 . 或 .. 目录段' }
      }
      const safeDirSegs = relSegs.slice(0, -1).map((seg, idx) =>
        existsSync(join(ctx.bookRoot, ...relSegs.slice(0, idx + 1))) ? seg : sanitizeFileNamePart(seg),
      )
      const copyRelPath = [...safeDirSegs, sanitizeFullFileName(relSegs[relSegs.length - 1]!)].join('/')
      // 能力：源 copy + 目标 write。能力闸交错安全的依据：layoutOf 是纯路径→布局查表
      //（无 IO、无共享可变状态），前段 await 让出事件循环不改变其判定；后续落位并发由
      // createFileExclusive 独占探测兜底。
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
      // existsSync 预检与落盘之间无互斥（TOCTOU），rename 会静默覆盖并发建到的目标；
      // 改 createFileExclusive（link 不覆盖，EEXIST → ALREADY_EXISTS，同 doCreate 口径），
      // 上方预检保留仅作快路
      if (existsSync(dstSafe)) return { ok: false, code: 'ALREADY_EXISTS', reason: '目标已存在' }

      // 落盘字节引用（try 内赋值；成功路径恒有值）
      let payloadBytes: Buffer | undefined
      try {
        // 按原始字节复制——utf-8 文本读写在非 UTF-8 源上会产出乱码副本（原件无损但副本
        // 即损坏）。合法 UTF-8 源按规范形复制（CRLF/BOM 归一——副本是新建文件，生而规范）；
        // 非 UTF-8 源维持字节级复制。
        const raw = readFileSync(srcSafe)
        const payload = isUtf8Bytes(raw) && bufferNeedsCanonical(raw) ? canonicalizeText(raw.toString('utf-8')) : raw
        // 落盘字节留引用供返回 revision 单写派生，不再落盘后重读全文
        payloadBytes = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload
        const created = createFileExclusive(dstSafe, payload, { fsync: true })
        if (created === 'exists') return { ok: false, code: 'ALREADY_EXISTS', reason: '目标已存在' }
      } catch (e) {
        return { ok: false, code: 'WRITE_ERROR', reason: `复制失败：${errMsg(e)}` }
      }
      // 新 docId + 清单登记（结构性操作触发建清单，W0-1 §4.2）
      const newDocId = generateDocId()
      // 登记收编同 doCreate：登记失败不误报完全失败，降级返回 legacyId（身份连续）
      let registeredDocId = newDocId
      try {
        //（登记/回退/返回统一用净化后 copyRelPath——落盘的是 dstSafe（其源即 copyRelPath），
        // 登记 input.relPath 会复现「清单 ≠ 盘上名」缺陷。）
        await ctx.upsertManifestEntryAsync(newDocId, copyRelPath)
      } catch (e) {
        registeredDocId = legacyId(copyRelPath)
        log.warn('document', `复制后清单登记失败（${copyRelPath}，降级返回 legacy id 与树扫描自愈同源）：${errMsg(e)}`)
      }
      invalidateTreeIndex(ctx.bookRoot, true)
      // 单写派生（payloadBytes 即刚写入字节；防御回落盘读）
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
 *  登记不成则删不成——先写登记成功再移文件）。
 *  回收站登记锁（appendTrashEntryAsync）与尾段清单 RMW 锁（withManifestLockAsync）
 *  等待均不阻塞服务事件循环；对外 Promise 契约不变。 */
async function doTrash(ctx: DocContext, docId: string): Promise<TrashResult> {
  // 入口补 safeDocId——与 saveDocument/executeSave 同口径的纵深一致性：manifest 属可篡改
  // 数据面，带恶意 docId 的登记可经 lookup 命中后进入 snapshot 留底/trash 路径拼接
  //（下游 resolveSafePath 两层已挡穿越，此处挡在更早，非法 ID 不进后续链）
  if (!safeDocId(docId)) return { ok: false, code: 'PATH_ESCAPE', reason: '文档 ID 非法' }
  // 软删全程持 per-doc save 锁——「落位（linkOrRenameExclusive）与删源（rmWithRetry）
  // 全程无 save 锁」会留下双向复活窗：他进程 executeSave 过锁内守卫后、落盘前，本方法把
  // 文件 rename 进 .trash 并删源，他进程 atomicWriteFile 在旧路径复活已删文件（绕过回收站、
  // 清单无登记）。现取 `<journal>.save.lock` 覆盖「lookup → 登记 → 落位 → 删源 → 清单删除」
  // 整段：本方持锁时他进程 save 在取锁处等待，锁内复核看到「回收站认领 + 文件不在盘」后按
  // REVISION_CONFLICT 拒绝；他进程 save 持锁时本方等待（删的是其保存后内容，快照/回收站
  // 留底，无复活）。锁序沿用全仓「save → 布线 → 清单」单向嵌套：其后 journal 锁 / trash
  // 清单锁 / 主清单锁均无反向取 save 锁者，无环。
  //（executeSave 的回收站复活守卫本可兜「删源后清单未删」窗，但兜不住「守卫已过、
  // atomicWrite 在旧路径复活」的毫秒窗——本锁闭合后者。）
  const journalPath = ctx.journalPathOf(docId) // 文件名编码口径单源（doc-context）
  // 取锁/释放编排单源 withSaveLocks（锁获取抛出的收口随迁）。软删段无布线文件，不传 wiring。
  return ctx.withSaveLocks<TrashResult>({
    journalPath,
    saveTimeoutMs: getStructSaveLockTimeoutMs(),
    onSaveLockThrown: (e) => ({ ok: false, code: 'WRITE_ERROR', reason: `删除保存锁获取失败（未执行删除，可重试）：${errMsg(e)}` }),
    onSaveLockTimeout: () => ({ ok: false, code: 'WRITE_ERROR', reason: '删除等待超时：另一进程正在保存或删除此文档（5 秒未让出），请重试' }),
    body: async () => {
  // lookup 命中读 strict 化后的收口——瞬态读失败按 WRITE_ERROR 拒删（文件未动、可重试），
  // 不裸穿 TrashResult 契约。
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

  // 回收站落名消毒同 create/rename 单源口径——basename 含 win 非法字符/尾点/控制字符时
  // 直拼 .trash 落名会写失败或产生跨平台同步盘/拷贝歧义。消毒只影响落名；
  // TrashEntry.trashedPath 记录消毒后的真实落位，还原语义不变。
  const cleanBase = sanitizeCreateSegment(basename(oldPath))
  const trashedRel = `工作区/.trash/${encodeDocDirName(docId)}-${cleanBase}`
  // 确定性命名残留防线的落位路径（函数域声明——成功返回值也要用）。上次软删「清单条目
  // 删除失败」残留后，同 docId 的文件经编辑器保存合法复活（executeSave 双条件守卫对
  // 「文件在盘」放行）再被再次软删时，同名 .trash 目标会被 renameSync 静默覆盖，上一版
  // 回收站内容无痕丢失。目标已存在 → 追加时间戳后缀保双份（lead-update-draft /
  // syncRenamePieceList 同款先例）；后缀须在回收站登记**之前**定——条目 trashedPath 记的
  // 是真实落位。
  let finalTrashRel = trashedRel
  try {
    // 单读派生——原 computeRevision + readFileSync 对全文双读（doMoveOrRename 已是单读
    // computeRevisionBytes 口径），win 瞬态占用下两次读失败概率翻倍；快照留底与基线指纹
    // 同源于同一次读取
    const content = readFileSync(oldSafe)
    const baseRev = computeRevisionBytes(content)
    // 留底读原始字节（单读既出）——utf-8 文本读入对 GBK 等非 UTF-8 源产出失真快照，删除
    // 落位后原字节不可恢复；writeVersion 支持原字节直存，快照即字节档。
    // 显式传 policy 使 global.json 的 snapMax* 对软删留底生效；force 显式 true（留底必留，
    // 与缺省一致）。
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
      // 与落名同源——从消毒后的 cleanBase 拆 stem/ext，时间戳后缀重试链产物同为消毒名
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
    // 软删前抓取定稿基线随 TrashEntry 落账（主清单条目稍后删除，不先抓就找不回）
    let priorFinalized: ReturnType<typeof trashBaselineOf> = {}
    try {
      if (existsSync(ctx.manifestPath)) {
        // strict 读——瞬态读失败不再静默降级「从未定稿」（还原后防覆盖闸失守且零留痕），
        // warn 后仍按无基线落账（软删主流程不因基线读失败中止）；真正的 fail-closed 由
        // 下方 appendTrashEntryAsync 的 strict 读把守——trash 清单读得失败时登记不成则删
        // 不成。
        const prior = readManifestStrict(ctx.manifestPath).entries.get(docId)
        if (prior) {
          priorFinalized = trashBaselineOf(prior)
        }
      }
    } catch (e) {
      log.warn('document', `软删 ${docId} 前读定稿基线失败（按无基线落账，还原后该章不带定稿态）：${errMsg(e)}`)
    }
    // 回收站登记先于移文件，且登记写失败即中止整个软删（宁删失败）——「先 rename 进
    // .trash、后补登记」在登记失败（磁盘满/登记路径被占）被吞掉时，结果是文件已删而回收站
    // 无记录，作者永远无法还原（静默丢稿）。登记失败 → WRITE_ERROR（API 层 structStatus
    // 映射 500），文件原地未动、清单条目保留。
    // 反向残留（登记成功而 rename 失败）留下指向不存在 trashedPath 的孤儿条目——无害：
    // 源文件未动，restore 报 NOT_FOUND、purge 可清。
    // 换名重试链里 trashedPath 变化须重登记（条目记的是真实落位），条目基座
    //（id/originalPath/role）抽出共用；基线字段不在基座里、各登记点随用随拼
    //（priorFinalized 可被删除 RMW 锁内回填覆盖，拼入时取当次值）。
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
    // 软删落位改 linkOrRenameExclusive 独占探测——原 existsSync 预检 + renameSync 之间
    // 存在跨进程窄窗：他进程并发落位同名回收站目标时 POSIX rename / win
    // MOVEFILE(REPLACE_EXISTING) 静默覆盖，上一版回收站内容无痕丢失。'exists' 时沿用
    // 时间戳后缀重试链（换名 → 重登记 → 再落位，有界 3 次——毫秒级窄窗连撞 3 个时间戳的
    // 形态只剩目录被塞满的病态卷）；重试耗尽按 WRITE_ERROR 收口（文件原地未动，孤儿条目
    // 无害如上）。EPERM 降级 rename 由 linkOrRenameExclusive 内部处理（非 NTFS 卷可用性）。
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
    // 删源失败（win 编辑器/同步盘占用正文文件 → EBUSY/EPERM 瞬时占用）回滚回收站侧——
    // 对齐 doMoveOrRename 删源失败回收新位的范式：此刻回收站已落位 + 条目已写入，不回滚会
    // 留下「回收站有条目但源文件还在」的双份状态（restore 撞源位 OCCUPIED、purge 会把仍在
    // 原位的文件按不可逆语义清掉，恢复/清空语义被污染）。回滚 = 删已落位的 finalTrashAbs +
    // 移除刚写入的回收站条目（条目以 id 为键，同 id 旧条目已被本次 appendTrashEntryAsync
    // 替换，按 id 移除即移除本次写入者）。回滚自身失败只 warn：此时确有双份残留，但源未删、
    // 数据无损（硬链接同 inode），重试软删按后缀链继续保双份。收口：throw 经外层 catch 统一
    // WRITE_ERROR，文案取人话「被占用」（原错误信息保留在尾部，win 真机臂断言）。
    try {
      // 删源收编 rmWithRetry——win 编辑器/同步盘瞬时锁（EPERM/EBUSY）下裸 rmSync 直败会
      // 误触发下方回收站回滚（软删无谓失败）；退避后仍失败才走既有回滚+报错链。
      rmWithRetry(oldSafe)
    } catch (rmErr) {
      try {
        // 回滚删回收站副本收编 rmWithRetry——瞬时锁退避自愈，退避后仍失败照走 catch warn
        //（回滚不净双份残留留痕，语义不变）
        rmWithRetry(finalTrashAbs)
        await removeTrashEntryAsync(ctx.bookRoot, docId)
      } catch (rollbackErr) {
        log.warn('document', `软删删源失败且回收站回滚不净（${oldPath}，源文件未删、回收站有残留，重试软删将按时间戳后缀保双份）：${errMsg(rollbackErr)}`)
      }
      throw new Error(`正文文件被占用无法删除（可能正被编辑器/同步盘打开），文件未动请重试：${errMsg(rmErr)}`)
    }
    // rename 成功后 manifest 更新改 best-effort——失败不阻断（文件已实质删除，
    // 回收站 manifest / 主清单不一致不影响数据安全，下次操作自然修复）
    try {
      if (existsSync(ctx.manifestPath)) {
        // RMW 持清单锁（跨进程互斥）；锁等待异步化，best-effort 语义不变。
        // TrashEntry 落账与清单删除收进同一清单锁临界段——上方 priorFinalized 是无锁快照
        //（本方法只持 per-doc save 锁，finalize 不持该锁），快照后、本删除前并发 finalize
        // 写入的基线（finalize 持清单锁落盘）若随整条 delete 丢弃，TrashEntry 记的还是快照
        // 旧值 → 还原后该章无定稿基线，ensureChapterNotFinalized 防覆盖闸失守（tags/order
        // 同窗同失）。现锁内 strict 新鲜读条目，基线投影与快照不一致时先按当次值回填
        // TrashEntry（append 同 id 替换）再 delete；回填写取 trash 清单锁与主清单锁仍单向
        //（全仓无「持 trash 清单锁再取主清单锁」路径，无环）。无并发时新鲜读与快照恒等 →
        // 不重写条目，行为逐字节不变。
        await withManifestLockAsync(ctx.manifestPath, async () => {
          const m = readManifestStrict(ctx.manifestPath) // RMW strict 读——读失败拒删，保住全书登记
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
