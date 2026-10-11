/**
 * 删书路由 + 删书/改名共用的书生命周期助手族。
 *
 * 内容：删书路由 books.delete（墓地原子改名 + 后台清理 + 登记/指针收尾）+ 生命周期助手族
 *——forgetBookKeyedCaches（书键缓存一次广播：转发 cache-registry.ts 登记表遍历，取代手工
 * forget 清单）+ 墓地删除族（DELETE_GRAVEYARD_DIR / 后台清理，清理函数经组装根 RouteOverrides
 * 注入）+ 清理句柄 / 测试注入口 + awaitOrchestrationsSettled / busyGate /
 * drainAndRecheckBookMutation（五连 drain + 闸后复查）。书架守卫 TTL 缓存族单源迁此
 *（shelfGuardCache 在本文件内联登记；残核 books.get 经 getShelfGuard 单向取用）。
 *
 * 本文件同时是**书键缓存登记制的聚合入口**：各缓存模块在模块顶层自登记
 *（registerBookKeyedCache），下方 side-effect import 段只负责拉齐求值；红线 = 新增书键缓存
 * 必须「新建模块自登记 + 本段加一行 import」，漏加由机器门顶红
 *（test/studio/server/ttl-cache.test.ts「书键缓存登记制对账」）。
 *
 * 改名路由族（book.rename + initialBook 直进指针）见 books-rename.ts；书架列表 / 建书 /
 * 单书身份 / boot 残核留 books.ts。原私有而 books-rename.ts 跨模块消费的四助手与残核消费的
 * getShelfGuard 就此导出，其余保持私有。
 * 依赖单向（无环）：本文件不 import 同批模块的任何运行时值（对 books.ts 仅 import type BookCtx，
 * 编译期擦除）；顶层求值常量（shelfGuardCache / 墓地句柄等）一律单源本文件。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { rmSync, mkdirSync, readdirSync, lstatSync, type Dirent } from 'node:fs'
import { renameWithRetry } from '../../../fs/atomic.js'
import { ulid } from '../../../fs/id.js' // 删书墓地名唯一后缀
import { rm } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import { defineRoute } from './schema.js'
import { reply, replyError } from '../http.js'
import { createTtlProbeCache } from '../ttl-cache.js' // TTL+FIFO 缓存壳单源
import { registerBookKeyedCache, forgetBookKeyedCaches as forgetRegisteredBookKeyedCaches } from '../cache-registry.js' // 书键缓存登记表（登记制单源；见下方聚合入口段）
import { resolveWithinRoot } from '../../../fs/safe-path.js'
import { removeBookEntryAsync } from '../../../install/books.js'
import { resolveBookOrReply } from '../book-context.js'
// 伏笔保存串行链 drain + 按书 forget（forgetForeshadowSaveChain 已改登记制：
// 自登记点在 api/documents-core.ts，本文件不再取其运行时值）
import { forgetService, drainDocumentSaves, drainForeshadowSaveChains, drainStructureChainsUnder } from './documents.js'
import { drainFilePutChainsUnder } from './files.js'
import { drainDraftSaveChainsUnder } from './draft.js'
import { invalidateTreeIndex } from '../../../document/tree.js'
import { clearChatHistory, abortChat, isChatRunning, waitChatSettled } from '../../../ai/orchestrate/chat.js'
import { abortSelfHeal, isSelfHealRunning, waitSelfHealSettled } from '../../../ai/orchestrate/self-heal.js'
import { waitBackgroundTasks, hasBackgroundTasks } from '../../../ai/orchestrate/background.js'
import { readBookConfig } from '../../../format/yaml.js'
import type { BookConfig } from '../../../format/types.js'
import { clearChapterDirCacheForBook } from '../../../format/chapters.js'
import { invalidateBookSummary } from './progress.js'
import { bookHash } from '../../../events/store.js'
import type { TaskGate } from './task-gate.js' // 闸实例经组装根注入（busyGate 为模块级助手，显式接闸）
import { forgetRagBuildTask } from './rag.js'
import { forgetSseCount } from './stream.js' // isSpawnRunning 面随 busyGate 收编矩阵，本文件不再直取
// ── 书键缓存登记制的聚合入口（单一入口，勿拆）────────────────────────────
// 各缓存模块在模块顶层自登记（registerBookKeyedCache），下列 side-effect import
// 只负责「让登记发生」（登记靠模块被 import 才发生）。**新增书键缓存 = 新建模块
// 顶层自登记 + 本段加一行 import**；漏加即被机器门顶红——登记完整性不靠人记
// （test/studio/server/ttl-cache.test.ts「书键缓存登记制对账」describe 把 src/**
// 全部 forget* 导出与登记表运行时实际登记项双向对账）。
// 列序 = 历史 22 条手工清单序（供迁移对账用）；执行序 = 登记序（模块求值序），且
// 逐条核对各 forgetFn 只删本模块私有 Map/Set、互不读写——顺序无语义，含历史居末的
// shelf-guard 整表 clear（见 cache-registry.ts 头注）。
import './health.js' // 历史①：体检文风扫描书键 TTL 缓存（同名重建书不读陈扫描结果）
import './overview.js' // ②：概览整包 + 判态书键 TTL 缓存
import './analysis.js' // ③⑨：style-corpus / analysis-overview 书键 TTL 缓存（模块内两条自登记）
import './knowledge.js' // ④：/learn 书键 TTL 缓存（仅成功结果入缓存）
import './state.js' // ⑤：/state 书键 TTL 缓存
import './check.js' // ⑥：/tree-issues 书键 TTL 缓存
import './search.js' // ⑦：全书搜索书键 TTL 缓存（复合键前缀清）
import './snapshots.js' // ⑩：version-stats 书键 TTL 缓存
import './foreshadows.js' // ⑪：伏笔条目/足迹书键 TTL 缓存
import './rhythm.js' // ⑫：节奏聚合书键 TTL 缓存
import './settings.js' // ⑬：设定台聚合书键 TTL 缓存（settings + completion-names 两壳同清）
import '../../../state/health.js' // ⑭：清扫节流戳 / 云盘扫描 / finalizedLost 三表
import '../../../cache/rebuild.js' // ⑮：章读解析缓存 + 源树扫描节流键（前缀/整键清）
import '../../../fs/md-text-cache.js' // ⑯：章正文/整文读取缓存单源（document/foreshadow 包装委托同源）
import '../../../document/version.js' // ⑰：版本指纹缓存（join(bookRoot,'工作区',.版本) 前缀清）
import '../../../format/style-entry.js' // ⑱：条目库读取缓存（全部 kind 变体前缀清）
import '../../../format/iron-rules.js' // ⑲：文风铁律指纹缓存（同名重建书不复用陈规则）
import './documents-core.js' // ㉑：伏笔保存串行链 Map 残条（drain 链已因 ./documents.js 求值，此行显式化登记来源）
// ⑧⑳ ai 侧两条（ai/rules/setting-rule.ts 设定目录读取缓存 / ai/calls.ts 旧格式迁移
// 标记）因 src/ai/** 零 studio 直连方向锁（test/governance/ai-studio-direction.test.ts）
// 不能自登记，由本入口代登记——登记语义与自登记逐位相同；机器门照常对账。
// 约束随迁：同名重建书不读陈设定目录（⑧）；migratedRoots 只增不减，不清则
// 删书重建同名书后旧格式迁移在本进程内永不重试（⑳，详见 ai/calls.ts forget 头注）。
import { forgetSettingCache } from '../../../ai/rules/setting-rule.js'
import { forgetMigratedRoots } from '../../../ai/calls.js'
import { log, errMsg } from '../../../log/index.js'
import type { BookCtx } from './books.js'

// ⑧⑳ 代登记（上两行的 ai 侧缓存；语句在全部 import 之后求值——ESM import 声明
// 提升，登记序与列序无关且无语义，见 cache-registry.ts 头注）。
registerBookKeyedCache('ai-setting-dir', forgetSettingCache)
registerBookKeyedCache('ai-calls-migrated-roots', forgetMigratedRoots)

/** 删书/改名共用的书键缓存一次广播（登记制：遍历登记表逐项 forgetFn(bookRoot)；
 *  各缓存 TTL/容量/键口径独立，TTL 仍为兜底自愈）。
 *  内存卫生：防删书后 5s 内残留概览/体检数据被同名重建书读到；约束信息见各缓存
 *  模块自登记处与各 forget 头注。 */
