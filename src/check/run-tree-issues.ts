/**
 * 树红点聚合族 —— （⑤④产品巨件拆分波2）自 run.ts 缝 A 拆出
 *（纯移动，零行为变化；代码与注释逐字未改）。
 *
 * 内容：TREE_ISSUES_YIELD_EVERY / __setLeadsBookDegradeForTest /
 * __setChapterCheckDegradeForTest / TreeIssuesResult（模块私有接口，原即未导出）/
 * collectTreeIssues / collectTreeIssuesAsync / collectTreeIssuesCore（生成器实现体，
 * 原 run.ts L457-850 一带）。依赖 tree-issues-cache / leads / outline-leads /
 * document / format / fs / log / async——编辑器层内闭合。
 *
 * （评审 /）两处结构变更（行为逐位不变）：
 * - 实现体拆为四段接力（前奏 / 输入面 / 账本全书性红项 / 逐章收集）+ 纯汇总，段间只经
 *   返回值传数据（原单件生成器内 IO 与判定交织）；纯判定件落 tree-issues-collect.ts。
 * - 单章机检链与批量预扫的实现体迁出 run.ts → run-single-doc.ts，本件直接引该件；
 *   run.ts 退为兼容桥（只 re-export）。两文件互 import 的运行时环（评审的
 *   check/run ↔ check/run-tree-issues）由此消失——ESM 具名绑定惰性解析不再需要承担
 *   环上的加载序。
 * 既有导出面（collectTreeIssues/collectTreeIssuesAsync/__setLeadsBookDegradeForTest/
 * __setChapterCheckDegradeForTest）由 run.ts 具名 re-export 桥接，全库 import 面零改动。
 */
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { scanChapterDirCore } from '../format/chapters.js'
import { readManifestDegraded, type ManifestEntry } from '../document/manifest.js'
import { deriveStatus } from '../document/status.js'
import { probeCachedRevision, probeCachedPublished } from '../document/tree.js'
import { existingAnalysisPath } from '../document/analysis.js'
import { docJoinKey, normalizeWinSeparators } from '../fs/safe-path.js'
import type { BookConfig, ChapterMeta } from '../format/types.js'
import { enabledLeadTypes } from './leads-config.js'
import { scanOutlineDeclarationMemo } from './outline-leads.js'
import {
  syncTreeIssuesEpoch,
  readTreeIssuesCache,
  writeTreeIssuesCacheBatch,
  computeLeadsBookFp,
  computeLeadsBookFpFromEpochFpCore,
  readLeadsBookRed,
  writeLeadsBookRed,
  computeTreeIssuesGlobalFpCore,
  closeTreeIssuesDb,
} from './tree-issues-cache.js'
import { checkLeadsBookItemsCore } from './leads.js'
import {
  readCheckConfig,
  openCheckDb,
  openCheckDbAsync,
  checkWithDb,
  maxWrittenChapterOf,
  scanChapterUpdatesByChapterCore,
  type BatchCheckContext,
  type OpenCheckDbOpts,
  type OpenCheckDbResult,
} from './run-single-doc.js'
import {
  treeIssuesChapterEntry,
  shouldQueueChapterCacheRow,
  indexManifestByPath,
  indexEntriesByPath,
  treeChapterAggregationStatus,
  skipsTreeRedDot,
  type TreeIssueEntry,
} from './tree-issues-collect.js'
import { log, errMsg } from '../log/index.js'
import { yieldToEventLoop } from '../async.js'
import { testableConst } from '../shared/testable.js'
import { preludeYieldStats } from '../shared/yield-stats.js'

// ── ：树红点聚合 async 孪生的逐块让出 ──────────────────────
// 服务是 Electron 主进程内嵌的单进程 HTTP 服务，collectTreeIssues 同步遍历全书
//（rebuild + 全章扫描 + 逐章机检）在 ≥500 章大书上单请求秒级冻结事件循环 = 桌面
// 整体卡死；既有 5s TTL 缓存只降频不减峰。异步让出范式同 learn/index.ts
//（setImmediate 级让出，块与块之间其它请求/SSE 心跳可跑）。让出窗口内的并发由既有
// 防护兜底：db busy_timeout 5s（与同进程 rebuild 并发等锁，见下方开库注释）、单章
// 失败 fail-open 不落缓存、写前纪元复核（//——聚合窗口
// 内输入变更整批丢弃缓存行）——同步版这些防护本就面向跨进程并发，async 版让出后的
// 同进程并发同享这套口径。
// 实现取「生成器核心 + 双驱动」而非复制体：逻辑单源零漂移（同步版驱到尾 = 与修复前
// 逐位等价的纯同步执行，存量测试调用方零感知），async 版在每个悬停点让出。
// 阶段 52 批 1 落定：前奏段切片 + rebuild 效应让出——fp 首尾遍（dirFp 递归
// walk）、正文/章纲目录整扫、账本预扫各自收进生成器核（tree-issues-cache / format/
// chapters / run），核内 `yield*` 委托、让出点透传本文件两驱动；rebuild/开库段
//（openCheckDb）改「效应让出」档：核 yield 效应对象，同步驱动现执行现回填（= 与切片前
// 逐位一致），async 驱动 await openCheckDbAsync（rebuild 内核走 worker 线程）后回填。
// 剩余单段同步块 = 单文件/单句柄粒度残余（如实记账）。
/** 章循环的让出粒度——每处理 25 章让出一次（块内单章 stat/机检为毫秒级）。 */
const TREE_ISSUES_YIELD_EVERY = 25

