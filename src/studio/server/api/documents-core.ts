/**
 * 文档域基建段（公共底座单源） —— 自 src/studio/server/api/documents.ts 拆出。
 *
 * R0916-5h（2026-09-16，⑤④产品巨件拆分波4）：documents.ts（1019 行）路由段按域
 * 纯移动拆分；本文件承载基建段，内容逐字节随迁、零触碰（⑤① R0916-5a 收敛的
 * 公共底座原样）：DocumentService per-bookRoot 缓存族（getOrCreateService /
 * __clearDocumentServices / forgetService / drainDocumentSaves）、伏笔事件族与
 * per-book 串行链（foreshadowSnapshot / recordForeshadowDelta / drain / forget /
 * keysForTest 观测钩子）、structure 串行链（enqueueStructureOp /
 * drainStructureChainsUnder / __structureChainKeysForTest）、书注册重验
 * （bookMovedFailureOk / BookMovedFailure）与五站写端点不变链单源
 * runBookScopedOp、busy 守卫单源 structureBusyGuarded、错误码→HTTP status 映射
 * structStatus。
 * 基建单源拆出的实读原因（记档）：路由装配是 defineRoute 副作用注册制（无路由表
 * 数据导出面），registerDocumentRoutes 是 server/index.ts 与
 * r1010b-srv-documents-bookmoved.test.ts 的既有消费名（消费面零改动）→ 聚合入口
 * 须留 documents.ts；若基建也留 documents.ts，域文件回引基建 + 残核 import 域
 * 文件即成模块环——vitest 的 vite SSR transform 对环返回未完成模块对象（本批
 * 实跑：域文件运行时取 runBookScopedOp 为 undefined），故基建单源本文件、残核
 * 单向 import 三域与本文件，模块图无环。原模块私有而域文件消费项（DocumentCtx /
 * runBookScopedOp / structStatus / enqueueStructureOp / structureBusyGuarded）就此
 * 导出，其余保持私有。
 * 依赖方向：本文件 → http/book-context/document/foreshadow/events/log/serial-
 * chain/review/ai 既有出边（studio→ai 组合根白名单面内，不新增 ai→studio 边），
 * 不 import 同批任何 documents-* 模块（单向无环）；顶层求值常量（services 缓存
 * Map / 伏笔与 structure 两条串行链 Map）单源本文件，绝不经环回引。
 * 路由域文件：documents-save.ts（缝 1：保存/文件树/定稿）、documents-crud.ts
 * （缝 2：字数日记与 CRUD/回收站）、documents-structure.ts（缝 3：章节结构
 * 操作）；聚合入口与外部消费名桥留 documents.ts 残核（头注保留原全部历史
 * 记载与拆分沿革）。
 */
import type { ServerResponse } from 'node:http'
import { replyError } from '../http.js'
import { bookMovedFailure } from '../book-context.js'
import { DocumentService } from '../../../document/service.js'
import { readForeshadows, type ForeshadowEntry } from '../../../document/foreshadow.js'
import { openSessionStoreAsync, bookHash } from '../../../events/store.js'
import { recordForeshadowChanges } from '../../../events/chain-bridge.js'
import { log, errMsg } from '../../../log/index.js' // R43-23（四十三轮）：伏笔观测层失败留痕；复审-0914-优化修复批：errMsg 三目收编
import { createSerialChainMap } from '../serial-chain.js' // P1-3（复审-0914-优化修复批）：per-book 串行链四胞胎通用件
import type { TaskGate, TaskGateInjected } from './task-gate.js' // R0916-7-P3-12：结构操作忙闸单源（R0916-7-P3-6：闸实例经组装根注入；structureBusyGuarded 为模块级助手，显式接闸）
import type { DriverHost } from '../driver-port.js' // R0916-7-P3-6：driver 经组装根注入

export interface DocumentCtx extends TaskGateInjected {
  /** R0916-7-P3-6：driver 宿主（会话面 + 能力面）——组装根注入 */
  driver: DriverHost
  workDir: string | null
  /** Z-P2-6：伏笔事件族接线需要（null → 观测层静默跳过） */
  userDataPath: string | null
}

