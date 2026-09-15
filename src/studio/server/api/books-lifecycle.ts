/**
 * 删书路由 + 删书/改名共用的书生命周期助手族 —— 自 src/studio/server/api/books.ts 缝 A 拆出。
 *
 * R0916-5h（2026-09-16，⑤④产品巨件拆分波4）：books.ts（870 行）缝 A+B 纯移动拆分。
 * 本文件承载缝 A：删书路由 books.delete（墓地原子改名 + 后台清理 + 登记/指针收尾）
 * + 删/改名共用的生命周期助手族——forgetBookKeyedCaches（书键 TTL 结果缓存族整表
 * 清理；其末尾清扫 shelfGuardCache，故书架守卫 TTL 缓存族随缝单源迁此，残核
 * books.get 经 getShelfGuard 单向取用）+ 墓地删除族（DELETE_GRAVEYARD_DIR / 后台
 * 清理句柄 / 两个测试注入口）+ awaitOrchestrationsSettled / busyGate /
 * drainAndRecheckBookMutation（五连 drain + 闸后复查）。
 * 改名路由族（book.rename + initialBook 直进指针）见 books-rename.ts（缝 B）；
 * 书架列表 / 建书 / 单书身份 / boot 残核留 books.ts，其头注末尾拆分沿革记全账。
 * 原私有而 books-rename.ts 跨模块消费的四助手与残核消费的 getShelfGuard 就此导出，
 * 其余保持私有；既有测试注入口导出面经 books.ts 桥接不变。
 * 依赖方向单向（无环回引）：本文件不 import 同批模块的任何运行时值（对 books.ts
 * 仅 import type BookCtx，编译期擦除）；顶层求值常量（shelfGuardCache / 墓地句柄
 * 等）一律单源本文件。注释全部原样随迁；行为、断言、测试零改动。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { rmSync, mkdirSync } from 'node:fs'
import { renameWithRetry } from '../../../fs/atomic.js'
import { ulid } from '../../../fs/id.js' // R42-14（四十二轮）：删书墓地名唯一后缀
import { rm } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import { defineRoute } from './schema.js'
import { reply, replyError } from '../http.js'
import { createTtlProbeCache } from '../ttl-cache.js' // D1（复审-0914-优化修复批）：TTL+FIFO 缓存壳单源
import { resolveWithinRoot } from '../../../fs/safe-path.js'
import { removeBookEntryAsync } from '../../../install/books.js'
import { resolveBookOrReply } from '../book-context.js'
// R1010b-SRV-P2-1/P3-1（2026-09-10 内存专项重审修复批）：伏笔保存串行链 drain + 按书 forget
import { forgetService, drainDocumentSaves, drainForeshadowSaveChains, forgetForeshadowSaveChain, drainStructureChainsUnder } from './documents.js'
import { drainFilePutChainsUnder } from './files.js'
import { drainDraftSaveChainsUnder } from './draft.js'
import { forgetSession } from '../../../driver/index.js'
import { invalidateTreeIndex } from '../../../document/tree.js'
import { clearChatHistory, abortChat, isChatRunning, waitChatSettled } from '../../../ai/orchestrate/chat.js'
import { abortSelfHeal, isSelfHealRunning, waitSelfHealSettled } from '../../../ai/orchestrate/self-heal.js'
import { waitBackgroundTasks, hasBackgroundTasks } from '../../../ai/orchestrate/background.js'
import { readBookConfig } from '../../../format/yaml.js'
import type { BookConfig } from '../../../format/types.js'
import { clearChapterDirCacheForBook } from '../../../format/chapters.js'
import { invalidateBookSummary } from './progress.js'
import { bookHash } from '../../../events/store.js'
import { heldTaskGatesFor, crossProcessHeldTaskGatesFor } from './task-gate.js'
import { isReviewRunningForBook } from './review.js'
import { forgetRagBuildTask } from './rag.js'
import { isSpawnRunning, forgetSseCount } from './stream.js'
// R67-15（十五轮）：四个书键 TTL 结果缓存（体检扫描/概览态/风格语料/learn 候选）的
// 失效挂点——删书/改名正向清理，TTL 5s 退为兜底自愈
import { forgetStyleScanCache } from './health.js'
import { forgetOverviewCache } from './overview.js'
import { forgetStyleCorpusCache } from './analysis.js'
import { forgetLearnCache } from './knowledge.js'
// R75-D-P3b（批 D）：/state 与 /tree-issues 两个书键 TTL 结果缓存同挂点收编
import { forgetStateCache } from './state.js'
import { forgetTreeIssuesCache } from './check.js'
// R35-7（三十五轮）：全书搜索 TTL 结果缓存同挂点收编
import { forgetSearchCache } from './search.js'
// R36-12（三十六轮）：设定一致规则 TTL 缓存同挂点收编（AI 热路径设定目录读取缓存）
import { forgetSettingCache } from '../../../ai/rules/setting-rule.js'
// R36-7（三十六轮）：analysis-overview / version-stats TTL 缓存同族收编——批 C 已
// 挂同文件写侧失效，删/改名生命周期清理由主评审补接本家族（防同名重建书读陈聚合）
import { forgetAnalysisOverviewCache } from './analysis.js'
import { forgetVersionStatsCache } from './snapshots.js'
// R44-8（四十四轮）：foreshadows / rhythm 全书扫描 TTL 缓存同族收编（删/改名后
// 同名重建书不读陈伏笔足迹/节奏聚合）
import { forgetForeshadowCache } from './foreshadows.js'
import { forgetRhythmCache } from './rhythm.js'
// R46-16（四十六轮）：settings 全书扫描 TTL 缓存同族收编（删/改名后同名重建书不读
// 陈设定台聚合——境界/角色卡/时间线/账本/relations）
import { forgetSettingsCache } from './settings.js'
// R46-40（四十六轮）：四个无 TTL 的模块级路径键缓存（sweep 节流戳/章读解析/章正文
// /版本指纹）同挂点收编——删书后全书条目成死重、改名后旧前缀键永不再命中
import { forgetStateSweepStamp } from '../../../state/state.js'
import { forgetChapterParseCacheForBook } from '../../../cache/rebuild.js'
import { forgetChapterTextCacheForBook } from '../../../document/foreshadow.js'
import { forgetVersionFpCacheForBook } from '../../../document/version.js'
// R46-20（四十六轮）：条目库读取 TTL+mtime 探针缓存同族收编（AI 写稿热路径的
// readEntries 不再每章每轮全量重读 文风/条目/；删/改名后同名重建书不读陈条目）
import { forgetEntriesCache } from '../../../format/style-entry.js'
// 复审-0913-源码 P3-⑩：文风铁律指纹缓存同族收编（同上删书/改名生命周期）
import { forgetIronRulesCache } from '../../../format/iron-rules.js'
// R46-23（四十六轮）：ai-calls 旧格式迁移标记同族收编——migratedRoots 只增不减，
// 删书重建同名书后旧标记会让旧格式迁移在本进程内永不重试
import { forgetMigratedRoots } from '../../../ai/calls.js'
import { log } from '../../../log/index.js'
import type { BookCtx } from './books.js'

/** R67-15：删书/改名共用的书键缓存清理（书键 TTL 结果缓存族——内存卫生，防删书后
 *  5s 内残留概览/体检数据被同名重建书读到）。 */