/**
 * 阶段 52 批 1：「效应让出」契约——核内单段同步块（rebuild/开库）无法靠
 * yield 悬停点切分（块内零悬停，且异步实现要换线程跑），改为 yield 一个效应请求对象，
 * 由驱动决定怎么执行、把结果 next 回填：
 *   yield 无值（undefined） = 纯悬停：同步驱动直推 next，async 驱动 await 让出事件循环
 *   yield TreeEffect        = 效应请求：同步驱动现执行现回填，async 驱动 await 异步实现后回填
 * 核内写法与普通悬停点同形（`const opened = (yield eff) as OpenCheckDbResult`），
 * 两种驱动各自解释——逻辑单源，无「同一段写两遍」的漂移面。
 */
type TreeEffect = { kind: 'openCheckDb'; bookRoot: string; hasWiring: boolean; opts: OpenCheckDbOpts }

/** 测试注入：async 效应实现替换口——断言 async 驱动确实走异步档（worker 路数）而非
 *  回落同步执行。生产恒 null（走真实 openCheckDbAsync）。 */
export const [getOpenCheckDbEffectForTest, __setOpenCheckDbAsyncForTest] = testableConst<
  ((eff: TreeEffect) => Promise<OpenCheckDbResult>) | null
>(null)

/** 同步效应执行：与切片前的内联调用逐位一致（含 preludeYieldStats.rebuild 计数）。 */
function execEffectSync(eff: TreeEffect): OpenCheckDbResult {
  preludeYieldStats.rebuild++
  return openCheckDb(eff.bookRoot, eff.hasWiring, eff.opts)
}

/** 异步效应执行：rebuild 内核搬 worker（openCheckDbAsync），降级信封口径与同步版同款。 */
async function execEffectAsync(eff: TreeEffect): Promise<OpenCheckDbResult> {
  preludeYieldStats.rebuild++
  const override = getOpenCheckDbEffectForTest()
  if (override) return override(eff)
  return openCheckDbAsync(eff.bookRoot, eff.hasWiring, eff.opts)
}

/** 测试注入：强制账本全书性红项计算抛错——验证 leadsBookDegraded 透出路径
 *  （真实损坏多被 readLeadsBookRed 自愈吞掉,难确定性触发）。生产恒 false。
 *  三件套换装 testableConst 工厂：getter 消费点显式调用，setter 元组第二位原名原签名。 */
export const [getLeadsBookDegradeForTest, __setLeadsBookDegradeForTest] = testableConst(false)

/** 测试注入：强制章级机检失败——验证 chaptersDegraded 透出路径
 *  （真实失败多为瞬态竞态/名册 ENOENT，难确定性触发）。生产恒 false。
 *  三件套换装 testableConst 工厂：getter 消费点显式调用，setter 元组第二位原名原签名。 */
export const [getChapterCheckDegradeForTest, __setChapterCheckDegradeForTest] = testableConst(false)

/** 树红点聚合结果形状（同步/async 孪生共用）。 */
interface TreeIssuesResult {
  issues: Record<string, { hasRed: boolean; verdictRejected: boolean }>
  rebuildFailed: boolean
  leadsBookDegraded: boolean
  chaptersDegraded: number
  /** 正文目录解析失败章计数（章号损坏章对树红点隐形，>0 = 本轮树不完整） */
  chaptersParseDegraded: number
  /** 清单读取失败降级旗标（读失败此前与「无清单」同归空表静默——
   *  章-账本红点整轮失明零透出，唯一数据正确性面的静默降级）。true = 本轮红点
   *  不完整，端点层转 warnings 透出（api/check.ts，与 rebuildFailed 同口径）。 */
  manifestDegraded: boolean
}

/**
 * 树红点聚合：扫正文章节，返回 { docId: { hasRed, verdictRejected } }（仅含有 issue 的 docId）。
 * HTTP 路径改走 async 孪生 collectTreeIssuesAsync；本同步版保留——
 * 存量测试调用方（test/check/ 下十余个回归文件）与等价性对照基准仍用同步口径。
 */
export function collectTreeIssues(
  bookRoot: string,
  readReviewVerdict: (docId: string) => { approved: boolean } | undefined,
  userDataPath?: string | null,
): TreeIssuesResult {
  // 同步驱动——生成器 yield 只把控制权交还本驱动，随即 next 续跑，
  // 净效果与修复前的纯同步执行逐位一致（无事件循环参与）；效应 yield（rebuild/开库）
  // 现执行现回填，同样零事件循环参与。
  // 阶段 52 批 1：回填结果必须接在 r 上继续判 done——效应 yield 可能是整轮
  // 聚合的**唯一**悬停点（小书：章数/目录项数均低于各段让出阈值），丢弃它再 next
  // 会让「已完成生成器」返回 {done:true, value:undefined} 把聚合结果吞成 undefined。
  const it = collectTreeIssuesCore(bookRoot, readReviewVerdict, userDataPath)
  let r: IteratorResult<void | TreeEffect, TreeIssuesResult> = it.next()
  while (!r.done) {
    const eff = r.value
    r = eff === undefined ? it.next() : it.next(execEffectSync(eff))
  }
  return r.value
}