/** per-bookRoot DocumentService 缓存（跨请求共享串行队列）。 */
const services = new Map<string, DocumentService>()

/** per-bookRoot DocumentService 缓存（跨请求共享串行队列）。
 *  snapshots.ts 的恢复端点复用同一实例——两个队列会破坏串行写保证。
 *  userDataPath 供写时清理读 global.json 全局保留策略（版本保留三层链）。 */
export function getOrCreateService(bookRoot: string, userDataPath: string | null = null): DocumentService {
  let svc = services.get(bookRoot)
  if (!svc) {
    svc = new DocumentService({ bookRoot, userDataPath })
    services.set(bookRoot, svc)
  }
  return svc
}

/** 测试用：清空 service 缓存（避免跨用例串行队列泄漏）。 */
export function __clearDocumentServices(): void {
  services.clear()
}

/** 删书时清理对应 bookRoot 的 service 缓存（防同 path 重建复用旧实例）。 */
export function forgetService(bookRoot: string): void {
  services.delete(bookRoot)
}

/** 第五轮：等该书串行保存队列清空（删书/改名前 drain 用）——在途 save 的收尾
 * （journal+快照+fsync，慢盘几十 ms）若在 rmSync/renameSync 之后恢复，会对已删/
 * 已搬路径 atomicWriteFile 重建孤儿文件。轮询到零或超时（保存秒级异常时放行，
 * 与 settle 超时降级同口径）；无 service 或无在途 → 立即返回。 */