export function forgetBookKeyedCaches(bookRoot: string): void {
  forgetStyleScanCache(bookRoot)
  forgetOverviewCache(bookRoot)
  forgetStyleCorpusCache(bookRoot)
  forgetLearnCache(bookRoot)
  // R75-D-P3b：判态/树红点缓存同族清理
  forgetStateCache(bookRoot)
  forgetTreeIssuesCache(bookRoot)
  // R35-7：全书搜索缓存同族清理
  forgetSearchCache(bookRoot)
  // R36-12：设定一致规则设定目录 TTL 缓存同族清理（删/改名后同名重建书不读陈设定）
  forgetSettingCache(bookRoot)
  // R36-7：analysis-overview / version-stats 书键聚合缓存同族清理（主评审补接）
  forgetAnalysisOverviewCache(bookRoot)
  forgetVersionStatsCache(bookRoot)
  // R44-8：伏笔足迹 / 节奏聚合缓存同族清理
  forgetForeshadowCache(bookRoot)
  forgetRhythmCache(bookRoot)
  // R46-16：设定台聚合缓存同族清理
  forgetSettingsCache(bookRoot)
  // R46-40：无 TTL 模块级路径键缓存同族清理（sweep 节流戳 / 章读解析 / 章正文 /
  // 版本指纹——前缀删旧书键，新书键惰性重建）
  forgetStateSweepStamp(bookRoot)
  forgetChapterParseCacheForBook(bookRoot)
  forgetChapterTextCacheForBook(bookRoot)
  forgetVersionFpCacheForBook(bookRoot)
  // R46-20：条目库读取缓存同族清理（按书前缀清全部 kind 变体键）
  forgetEntriesCache(bookRoot)
  // 复审-0913-源码 P3-⑩：文风铁律指纹缓存同族清理（删/改名后同名重建书不复用陈规则）
  forgetIronRulesCache(bookRoot)
  // R46-23：ai-calls 旧格式迁移标记同族清理（删书重建后迁移可重试）
  forgetMigratedRoots(bookRoot)
  // R1010b-SRV-P3-1（2026-09-10 内存专项重审修复批）：伏笔保存串行链 Map 条目同族
  // 清理——链尾自清理覆盖常态，此处兜删书/改名时点的悬挂残条（bookRoot 键成死重）；
  // 删书/改名后同名重建书不复用旧链尾（调用点已 drainForeshadowSaveChains，链空，
  // 删除不破坏在途串行）。
  // R0911-B-P3-1（2026-09-11 全量重评 GLM-5.3 修复批）：R0910-W 批在此（shelfGuardCache
  // 清扫之后）重复追加了第二次调用——幂等零影响，但两条注释读作两件不同的事。合并为
  // 单次调用，真实语义即上注（Map.delete 幂等，一次已达清理目的）。
  forgetForeshadowSaveChain(bookRoot)
  // R39-16：书架守卫/配置缓存同族清理（删/改名后同名重建书不读陈 book.yaml；
  // 缓存按 workDir+path 键，整表清扫语义与「该书键失效」等价——书键族口径）
  shelfGuardCache.clear()
}