/**
 * collectTreeIssues 的 async 孪生——生成器核心的每个章循环悬停点
 *（每 TREE_ISSUES_YIELD_EVERY 章）await setImmediate 让出事件循环，大书聚合期间
 * 其它请求/SSE 心跳可跑（服务热路径纪律：禁止同步长段，让出范式同 learn/index.ts
 * ）。并发防护口径见上方注释块——与同步版共享，无新增差异面。
 * 阶段 52 批 1：驱动加 inject 槽承载「效应让出」——rebuild/开库段改 await
 * openCheckDbAsync（rebuild 内核走 worker 线程，慢盘上该段不再冻结事件循环）。
 */
export async function collectTreeIssuesAsync(
  bookRoot: string,
  readReviewVerdict: (docId: string) => { approved: boolean } | undefined,
  userDataPath?: string | null,
): Promise<TreeIssuesResult> {
  const it = collectTreeIssuesCore(bookRoot, readReviewVerdict, userDataPath)
  let inject: OpenCheckDbResult | undefined
  for (;;) {
    const r = it.next(inject)
    inject = undefined
    if (r.done) return r.value
    if (r.value !== undefined) inject = await execEffectAsync(r.value as TreeEffect)
    else await yieldToEventLoop()
  }
}

// ── 聚合管线：四段接力─────────────────────────────────────────
// 段序是三处既有不变量所定，不可调换：
// ① 纪元基线（epochFp0）必须在 rebuild **之前**算得——头窗内源变使首尾 fp
//    不等，整批落盘按既有失效路径丢弃，陈旧红值不会以新纪元固化；基线缺席（前算失败）
//    一律按 miss 处理（宁重算勿混纪元）。
// ② 账本全书性红项先于章循环定型——章级条目的展示值要合并它，而章级缓存行只存
//    章作用域 hasRed。
// ③ 待落盘章缓存行必须在循环后经一次终核纪元再写盘——故「逐章收集」段一次
//    交出「红点表 + 待落盘行」，写盘紧随其后（同在收集段尾，pendingCacheWrites 不出段）。
// 段间只经返回值传数据（无跨段闭包状态）；判定面（条目合并/入列闸/索引折叠）另有纯件
// tree-issues-collect.ts 直测。

/** 前奏段产物：纪元基线 + 开库结果（db 句柄由核的 finally 收口）。 */
interface TreeIssuesPrelude {
  config: BookConfig
  hasWiring: boolean
  db: DatabaseSync | null
  rebuildFailed: boolean
  epochFp0: string | null
}

/**
 * 前奏段：读配置 → 纪元基线（rebuild 之前）→「rebuild→开库→PRAGMA」。
 * 悬停面两处：fp 首遍（递归 walk 委托进核）与开库效应（TreeEffect，由驱动解释执行）。
 */
function* openTreeIssuesAggregate(
  bookRoot: string,
  userDataPath: string | null,
): Generator<void | TreeEffect, TreeIssuesPrelude, unknown> {
  // 检查 .ok，损坏时 warn 留诊断（config 回落 DEFAULT_CONFIG，不阻断）
  // 树聚合路径降级只 warn 不产黄项——树红点聚合只吃 hasRed
  // （issues 只记 {hasRed, verdictRejected}，黄项无处落），逐章注入黄项既不可见又会
  // 拖累章级缓存判定；降级可见性由 warn 日志 + 单章面板（runCheckForDocument 注入的
  // book-config-degraded 黄项）承担。（「读配置→托底」前奏收编 readCheckConfig
  // ——与 runCheckForDocument 同源；树聚合只吃 config，degradedError 弃用。）
  const { config } = readCheckConfig(bookRoot, userDataPath)
  const hasWiring = existsSync(join(bookRoot, '布线'))
  let db: DatabaseSync | null = null
  let rebuildFailed = false
  // 纪元指纹基线再前移——rebuild **之前**。 的前移只到
  // sync 之前，rebuild 内部扫源 stat 与 fp0 计算之间仍留头窗：窗口内源文件被改写时
  // rebuild 读到旧库、其后计算的 fp0 已是新纪元 → 陈旧红值以新纪元落缓存（指纹自洽，
  // 终核不再失效它，红点口径被固化到下纪元）。fp0 提前后终核（epochFpEnd）窗口覆盖
  // 「fp0 → 聚合全程」：头窗内任何变更使 fpEnd≠fp0，整批写入按既有失效路径丢弃。
  // fp 前算失败不阻断 rebuild：保持 null，sync 处 precomputedFp 缺省自算兜底（再败
  // 则 cacheEnabled=false 走全量，降级口径不变）。
  let epochFp0: string | null = null
  if (hasWiring) {
    try {
      epochFp0 = yield* computeTreeIssuesGlobalFpCore(bookRoot, userDataPath)
    } catch {
      /* fp 前算失败：rebuild 照常，sync 处自算兜底 */
    }
    // rebuild / 开库 / PRAGMA 的硬异常按 fail-open 降级（warn + 留痕），
    // 不再穿透成 500——与缓存层头注释「读写失败跳过缓存走全量路径」红线对齐。此前只有
    // 「rebuild 报错列表非空」这一种失败形态走了降级，库损坏/锁超时直接把树红点端点打挂。
    //（「rebuild→开库→PRAGMA」前奏收编 openCheckDb（failMode 'fail-open'，rebuild
    // 失败降级 comment 随实现移入该函数）；树聚合不吃节流，口径见其头注。）
    // 阶段 52 批 1：改「效应让出」——同步驱动现执行现回填（openCheckDb，行为
    // 与切片前逐位一致），async 驱动 await openCheckDbAsync（rebuild 走 worker 线程）
    const opened = (yield {
      kind: 'openCheckDb',
      bookRoot,
      hasWiring,
      opts: { throttleSourceProbe: false, failMode: 'fail-open' },
    }) as OpenCheckDbResult
    db = opened.db
    rebuildFailed = opened.rebuildFailed
  }
  return { config, hasWiring, db, rebuildFailed, epochFp0 }
}