export function forgetBookKeyedCaches(bookRoot: string): void {
  forgetRegisteredBookKeyedCaches(bookRoot)
}

// ──：书架守卫/配置 TTL 缓存 ──────────────────
// resolveWithinRoot（双侧 realpath + existsSync 链）与 readBookConfig（读盘 + YAML
// 解析）此前每请求每书全量重跑，不受 30s 摘要缓存保护——书库大 + 书架页高频刷新/
// 多窗口时每轮数百次同步 stat。与书架摘要同 TTL 口径：book.yaml 变更/书被外部移动
// 最迟 30s 可见（与摘要 staleness 语义一致）；应用内删书/改名经 forgetBookKeyedCaches
// 即时失效。容量 FIFO 128 对齐 probeCache 惯例（书数常态远小于此，仅防异常增长）。
type ShelfGuardValue = { damaged: true } | { damaged: false; bookRoot: string; config: BookConfig }
const SHELF_GUARD_TTL_MS = 30_000
const SHELF_GUARD_MAX = 128

/** 缓存壳收编 ttl-cache.ts 通用件（原本地 Map + FIFO +
 * 过期逐出本地壳删除；命中/失效时序/逐出序逐位不变——纯 TTL 30s + FIFO 128
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

// 登记制（模块顶层自登记，历史㉒条/清单居末）：删/改名后同名重建书不读陈 book.yaml——
// 缓存键为 workDir+path 复合键（与 bookRoot 前缀无关），整表清扫语义与「该书键失效」
// 等价；居末只是编写顺序，整表 clear 与其余按书键删互不交织，位置无语义
// （见 cache-registry.ts 头注）。闭包零参——bookRoot 对本缓存无消费面（登记表调用面
// 允许少参函数）。
registerBookKeyedCache('shelf-guard', () => shelfGuardCache.clear())

/** MISS 计算体（原 getShelfGuard 内联逻辑原样下沉；损坏标记也落缓存/低-3 口径）。 */
function computeShelfGuardValue(key: { workDir: string; path: string }): ShelfGuardValue {
  const within = resolveWithinRoot(key.workDir, key.path)
  if (!within) {
    return { damaged: true }
  }
  try {
    const cfgResult = readBookConfig(join(within.abs, 'book.yaml'))
    // 低-3：book.yaml 损坏/缺失显式标 damaged——readBookConfig 容错不抛，
    // 此前回落默认骨架的空 title 混进列表装作正常书，与单书端点 500 口径分叉。
    // 前端按 damaged 展示可后续轮次接线（既有登记）
    return cfgResult.ok ? { damaged: false, bookRoot: within.abs, config: cfgResult.config } : { damaged: true }
  } catch {
    // 书仓库读盘异常：保留登记原样 + 显式损坏标记（原 try/catch 语义）
    return { damaged: true }
  }
}