// ── R39-16（三十九轮）：书架守卫/配置 TTL 缓存 ──────────────────
// resolveWithinRoot（双侧 realpath + existsSync 链）与 readBookConfig（读盘 + YAML
// 解析）此前每请求每书全量重跑，不受 30s 摘要缓存保护——书库大 + 书架页高频刷新/
// 多窗口时每轮数百次同步 stat。与书架摘要同 TTL 口径：book.yaml 变更/书被外部移动
// 最迟 30s 可见（与摘要 staleness 语义一致）；应用内删书/改名经 forgetBookKeyedCaches
// 即时失效。容量 FIFO 128 对齐 probeCache 惯例（书数常态远小于此，仅防异常增长）。
type ShelfGuardValue =
  | { damaged: true }
  | { damaged: false; bookRoot: string; config: BookConfig }
const SHELF_GUARD_TTL_MS = 30_000
const SHELF_GUARD_MAX = 128

/** D1（复审-0914-优化修复批）：缓存壳收编 ttl-cache.ts 通用件（原本地 Map + FIFO +
 *  R47-18 过期逐出本地壳删除；命中/失效时序/逐出序逐位不变——纯 TTL 30s + FIFO 128
 *  + 同步计算；workDir+path 复合键经 keyOf 字符串化，键串与原实现逐位一致），
 *  见 ttl-cache.ts 头部收敛映射表。 */
const shelfGuardCache = createTtlProbeCache<{ workDir: string; path: string }, ShelfGuardValue>({
  name: 'shelf-guard',
  keyOf: (k) => `${k.workDir}\u0000${k.path}`,
  max: SHELF_GUARD_MAX,
  ttl: () => SHELF_GUARD_TTL_MS,
  computeSync: computeShelfGuardValue,
})