/** 输入面段产物：清单/正文目录/账本预扫（章循环的只读输入）。 */
interface TreeIssuesInputs {
  bodyDir: string
  bodyChapters: ChapterMeta[]
  chaptersParseDegraded: number
  pathToDocId: Map<string, string>
  /** 折叠 join 键 → 清单条目（定稿态跳过判定用；与 pathToDocId 同键空间） */
  entryByPath: Map<string, ManifestEntry>
  manifestDegraded: boolean
  maxWritten: number | undefined
  cacheEnabled: boolean
}

/**
 * 输入面段：清单整读（降级旗标）→ docId 反查表 → 纪元同步 → 正文目录整扫 → 未来章基准。
 * 悬停面 = 正文目录整扫（scanChapterDirCore 委托进核）。
 */
function* loadTreeIssuesInputs(
  pre: TreeIssuesPrelude,
  bookRoot: string,
  userDataPath: string | null,
): Generator<void, TreeIssuesInputs, unknown> {
  const { db, epochFp0 } = pre
  // 此处整读的 entries 直传 maxWrittenChapterOf
  //（原其内部再 readManifest 同一清单 = 单请求双读）
  // 读失败（EACCES/EBUSY/EIO 瞬态）此前与「无清单」同为空表静默
  // ——整轮章-账本红点失明零透出。改走 readManifestDegraded 分离「不存在=合法空」
  // 与「读失败=降级」：降级 warn 留痕 + manifestDegraded 旗标随返回透出。
  const manifestRead = readManifestDegraded(join(bookRoot, '项目', '文档清单.jsonl'))
  if (manifestRead.degraded) {
    log.warn('check', `文档清单读取失败（${manifestRead.degraded.code}），本轮章-账本红点聚合降级（红点可能缺失）`)
  }
  const manifestDegraded = manifestRead.degraded !== null
  const manifest = manifestRead.manifest.entries
  // join 键折叠（win32 大小写 + NFC）——盘上扫描路径与清单登记
  // 路径仅大小写/组合形异时 docId 仍可追溯（下方 .get 侧同键）
  const pathToDocId = indexManifestByPath(manifest)
  // 定稿态跳过判定用（同上折叠键；case-only 改名章的条目仍可命中）
  const entryByPath = indexEntriesByPath(manifest)
  const bodyDir = join(bookRoot, '写作', '正文')
  // 增量缓存——只重查指纹变过的章。仅对有布线的书启用（长篇才是
  // 数百章规模；短篇不开 .cache/index.db，行为与从前完全一致）。表缺席/纪元
  // 同步失败 → cacheEnabled=false 走现行全量路径（语义无损降级）。
  let cacheEnabled = false
  // 纪元 fp 写前复核基线——fp 在聚合开头计算、行写入在其后，
  // 外部编辑器/第二进程恰在窗口内改纪元输入时旧行按新输入视角陈旧落表（单请求
  // 周期陈旧、下一聚合自愈，但该周期红点错）。写入前复核 fp 未变才落缓存。
  // 基线声明前移至 hasWiring 块（rebuild 之前计算，见上方注释）。
  if (db) {
    try {
      // 纪元指纹首遍前移——传入预计算 fp 复用（起 fp0
      // 在 rebuild 之前算得，sync 不再自算）；传入的 fp 与落表 global_fp 同源
      // （基线即纪元）。首尾口径（既定）不变：首 = rebuild 前一遍，
      // 尾 = 循环后终核一遍。
      syncTreeIssuesEpoch(db, bookRoot, userDataPath, epochFp0 ?? undefined)
      cacheEnabled = true
    } catch {
      cacheEnabled = false
    }
  }
  // 账本全书性红项（章号一致/引文命中/状态闭合）——本书一次计算，
  // 按「纪元 + 正文目录指纹」独立缓存（tree_issues_meta leads_book_*），不进章级行。
  // 此前它们进每章 report 的 hasRed，却只按本章 stat 失效：改第 N 章正文补/删引文后
  // 其余章缓存红点陈旧（假红残留或漏红）。指纹含正文目录摘要——改任何一章都会重算
  // 这一项（正确性所需），章级行的增量性不受拖累。计算失败 fail-open：不落缓存、
  // 本轮按无红处理（下轮重试），不拦树。
  // 全书最高已定稿章号：一次预扫两处共用——leads 全书性红项的未来章基准 + 章循环
  // batch（新增消费方；不共用会把 readChapterDir 调用次数抬高回去，的
  // 调用次数回归锚会红）。-管线：bodyChapters 列表直接传入
  // maxWrittenChapterOf——原实现内部重扫一遍正文（「一次预扫」注释与实现漂移）
  // manifest entries 同点直传（消聚合头双读，见上）
  // 正文目录解析错误不再静默丢弃——章号损坏/缺章号的章进不了
  // chapters 列表，树红点对其完全隐形（损坏越重越安静）。errors 逐条 warn 留痕并以
  // 计数透出（chaptersParseDegraded，与 chaptersDegraded 同款降级口径）；章级黄项
  // 无处落（issues 只存 hasRed/verdictRejected 布尔，见上方注），可见性由
  // 计数标志 + warn 承担。
  const bodyDirScan = existsSync(bodyDir) ? yield* scanChapterDirCore(bodyDir) : null
  const bodyChapters = bodyDirScan?.chapters ?? []
  let chaptersParseDegraded = 0
  for (const pe of bodyDirScan?.errors ?? []) {
    chaptersParseDegraded++
    log.warn('check', `章文件解析失败（树红点对该章失明）：${pe.file}——${pe.message}`)
  }
  const maxWritten = maxWrittenChapterOf(bookRoot, bodyChapters, manifest)
  return {
    bodyDir,
    bodyChapters,
    chaptersParseDegraded,
    pathToDocId,
    entryByPath,
    manifestDegraded,
    maxWritten,
    cacheEnabled,
  }
}