export async function drainDocumentSaves(bookRoot: string, timeoutMs = 2_000): Promise<void> {
  const svc = services.get(bookRoot)
  if (!svc) return
  const deadline = Date.now() + timeoutMs
  while (svc.inFlightSaves() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// ── Z-P2-6：伏笔事件族接线（设定/伏笔/*.md 变更 → foreshadow/change 事件）──────
// 快照-差分模式：变更前抓 设定/伏笔/ 全量状态（非伏笔路径 null 免读），变更后
// recordForeshadowChanges 差分落 workspace 会话（与 step/llm 链路事件同会话）。

/** 变更前快照：path 落在 设定/伏笔/ 才读（其余文档零开销直通 null）。
 *  R43-23（四十三轮）：docId 仅作失败留痕的因果标注（对齐 R67-7）。 */
function foreshadowSnapshot(bookRoot: string, path: string | null, docId: string): ForeshadowEntry[] | null {
  if (!path || !path.startsWith('设定/伏笔/')) return null
  try {
    return readForeshadows(bookRoot)
  } catch (e) {
    // R43-23（四十三轮）：空 catch 补留痕——快照失败静默返回 null 时本轮变更不落
    // foreshadow/change 事件且无从排查（观测层缺一段差分）；带 docId 因果
    log.warn('api', `伏笔快照读取失败（docId=${docId}），本轮变更不落 foreshadow/change 事件：${errMsg(e)}`)
    return null
  }
}

/** 变更后差分落事件：prev 为 null（非伏笔/快照失败）静默跳过；写失败静默（观测层）。
 *  R34D-19（三十四轮）：转 async——开库走 openSessionStoreAsync（首开锁等待不阻塞
 *  服务事件循环）；两处调用方均在异步 handler 内 await。 */
async function recordForeshadowDelta(
  userDataPath: string | null,
  bookRoot: string,
  prev: ForeshadowEntry[] | null,
  /** R43-23（四十三轮）：失败留痕的因果标注（对齐 R67-7） */
  docId: string,
): Promise<void> {
  if (!prev || !userDataPath) return
  try {
    const store = await openSessionStoreAsync(userDataPath, bookRoot)
    if (!store) return
    try {
      const sessionId = store.workspaceSession(bookHash(bookRoot))
      recordForeshadowChanges(store, sessionId, prev, readForeshadows(bookRoot))
    } finally {
      // L2（二轮复审）：openSessionStore 是引用计数单例——中途抛错（如跨进程 SQLITE_BUSY
      // 超时）不 close 则 refs 永不归零，连接泄漏；同文件其他调用方均为 try/finally 配对
      store.close()
    }
  } catch (e) {
    // 观测层：写失败不炸文档操作
    // R43-23（四十三轮）：空 catch 补留痕——差分落库失败静默时本轮伏笔事件缺失
    // 无从排查（文档操作本身已成功，事件链断在观测层）；带 docId 因果
    log.warn('api', `伏笔差分落事件失败（docId=${docId}，本轮伏笔变更未记录）：${errMsg(e)}`)
  }
}

// ── 重评2-P3-①（2026-09-09 全量重评 GLM-5.3）：伏笔保存 per-book 串行链 ─────────
// 原 PUT content 的 foreshadowSnapshot 读在 svc.save 的 per-docId 串行队列之外：两
// 并发保存交叠时双方快照基线同取前者变更前的状态，而 recordForeshadowDelta 的差分
// 读的是「当刻」全量状态——后落库的一方会把先落库者的变更一并计入自己的差分窗
// （事件流重复计窗）。现把「快照读 → save → 差分落事件」整段挂到 per-bookRoot
// promise 链上串行执行：后继单元的快照基线必然已含前继单元落库的变更，差分各归
// 各窗。仅伏笔域路径入链（非伏笔保存零开销、并行性不变）；链上单元失败不阻断后继
// （prev.then(unit, unit)），观测层串行不引入新的失败面；伏笔正本保存语义零变更
// （save 仍在原链路原样执行，只是调度位置移入临界段）。
// 清偿-伏笔接线×4（2026-09-09 残留清偿批）：PATCH（fm/rename/move/meta 共用 handler）、
// 新建、软删、copy 四处同型「快照读在链外」残留一并收口——各操作「快照读 → op → 差分」
// 整段入链，链内单元语义按各操作适配：新建/软删/copy 改 docId 集合，差分基线仍取
// 「本单元 op 前的全域快照」（差分是全域标题集对比，recordForeshadowChanges），链内
// 串行保证前继单元落库的增删改必在基线中，事件各归各窗。死锁核查：四处 op 体走
// SaveQueue（save）/chainDocMetaOp（meta/fm）/清单·回收站锁（create/copy/trash/
// rename/move），均只被链单元单向 await、从不反等本链，外链→内链/锁单向无环；
// drainDocumentSaves 只计 SaveQueue 在途，四处本就不入该计数，链化无顺序回归。
const foreshadowSaveChains = createSerialChainMap()
// P1-3（复审-0914-优化修复批）：链体机械段（prev.then(unit,unit) + settled 吞错 +
// R1010b-SRV-P3-1 链尾身份校验自清理）收编 serial-chain.ts createSerialChainMap
// 单源；本节保留编排语义头注（上方重评2-P3-① / 清偿-伏笔接线×4 沿革）。
function runInForeshadowSaveChain<T>(bookRoot: string, unit: () => Promise<T>): Promise<T> {
  return foreshadowSaveChains.enqueue(bookRoot, unit)
}

/** R1010b-SRV-P2-1（2026-09-10 内存专项重审修复批·面 B）：等该书伏笔串行链尾排空
 *  ——删书/改名前 drain（与 drainDocumentSaves / drainFilePutChainsUnder 同型）。
 *  竞态时序：已入队未启动的伏笔单元在 SaveQueue 之外（drainDocumentSaves 只计在途
 *  save，本链不可见——:148 旧注自认），不 drain 则删书/改名后链单元才开跑、照写旧
 *  捕获 bookRoot 落孤儿文件。快照式（同 drainFilePutChainsUnder 口径）：只等快照
 *  时点的链尾，drain 窗口内新进单元不等——其安全由单元体内书注册重验（409
 *  BOOK_MOVED）兜底。死锁核查：链单元只单向 await SaveQueue / 清单·回收站锁 /
 *  save·布线锁，从不反等 books 侧任何锁，drain 置于 books.ts 既有两 drain 之后不
 *  引入环。无条目即立即 resolve。
 *  P1-3（复审-0914-优化修复批）：实现收编 createSerialChainMap().drainExact
 *  （恰等键排空 = 本链原口径）。 */
export async function drainForeshadowSaveChains(bookRoot: string): Promise<void> {
  return foreshadowSaveChains.drainExact(bookRoot)
}

/** R1010b-SRV-P3-1：删书/改名按书清理伏笔链 Map 条目（对齐 forgetService 等既有
 *  forgetBookKeyedCaches 挂点形态）——链尾自清理已覆盖常态，此处兜悬挂残条。
 *  P1-3（复审-0914-优化修复批）：实现收编 createSerialChainMap().forget。 */
export function forgetForeshadowSaveChain(bookRoot: string): void {
  foreshadowSaveChains.forget(bookRoot)
}

/** R1010b-SRV-P3-1：测试观测钩子（对齐 files.ts __filePutChainKeysForTest 风格）——
 *  当前在途伏笔链键的只读快照（自清理/forget 生效断言用；快照时点在途，settle 后
 *  自清理）。P1-3（复审-0914-优化修复批）：实现收编 createSerialChainMap().keysForTest。 */
export function __foreshadowSaveChainKeysForTest(): readonly string[] {
  return foreshadowSaveChains.keysForTest()
}

// ── 阶段 24 章节结构操作：per-book structure 串行链（draftSaveChains 同款范式）──────
// 合并/拆分/撤销是「多文档、多步」的结构性操作（save + trash + create 三个内部各自
// 有锁，但操作间序须整段串行：同书两次并发合并会在 fm 并入 折叠上互相覆盖）。链
// key=书根；链单元只单向 await DocumentService 的 per-doc 队列/清单/回收站锁与 RAG
// 清理，从不反等 books 侧锁，drain 置于既有四 drain 之后不引入环。链内临界段首行
// bookMovedFailure 单源重验（readJson await 窗口内书可被删/改名，重评-0912-4 P2-1
// 同款幽灵目录防线）。
// P1-3（复审-0914-优化修复批）：链体机械段收编 createSerialChainMap 单源
//（drainMatch 'exact-or-prefix' = 本链原口径：链键恰为书根本体，无尾分隔符）。
const structureChains = createSerialChainMap()

export function enqueueStructureOp<T>(bookRoot: string, critical: () => Promise<T>): Promise<T> {
  return structureChains.enqueue(bookRoot, critical)
}

/** 阶段 24：等待某书在途 structure 串行链排空——books.ts 删书/改名排水段第 5 调用
 *  （drainDraftSaveChainsUnder 同型：恰等于书根 + realpath 双口径；快照式——drain
 *  窗口内新进链不等，由链内 bookMovedFailure 重验兜底拒绝）。
 *  P1-3（复审-0914-优化修复批）：实现收编 createSerialChainMap().drainUnder。 */
export async function drainStructureChainsUnder(bookRoot: string): Promise<void> {
  return structureChains.drainUnder(bookRoot)
}

/** 阶段 24：测试观测钩子（__draftSaveChainKeysForTest 同款）——当前在途链键只读快照。
 *  P1-3（复审-0914-优化修复批）：实现收编 createSerialChainMap().keysForTest。 */
export function __structureChainKeysForTest(): readonly string[] {
  return structureChains.keysForTest()
}

// ── R1010b-SRV-P2-1（2026-09-10 内存专项重审修复批·面 A）：书注册重验 ─────────
// 五处链内写单元（PUT content / PATCH / 新建 / 软删 / copy）的临界段首行防线；重验
// 竞态时序与防线形态单源见 book-context.ts R0912-B-P3-2 头注（R0912-B-P3-2 起四处
// 本地拷贝收敛到 book-context.ts）。本文件特有：SaveOutcome/CreateResult 等失败
// code 联合在 src/document/service.ts 是闭集合（本批不越界改源），BOOK_MOVED 以
// 本地等价形状（ok:false + code + reason，下方 BookMovedFailure）扩展，出口统一经
// structStatus（随批补 409 映射）走 replyError 单一出口，信封形状与其他结构化失败一致。

/** 书注册重验失败的结构化出口（BOOK_MOVED 本地扩展形状，见上节头注）。 */
type BookMovedFailure = { ok: false; code: 'BOOK_MOVED'; reason: string }

/** R0912-B-P3-2：单源重验（book-context.ts）的本文件包装——链单元返回联合以 ok
 *  判别（SaveOutcome/CreateResult/MoveResult 均以 ok:true 成功判定），核心对象补
 *  ok:false 组合，响应契约逐字节不变。 */
function bookMovedFailureOk(ctx: DocumentCtx, name: string | undefined, capturedRoot: string): BookMovedFailure | null {
  const moved = bookMovedFailure(ctx.workDir, name, capturedRoot)
  return moved === null ? null : { ...moved, ok: false }
}

// ── R0916-5a（2026-09-16）：五站写端点不变链收编单源 ─────────────────────────
// 原 runSave/runCreate/runPatch/runCopy/runTrash 五份脚手架拷贝（PUT content / 新建 /
// PATCH / copy / 软删）共享同一不变序，收编为 runBookScopedOp，各站只存 op 业务体与
// 站参数：
//   ① 链单元首行书注册重验（R1010b-SRV-P2-1 面 A → 409 BOOK_MOVED；竞态时序见
//     book-context.ts R0912-B-P3-2 头注）；
//   ② 伏笔快照先于 op（Z-P2-6：差分需要变更前状态；快照读在链内——重评2-P3-① /
//     清偿-伏笔接线×4：链内串行保证前继落库变更必在基线中，差分各归各窗）；
//   ③ op 业务体（PATCH 形状校验 400 也留在单元内——BOOK_MOVED 409 先于 BAD_INPUT
//     400 的现行错误优先序；返回 undefined = 响应已发，直通不落差分）；
//   ④ op 成功才差分落事件（观测层，写失败静默）；
//   ⑤ 伏笔域路径（fsPath 前缀判定；patch/trash 的 docPath null 守卫同形收编）整段
//     入 per-book 伏笔串行链，非伏笔直调（快照直通 null、并行性不变）。
// 响应信封不进本 helper——五站回复尾保持原样逐字节不变（save 成功体是投影非透传）。
// deltaId 仅在 result.ok 时回调（R43-23 留痕口径：save/patch/trash 恒 docId；
// create/copy 取 result.docId，回调的 else 支为类型完备的不可达兜底）。

/** runBookScopedOp 站参数：bookName/bookRoot 供链单元首行重验；fsPath 兼任伏笔域
 *  判定与快照路径（null 免读直通）；causeId/deltaId = R43-23 留痕因果。 */
interface BookScopedOpSite<T extends { ok: boolean }> {
  bookName: string | undefined
  bookRoot: string
  fsPath: string | null
  causeId: string
  deltaId: (result: T) => string
  op: () => Promise<T | undefined>
}

// 重载分档：op 不发 undefined 的四站（save/create/copy/trash）取第一重载——返回
// 类型不含 undefined，回复尾零类型噪音；PATCH 的 op 返回 MoveResult | undefined 落
// 第二重载（第一重载的 T 约束对含 undefined 的推断不成立，落档由类型系统可证，
// 非断言）。
export async function runBookScopedOp<T extends { ok: boolean }>(
  ctx: DocumentCtx,
  site: BookScopedOpSite<T> & { op: () => Promise<T> },
): Promise<T | BookMovedFailure>
export async function runBookScopedOp<T extends { ok: boolean }>(
  ctx: DocumentCtx,
  site: BookScopedOpSite<T>,
): Promise<T | BookMovedFailure | undefined>
export async function runBookScopedOp<T extends { ok: boolean }>(
  ctx: DocumentCtx,
  site: BookScopedOpSite<T>,
): Promise<T | BookMovedFailure | undefined> {
  const unit = async (): Promise<T | BookMovedFailure | undefined> => {
    const moved = bookMovedFailureOk(ctx, site.bookName, site.bookRoot)
    if (moved) return moved
    const fsPrev = foreshadowSnapshot(site.bookRoot, site.fsPath, site.causeId)
    const result = await site.op()
    if (result !== undefined && result.ok) {
      await recordForeshadowDelta(ctx.userDataPath, site.bookRoot, fsPrev, site.deltaId(result))
    }
    return result
  }
  return site.fsPath !== null && site.fsPath.startsWith('设定/伏笔/')
    ? runInForeshadowSaveChain(site.bookRoot, unit)
    : unit()
}

/** R0916-5a（2026-09-16）：structure-apply / merge-undo 两站重复的 busy 守卫四连
 *  收编单源——次序 self-heal → spawn → orchestration → 三审与四条 409 文案逐字节
 *  保留。返回 true = 已回写 409，调用方直接 return。'structure' 任务闸不在此列：
 *  闸调用点保持各站原位原样（known-actions-audit 按真实调用点对账）。
 *  R0916-7-P3-12：四连本体收编为 task-gate 的 BUSY_MATRIX 'structure' 行（原实序
 *  self-heal → spawn → orchestrationBusyFor(self-heal 重复/chat/spawn 重复/后台) →
 *  三审；表里前两格即原前两闸，chat/background 承接编排面，末格三审——重复格去重后
 *  的可观察文案与序等价：前两闸同步无 await，重复核查永不可达）。 */
export function structureBusyGuarded(gate: TaskGate, name: string, res: ServerResponse): boolean {
  const busy = gate.busyReason(name, 'structure')
  if (busy) {
    replyError(res, 409, 'BUSY', busy)
    return true
  }
  return false
}

/** 结构性操作错误码 → HTTP status（W2A §8）。 */
export function structStatus(code: string): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404
    case 'CAPABILITY_DENIED':
      return 403
    case 'PATH_ESCAPE':
    case 'BAD_INPUT':
      return 400
    case 'ALREADY_EXISTS':
    case 'OCCUPIED':
    case 'REVISION_CONFLICT':
      return 409
    // 阶段 24 章节结构操作：干跑指纹失配/无并入可撤销/回滚快照缺失均为账实状态冲突
    //（可重试或人工处置）；非 UTF-8 存量与拆分点非法属输入问题 → 400（NOT_UTF8_TARGET
    // 对齐 draft-save 同码档位）
    case 'PLAN_STALE':
    case 'NOT_MERGE_STATE':
    case 'UNDO_NO_SNAPSHOT':
      return 409
    case 'NOT_UTF8_TARGET':
      return 400
    // R1010b-SRV-P2-1（2026-09-10 内存专项重审修复批）：书注册重验失败（删书/改名
    // drain 窗口后新进单元）——账实状态冲突可重试，与 REVISION_CONFLICT/OCCUPIED
    // 冲突族同 409 档（ee-P1-3 LEAD_GATE 同口径先例）
    case 'BOOK_MOVED':
      return 409
    // S5（阶段 24）：WRITE_ERROR 升 409 可重试档——apply 收尾段锁等待超时等瞬态写
    // 失败的信封自带「重试将自动续跑收尾」语义（finishMerge 幂等），与 files.ts PUT
    // 的 409 WRITE_ERROR 拒写可重试口径对齐（原 500 档让重试语义失真）
    case 'WRITE_ERROR':
      return 409
    // B004（0918三拍板批）：全书 fm ≡ 文件名号失配——盘面账实状态冲突（修书后可
    // 重试），与 PLAN_STALE 冲突族同 409 档
    case 'CHAPTER_NO_MISMATCH':
      return 409
    default:
      return 500
  }
}
