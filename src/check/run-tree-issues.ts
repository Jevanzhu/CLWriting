/**
 * 树红点聚合族 —— R0916-5f（2026-09-16，⑤④产品巨件拆分波2）自 run.ts 缝 A 拆出
 *（纯移动，零行为变化；代码与注释逐字未改）。
 *
 * 内容：TREE_ISSUES_YIELD_EVERY / __setLeadsBookDegradeForTest /
 * __setChapterCheckDegradeForTest / TreeIssuesResult（模块私有接口，原即未导出）/
 * collectTreeIssues / collectTreeIssuesAsync / collectTreeIssuesCore（生成器实现体，
 * 原 run.ts L457-850 一带）。依赖 tree-issues-cache / leads / runner / outline-leads /
 * document / format / fs / log / async——编辑器层内闭合；「读配置→托底」与
 * 「rebuild→开库→PRAGMA」前奏、单章机检内核与批量预扫仍在 run.ts 残核，经该处
 * export（readCheckConfig/openCheckDb/checkWithDb/maxWrittenChapterOf/
 * scanChapterUpdatesByChapter/BatchCheckContext）复用。两文件互 import 为函数声明
 * 级循环（无顶层求值依赖），ESM 具名绑定惰性解析，两向加载序均安全。
 * 既有导出面（collectTreeIssues/collectTreeIssuesAsync/__setLeadsBookDegradeForTest/
 * __setChapterCheckDegradeForTest）由 run.ts 具名 re-export 桥接，全库 import 面
 * 零改动。
 */
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { readChapterDir } from '../format/chapters.js'
import { readManifestDegraded, type ManifestEntry } from '../document/manifest.js'
import { deriveStatus } from '../document/status.js'
import { probeCachedRevision, probeCachedPublished } from '../document/tree.js'
import { existingAnalysisPath } from '../document/analysis.js'
import { docJoinKey, normalizeWinSeparators } from '../fs/safe-path.js'
import { enabledLeadTypes } from './runner.js'
import { scanOutlineDeclarationMemo } from './outline-leads.js'
import {
  syncTreeIssuesEpoch,
  readTreeIssuesCache,
  writeTreeIssuesCacheBatch,
  computeLeadsBookFp,
  computeLeadsBookFpFromEpochFp,
  readLeadsBookRed,
  writeLeadsBookRed,
  computeTreeIssuesGlobalFp,
  closeTreeIssuesDb,
} from './tree-issues-cache.js'
import { checkLeadsBookItems } from './leads.js'
import {
  readCheckConfig,
  openCheckDb,
  checkWithDb,
  maxWrittenChapterOf,
  scanChapterUpdatesByChapter,
  type BatchCheckContext,
} from './run.js'
import { log, errMsg } from '../log/index.js'
import { yieldToEventLoop } from '../async.js'

// ── R37-3（三十七轮）：树红点聚合 async 孪生的逐块让出 ──────────────────────
// 服务是 Electron 主进程内嵌的单进程 HTTP 服务，collectTreeIssues 同步遍历全书
//（rebuild + 全章扫描 + 逐章机检）在 ≥500 章大书上单请求秒级冻结事件循环 = 桌面
// 整体卡死；既有 5s TTL 缓存只降频不减峰。异步让出范式同 learn/index.ts R72-2
//（setImmediate 级让出，块与块之间其它请求/SSE 心跳可跑）。让出窗口内的并发由既有
// 防护兜底：db busy_timeout 5s（与同进程 rebuild 并发等锁，见下方开库注释）、单章
// 失败 fail-open 不落缓存（R65-5）、写前纪元复核（R70-14/R71-20/R32-14——聚合窗口
// 内输入变更整批丢弃缓存行）——同步版这些防护本就面向跨进程并发，async 版让出后的
// 同进程并发同享这套口径。
// 实现取「生成器核心 + 双驱动」而非复制体：逻辑单源零漂移（同步版驱到尾 = 与修复前
// 逐位等价的纯同步执行，存量测试调用方零感知），async 版在每个悬停点让出。
// 边界如实记：rebuild/预扫段（readChapterDir×2 + 账本预扫）仍是单段同步块——其内核
//（src/cache/rebuild.ts、src/format/chapters.ts）不在本批允许清单，热路径有 stat 级
// 缓存（CC-P1-3）与增量 rebuild 兜住；本批切的是章循环（大书的主要阻塞段）。
/** R37-3：章循环的让出粒度——每处理 25 章让出一次（块内单章 stat/机检为毫秒级）。 */
const TREE_ISSUES_YIELD_EVERY = 25