/** 账本全书性红项段产物（本书一次算 + 独立指纹缓存）。 */
interface LeadsBookRedState {
  leadsBookRed: boolean
  leadsBookDegraded: boolean
}

/** 账本全书性红项段：指纹命中的缓存读，miss 走全账本扫描并按写前终核决定是否落缓存。 */
function* computeLeadsBookRed(
  pre: TreeIssuesPrelude,
  maxWritten: number | undefined,
  bookRoot: string,
  userDataPath: string | null,
): Generator<void, LeadsBookRedState, unknown> {
  const { config, db, rebuildFailed, epochFp0 } = pre
  let leadsBookRed = false
  // 账本全书性红项计算失败的可视标志——此前静默降级为「无红」，持续性失败
  // 期间全树永不显示账本红项且响应无 warning（fail-open 方向是漏红，与 rebuildFailed
  // 处理不对称）；随响应透出让前端留痕
  let leadsBookDegraded = false
  if (db && !rebuildFailed) {
    try {
      if (getLeadsBookDegradeForTest()) throw new Error('R62-7 注入：账本全书性红项读取失败')
      // epochFp0（轮基线，rebuild 前算得）在座时 leadsBook
      // 指纹按 `${epochFp0}|${dirFp(正文)}` 拼装（computeLeadsBookFpFromEpochFp，与
      // computeLeadsBookFp 输出逐字节同构、值域同空间）——不再整调
      // computeTreeIssuesGlobalFp，聚合的全局目录递归 stat 自此首（epochFp0）尾
      // （epochFpEnd）各一遍（口径成立，见下方待落盘段注）；基线缺席（前算
      // 失败为 null）回落全算，非空/null 分支语义保持。
      const leadsFp =
        epochFp0 !== null
          ? yield* computeLeadsBookFpFromEpochFpCore(bookRoot, epochFp0)
          : computeLeadsBookFp(bookRoot, userDataPath)
      const cachedRed = readLeadsBookRed(db, leadsFp)
      if (cachedRed !== null) {
        leadsBookRed = cachedRed
      } else {
        // 零定稿章（新书/清单损坏）的回退已内置 maxWrittenChapterOf
        //（bodyChapters 全空时以 0 为基准）；：原 `?? maxExisting`
        // 死回退与「回退全书最高现存章号」注释删除——maxWritten 为 undefined 仅当
        // bodyChapters 为空，此时 maxExisting 恒 0，真回退在上移的函数内完成
        leadsBookRed = (yield* checkLeadsBookItemsCore(db, bookRoot, maxWritten ?? 0, enabledLeadTypes(config))).some(
          (i) => i.level === 'red',
        )
        // 写前纪元终核（章级行同款口径）——leadsFp 在
        // 聚合开头计算，checkLeadsBookItems 全账本扫描期间外部编辑器/第二进程可改
        // 纪元输入，旧行按新输入视角陈旧落表。写前复核 fp 未变才落缓存；漂移 → 本轮
        // 不固化（fail-open 不拦树，leadsBookRed 本轮值照常返回，仅缓存不写、下轮重算）。
        // 复核改同基线拼装——leadsFpNow = `${epochFp0}|${dirFp(正文) 新鲜扫描}`，
        // 正文目录窗口内漂移照旧拦固化；全局输入窗口内漂移不再拦写，但落表行仍带
        // 轮基线纪元、全局输入一变读侧 leadsFp 必全等失配 miss 自愈重算（readLeadsBookRed
        // 的 fp 比对即失效判定，语义不变；mtimeNs 粒度下旧 fp 值不可复现，无脏读面）
        // ——两分支下轮都付同一次重算，仅少留一行必然失效的单键值。
        const leadsFpNow =
          epochFp0 !== null
            ? yield* computeLeadsBookFpFromEpochFpCore(bookRoot, epochFp0)
            : computeLeadsBookFp(bookRoot, userDataPath)
        if (leadsFpNow === leadsFp) {
          writeLeadsBookRed(db, leadsFp, leadsBookRed)
        } else {
          log.warn('check', '账本全书性红项聚合窗口内纪元漂移——本轮结果不落缓存（下轮重算）')
        }
      }
    } catch (e) {
      leadsBookDegraded = true
      log.warn('check', `账本全书性红项计算失败（本轮降级为无，不落缓存）：${errMsg(e)}`)
    }
  }
  return { leadsBookRed, leadsBookDegraded }
}