export function getShelfGuard(workDir: string, path: string): ShelfGuardValue {
  return shelfGuardCache.getSync({ workDir, path })
}

/** MISS 计算体（原 getShelfGuard 内联逻辑原样下沉；损坏标记也落缓存，R39-16/低-3 口径）。 */
function computeShelfGuardValue(key: { workDir: string; path: string }): ShelfGuardValue {
  const within = resolveWithinRoot(key.workDir, key.path)
  if (!within) {
    return { damaged: true }
  }
  try {
    const cfgResult = readBookConfig(join(within.abs, 'book.yaml'))
    // 低-3（第十轮）：book.yaml 损坏/缺失显式标 damaged——readBookConfig 容错不抛，
    // 此前回落默认骨架的空 title 混进列表装作正常书，与单书端点 500 口径分叉。
    // 前端按 damaged 展示可后续轮次接线（R36-24 既有登记）
    return cfgResult.ok ? { damaged: false, bookRoot: within.abs, config: cfgResult.config } : { damaged: true }
  } catch {
    // 书仓库读盘异常：保留登记原样 + 显式损坏标记（原 try/catch 语义）
    return { damaged: true }
  }
}

// R73-34（二十一轮 D-1）：删书墓地——workDir 根下点前缀目录（与 .journal/.旧版 同族，
// 书架扫描与启动 repair 不触达），同盘 rename 保证原子性
const DELETE_GRAVEYARD_DIR = '.删书墓地'

// R35-6（三十五轮）：墓地清理移出请求路径——全部书共享本服务进程（SSE/心跳/保存），
// 大书含 .git 的同步递归 rm 可达秒级事件循环冻结。热路径只保留原子改名（改完即可响应），
// rm 走 fs.promises 后台执行；失败仅留痕（数据在墓地可手工恢复，删除语义不变）。
// 本仓无墓地自动清扫兜底（启动/healthCheck 均不扫 .删书墓地），残留靠错误日志发现。
const defaultGraveyardCleanup = (graveAbs: string): Promise<void> => rm(graveAbs, { recursive: true, force: true })
let graveyardCleanup = defaultGraveyardCleanup
/** R35-6：在途墓地清理句柄——handler 同步注册、响应先行不等 rm；测试等待钩子据此收口。 */
const pendingGraveyardCleanups = new Set<Promise<void>>()

/** R35-6：测试注入口（null 还原默认；生产零调用）——注入受控清理以断言端点不被 rm 阻塞。 */
export function __setGraveyardCleanupForTest(fn: ((graveAbs: string) => Promise<void>) | null): void {
  graveyardCleanup = fn ?? defaultGraveyardCleanup
}

/** R35-6：等待全部在途墓地后台清理收尾（含失败）——测试确定性断言用，生产零调用。 */
export function __waitForGraveyardCleanupForTest(): Promise<void> {
  return Promise.allSettled([...pendingGraveyardCleanups]).then(() => {})
}

/** #7：等被 abort 的在途编排（chat / self-heal / M-2 后台任务）真正收尾。abort 只是异步
 * 信号——straggler 编排要跑到下一个 await 点才解旋，其收尾写库/flush 若在关库或目录搬移
 * 之后恢复，会抛「连接未打开」或对已删/已搬路径重建孤儿目录。上限 10s：等待是尽善，
 * 挂死编排不应阻塞删/改请求（超时后行为同旧版，事件库启动修复兜底）。
 * M-2：补 waitBackgroundTasks——定稿章摘要/账本草稿等 fire-and-forget 后台任务同样
 * 有对书根落盘的收尾窗口（无 abort 句柄，只能等或超时放行）。 */
export async function awaitOrchestrationsSettled(name: string): Promise<void> {
  await Promise.race([
    Promise.all([waitChatSettled(name), waitSelfHealSettled(name), waitBackgroundTasks(name)]),
    new Promise<void>((resolve) => setTimeout(resolve, 10_000).unref()), // R62-41：兜底定时器 unref——不再因等待中的备选定时器拖延进程退出
  ])
}