/** R62-7 测试注入：强制账本全书性红项计算抛错——验证 leadsBookDegraded 透出路径
 *  （真实损坏多被 readLeadsBookRed 自愈吞掉,难确定性触发）。生产恒 false。 */
let __leadsBookDegradeForTest = false
export function __setLeadsBookDegradeForTest(v: boolean): void {
  __leadsBookDegradeForTest = v
}

/** R65-5（十三轮）测试注入：强制章级机检失败——验证 chaptersDegraded 透出路径
 *  （真实失败多为瞬态竞态/名册 ENOENT，难确定性触发）。生产恒 false。 */
let __chapterCheckDegradeForTest = false
export function __setChapterCheckDegradeForTest(v: boolean): void {
  __chapterCheckDegradeForTest = v
}

/** R37-3（三十七轮）：树红点聚合结果形状（同步/async 孪生共用）。 */
interface TreeIssuesResult {
  issues: Record<string, { hasRed: boolean; verdictRejected: boolean }>
  rebuildFailed: boolean
  leadsBookDegraded: boolean
  chaptersDegraded: number
  /** R35-24：正文目录解析失败章计数（章号损坏章对树红点隐形，>0 = 本轮树不完整） */
  chaptersParseDegraded: number
  /** R0916-6-P2-1：清单读取失败降级旗标（读失败此前与「无清单」同归空表静默——
   *  章-账本红点整轮失明零透出，唯一数据正确性面的静默降级）。true = 本轮红点
   *  不完整，端点层转 warnings 透出（api/check.ts，与 rebuildFailed 同口径）。 */
  manifestDegraded: boolean
}

/**
 * 树红点聚合：扫正文章节，返回 { docId: { hasRed, verdictRejected } }（仅含有 issue 的 docId）。
 * R37-3（三十七轮）：HTTP 路径改走 async 孪生 collectTreeIssuesAsync；本同步版保留——
 * 存量测试调用方（test/check/ 下十余个回归文件）与等价性对照基准仍用同步口径。
 */
export function collectTreeIssues(
  bookRoot: string,
  readReviewVerdict: (docId: string) => { approved: boolean } | undefined,
  userDataPath?: string | null,
): TreeIssuesResult {
  // R37-3：同步驱动——生成器 yield 只把控制权交还本驱动，随即 next() 续跑，
  // 净效果与修复前的纯同步执行逐位一致（无事件循环参与）
  const it = collectTreeIssuesCore(bookRoot, readReviewVerdict, userDataPath)
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
  }
}

/**
 * R37-3（三十七轮）：collectTreeIssues 的 async 孪生——生成器核心的每个章循环悬停点
 *（每 TREE_ISSUES_YIELD_EVERY 章）await setImmediate 让出事件循环，大书聚合期间
 * 其它请求/SSE 心跳可跑（服务热路径纪律：禁止同步长段，让出范式同 learn/index.ts
 * R72-2）。并发防护口径见上方 R37-3 注释块——与同步版共享，无新增差异面。
 */
export async function collectTreeIssuesAsync(
  bookRoot: string,
  readReviewVerdict: (docId: string) => { approved: boolean } | undefined,
  userDataPath?: string | null,
): Promise<TreeIssuesResult> {
  const it = collectTreeIssuesCore(bookRoot, readReviewVerdict, userDataPath)
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
    await yieldToEventLoop()
  }
}