/** 逐章收集段入参（段间数据全量显式传入，无隐式闭包态）。 */
interface ChapterCollectArgs {
  bookRoot: string
  userDataPath: string | null
  pre: TreeIssuesPrelude
  inputs: TreeIssuesInputs
  leadsBookRed: boolean
  readReviewVerdict: (docId: string) => { approved: boolean } | undefined
}

/** 逐章收集段产物：红点表（仅含有 issue 的 docId）+ 章机检失败计数。 */
interface ChapterRedDots {
  issues: Record<string, TreeIssueEntry>
  chaptersDegraded: number
}

/**
 * 逐章收集段：正文目录不存在 → 空表直返；否则逐章「定稿态跳过 → 缓存命中 → 机检 →
 * verdict」产出红点条目与待落盘行，循环后经终核纪元一次批量落盘（/）。
 * 悬停面 = 每 TREE_ISSUES_YIELD_EVERY 章一次（async 驱动在此让出事件循环）。
 */
function* collectChapterRedDots(a: ChapterCollectArgs): Generator<void, ChapterRedDots, unknown> {
  const { bookRoot, userDataPath, pre, inputs, leadsBookRed, readReviewVerdict } = a
  const { db, rebuildFailed, config, hasWiring, epochFp0 } = pre
  const { bodyDir, bodyChapters, pathToDocId, entryByPath, maxWritten, cacheEnabled } = inputs
  const issues: Record<string, TreeIssueEntry> = {}
  let chaptersDegraded = 0
  if (existsSync(bodyDir)) {
    const chapters = bodyChapters
    // 定稿态（final/published）= 作者已确认，不参与树红点聚合（根本性解决）：
    // 跳过机检 + verdict 检查；作者仍可通过 CheckPanel 单章主动查看机检。
    // join 键折叠（win32 大小写 + NFC）——case-only 改名章的
    // manifest 条目仍可命中（定稿态跳过判定不失明），下方 .get 侧同键（索引在输入面
    // 段按 manifest 建好：entryByPath 与 pathToDocId 同源同键空间）
    // 统一用 maxWrittenChapterOf（仅计已定稿章），与单章 checkWithDb 端点一致。
    // 旧实现遍历所有 chapters（含未定稿草稿），导致树红点聚合与单章机检的"最高已写章号"基准不一致。
    // 三项预扫提升到循环外——此前每章 checkWithDb 内各现扫一遍（大纲/章纲 全量
    // readChapterDir + 工作区/账本推进 整读），大书数百章 O(N²) 文件读阻塞事件循环秒级；
    // 单请求内共享一份（章纲/账本推进只在编辑时变，跨请求由增量 rebuild/probe 缓存兜住）
    const batch: BatchCheckContext = {
      maxWrittenChapter: maxWritten,
      outlineChapters: existsSync(join(bookRoot, '大纲', '章纲'))
        ? (yield* scanChapterDirCore(join(bookRoot, '大纲', '章纲'))).chapters
        : [],
      // 批量预扫同口径走「主文件 + 归档暂存」两源（此前 readChapterLeadUpdates
      // 只读主文件——归档章实际侧失明，与单章端点统一后此处一并统一）
      leadUpdatesForChapter: yield* scanChapterUpdatesByChapterCore(bookRoot),
      // 细纲声明批内 memo（此前每章现读同一细纲文件，预扫漏项）
      outlineDeclarationFor: scanOutlineDeclarationMemo(bookRoot),
      // 布线判定透传——章循环内 checkWithDb 不再逐章
      // existsSync（聚合头 :490 同源判定，rebuild/开库决策一致）
      hasWiring,
    }
    // 写前纪元复核改轮内缓存——原实现每 miss 章重算一次 computeTreeIssuesGlobalFp
    // （递归 readdir+stat 全输入树），任一全局输入变动清表后全书 miss，数百章书一次聚合
    // 数百次全树遍历（同步路径性能回退）。修正口径：轮前一次**弱于**
    // 逐章复核——窗口内全局输入变更仍会落陈旧行；章缓存写入因此全部推迟到循环后，经一次
    // 终核纪元再落盘（漂移 → 整批丢弃下轮重算），每请求仅首尾两次全树指纹（O(1)/请求的
    // 口径保留）。
    // 轮前复核遍（epochFpNow）消重——其「检测聚合窗口内源漂移」的
    // 职责由循环后终核（epochFpEnd）统一承担：轮前漂移若持续到循环后必被终核检出（整批
    // 丢弃），瞬时漂移（改回原状）与循环内同类盲区同口径（既定取舍）。
    // 「收敛为首尾各一遍」至此如实成立——此前 leadsBook
    // 指纹（leadsFp/leadsFpNow）各自整调 computeTreeIssuesGlobalFp，一次聚合对同批全局
    // 目录实扫 4 遍；现按轮基线拼装（computeLeadsBookFpFromEpochFp，见 leadsBook 段注），
    // 全局纪元指纹实扫 = 首（epochFp0）+ 尾（epochFpEnd，有待落盘章时）各一遍。
    // epochFp0 为 null（纪元同步失败、缓存禁用）时不入列。
    // 待落盘章缓存（循环后统一终核纪元再写）
    const pendingCacheWrites: Array<{
      relPath: string
      chapterFp: number
      size: number
      verdictFp: string | null
      value: { hasRed: boolean; verdictRejected: boolean }
      // 清偿批行级纪元戳——落行时带轮基线，读侧按行比对防混纪元
      epochFp: string
    }> = []
    // 章循环悬停计数（async 驱动每 TREE_ISSUES_YIELD_EVERY 章让出一次）
    let chaptersProcessed = 0
    for (const ch of chapters) {
      if (!ch._path) continue
      // 悬停点——同步驱动无感续跑；async 驱动在此让出事件循环
      if (++chaptersProcessed % TREE_ISSUES_YIELD_EVERY === 0) yield
      // 同上归一——entryByPath/pathToDocId 的键与 manifest/树同用正斜杠
      // （-mac适配：归一收窄 win32-only，posix 字面 `\` 原样保留）
      const relPath = normalizeWinSeparators(relative(bookRoot, ch._path))
      // 定稿态跳过——不在树上打扰已确认的章节
      const entry = entryByPath.get(docJoinKey(relPath)) ?? null // 折叠键（与 set 侧成对）
      // 字节指纹走 probeCache（stat 级命中零读零哈希，与树同口径），
      // 替代每章 computeRevision 整读 + SHA-256
      const rev = probeCachedRevision(bookRoot, relPath)
      // #6（中级遗留）：published 判定同样走 probeCache——此前 deriveStatusFull →
      // readPublished 对 final 章整读定稿稿且不吃缓存，成熟书 O(final 章数) 整读/请求，
      // 削弱收益。probe 的 published 与树视图同口径（单次读探针）
      // 定稿态判定（probe 惰性：仅 final 才问 published，省 final 以外的探针）
      const st = treeChapterAggregationStatus(deriveStatus(relPath, entry, rev), () =>
        probeCachedPublished(bookRoot, relPath),
      )
      if (skipsTreeRedDot(st)) continue
      const docId = pathToDocId.get(docJoinKey(relPath)) // 折叠键（与 set 侧成对）
      if (!docId) continue
      // 章级指纹 = 正文 stat + 裁决信封 stat（信封改动=verdict 变，
      // 自动失效；无信封=verdict_fp NULL）。全中 → 直接取缓存聚合，零机检零重读。
      // stat 精度毫秒 → mtimeNs bigint（与纪元/dirFp 的
      // 口径一致）——同毫秒内「改回同长内容」此前不失效，ns 级撞车窗口收窄到与
      // 章缓存/纪元同源。缓存列存 µs 整数（mtimeNs/1000n → JS 安全整数，64-bit
      // SQLite 列无损绑定）：毫秒值(~1.7e12)与微秒值(~1.7e15)量级隔离，旧代毫秒行
      // 必 miss → 一次性整表重算，不存在旧缓存脏读面（方案升级失效与指纹
      // 格式变更同路径：值空间不相交即天然失效，无需额外版本号）。
      let chapterSt: { mtimeNs: bigint; size: number }
      try {
        const st = statSync(ch._path, { bigint: true })
        chapterSt = { mtimeNs: st.mtimeNs, size: Number(st.size) }
      } catch {
        continue // 竞态消失（回收站/删除）：本条跳过
      }
      // µs 级安全整数指纹（读/写共用同一次换算，口径一致）
      const chapterFp = Number(chapterSt.mtimeNs / 1000n)
      const envAbs = existingAnalysisPath(bookRoot, docId) // 双候选读侧定位（信封 stat 指纹不吃单候选分裂）
      let verdictFp: string | null = null
      if (envAbs) {
        try {
          const es = statSync(envAbs, { bigint: true })
          verdictFp = `${es.mtimeNs}:${es.size}`
        } catch {
          verdictFp = null // 信封竞态消失：按无信封处理
        }
      }
      // 清偿批读侧加纪元锚校验（epochFp0 为轮基线，与 sync 落表
      // global_fp 同源）——双进程并发且轮中全局输入变更时，他进程按新纪元清表写入
      // 的新纪元行不再被本进程按章指纹误读（单轮混纪元口径的修复面）；基线缺席
      // （epochFp0=null，纪元指纹前算失败）时一律按 miss（宁重算勿混纪元）。
      if (cacheEnabled && db && epochFp0 !== null) {
        const cached = readTreeIssuesCache(db, relPath, chapterFp, chapterSt.size, verdictFp, epochFp0)
        if (cached) {
          // 章级行只存章作用域 hasRed（拆分后），全书性红项在此合并展示
          const hit = treeIssuesChapterEntry(cached.hasRed, cached.verdictRejected, leadsBookRed)
          if (hit) issues[docId] = hit
          continue
        }
      }
      let hasRed = false
      let checkFailed = false
      if (!rebuildFailed) {
        // 树红点聚合的章级检查跳过账本全书性条目（独立缓存见上），章级行因此
        // 只依赖「本章 stat + 纪元」，跨章陈旧窗口消除
        const outcome = getChapterCheckDegradeForTest()
          ? ({ ok: false } as const)
          : checkWithDb(bookRoot, ch._path, db, config, batch, { skipLeadsBookChecks: true })
        if (outcome.ok) hasRed = outcome.hasRed
        else checkFailed = true
      }
      // 单章机检失败计数透出——与的 leadsBookDegraded 同口径，
      // 此前 checkFailed 只影响「不落缓存」，持续性失败（名册竞态/账本损坏）期间该章
      // 红点缺失且响应零提示（fail-open 漏红不可见）
      if (checkFailed) {
        chaptersDegraded++
        log.warn('check', `章机检失败（红点可能缺失）：${relPath}`)
      }
      const verdict = readReviewVerdict(docId)
      const verdictRejected = !!verdict && !verdict.approved
      // 检查失败（瞬态异常：SQLITE_BUSY 超时/名册 ENOENT 竞态）不落缓存——此前无条件
      // writeTreeIssuesCache 会把「未检出」固化为假阴性，指纹不变期间红点永久消失、
      // 后续请求直命中坏缓存；不写则下轮重试。verdict 与缓存互不连带。
      // 注意写入的是章作用域 hasRed（不含 leadsBookRed），合并只在展示层发生。
      // 窗口内纪元变了则本轮不落缓存（下轮重算）。：比较用轮内缓存值。
      // 直接写改入列——落盘推迟到循环后终核纪元（见 pendingCacheWrites 段注）。
      // 轮内缓存值即基线 epochFp0（轮前复核遍已消重），入列闸 = 基线存在。
      if (
        shouldQueueChapterCacheRow({
          checkFailed,
          cacheEnabled,
          hasDb: db !== null,
          hasEpochBaseline: epochFp0 !== null,
        })
      ) {
        pendingCacheWrites.push({
          relPath,
          chapterFp,
          size: chapterSt.size,
          verdictFp,
          value: { hasRed, verdictRejected },
          epochFp: epochFp0!,
        })
      }
      const entryValue = treeIssuesChapterEntry(hasRed, verdictRejected, leadsBookRed)
      if (entryValue) issues[docId] = entryValue
    }
    // 循环后终核纪元再落盘——聚合窗口内全局输入（大纲/章纲/布线）
    // 变更时轮内各章的纪元判定已陈旧，直接落会把旧纪元判定固化成缓存行（单轮错、下轮
    // 自愈，但窗口内各章红点口径前后不一致）。漂移 → 整批丢弃（本轮零落缓存，下轮
    // 全部重算），每请求只多一次全树指纹计算。：此终核遍是聚合的
    // 「尾」遍（首遍 = 开头的 epochFp0，两遍之间不再有中间遍）。
    // 落盘改单事务包批（writeTreeIssuesCacheBatch）——数百章书
    // 纪元失效后一轮聚合此前逐行独立 commit（WAL 放大）。
    if (pendingCacheWrites.length > 0 && db && epochFp0 !== null) {
      const epochFpEnd = yield* computeTreeIssuesGlobalFpCore(bookRoot, userDataPath)
      if (epochFpEnd !== epochFp0) {
        log.warn('check', `聚合窗口内全局输入纪元漂移——本轮 ${pendingCacheWrites.length} 条章缓存不落盘（下轮重算）`)
      } else {
        writeTreeIssuesCacheBatch(db, pendingCacheWrites)
      }
    }
  }
  return { issues, chaptersDegraded }
}