/** M-4：spawn/三审/task-gate 三闸联合检查——任一在途返回 BUSY 文案（否则 null）。
 * 各闸背景：ee-P2-11 /spawn 手动写稿分钟级且持 bookRoot 闭包（收尾落盘写旧路径重建
 * 孤儿目录）；hh-P1 三审同为分钟级长任务；dd-P2 task-gate（analyze/rewrite/rag-build
 * 等）无 abort 通道——三者持闸时都只能拒删/拒改（409），白烧 API 费用同理。 */
export function busyGate(name: string, verb: '删' | '改名'): { error: string } | null {
  if (isSpawnRunning(name)) return { error: `本书正在生成（手动写稿），先等它完成或中断后再${verb}` }
  if (isReviewRunningForBook(name)) return { error: `本书三审进行中，先等它完成后再${verb}` }
  // R75-5（批 D）：进程内 Set 与跨进程锁文件扫描合并去重——dev-api/脚本与 GUI 双进程
  // 并存时，此前只查 heldTaskGatesFor（进程内）看不见进程 A 的分钟级任务闸，放行删/改
  // 后任务收尾原子写在旧路径重建孤儿目录并白烧 API 费。跨进程侧陈锁（死 pid/超龄）由
  // 锁原语语义剔除，不算在持；本进程闸两侧都会报（锁文件也在），去重防文案双报。
  const held = [...new Set([...heldTaskGatesFor(name), ...crossProcessHeldTaskGatesFor(name)])]
  if (held.length > 0) return { error: `本书有任务在跑（${held.join('、')}），先等它完成或稍后再${verb}` }
  return null
}

/** P1-4（复审-0914-优化修复批）：删书/改名共用的「五连 drain + 闸后复查」排水段收编
 *  单源——此前两 handler 各自复制同一段 55 行（本段原实现顺位：第五轮 saveQueue →
 *  R69-25 PUT 链 → R1010b-SRV-P2-1 伏笔链 → 重评-0912-4 P2-1 draft-save 链 → 阶段 24
 *  structure 链，再接 M-4/R33D-7 与 R33-63 两级复查）。drain 顺序、复查判定与人话文案
 *  逐位保留；verb 仅参数化两处文案（已中止删除/改名、请稍后再删/改名）。返回 null =
 *  可安全动盘；非空 = 调用方回 409 BUSY。
 *
 *  各 drain 背景（原文沿革，逐条保序）：
 *  - 第五轮：drain 该书串行保存队列——在途 save 的收尾（journal+快照+fsync）若在
 *    rmSync/renameSync 之后恢复，会对已删/已搬路径 atomicWriteFile 重建孤儿文件
 *   （窗口毫秒级但真实）。
 *  - R69-25（十七轮）：PUT /file 的 per-file 串行链同款 drain——临界段内 readFileHashed
 *    跨 rm 的 await 窗口理论上会重建目录（删除路径基线 ENOENT → 404 天然免疫，一并
 *    drain 求同口径；改名侧重建的旧路径目录树无 book.yaml 孤儿，repairBooks 不认领）。
 *  - R1010b-SRV-P2-1（2026-09-10 内存专项重审修复批·面 B）：伏笔保存串行链同款
 *    drain——已入队未启动的伏笔单元在 SaveQueue 之外（drainDocumentSaves 看不见），
 *    不 drain 则 rmSync 后链单元才开跑、照写旧捕获 bookRoot 成孤儿。死锁核查：链单元
 *    只单向 await SaveQueue/清单·回收站锁、从不反等 books 侧锁，置于既有 drain 之后
 *    不引入环；drain 窗口内新进单元不等（快照式），由单元体内书注册重验兜底。
 *  - 重评-0912-4 P2-1（2026-09-12 全量重评修复批）：draft-save 串行链同款 drain——
 *    在途/迟到 draft-save 跨墓地 renameSync 后 saveDraft 的 mkdirSync(recursive) 会按
 *    旧书路径重建幽灵目录树并返 200（内容不属于任何书）。死锁核查同伏笔链。
 *  - 阶段 24 章节结构操作：structure 串行链同款 drain（第 5 个）——链单元内
 *    applyChapterMerge/applyChapterSplit 的 save/trash/create 各自会 mkdir + 落盘，
 *    跨 rmSync 开跑会对旧书路径重建孤儿文件。死锁核查同上。
 *  复查背景（原文沿革）：
 *  - M-4：闸后复查——settle 等待的 await 间隙里新 acquire 的闸（spawn/三审/task-gate）
 *    在此拦截；复检到 rmSync/renameSync 之间全同步（单线程事件循环无新任务可插入），
 *    三闸 TOCTOU 窗归零。
 *  - R33D-7（三十三轮 dev 线）：复查补 chat/self-heal——两闸不在 busyGate 之列，drain 段
 *    await 窗口内新起的对话/写稿既不在入口 abort 之列也无闸拦截，会贯穿 rmSync 继续跑
 *    分钟级（重建孤儿目录 + 白烧 API 费）。命中 → 保守 409（作者正主动用书，删除可重试）。
 *  - R33-63（三十三轮 win 线）：复查补 hasBackgroundTasks——10s settle 窗口内新登记的
 *    后台摘要任务此前可绕过复查，对已删路径收尾写（对齐 settle 三条件口径）。 */