// 删书墓地——workDir 根下点前缀目录（与 .journal/.旧版 同族，
// 书架扫描与启动 repair 不触达），同盘 rename 保证原子性
const DELETE_GRAVEYARD_DIR = '.删书墓地'

// 墓地清理移出请求路径——全部书共享本服务进程（SSE/心跳/保存），
// 大书含 .git 的同步递归 rm 可达秒级事件循环冻结。热路径只保留原子改名（改完即可响应），
// rm 走 fs.promises 后台执行；失败仅留痕（数据在墓地可手工恢复，删除语义不变）。
// 清扫兜底见下方 sweepGraveyardOnce（启动期装配挂点单次执行——原注「本仓无墓地自动
// 清扫兜底」即所指缺口：清理失败的大书目录（含 .git）会永久驻留）。
const defaultGraveyardCleanup = (graveAbs: string): Promise<void> => rm(graveAbs, { recursive: true, force: true })
/** 收尾：__setGraveyardCleanupForTest / __waitForGraveyardCleanupForTest
 * 与 pendingGraveyardCleanups 在途句柄表删除——清理函数改组装根 RouteOverrides 注入
 * （BookCtx.graveyardCleanup，undefined = 真删生产口径逐位不变）。在途句柄表生产零读
 * （纯测试簿记），回归断言改行为化：受控桩由测试自持 deferred 直接 await，真删路径
 * 以 vi.waitFor 轮询墓地终态（断言内容零弱化）。 */

/** 墓地名唯一形态（删书路由产出：`${Date.now()}-${书目录名}-${ulid()}`）。
 *  清扫只认本形态的项——边界红线：墓地域只由删书路由写入，「形态不符即非本目录产物」
 *  ⇒ 作者手放的杂物、早期无 ULID 后缀的旧残留一律留档不动（宁残留勿误删）。
 *  中段贪婪：书目录名自身可含 '-'。 */