/**
 * 汇总段（纯形状透传）：报告项形状与五个降级旗标逐位不变。issues 的插入序 = 章循环序
 * （无排序无二次去重合并——键为 docId，同章只会写一次）。
 */
function assembleTreeIssuesResult(parts: {
  issues: Record<string, TreeIssueEntry>
  rebuildFailed: boolean
  leadsBookDegraded: boolean
  chaptersDegraded: number
  chaptersParseDegraded: number
  manifestDegraded: boolean
}): TreeIssuesResult {
  return {
    issues: parts.issues,
    rebuildFailed: parts.rebuildFailed,
    leadsBookDegraded: parts.leadsBookDegraded,
    chaptersDegraded: parts.chaptersDegraded,
    chaptersParseDegraded: parts.chaptersParseDegraded,
    manifestDegraded: parts.manifestDegraded,
  }
}

/** 树红点聚合的实现体（生成器，单源供同步/async 双驱动）——四段接力驱动。
 *  阶段 52 批 1：yield 面含效应请求（TreeEffect），由驱动解释执行（见上「效应让出」注）。
 *  ：段序不变量见上方「聚合管线」块注。 */
function* collectTreeIssuesCore(
  bookRoot: string,
  readReviewVerdict: (docId: string) => { approved: boolean } | undefined,
  userDataPath?: string | null,
): Generator<void | TreeEffect, TreeIssuesResult, unknown> {
  const pre = yield* openTreeIssuesAggregate(bookRoot, userDataPath ?? null)
  try {
    const inputs = yield* loadTreeIssuesInputs(pre, bookRoot, userDataPath ?? null)
    const leads = yield* computeLeadsBookRed(pre, inputs.maxWritten, bookRoot, userDataPath ?? null)
    const chapters = yield* collectChapterRedDots({
      bookRoot,
      userDataPath: userDataPath ?? null,
      pre,
      inputs,
      leadsBookRed: leads.leadsBookRed,
      readReviewVerdict,
    })
    return assembleTreeIssuesResult({
      issues: chapters.issues,
      rebuildFailed: pre.rebuildFailed,
      leadsBookDegraded: leads.leadsBookDegraded,
      chaptersDegraded: chapters.chaptersDegraded,
      chaptersParseDegraded: inputs.chaptersParseDegraded,
      manifestDegraded: inputs.manifestDegraded,
    })
  } finally {
    if (pre.db) closeTreeIssuesDb(pre.db) // 裸 close 改道（prepared ephemeron 断链，closeTreeIssuesDb 单源）
  }
}