export async function drainAndRecheckBookMutation(bookRoot: string, name: string, verb: '删' | '改名'): Promise<{ error: string } | null> {
  await drainDocumentSaves(bookRoot)
  await drainFilePutChainsUnder(bookRoot)
  await drainForeshadowSaveChains(bookRoot)
  await drainDraftSaveChainsUnder(bookRoot)
  await drainStructureChainsUnder(bookRoot)
  if (isChatRunning(name) || isSelfHealRunning(name)) {
    return { error: `本书有对话/写稿在途启动，已中止${verb === '删' ? '删除' : '改名'}——请等它完成或中断后重试` }
  }
  return busyGate(name, verb) ?? (hasBackgroundTasks(name) ? { error: `本书后台任务进行中，请稍后再${verb}` } : null)
}

export function registerBookLifecycleRoutes(ctx: BookCtx): void {
  // 删书（物理删除：书目录原子改名入墓地 + 后台清理 + 移 books.jsonl 登记 + 清 active 指针）
  defineRoute('books.delete', {
    method: 'DELETE',
    path: '/api/books/:name',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    if (!ctx.workDir) {
      replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
      return
    }
    const name = params['name'] ?? ''
    // SRV-N8（专项精简优化 §五，2026-09-15 机械批）：resolveBook 双行样板收编单源
    const r = resolveBookOrReply(ctx.workDir, name, res)
    if (!r) return
    const entry = r.entry
    // ee-P2-11 / hh-P1 / dd-P2：三闸联合检查（busyGate 集中各闸口径）
    // R32-6（三十二轮）：闸检查前置（对齐 rename 路径 R26-58 序）——此前先 abort 后过闸，
    // 闸拒绝（409，如 spawn/三审/任务闸在持）时在途对话/嵌套写稿已被不可逆中断，作者
    // 只是想删书却被顺带杀掉别的在途任务还删不成。abort 移到闸后：闸忙直接 409，
    // 零副作用；闸过才中断 chat/self-heal 走删除。
    const busy = busyGate(name, '删')
    if (busy) {
      return replyError(res, 409, 'BUSY', busy.error)
    }
    // U-P2-7：先中断该书在途的 AI 编排（self-heal 批量写稿可长达十几分钟，
    // 不中断会在删除后继续落盘重建目录、白耗 API 费用）
    const hadSelfHeal = isSelfHealRunning(name)
    if (hadSelfHeal) abortSelfHeal(name)
    const hadChat = isChatRunning(name)
    if (hadChat) abortChat(name)
    // #7：等被中断的编排收尾后再动磁盘/事件库——straggler 的 session/end 与链路
    // flush 落定后才 clearChatHistory，防「清完表又被 straggler 写回」（清不彻底）。
    // M-2 接线收口：后台任务须独立判定——定稿章摘要等 fire-and-forget 常发生在
    // 无 chat/self-heal 在途时（hadSelfHeal/hadChat 均 false），漏判会让摘要任务
    // 对已删路径重建孤儿目录
    if (hadSelfHeal || hadChat || hasBackgroundTasks(name)) await awaitOrchestrationsSettled(name)
    // P1-4（复审-0914-优化修复批）：五连 drain + 闸后复查收编 drainAndRecheckBookMutation
    // 单源——本段原为与改名 handler 逐位复制的 55 行排水段（第五轮/R69-25/R1010b-SRV-P2-1/
    // 重评-0912-4 P2-1/阶段 24 五 drain + M-4/R33D-7/R33-63 复查，沿革与顺序见 helper 头注）。
    const blocked = await drainAndRecheckBookMutation(join(ctx.workDir, entry.path), name, '删')
    if (blocked) {
      return replyError(res, 409, 'BUSY', blocked.error)
    }
      // 删书目录：整目录原子改名入墓地（含 git 历史）；物理清理移交后台（R35-6）
      const bookAbs = join(ctx.workDir, entry.path)
      // symlink/越出校验：防 entry.path 中间组件是符号链接或 .. → rmSync 删到书库外。
      // 批 6 统一：resolveWithinRoot（防穿越 + symlink 双侧 realpath；书路径 = workDir 自身
      // 时 rel='' 同判非法）。realpath 失败（不存在/权限）→ null → 拒绝删除
      if (!resolveWithinRoot(ctx.workDir, entry.path)) {
        return replyError(res, 400, 'BAD_PATH', '书路径非法（越出书库）')
      }
      // R73-34（二十一轮 D-1）：裸 rmSync 中途抛错（占用/权限/磁盘满）会留下半删目录 +
      // 未清的 books.jsonl 登记（启动 repair 只兜底整目录缺失，半删态登记悬空且不可逆）。
      // 改先整体 rename 进删书墓地（同盘 rename 原子：成功即原位不存在半删态），墓地副本
      // 清理失败仅留痕不阻断——数据在墓地可手工恢复，登记照常移除（与作者删除意图一致）。
      // R42-14（四十二轮）：墓地名追加 ULID 后缀——`${Date.now()}-${basename}` 在同毫秒
      // 并发双删同一书时撞出同一路径，第二请求 rename 落 ENOTEMPTY → 500（文案「书未
      // 受影响，可重试」与事实矛盾）；ULID 的 80bit 随机段保证墓地名恒唯一，双删各自
      // 落独立墓地副本（时间戳前缀保留，肉眼排序/排查语义不变）。
      const graveAbs = join(ctx.workDir, DELETE_GRAVEYARD_DIR, `${Date.now()}-${basename(entry.path)}-${ulid()}`)
      try {
        mkdirSync(dirname(graveAbs), { recursive: true })
        // R2W-3（win 平台专项复审 R2）：整目录 rename 是全应用对杀软/索引器最敏感的
        // 操作（要求整棵子树无句柄持有）——收编 renameWithRetry 的 EPERM/EBUSY 退避
        //（R77-3 原语），瞬时占用不再直接 500
        renameWithRetry(bookAbs, graveAbs)
      } catch (e) {
        // R39-16（三十九轮）：并发删书第二请求的 ENOENT 如实回 404——删书无书级互斥闸
        //（busyGate 只查任务闸），双击删除时第二请求经 resolveBook/全闸后在 drain 窗口
        // 后 rename 已被第一请求搬走的 bookAbs 报 ENOENT：原 500 文案「书未受影响，
        // 可重试」与事实（书已删成功）矛盾，用户照文案重试得 404 语义打架。
        // R42-14（四十二轮）：ENOTEMPTY/EEXIST 同口径收口 404（双保险）——墓地目标
        // 已被占同样意味着「另一并发删除已推进过改名」（ULID 后缀已使撞名几乎不可能，
        // 此处兜底墓地名生成前后的极端竞态与历史残留的同名墓地目录）。
        const graveCode = (e as NodeJS.ErrnoException).code
        if (graveCode === 'ENOENT' || graveCode === 'ENOTEMPTY' || graveCode === 'EEXIST') {
          replyError(res, 404, 'NOT_FOUND', `没有这本书：${name}（可能刚被删除）`)
          return
        }
        log.error('api', `删书移入墓地失败（${name}，书原样保留）`, e)
        replyError(res, 500, 'IO_ERROR', '删除书目录失败（书未受影响，可重试）')
        return
      }
      // R35-6：墓地清理后台执行（不 await——响应不被递归 rm 阻塞）；在途句柄先注册再挂
      // finally（防等待钩子读到已删集合漏等），失败仅留痕
      const cleanupDone = graveyardCleanup(graveAbs).catch((e) => {
        log.error('api', `删书墓地后台清理失败（${name}，留档待手工处理：${graveAbs}）`, e)
      })
      pendingGraveyardCleanups.add(cleanupDone)
      void cleanupDone.finally(() => {
        pendingGraveyardCleanups.delete(cleanupDone)
      })
      // 移 books.jsonl 登记 + 清活动书指针（残留清偿批：同步 removeBookEntry 的
      // Atomics.wait 锁等待改异步孪生——mutator 族服务面落点至此归零）
      await removeBookEntryAsync(ctx.workDir, name)
      // 清理 service 缓存，防同 path 重建复用旧实例
      forgetService(bookAbs)
      // P1-S2：清理 driver session + 树索引缓存，防删书后资源泄漏
      forgetSession(name)
      // R-18（第十六轮）：per-book SSE 计数一并清——残留计数会让同名重建书被顶到 429 上限
      forgetSseCount(name)
      // R67-15（十五轮）：书键 TTL 结果缓存一并清（见顶部 forgetBookKeyedCaches 注释）
      forgetBookKeyedCaches(bookAbs)
      // R69-24（十七轮）：书架摘要缓存一并清——rename 分支（:444）有 invalidateBookSummary，
      // delete 分支漏配：删后 5s TTL 窗口内同名重建书，书架卡会读到旧章数/字数/最近编辑
      invalidateBookSummary(bookAbs)
      invalidateTreeIndex(bookAbs, true)
      // 内存闸（2026-08-24 审计 C2）：章节元数据缓存按书前缀一并清——删书后目录已不在，
      // 每章元数据条目成死重（bookAbs 即各调用方 readChapterDir 键的 join 前缀）
      clearChapterDirCacheForBook(bookAbs)
      // GG-P2-3：事件库一并清（Y-P2-7 双键：book=书名 + book=bookHash(bookRoot)）——
      // 只清内存时事件库残留，同名重建书会在 audit 重放里继承旧书会话/链路事件。
      // L-S4（第八轮）：删除主流程已完成（登记已移、目录已删），清史收尾若抛（SQLITE_BUSY
      // 等）不该让客户端看到 500「内部错误」且跳过下方 db 文件清理留孤儿——防御性收编
      try {
        // R34D-19（三十四轮）：clearChatHistory 转异步（事件库开库异步孪生），防御性收编不变
        await clearChatHistory(name, ctx.userDataPath ?? undefined, bookAbs)
      } catch (e) {
        // 低-6（第十轮）：留痕走项目 logger——console 在打包态 mirrorConsole=false 无人看见
        // 也不进 JSONL（诊断失明）；tag 与本文件 log.error 删除目录失败同源 'api'
        log.warn('api', `删书清史失败（${name}，残留 db 文件将由下方清理兜底）`, e)
      }
      // 二轮复审（低级）：事件库**文件**一并删（<hash>.db + WAL/SHM 伴生）——clearChatHistory
      // 只清行，库文件本体滞留 userData 成永久孤儿（每书一库）；settle 已保证无人持有句柄，
      // 清理失败不阻断删书（残留文件无读者）
      if (ctx.userDataPath) {
        const dbBase = join(ctx.userDataPath, 'clwriting', 'session', bookHash(bookAbs) + '.db')
        for (const suffix of ['', '-wal', '-shm']) {
          try {
            rmSync(dbBase + suffix, { force: true })
          } catch {
            /* 单个伴生文件清理失败忽略 */
          }
        }
      }
      forgetRagBuildTask(name) // dd-P3：模块级索引任务表随删书清理
      reply(res, 200, { ok: true, name })
  },
  })
}