const GRAVE_ENTRY_RE = /^\d+-(.+)-[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * 删书墓地启动兜底清扫（装配挂点单次调用，fire-and-forget）——热路径（books.delete）
 * 只做原子改名入墓地、rm 交后台且失败仅留痕：清理失败的大书目录（含 .git）此前无任何
 * 重试通道。挂点取路由装配（server 启动链既有单次调用点：createStudioServer →
 * buildRoutes → registerBookRoutes → registerBookLifecycleRoutes），不新造启动链。
 *
 * 边界：只清形态匹配 GRAVE_ENTRY_RE 的**真实目录**（lstat 复核，不跟随符号链接——
 * ent.isDirectory() 在 DT_UNKNOWN 卷上不可信；链接不是本目录产物，不删不追）；
 * 不递归跨目录追击、不碰形态不符项。
 *
 * 并发（两窗同时启动 = 两 server 实例同时清扫）：墓地名带 ulid 唯一后缀，同名项只可能
 * 指向同一物理删除目标；rm(force) 对已消失项是幂等 no-op，且扫描列表是快照——并发
 * 清扫同一项无竞态、无需锁/防重入（最坏是一次多余的 no-op 调用）。与热路径后台清理
 * 并发同理（两处都 force，先到者删净、后到者 no-op）。
 *
 * 失败不阻断启动：逐项 try/catch，失败 warn 留痕（含路径与原因）留待下次启动重试或
 * 手工处理；不因清扫失败/慢盘延后启动（调用方不 await）。
 */
export async function sweepGraveyardOnce(workDir: string): Promise<{ removed: number; failed: number }> {
  const graveyard = join(workDir, DELETE_GRAVEYARD_DIR)
  let entries: Dirent[]
  try {
    entries = readdirSync(graveyard, { withFileTypes: true })
  } catch {
    return { removed: 0, failed: 0 } // 目录不存在（常态）/不可读：无清扫面
  }
  let removed = 0
  let failed = 0
  for (const ent of entries) {
    if (!GRAVE_ENTRY_RE.test(ent.name)) continue
    const abs = join(graveyard, ent.name)
    try {
      if (!lstatSync(abs).isDirectory()) continue // 不跟随符号链接：只清真实目录
      await rm(abs, { recursive: true, force: true })
      removed++
    } catch (e) {
      failed++
      log.warn('api', `删书墓地兜底清扫失败（留档待下次启动重试或手工处理：${abs}）：${errMsg(e)}`, e)
    }
  }
  if (removed > 0) log.info('api', `删书墓地兜底清扫：已清理 ${removed} 个上次未清干净的删书副本`)
  return { removed, failed }
}

/** #7：等被 abort 的在途编排（chat / self-heal 后台任务）真正收尾。abort 只是异步
 * 信号——straggler 编排要跑到下一个 await 点才解旋，其收尾写库/flush 若在关库或目录搬移
 * 之后恢复，会抛「连接未打开」或对已删/已搬路径重建孤儿目录。上限 10s：等待是尽善，
 * 挂死编排不应阻塞删/改请求（超时后行为同旧版，事件库启动修复兜底）。
 * 补 waitBackgroundTasks——定稿章摘要/账本草稿等 fire-and-forget 后台任务同样
 * 有对书根落盘的收尾窗口（无 abort 句柄，只能等或超时放行）。 */
export async function awaitOrchestrationsSettled(name: string): Promise<void> {
  await Promise.race([
    Promise.all([waitChatSettled(name), waitSelfHealSettled(name), waitBackgroundTasks(name)]),
    new Promise<void>((resolve) => setTimeout(resolve, 10_000).unref()), // 兜底定时器 unref——不再因等待中的备选定时器拖延进程退出
  ])
}

/** spawn/三审/task-gate 三闸联合检查——任一在途返回 BUSY 文案（否则 null）。
 * 各闸背景：/spawn 手动写稿分钟级且持 bookRoot 闭包（收尾落盘写旧路径重建
 * 孤儿目录）；三审同为分钟级长任务；task-gate（analyze/rewrite/rag-build
 * 等）无 abort 通道——三者持闸时都只能拒删/拒改（409），白烧 API 费用同理。
 * 进程内 Set 与跨进程锁文件扫描合并去重——dev-api/脚本与 GUI 双进程
 * 并存时，此前只查 heldTaskGatesFor（进程内）看不见进程 A 的分钟级任务闸，放行删/改
 * 后任务收尾原子写在旧路径重建孤儿目录并白烧 API 费。跨进程侧陈锁（死 pid/超龄）由
 * 锁原语语义剔除，不算在持。
 * 三闸本体与文案单源在 task-gate 的 BUSY_MATRIX（'book-delete'/
 * 'book-rename' 两行，序 spawn → review → task-gate 逐位保留），本函数退为「动词 →
 * 意图」薄适配。 */
export function busyGate(gate: TaskGate, name: string, verb: '删' | '改名'): { error: string } | null {
  const reason = gate.busyReason(name, verb === '删' ? 'book-delete' : 'book-rename')
  return reason === null ? null : { error: reason }
}

/** 删书/改名共用的「五连 drain + 闸后复查」排水段收编
 * 单源——此前两 handler 各自复制同一段 55 行（本段原实现顺位：saveQueue →
 * PUT 链 →伏笔链 →draft-save 链 → 阶段 24
 * structure 链，再接与两级复查）。drain 顺序、复查判定与人话文案
 *  逐位保留；verb 仅参数化两处文案（已中止删除/改名、请稍后再删/改名）。返回 null =
 *  可安全动盘；非空 = 调用方回 409 BUSY。
 *
 *  各 drain 背景（原文沿革，逐条保序）：
 * -：drain 该书串行保存队列——在途 save 的收尾（journal+快照+fsync）若在
 *    rmSync/renameSync 之后恢复，会对已删/已搬路径 atomicWriteFile 重建孤儿文件
 *   （窗口毫秒级但真实）。
 * -：PUT /file 的 per-file 串行链同款 drain——临界段内 readFileHashed
 *    跨 rm 的 await 窗口理论上会重建目录（删除路径基线 ENOENT → 404 天然免疫，一并
 *    drain 求同口径；改名侧重建的旧路径目录树无 book.yaml 孤儿，repairBooks 不认领）。
 * -（面 B）：伏笔保存串行链同款
 *    drain——已入队未启动的伏笔单元在 SaveQueue 之外（drainDocumentSaves 看不见），
 *    不 drain 则 rmSync 后链单元才开跑、照写旧捕获 bookRoot 成孤儿。死锁核查：链单元
 *    只单向 await SaveQueue/清单·回收站锁、从不反等 books 侧锁，置于既有 drain 之后
 *    不引入环；drain 窗口内新进单元不等（快照式），由单元体内书注册重验兜底。
 * draft-save 串行链同款 drain——
 *    在途/迟到 draft-save 跨墓地 renameSync 后 saveDraft 的 mkdirSync(recursive) 会按
 *    旧书路径重建幽灵目录树并返 200（内容不属于任何书）。死锁核查同伏笔链。
 *  - 阶段 24 章节结构操作：structure 串行链同款 drain（第 5 个）——链单元内
 *    applyChapterMerge/applyChapterSplit 的 save/trash/create 各自会 mkdir + 落盘，
 *    跨 rmSync 开跑会对旧书路径重建孤儿文件。死锁核查同上。
 *  复查背景（原文沿革）：
 * 闸后复查——settle 等待的 await 间隙里新 acquire 的闸（spawn/三审/task-gate）
 *    在此拦截；复检到 rmSync/renameSync 之间全同步（单线程事件循环无新任务可插入），
 *    三闸 TOCTOU 窗归零。
 * -（dev 线）：复查补 chat/self-heal——两闸不在 busyGate 之列，drain 段
 *    await 窗口内新起的对话/写稿既不在入口 abort 之列也无闸拦截，会贯穿 rmSync 继续跑
 *    分钟级（重建孤儿目录 + 白烧 API 费）。命中 → 保守 409（作者正主动用书，删除可重试）。
 * -（win 线）：复查补 hasBackgroundTasks——10s settle 窗口内新登记的
 *    后台摘要任务此前可绕过复查，对已删路径收尾写（对齐 settle 三条件口径）。 */
export async function drainAndRecheckBookMutation(
  gate: TaskGate,
  bookRoot: string,
  name: string,
  verb: '删' | '改名',
): Promise<{ error: string } | null> {
  await drainDocumentSaves(bookRoot)
  await drainFilePutChainsUnder(bookRoot)
  await drainForeshadowSaveChains(bookRoot)
  await drainDraftSaveChainsUnder(bookRoot)
  await drainStructureChainsUnder(bookRoot)
  if (isChatRunning(name) || isSelfHealRunning(name)) {
    return { error: `本书有对话/写稿在途启动，已中止${verb === '删' ? '删除' : '改名'}——请等它完成或中断后重试` }
  }
  return (
    busyGate(gate, name, verb) ?? (hasBackgroundTasks(name) ? { error: `本书后台任务进行中，请稍后再${verb}` } : null)
  )
}

export function registerBookLifecycleRoutes(ctx: BookCtx): void {
  // 启动兜底清扫（fire-and-forget）；不 await——清扫走盘不受限（墓地可含秒级递归删）
  // 也不得因失败/慢盘阻断启动（函数内部逐项吞错留痕，外层 .catch 只兜编译期不可见异常）。
  if (ctx.workDir) {
    void sweepGraveyardOnce(ctx.workDir).catch((e) => log.error('api', '删书墓地兜底清扫异常（忽略，不影响启动）', e))
  }
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
      // SRV-：resolveBook 双行样板收编单源
      const r = resolveBookOrReply(ctx.workDir, name, res)
      if (!r) return
      const entry = r.entry
      // 三闸联合检查（busyGate 集中各闸口径）
      // 闸检查前置（对齐 rename 路径序）——此前先 abort 后过闸，
      // 闸拒绝（409，如 spawn/三审/任务闸在持）时在途对话/嵌套写稿已被不可逆中断，作者
      // 只是想删书却被顺带杀掉别的在途任务还删不成。abort 移到闸后：闸忙直接 409，
      // 零副作用；闸过才中断 chat/self-heal 走删除。
      const busy = busyGate(ctx.gate, name, '删')
      if (busy) {
        return replyError(res, 409, 'BUSY', busy.error)
      }
      // 先中断该书在途的 AI 编排（self-heal 批量写稿可长达十几分钟，
      // 不中断会在删除后继续落盘重建目录、白耗 API 费用）
      const hadSelfHeal = isSelfHealRunning(name)
      if (hadSelfHeal) abortSelfHeal(name)
      const hadChat = isChatRunning(name)
      if (hadChat) abortChat(name)
      // #7：等被中断的编排收尾后再动磁盘/事件库——straggler 的 session/end 与链路
      // flush 落定后才 clearChatHistory，防「清完表又被 straggler 写回」（清不彻底）。
      // 接线收口：后台任务须独立判定——定稿章摘要等 fire-and-forget 常发生在
      // 无 chat/self-heal 在途时（hadSelfHeal/hadChat 均 false），漏判会让摘要任务
      // 对已删路径重建孤儿目录
      if (hadSelfHeal || hadChat || hasBackgroundTasks(name)) await awaitOrchestrationsSettled(name)
      // 五连 drain + 闸后复查收编 drainAndRecheckBookMutation
      // 单源——本段原为与改名 handler 逐位复制的 55 行排水段（/
      // /阶段 24 五 drain +复查，沿革与顺序见 helper 头注）。
      const blocked = await drainAndRecheckBookMutation(ctx.gate, join(ctx.workDir, entry.path), name, '删')
      if (blocked) {
        return replyError(res, 409, 'BUSY', blocked.error)
      }
      // 删书目录：整目录原子改名入墓地（含 git 历史）；物理清理移交后台
      const bookAbs = join(ctx.workDir, entry.path)
      // symlink/越出校验：防 entry.path 中间组件是符号链接或 .. → rmSync 删到书库外。
      // 统一：resolveWithinRoot（防穿越 + symlink 双侧 realpath；书路径 = workDir 自身
      // 时 rel='' 同判非法）。realpath 失败（不存在/权限）→ null → 拒绝删除
      if (!resolveWithinRoot(ctx.workDir, entry.path)) {
        return replyError(res, 400, 'BAD_PATH', '书路径非法（越出书库）')
      }
      // 裸 rmSync 中途抛错（占用/权限/磁盘满）会留下半删目录 +
      // 未清的 books.jsonl 登记（启动 repair 只兜底整目录缺失，半删态登记悬空且不可逆）。
      // 改先整体 rename 进删书墓地（同盘 rename 原子：成功即原位不存在半删态），墓地副本
      // 清理失败仅留痕不阻断——数据在墓地可手工恢复，登记照常移除（与作者删除意图一致）。
      // 墓地名追加 ULID 后缀——`${Date.now()}-${basename}` 在同毫秒
      // 并发双删同一书时撞出同一路径，第二请求 rename 落 ENOTEMPTY → 500（文案「书未
      // 受影响，可重试」与事实矛盾）；ULID 的 80bit 随机段保证墓地名恒唯一，双删各自
      // 落独立墓地副本（时间戳前缀保留，肉眼排序/排查语义不变）。
      const graveAbs = join(ctx.workDir, DELETE_GRAVEYARD_DIR, `${Date.now()}-${basename(entry.path)}-${ulid()}`)
      try {
        mkdirSync(dirname(graveAbs), { recursive: true })
        // （win 平台）：整目录 rename 是全应用对杀软/索引器最敏感的
        // 操作（要求整棵子树无句柄持有）——收编 renameWithRetry 的 EPERM/EBUSY 退避
        //（原语），瞬时占用不再直接 500
        renameWithRetry(bookAbs, graveAbs)
      } catch (e) {
        // 并发删书第二请求的 ENOENT 如实回 404——删书无书级互斥闸
        //（busyGate 只查任务闸），双击删除时第二请求经 resolveBook/全闸后在 drain 窗口
        // 后 rename 已被第一请求搬走的 bookAbs 报 ENOENT：原 500 文案「书未受影响，
        // 可重试」与事实（书已删成功）矛盾，用户照文案重试得 404 语义打架。
        // ENOTEMPTY/EEXIST 同口径收口 404（双保险）——墓地目标
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
      // 墓地清理后台执行（不 await——响应不被递归 rm 阻塞）；失败仅留痕。
      // 收尾：清理函数经 ctx（组装根 RouteOverrides）注入——undefined =
      // defaultGraveyardCleanup 真删口径逐位不变（在途句柄表随缝删除，见上方注）
      ;(ctx.graveyardCleanup ?? defaultGraveyardCleanup)(graveAbs).catch((e) => {
        log.error('api', `删书墓地后台清理失败（${name}，留档待手工处理：${graveAbs}）`, e)
      })
      // 移 books.jsonl 登记 + 清活动书指针（同步 removeBookEntry 的
      // Atomics.wait 锁等待改异步孪生——mutator 族服务面落点至此归零）
      await removeBookEntryAsync(ctx.workDir, name)
      // 清理 service 缓存，防同 path 重建复用旧实例
      forgetService(bookAbs)
      // 清理 driver session + 树索引缓存，防删书后资源泄漏
      ctx.driver.forgetSession(name)
      // per-book SSE 计数一并清——残留计数会让同名重建书被顶到 429 上限
      forgetSseCount(name)
      // 书键 TTL 结果缓存一并清（见顶部 forgetBookKeyedCaches 注释）
      forgetBookKeyedCaches(bookAbs)
      // 书架摘要缓存一并清——rename 分支（444）有 invalidateBookSummary，
      // delete 分支漏配：删后 5s TTL 窗口内同名重建书，书架卡会读到旧章数/字数/最近编辑
      invalidateBookSummary(bookAbs)
      invalidateTreeIndex(bookAbs, true)
      // 内存闸（审计）：章节元数据缓存按书前缀一并清——删书后目录已不在，
      // 每章元数据条目成死重（bookAbs 即各调用方 readChapterDir 键的 join 前缀）
      clearChapterDirCacheForBook(bookAbs)
      // 事件库一并清（双键：book=书名 + book=bookHash(bookRoot)）——
      // 只清内存时事件库残留，同名重建书会在 audit 重放里继承旧书会话/链路事件。
      // L-：删除主流程已完成（登记已移、目录已删），清史收尾若抛（SQLITE_BUSY
      // 等）不该让客户端看到 500「内部错误」且跳过下方 db 文件清理留孤儿——防御性收编
      try {
        // clearChatHistory 转异步（事件库开库异步孪生），防御性收编不变
        await clearChatHistory(name, ctx.userDataPath ?? undefined, bookAbs)
      } catch (e) {
        // 低-6：留痕走项目 logger——console 在打包态 mirrorConsole=false 无人看见
        // 也不进 JSONL（诊断失明）；tag 与本文件 log.error 删除目录失败同源 'api'
        log.warn('api', `删书清史失败（${name}，残留 db 文件将由下方清理兜底）`, e)
      }
      // （低级）：事件库**文件**一并删（<hash>.db + WAL/SHM 伴生）——clearChatHistory
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
      forgetRagBuildTask(name) // 模块级索引任务表随删书清理
      reply(res, 200, { ok: true, name })
    },
  })
}