/** R37-3：树红点聚合的实现体（生成器，单源供同步/async 双驱动）。 */
function* collectTreeIssuesCore(
  bookRoot: string,
  readReviewVerdict: (docId: string) => { approved: boolean } | undefined,
  userDataPath?: string | null,
): Generator<void, TreeIssuesResult, unknown> {
  // B-P2-7：检查 .ok，损坏时 warn 留诊断（config 回落 DEFAULT_CONFIG，不阻断）
  // R29-5（二十九轮）：树聚合路径降级只 warn 不产黄项——树红点聚合只吃 hasRed
  // （issues 只记 {hasRed, verdictRejected}，黄项无处落），逐章注入黄项既不可见又会
  // 拖累章级缓存判定；降级可见性由 warn 日志 + 单章面板（runCheckForDocument 注入的
  // book-config-degraded 黄项）承担。（「读配置→托底」前奏 P3 收编 readCheckConfig
  // ——与 runCheckForDocument 同源；树聚合只吃 config，degradedError 弃用。）
  const { config } = readCheckConfig(bookRoot, userDataPath ?? null)
  const hasWiring = existsSync(join(bookRoot, '布线'))
  let db: DatabaseSync | null = null
  let rebuildFailed = false
  // R65-5（十三轮）：单章机检失败章计数（透出 warning，见下方 checkFailed 分支）
  let chaptersDegraded = 0
  // R52-E-1（五十二轮）：纪元指纹基线再前移——rebuild **之前**。R47-30 的前移只到
  // sync 之前，rebuild 内部扫源 stat 与 fp0 计算之间仍留头窗：窗口内源文件被改写时
  // rebuild 读到旧库、其后计算的 fp0 已是新纪元 → 陈旧红值以新纪元落缓存（指纹自洽，
  // 终核不再失效它，红点口径被固化到下纪元）。fp0 提前后终核（epochFpEnd）窗口覆盖
  // 「fp0 → 聚合全程」：头窗内任何变更使 fpEnd≠fp0，整批写入按既有失效路径丢弃。
  // fp 前算失败不阻断 rebuild：保持 null，sync 处 precomputedFp 缺省自算兜底（再败
  // 则 cacheEnabled=false 走全量，降级口径不变）。
  let epochFp0: string | null = null
  if (hasWiring) {
    try {
      epochFp0 = computeTreeIssuesGlobalFp(bookRoot, userDataPath ?? null)
    } catch {
      /* fp 前算失败：rebuild 照常，sync 处自算兜底 */
    }
    // M-9（2026-08-21）：rebuild / 开库 / PRAGMA 的硬异常按 fail-open 降级（warn + 留痕），
    // 不再穿透成 500——与缓存层头注释「读写失败跳过缓存走全量路径」红线对齐。此前只有
    // 「rebuild 报错列表非空」这一种失败形态走了降级，库损坏/锁超时直接把树红点端点打挂。
    //（「rebuild→开库→PRAGMA」前奏 P3 收编 openCheckDb（failMode 'fail-open'，rebuild
    // 失败降级 comment 随实现移入该函数）；树聚合不吃 R47-11 节流，口径见其头注。）
    const opened = openCheckDb(bookRoot, hasWiring, { throttleSourceProbe: false, failMode: 'fail-open' })
    db = opened.db
    rebuildFailed = opened.rebuildFailed
  }
  try {
    // P3（复审-0914-优化修复批）：此处整读的 entries 直传 maxWrittenChapterOf
    //（原其内部再 readManifest 同一清单 = 单请求双读）
    // R0916-6-P2-1：读失败（EACCES/EBUSY/EIO 瞬态）此前与「无清单」同为空表静默
    // ——整轮章-账本红点失明零透出。改走 readManifestDegraded 分离「不存在=合法空」
    // 与「读失败=降级」：降级 warn 留痕 + manifestDegraded 旗标随返回透出。
    const manifestRead = readManifestDegraded(join(bookRoot, '项目', '文档清单.jsonl'))
    if (manifestRead.degraded) {
      log.warn('check', `文档清单读取失败（${manifestRead.degraded.code}），本轮章-账本红点聚合降级（红点可能缺失）`)
    }
    const manifestDegraded = manifestRead.degraded !== null
    const manifest = manifestRead.manifest.entries
    const pathToDocId = new Map<string, string>()
    // R42-5（四十二轮）：join 键折叠（win32 大小写 + NFC）——盘上扫描路径与清单登记
    // 路径仅大小写/组合形异时 docId 仍可追溯（下方 .get 侧同键）
    for (const [docId, m] of manifest) pathToDocId.set(docJoinKey(m.path), docId)
    const issues: Record<string, { hasRed: boolean; verdictRejected: boolean }> = {}
    const bodyDir = join(bookRoot, '写作', '正文')
    // A1（批 1）：增量缓存——只重查指纹变过的章。仅对有布线的书启用（长篇才是
    // 数百章规模；短篇不开 .cache/index.db，行为与从前完全一致）。表缺席/纪元
    // 同步失败 → cacheEnabled=false 走现行全量路径（语义无损降级）。
    let cacheEnabled = false
    // R70-14（十八轮）：纪元 fp 写前复核基线——fp 在聚合开头计算、行写入在其后，
    // 外部编辑器/第二进程恰在窗口内改纪元输入时旧行按新输入视角陈旧落表（单请求
    // 周期陈旧、下一聚合自愈，但该周期红点错）。写入前复核 fp 未变才落缓存。
    // R52-E-1：基线声明前移至 hasWiring 块（rebuild 之前计算，见上方注释）。
    if (db) {
      try {
        // R47-30（四十七轮）：纪元指纹首遍前移——传入预计算 fp 复用（R52-E-1 起 fp0
        // 在 rebuild 之前算得，sync 不再自算）；传入的 fp 与落表 global_fp 同源
        // （基线即纪元）。首尾口径（R32-14 既定）不变：首 = rebuild 前一遍，
        // 尾 = 循环后终核一遍。
        syncTreeIssuesEpoch(db, bookRoot, userDataPath ?? null, epochFp0 ?? undefined)
        cacheEnabled = true
      } catch {
        cacheEnabled = false
      }
    }
    // H-1（2026-08-21）：账本全书性红项（章号一致/引文命中/状态闭合）——本书一次计算，
    // 按「纪元 + 正文目录指纹」独立缓存（tree_issues_meta leads_book_*），不进章级行。
    // 此前它们进每章 report 的 hasRed，却只按本章 stat 失效：改第 N 章正文补/删引文后
    // 其余章缓存红点陈旧（假红残留或漏红）。指纹含正文目录摘要——改任何一章都会重算
    // 这一项（正确性所需），章级行的增量性不受拖累。计算失败 fail-open：不落缓存、
    // 本轮按无红处理（下轮重试），不拦树。
    // 全书最高已定稿章号：一次预扫两处共用——leads 全书性红项的未来章基准 + 章循环
    // batch（H-1 新增消费方；不共用会把 readChapterDir 调用次数抬高回去，CC-P1-3 的
    // 调用次数回归锚会红）。P5-管线（第七轮）：bodyChapters 列表直接传入
    // maxWrittenChapterOf——原实现内部重扫一遍正文（「一次预扫」注释与实现漂移）
    // P3（复审-0914-优化修复批）：manifest entries 同点直传（消聚合头双读，见上）
    // R35-24（三十五轮）：正文目录解析错误不再静默丢弃——章号损坏/缺章号的章进不了
    // chapters 列表，树红点对其完全隐形（损坏越重越安静）。errors 逐条 warn 留痕并以
    // 计数透出（chaptersParseDegraded，与 chaptersDegraded 同款降级口径）；章级黄项
    // 无处落（issues 只存 hasRed/verdictRejected 布尔，见上方 R29-5 注），可见性由
    // 计数标志 + warn 承担。
    const bodyDirScan = existsSync(bodyDir) ? readChapterDir(bodyDir) : null
    const bodyChapters = bodyDirScan?.chapters ?? []
    let chaptersParseDegraded = 0
    for (const pe of bodyDirScan?.errors ?? []) {
      chaptersParseDegraded++
      log.warn('check', `章文件解析失败（树红点对该章失明）：${pe.file}——${pe.message}`)
    }
    const maxWritten = maxWrittenChapterOf(bookRoot, bodyChapters, manifest)
    let leadsBookRed = false
    // R62-7：账本全书性红项计算失败的可视标志——此前静默降级为「无红」，持续性失败
    // 期间全树永不显示账本红项且响应无 warning（fail-open 方向是漏红，与 rebuildFailed
    // 处理不对称）；随响应透出让前端留痕
    let leadsBookDegraded = false
    if (db && !rebuildFailed) {
      try {
        if (__leadsBookDegradeForTest) throw new Error('R62-7 注入：账本全书性红项读取失败')
        // F4（复审-0914-优化修复批）：epochFp0（轮基线，rebuild 前算得）在座时 leadsBook
        // 指纹按 `${epochFp0}|${dirFp(正文)}` 拼装（computeLeadsBookFpFromEpochFp，与
        // computeLeadsBookFp 输出逐字节同构、值域同空间）——不再整调
        // computeTreeIssuesGlobalFp，聚合的全局目录递归 stat 自此首（epochFp0）尾
        // （epochFpEnd）各一遍（R47-30 口径成立，见下方待落盘段注）；基线缺席（前算
        // 失败为 null）回落全算，非空/null 分支语义保持。
        const leadsFp = epochFp0 !== null
          ? computeLeadsBookFpFromEpochFp(bookRoot, epochFp0)
          : computeLeadsBookFp(bookRoot, userDataPath ?? null)
        const cachedRed = readLeadsBookRed(db, leadsFp)
        if (cachedRed !== null) {
          leadsBookRed = cachedRed
        } else {
          // R69-17：零定稿章（新书/清单损坏）的回退已内置 maxWrittenChapterOf
          //（bodyChapters 全空时以 0 为基准）；R48-37（四十八轮）：原 `?? maxExisting`
          // 死回退与「回退全书最高现存章号」注释删除——maxWritten 为 undefined 仅当
          // bodyChapters 为空，此时 maxExisting 恒 0，真回退在上移的函数内完成
          leadsBookRed = checkLeadsBookItems(db, bookRoot, maxWritten ?? 0, enabledLeadTypes(config)).some(
            (i) => i.level === 'red',
          )
          // R53-E-1（五十三轮）：写前纪元终核（R70-14 章级行同款口径）——leadsFp 在
          // 聚合开头计算，checkLeadsBookItems 全账本扫描期间外部编辑器/第二进程可改
          // 纪元输入，旧行按新输入视角陈旧落表。写前复核 fp 未变才落缓存；漂移 → 本轮
          // 不固化（fail-open 不拦树，leadsBookRed 本轮值照常返回，仅缓存不写、下轮重算）。
          // F4：复核改同基线拼装——leadsFpNow = `${epochFp0}|${dirFp(正文) 新鲜扫描}`，
          // 正文目录窗口内漂移照旧拦固化；全局输入窗口内漂移不再拦写，但落表行仍带
          // 轮基线纪元、全局输入一变读侧 leadsFp 必全等失配 miss 自愈重算（readLeadsBookRed
          // 的 fp 比对即失效判定，语义不变；mtimeNs 粒度下旧 fp 值不可复现，无脏读面）
          // ——两分支下轮都付同一次重算，仅少留一行必然失效的单键值。
          const leadsFpNow = epochFp0 !== null
            ? computeLeadsBookFpFromEpochFp(bookRoot, epochFp0)
            : computeLeadsBookFp(bookRoot, userDataPath ?? null)
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
    if (existsSync(bodyDir)) {
      const chapters = bodyChapters
      // 定稿态（final/published）= 作者已确认，不参与树红点聚合（根本性解决）：
      // 跳过机检 + verdict 检查；作者仍可通过 CheckPanel 单章主动查看机检。
      const entryByPath = new Map<string, ManifestEntry>()
      // R42-5（四十二轮）：join 键折叠（win32 大小写 + NFC）——case-only 改名章的
      // manifest 条目仍可命中（定稿态跳过判定不失明），下方 .get 侧同键
      for (const m of manifest.values()) entryByPath.set(docJoinKey(m.path), m)
      // B-P1-1：统一用 maxWrittenChapterOf（仅计已定稿章），与单章 checkWithDb 端点一致。
      // 旧实现遍历所有 chapters（含未定稿草稿），导致树红点聚合与单章机检的"最高已写章号"基准不一致。
      // CC-P1-3：三项预扫提升到循环外——此前每章 checkWithDb 内各现扫一遍（大纲/章纲 全量
      // readChapterDir + 工作区/账本推进 整读），大书数百章 O(N²) 文件读阻塞事件循环秒级；
      // 单请求内共享一份（章纲/账本推进只在编辑时变，跨请求由增量 rebuild/probe 缓存兜住）
      const batch: BatchCheckContext = {
        maxWrittenChapter: maxWritten,
        outlineChapters: existsSync(join(bookRoot, '大纲', '章纲'))
          ? readChapterDir(join(bookRoot, '大纲', '章纲')).chapters
          : [],
        // R65-24：批量预扫同口径走「主文件 + 归档暂存」两源（此前 readChapterLeadUpdates
        // 只读主文件——归档章实际侧失明，与单章端点统一后此处一并统一）
        leadUpdatesForChapter: scanChapterUpdatesByChapter(bookRoot),
        // R32-16：细纲声明批内 memo（此前每章现读同一细纲文件，CC-P1-3 预扫漏项）
        outlineDeclarationFor: scanOutlineDeclarationMemo(bookRoot),
        // P3（复审-0914-优化修复批）：布线判定透传——章循环内 checkWithDb 不再逐章
        // existsSync（聚合头 :490 同源判定，rebuild/开库决策一致）
        hasWiring,
      }
      // R71-20：写前纪元复核改轮内缓存——原实现每 miss 章重算一次 computeTreeIssuesGlobalFp
      // （递归 readdir+stat 全输入树），任一全局输入变动清表后全书 miss，数百章书一次聚合
      // 数百次全树遍历（同步路径性能回退）。R32-14（三十二轮）修正口径：轮前一次**弱于**
      // 逐章复核——窗口内全局输入变更仍会落陈旧行；章缓存写入因此全部推迟到循环后，经一次
      // 终核纪元再落盘（漂移 → 整批丢弃下轮重算），每请求仅首尾两次全树指纹（O(1)/请求的
      // R71-20 口径保留）。
      // R47-30（四十七轮）：轮前复核遍（epochFpNow）消重——其「检测聚合窗口内源漂移」的
      // 职责由循环后终核（epochFpEnd）统一承担：轮前漂移若持续到循环后必被终核检出（整批
      // 丢弃），瞬时漂移（改回原状）与循环内同类盲区同口径（R32-14 既定取舍）。
      // F4（复审-0914-优化修复批）：「收敛为首尾各一遍」至此如实成立——此前 leadsBook
      // 指纹（leadsFp/leadsFpNow）各自整调 computeTreeIssuesGlobalFp，一次聚合对同批全局
      // 目录实扫 4 遍；现按轮基线拼装（computeLeadsBookFpFromEpochFp，见 leadsBook 段注），
      // 全局纪元指纹实扫 = 首（epochFp0）+ 尾（epochFpEnd，有待落盘章时）各一遍。
      // epochFp0 为 null（纪元同步失败、缓存禁用）时不入列。
      // R32-14：待落盘章缓存（循环后统一终核纪元再写）
      const pendingCacheWrites: Array<{
        relPath: string
        chapterFp: number
        size: number
        verdictFp: string | null
        value: { hasRed: boolean; verdictRejected: boolean }
        // R59 清偿批（R55-D-3）：行级纪元戳——落行时带轮基线，读侧按行比对防混纪元
        epochFp: string
      }> = []
      // R37-3：章循环悬停计数（async 驱动每 TREE_ISSUES_YIELD_EVERY 章让出一次）
      let chaptersProcessed = 0
      for (const ch of chapters) {
        if (!ch._path) continue
        // R37-3：悬停点——同步驱动无感续跑；async 驱动在此让出事件循环
        if (++chaptersProcessed % TREE_ISSUES_YIELD_EVERY === 0) yield
        // M-4（第六轮）：同上归一——entryByPath/pathToDocId 的键与 manifest/树同用正斜杠
        // （复审-0913-mac适配 P3-2：归一收窄 win32-only，posix 字面 `\` 原样保留）
        const relPath = normalizeWinSeparators(relative(bookRoot, ch._path))
        // 定稿态跳过——不在树上打扰已确认的章节
        const entry = entryByPath.get(docJoinKey(relPath)) ?? null // R42-5：折叠键（与 set 侧成对）
        // CC-P1-3：字节指纹走 probeCache（stat 级命中零读零哈希，与树 W-P2-4 同口径），
        // 替代每章 computeRevision 整读 + SHA-256
        const rev = probeCachedRevision(bookRoot, relPath)
        // #6（中级遗留）：published 判定同样走 probeCache——此前 deriveStatusFull →
        // readPublished 对 final 章整读定稿稿且不吃缓存，成熟书 O(final 章数) 整读/请求，
        // 削弱 A1 收益。probe 的 published 与树视图同口径（W-P2-4 单次读探针）
        const base = deriveStatus(relPath, entry, rev)
        const st = base === 'final' && probeCachedPublished(bookRoot, relPath) ? 'published' : base
        if (st === 'final' || st === 'published') continue
        const docId = pathToDocId.get(docJoinKey(relPath)) // R42-5：折叠键（与 set 侧成对）
        if (!docId) continue
        // A1（批 1）：章级指纹 = 正文 stat + 裁决信封 stat（信封改动=verdict 变，
        // 自动失效；无信封=verdict_fp NULL）。全中 → 直接取缓存聚合，零机检零重读。
        // R29-B8（二十九轮）：stat 精度毫秒 → mtimeNs bigint（与纪元/dirFp 的 R73-27
        // 口径一致）——同毫秒内「改回同长内容」此前不失效，ns 级撞车窗口收窄到与
        // 章缓存/纪元同源。缓存列存 µs 整数（mtimeNs/1000n → JS 安全整数，64-bit
        // SQLite 列无损绑定）：毫秒值(~1.7e12)与微秒值(~1.7e15)量级隔离，旧代毫秒行
        // 必 miss → 一次性整表重算，不存在旧缓存脏读面（方案升级失效与 R73-27 指纹
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
        const envAbs = existingAnalysisPath(bookRoot, docId) // R68-3：双候选读侧定位（信封 stat 指纹不吃单候选分裂）
        let verdictFp: string | null = null
        if (envAbs) {
          try {
            const es = statSync(envAbs, { bigint: true })
            verdictFp = `${es.mtimeNs}:${es.size}`
          } catch {
            verdictFp = null // 信封竞态消失：按无信封处理
          }
        }
        // R59 清偿批（R55-D-3）：读侧加纪元锚校验（epochFp0 为轮基线，与 sync 落表
        // global_fp 同源）——双进程并发且轮中全局输入变更时，他进程按新纪元清表写入
        // 的新纪元行不再被本进程按章指纹误读（单轮混纪元口径的修复面）；基线缺席
        // （epochFp0=null，纪元指纹前算失败）时一律按 miss（宁重算勿混纪元）。
        if (cacheEnabled && db && epochFp0 !== null) {
          const cached = readTreeIssuesCache(db, relPath, chapterFp, chapterSt.size, verdictFp, epochFp0)
          if (cached) {
            // 章级行只存章作用域 hasRed（H-1 拆分后），全书性红项在此合并展示
            const mergedRed = cached.hasRed || leadsBookRed
            if (mergedRed || cached.verdictRejected) {
              issues[docId] = { hasRed: mergedRed, verdictRejected: cached.verdictRejected }
            }
            continue
          }
        }
        let hasRed = false
        let checkFailed = false
        if (!rebuildFailed) {
          // H-1：树红点聚合的章级检查跳过账本全书性条目（独立缓存见上），章级行因此
          // 只依赖「本章 stat + 纪元」，跨章陈旧窗口消除
          const outcome = __chapterCheckDegradeForTest
            ? ({ ok: false } as const)
            : checkWithDb(bookRoot, ch._path, db, config, batch, { skipLeadsBookChecks: true })
          if (outcome.ok) hasRed = outcome.hasRed
          else checkFailed = true
        }
        // R65-5（十三轮）：单章机检失败计数透出——与 R62-7 的 leadsBookDegraded 同口径，
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
        // R70-14：窗口内纪元变了则本轮不落缓存（下轮重算）。R71-20：比较用轮内缓存值。
        // R32-14：直接写改入列——落盘推迟到循环后终核纪元（见 pendingCacheWrites 段注）。
        // R47-30：轮内缓存值即基线 epochFp0（轮前复核遍已消重），入列闸 = 基线存在。
        if (!checkFailed && cacheEnabled && db && epochFp0 !== null) {
          pendingCacheWrites.push({ relPath, chapterFp, size: chapterSt.size, verdictFp, value: { hasRed, verdictRejected }, epochFp: epochFp0 })
        }
        const mergedRed = hasRed || leadsBookRed
        if (mergedRed || verdictRejected) issues[docId] = { hasRed: mergedRed, verdictRejected }
      }
      // R32-14（三十二轮）：循环后终核纪元再落盘——聚合窗口内全局输入（大纲/章纲/布线）
      // 变更时轮内各章的纪元判定已陈旧，直接落会把旧纪元判定固化成缓存行（单轮错、下轮
      // 自愈，但窗口内各章红点口径前后不一致）。漂移 → 整批丢弃（本轮零落缓存，下轮
      // 全部重算），每请求只多一次全树指纹计算。R47-30（四十七轮）：此终核遍是聚合的
      // 「尾」遍（首遍 = 开头的 epochFp0，两遍之间不再有中间遍）。
      // R33D-17（三十三轮）：落盘改单事务包批（writeTreeIssuesCacheBatch）——数百章书
      // 纪元失效后一轮聚合此前逐行独立 commit（WAL 放大）。
      if (pendingCacheWrites.length > 0 && db && epochFp0 !== null) {
        const epochFpEnd = computeTreeIssuesGlobalFp(bookRoot, userDataPath ?? null)
        if (epochFpEnd !== epochFp0) {
          log.warn('check', `聚合窗口内全局输入纪元漂移——本轮 ${pendingCacheWrites.length} 条章缓存不落盘（下轮重算）`)
        } else {
          writeTreeIssuesCacheBatch(db, pendingCacheWrites)
        }
      }
    }
    return { issues, rebuildFailed, leadsBookDegraded, chaptersDegraded, chaptersParseDegraded, manifestDegraded }
  } finally {
    if (db) closeTreeIssuesDb(db) // R0916-6：裸 close 改道（prepared ephemeron 断链，closeTreeIssuesDb 单源）
  }
}