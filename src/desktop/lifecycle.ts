/**
 * 主窗退出链与生命周期监听（复审-0914-优化修复批 F1 自 main.ts 拆出——纯移动零逻辑变化）。
 *
 * 跨模块状态：sessionEnding/appTearingDown（isAppTearingDown 供 serverManager 退出
 * 探测接线）；窗口引用经 wins（windows.ts）；切库回滚/relaunch 意图经 workdir-controller。
 */
import { app, dialog, type BrowserWindow } from 'electron'
import { log } from '../log/index.js'
import { raceWithTimeout } from './workdir-store.js'
import { guardClosedCleanup, saveWinState, wins } from './windows.js'
import {
  armPendingRelaunchIfAny,
  discardPendingRelaunch,
  rollbackCancelledSwitch,
} from './workdir-controller.js'

// ── 退出链共享状态（原 main.ts 模块级旗，读写面收敛于本文件）──

/** R44-2（四十四轮）：关窗拦截的全局避让旗。session-end（OS 关机/注销）时间窗有限，
 *  close 拦截只会白拖 OS 收尾（停机兜底由 session-end 处理器负责）；退出链
 *  （before-quit）自行先行 flush 并在收口 destroy 全窗，close 事件再拦截是重复动作。
 *  两旗分别由 session-end / before-quit 链路置位，close 拦截读它们。 */
let sessionEnding = false
let appTearingDown = false
/** R55-A-1（五十五轮）：serverManager 退出探测（main.ts 建 manager 时接线
 *  isProcessExiting）——自愈等待/收口窗口内用户真退出则放弃恢复。 */
export function isAppTearingDown(): boolean {
  return appTearingDown
}
/** R50-A-1（五十轮）：session-end 观察窗自愈——win 上 OS 关机/注销被取消（其他应用
 *  拒绝关机、用户反悔等）时进程存活但 sessionEnding 永真 + server 已 shutdown：close
 *  拦截从此直关放行（渲染层 flush 链失效，编辑增量丢失面）、API 全断且无重启链路。
 *  session-end 置旗后起观察窗，定时器居然触发 = OS 收尾没带走进程 → 复位
 *  sessionEnding + 经 manager 钉住原端口拉回 server（渲染层 origin 不动，无缝续用）。
 *  真关机路径进程活不到窗口到点（Windows 会话收尾宽限秒级），unref 不拖收尾；
 *  时长可经 CLW_SESSION_END_RECOVERY_MS 注入（回归测试快进用）。 */
let sessionEndRecoveryTimer: ReturnType<typeof setTimeout> | null = null
const SESSION_END_RECOVERY_MS = Number(process.env['CLW_SESSION_END_RECOVERY_MS']) || 5_000
/** R53-A-1（五十三轮）：session-end 并行 flush 的短预算——关机/注销窗口有限，预算只兜
 *  渲染层挂起（executeJavaScript 永不 resolve），刻意小于 server shutdown 3.5s 总超时，
 *  到点即放弃不拖 OS 收尾。可经 CLW_SESSION_END_FLUSH_BUDGET_MS 注入（回归测试快进用）。 */
const SESSION_END_FLUSH_BUDGET_MS = Number(process.env['CLW_SESSION_END_FLUSH_BUDGET_MS']) || 2_000
/** R49-5（评审四十九轮）：close/quit 两 flush 链的在途旗——原 closeFlushInFlight 居
 *  bootstrap() 闭包、quitFlushInFlight 居生命周期 if 块，两链互不可见：close flush 在途
 *  时 Cmd+Q 会对同窗再起一次 flush（双 executeJavaScript、极端时序双确认框），反向
 *  同理。提为模块级互查互斥（两链入口均拦下对方在途窗，不起第二链）；
 *  quitDuringCloseFlush 记「close flush 在途时到达的退出请求」，由 close 链收尾统一
 *  汇入 app.quit()（不直接放行 quit——在途 flush 会被退出连带打断丢保存）。
 *  复位纪律：随各自链路收尾复位（close 链 destroy/cancel、quit 链 destroy/cancel），
 *  跨 re-bootstrap 不残留。 */
let closeFlushInFlight = false
let quitFlushInFlight = false
let quitDuringCloseFlush = false

// ── 渲染层兜底 flush（原 main.ts :1012-1120 对应节）──

/** R44-2：close/quit 拦截里渲染层 flush 的总预算——本机服务下保存链毫秒级，预算只兜
 *  渲染层挂起/死循环（executeJavaScript 永不 resolve）不拖死关窗与退出。 */
const CLOSE_FLUSH_BUDGET_MS = 4_000

/** R44-2（四十四轮）：关窗/退出前渲染层兜底 flush——主进程拦下 close/quit 后经
 *  executeJavaScript 调渲染层 window.__clwFlushBeforeClose（Book 页注册，页面未进
 *  卸载、异步保存链全通；Chromium ≥M80 在页面卸载路径整体禁同步 XHR，原渲染层
 *  beforeunload 内同步 XHR 兜底经双 Electron 实验实证零字节到达，已随本钩子移除）。
 *  返回 null＝钩子不在或渲染层不可达（非编辑页无 dirty 状态，无兜底可做）。
 *  R58-B-2（五十八轮）：同一表达式内先行冲刷全局偏好（window.__clwFlushPrefs，App.vue
 *  注册，任何窗口可用）——prefs store 的 500ms 防抖窗内最后改动随关窗落盘；预冲刷失败
 *  吞掉不阻断 doc flush 与关窗。保持单次 executeJavaScript（execJs 调用次数与返回形状
 *  不变，main.test 断言锚定）。 */
async function flushRendererBeforeClose(target: BrowserWindow): Promise<{ conflict: string[]; failed: string[] } | null> {
  if (target.isDestroyed()) return null
  try {
    const r = (await target.webContents.executeJavaScript(
      '(async () => { try { await (typeof window.__clwFlushPrefs === "function" ? window.__clwFlushPrefs() : null) } catch {} return typeof window.__clwFlushBeforeClose === "function" ? window.__clwFlushBeforeClose() : Promise.resolve(null) })()',
    )) as unknown
    if (r && typeof r === 'object') {
      const pick = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
      return { conflict: pick((r as { conflict?: unknown }).conflict), failed: pick((r as { failed?: unknown }).failed) }
    }
    return null
  } catch {
    return null
  }
}

/** R54 复审顺手项①（五十四轮修复批复审）：close/quit/session-end 三链共用的「渲染层
 *  flush + 预算」竞速单源——超时以哨兵分流（与 probeDirReachable 的 PROBE_TIMEOUT
 *  同款，替代此前各链「旗 + null 双信号」），并以 FLUSH_BUDGET_TIMEOUT 哨兵回填结果，
 *  供调用方与 null（无钩子）分流、同权放行；race 落定即 clearTimeout（R54-A-5 计时器
 *  卫生收编于此，P3（复审-0914-优化修复批）竞速体收编 raceWithTimeout 单源）。
 *  flushRendererBeforeClose 自吞异常不 reject，catch 仅可能收到哨兵（非哨兵照抛，防御性）。 */
const FLUSH_BUDGET_TIMEOUT = Symbol('flush-budget-timeout')
async function flushRendererWithBudget(
  target: BrowserWindow,
  budgetMs: number,
): Promise<{ conflict: string[]; failed: string[] } | null | typeof FLUSH_BUDGET_TIMEOUT> {
  return raceWithTimeout(flushRendererBeforeClose(target), budgetMs, FLUSH_BUDGET_TIMEOUT)
}

/** R44-2/R44-19（四十四轮）：冲突未决的原生确认——Electron 不渲染浏览器 Leave-site
 *  确认框，渲染层 preventDefault 是无反馈死关窗；冲突项又无法代存（autosave/flush
 *  均跳过 conflict 项）。返回 true＝放弃未保存的本地修改继续关/退。 */
function confirmDiscardConflicts(parent: BrowserWindow, count: number): boolean {
  return (
    dialog.showMessageBoxSync(parent, {
      type: 'warning',
      title: 'CLWriting',
      message: `有 ${count} 个文档存在未解决的保存冲突，未保存的本地修改将丢失。`,
      detail: '冲突需要在应用内选择「重载」或「覆盖」后才能自动保存。',
      buttons: ['放弃修改并继续', '取消'],
      defaultId: 1,
      cancelId: 1,
    }) === 0
  )
}

/** 重评-1（全库代码重评审 2026-09-05）：保存失败的原生确认——flush 钩子返回的
 *  failed（保存失败的 docId 列表，产出面 web-next stores/doc.ts flushBeforeClose）
 *  与 conflict 同属「flush 未落净」：本链路无法代存，零消费＝编辑增量静默丢失
 * （违背「编辑永不静默丢失」红线）。与 confirmDiscardConflicts 同款交互（type 用
 *  error 区分失败/冲突语义），返回 true＝放弃失败的修改继续关/退；取消后作者可
 *  重试保存或排查本地服务状态。 */
function confirmDiscardFailed(parent: BrowserWindow, count: number): boolean {
  return (
    dialog.showMessageBoxSync(parent, {
      type: 'error',
      title: 'CLWriting',
      message: `有 ${count} 个文档保存失败，这些文档里最近的修改尚未落盘。`,
      detail: '可先取消，回到应用内重试保存或检查本地服务状态后再关闭；若继续，这些修改将被丢弃。',
      buttons: ['放弃修改并继续', '取消'],
      defaultId: 1,
      cancelId: 1,
    }) === 0
  )
}

/**
 * F2（复审-0914-优化修复批）：close/quit 两链的 flush→确认→取消复位流程双写单源。
 * 流程（两链原序逐位保留）：
 *   flushRendererWithBudget（预算竞速）→ 超时 warn / 无钩子 info 留痕（文案各链注入）
 *   → skipConfirms 停机复查留痕（仅 close 链传——R1010b-DSK-P2-1）→ conflict 原生
 *   确认 → failed 留痕 + 原生确认 → 取消即 onCancel()（复位各自在途旗/丢弃切库意图/
 *   回写回滚基线——复位时机原样）并返回 'cancel'。
 * 返回 'proceed' = 确认全过（或无可确认），调用方接各自收尾（close 链 destroy 单窗、
 * quit 链 appTearingDown + 全窗 destroy）。
 */
interface FlushConfirmOpts {
  budgetMs: number
  /** 超时态 warn 文案（R54-A-1 两链措辞各一，逐字保留） */
  timeoutLog: string
  /** 无钩子/渲染层不可达态 info 文案（R54-A-1 两链措辞各一，逐字保留） */
  idleLog: string
  /** failed 留痕前缀（「关窗兜底」/「退出前」——原文案逐字拆分点） */
  failedPrefix: string
  /** R1010b-DSK-P2-1（2026-09-10 内存专项重审修复批）：flush 落定后补停机复查——
   *  仅 close 链传入（sessionEnding/appTearingDown 在途时跳过确认框：停机窗口内
   *  无人可答），quit 链无此项。Thunk 形态：竞窗语义是「flush 落定后」再读旗
   *  （close 先到 → flush 在途 → session-end 后置也命中），调用时快照布尔会漏掉
   *  后置置位——评估点固定在 flush 落定后（flushRendererWithBudget await 之后的
   *  唯一读取点），与本抽离前原内联复查时机逐位一致。 */
  skipConfirms?: () => boolean
  /** 确认被取消：复位旗/丢弃切库意图（各链差异点，原内联复位语句原样迁入） */
  onCancel: () => void
}
async function runFlushConfirm(win: BrowserWindow, opts: FlushConfirmOpts): Promise<'proceed' | 'cancel'> {
  // R54-A-1（五十四轮）：超时与「无钩子/渲染层不可达」此前同落 res===null 静默
  // destroy——保存链慢盘/server 退避窗下超时窗内的最后键入静默丢失且零诊断线索；
  // 超时态 warn、无钩子态 info（哨兵归一化回 null 后进下游，conflict/failed 守卫
  // 沿用 null 假值语义）。
  const raced = await flushRendererWithBudget(win, opts.budgetMs)
  const res = raced === FLUSH_BUDGET_TIMEOUT ? null : raced
  if (raced === FLUSH_BUDGET_TIMEOUT) {
    log.warn('desktop', opts.timeoutLog)
  } else if (raced === null) {
    log.info('desktop', opts.idleLog)
  }
  // R1010b-DSK-P2-1：thunk 在此评估（flush 落定后）——原内联停机复查时机逐位一致
  const skipConfirms = opts.skipConfirms?.() === true
  if (skipConfirms && res && (res.conflict.length > 0 || res.failed.length > 0)) {
    // R1010b-DSK-P2-1：命中即 warn 留痕未落净清单（对齐 R53-A-1「只留痕不弹窗」）后
    // 直落收口 destroy。
    log.warn(
      'desktop',
      `关窗兜底 flush 落定但${sessionEnding ? 'OS 停机' : '应用退出收尾'}已在途，跳过冲突/失败确认直接关窗（停机窗口内无人可答）：冲突 ${res.conflict.length} 个、保存失败 ${res.failed.length} 个`,
    )
  }
  if (res && res.conflict.length > 0 && !win.isDestroyed() && !skipConfirms) {
    // R44-19（四十四轮）收口：冲突未决的本地修改无法代存，原生确认给作者最后一念
    if (!confirmDiscardConflicts(win, res.conflict.length)) {
      opts.onCancel()
      return 'cancel'
    }
  }
  if (res && res.failed.length > 0 && !win.isDestroyed() && !skipConfirms) {
    // 重评-1（全库代码重评审 2026-09-05）：保存失败（failed = 保存失败的 docId 列表）
    // 与冲突同属「flush 未落净」——原实现 failed 零消费，关窗/退出时编辑增量静默丢失。
    // 先留痕失败清单（只是文档 id，供诊断），再弹原生确认给作者最后一念。
    log.error('desktop', `${opts.failedPrefix} flush 有 ${res.failed.length} 个文档保存失败（${res.failed.join(', ')}），需作者确认是否放弃未落盘修改`)
    if (!confirmDiscardFailed(win, res.failed.length)) {
      opts.onCancel()
      return 'cancel'
    }
  }
  return 'proceed'
}

// ── 依赖注入面（main.ts 装配时传入——显式参数，对齐纯函数抽离纪律）──

/** lifecycle 所需的最小 server 管理面（ReturnType 推断，避免放大 server-manager 导出面）。 */
type ServerManagerLike = ReturnType<typeof import('./server-manager.js').createStudioServerManager>

interface MainWindowLifecycleDeps {
  serverManager: ServerManagerLike
  /** R50-A-1：session-end 观察窗自愈的「有服务可拉回」判据——bootstrap 本轮是否 fork
   *  了 studio server（dev HMR 态只复位旗、不拉服务，API 由独立 dev:api 进程供给） */
  isServerStarted: () => boolean
}

/** before-quit 链所需的停机门最小面（bootstrap-runner 结构子集）。 */
interface ShutdownGateLike {
  beginShutdown(): boolean
  readonly shuttingDown: boolean
}

/**
 * 主窗生命周期监听装配（原 main.ts bootstrap 内建窗后的连续挂载段，原序保留）：
 * close 拦截链 → session-end 链 → focus 关书库窗 → closed 退出链 → 全屏反向同步。
 */
export function attachMainWindowLifecycle(win: BrowserWindow, deps: MainWindowLifecycleDeps): void {
  const { serverManager } = deps
  // R44-2（四十四轮）：关窗兜底——首轮 close 先 preventDefault，经渲染层钩子异步
  // flush（页面未死，异步保存链全通）落定/短超时后 destroy() 真正关窗（destroy 不再
  // 触发 beforeunload，链路单次不循环）。退出链（before-quit）已先行 flush 并在收口
  // destroy 全窗，session-end 时间窗有限，两者都直接放行。
  // R49-5（评审四十九轮）：在途旗（closeFlushInFlight/quitFlushInFlight）与 quit 汇入
  // 旗（quitDuringCloseFlush）为模块级——原 closeFlushInFlight 居本闭包、quit 链旗居
  // 生命周期 if 块，两链互不可见才撞出双 flush；复位闸从「cancel 路径手工复位」改为
  // 链路收尾统一复位（destroy 后 close 不再触发，复位无副作用），并兼作 quit 汇入点。
  win.on('close', (e) => {
    saveWinState()
    // R44-2（四十四轮）：OS 收尾（session-end）/退出收尾（appTearingDown，退出链自行
    // flush+destroy 全窗）期直关放行——时间窗有限，不在窗口里白等渲染层 flush
    //（session-end 链的 flush 已由 R53-A-1 改为处理器内并行尽力而为，此处保持直关）
    if (sessionEnding || appTearingDown) return
    // R49-5（评审四十九轮）：close/quit 任一 flush 链在途——只拦不再起第二链（同窗
    // 双 executeJavaScript、极端时序双确认框），在途链自会收口（close 链 destroy 收尾
    // / quit 链统一 destroy 全窗）；拦下而非放行，防在途 flush 写到一半窗口被原生
    // close 走 beforeunload 关死（保存链半途丢失）。
    if (closeFlushInFlight || quitFlushInFlight) {
      e.preventDefault()
      return
    }
    e.preventDefault()
    closeFlushInFlight = true
    void (async () => {
      const target = wins.mainWindow
      if (!target || target.isDestroyed()) {
        // R49-5：退化形态（窗口先于本链销毁）也复位，防在途旗卡死后续 quit 汇入
        closeFlushInFlight = false
        return
      }
      const outcome = await runFlushConfirm(target, {
        budgetMs: CLOSE_FLUSH_BUDGET_MS,
        // R54-A-1：超时态补 warn（「关窗兜底 flush 超时…」原文案逐字保留）
        timeoutLog: `关窗兜底 flush 超时（≥${CLOSE_FLUSH_BUDGET_MS}ms）未落定即关窗——超时窗内未保存的键入可能丢失`,
        idleLog: '关窗兜底 flush 无钩子/渲染层不可达（非编辑页常态），直接关窗',
        failedPrefix: '关窗兜底',
        // R1010b-DSK-P2-1：flush 落定后补停机复查（session-end/before-quit 在途不弹确认）
        // thunk：旗在 flush 在途期后置也命中（评估点在 runFlushConfirm 内 flush 落定后）
        skipConfirms: () => sessionEnding || appTearingDown,
        // R49-5：作者放弃关窗 → 待汇入的退出请求一并作废（与 quit 链自身 cancel
        // 「取消即中止退出、应用原样保留」语义一致）
        onCancel: () => {
          closeFlushInFlight = false
          quitDuringCloseFlush = false
        },
      })
      if (outcome === 'cancel') return
      try {
        if (!target.isDestroyed()) target.destroy()
      } catch (err) {
        // 收尾期 destroy 可抛（平台/生命周期边角）：吞掉防 async 链成未处理拒绝，
        // 窗口交由 Electron 退出流程兜底收口
        log.error('desktop', '关窗兜底 flush 后 destroy 异常（交退出流程兜底）', err)
      }
      // R49-5：复位闸移到链路收尾（destroy 后 close 不再触发，复位无副作用）；
      // close flush 在途时到达的退出请求由此统一汇入 app.quit()——多窗态下
      // window-all-closed 不触发，只能这里补发；单窗态与 window-all-closed 双发
      // 在 before-quit 幂等收敛（quitFlushInFlight/quitViaShutdown 门）。
      closeFlushInFlight = false
      if (quitDuringCloseFlush) {
        quitDuringCloseFlush = false
        app.quit()
      }
    })()
  })
  // R1W-9（win 平台专项复审 R1）：win 会话收尾兜底——OS 关机/重启/注销对主窗发
  // session-end（不可阻止，时间窗有限），此前整条优雅停机链被跳过、utility child
  // 随进程硬死（在途 session/end 落库全失，靠 10min 孤儿会话宽限兜底）。尽力下发
  // 停机指令（shutdown 内部有 3.5s 总超时，不会拖住 OS 收尾）。
  win.on('session-end', () => {
    // R44-2（四十四轮）：OS 关机/注销窗口有限——置旗让上方 close 拦截放行直关，
    // 不在有限窗口里白等渲染层 flush（本条链路的停机兜底以 server 停机指令为准）
    sessionEnding = true
    // R53-A-1（五十三轮）：close/quit 两链在关窗/退出前都有渲染层 flush，唯 session-end
    // 链「能 flush 而不 flush」——win 关机/注销是高频日常动作，自动保存节拍内（默认
    // 30s）的最后键入在此链原样静默丢失（「编辑永不静默丢失」红线）。渲染层此刻未死：
    // 与停机指令并行尽力下发一次 flush（≤SESSION_END_FLUSH_BUDGET_MS，小于 shutdown
    // 3.5s 总超时）——落净即赚到；超时/不可达即放弃，不等待不重试（R44-2「不在有限
    // 窗口里白等」的直关语义保持，本 flush 是并行尽力而为，不是等待）。conflict 项
    // 本就无法代存、failed 停机窗口内无人在场可答，两者只留痕不弹窗（原生确认框会
    // 反把进程钉死在收尾期）。
    void (async () => {
      const target = wins.mainWindow
      if (!target || target.isDestroyed()) return
      // R54 复审顺手项①：race 收敛 flushRendererWithBudget 单源（超时哨兵/落定清理，
      // R54-A-5 卫生随函数收编）；未落定（无钩子/超时）恒 info，尽力而为不拖停机。
      const res = await flushRendererWithBudget(target, SESSION_END_FLUSH_BUDGET_MS)
      if (res === null || res === FLUSH_BUDGET_TIMEOUT) {
        log.info('desktop', 'session-end 渲染层 flush 未落定（钩子缺失/超时，尽力而为不拖停机）')
        return
      }
      if (res.conflict.length > 0 || res.failed.length > 0) {
        log.error(
          'desktop',
          `session-end 渲染层 flush 落定但未落净：冲突 ${res.conflict.length} 个、保存失败 ${res.failed.length} 个（停机窗口内无人可确认，仅留痕）`,
        )
        return
      }
      log.info('desktop', 'session-end 渲染层 flush 落净')
    })()
    // R40-29（四十轮）：停机前补存窗口状态——OS 关机/注销走 session-end，主窗
    // close 事件不保证收到（此前窗口位置/尺寸不落盘，下次开窗回默认位）。存状态是
    // 一次内存读 + 原子写，毫秒级不挤占停机窗口；saveWinState 内部已吞错，外层
    // try/catch 双保险（收尾期 Electron getter 可抛），失败不阻断停机。
    try {
      saveWinState()
    } catch {
      /* 存状态失败不阻断停机（窗口状态非关键数据，宁可丢状态也要下发停机指令） */
    }
    void serverManager.shutdown().catch((err) => log.error('desktop', 'session-end 停机失败（OS 即将收尾）', err))
    // R50-A-1（五十轮）：观察窗（语义见旗声明处注释）——OS 真收尾时进程活不到到点
    // （timer 无从触发）；到点仍存活即关机被取消/被拒，复位直关旗并拉回 server。
    // 重复 session-end 重臂不叠窗；unref 不拖真收尾。
    if (sessionEndRecoveryTimer) clearTimeout(sessionEndRecoveryTimer)
    sessionEndRecoveryTimer = setTimeout(() => {
      sessionEndRecoveryTimer = null
      if (appTearingDown) return // 真退出链已接管（closed → app.quit → before-quit）
      sessionEnding = false
      log.info('desktop', 'session-end 观察窗到点进程仍存活——判定 OS 关机未收尾（被取消/被拒），复位 close 直关旗')
      if (!deps.isServerStarted()) return // dev HMR 态无 server（API 由独立 dev:api 进程供给）
      if (!wins.mainWindow || wins.mainWindow.isDestroyed()) return // 窗已不在：退出链接管，不白 fork
      void serverManager.restartPinned().then((recoveredPort) => {
        if (recoveredPort === null) {
          log.error('desktop', 'session-end 自愈：studio server 恢复失败（编辑仍在渲染层，API 不可用——建议重启应用）')
        }
      })
    }, SESSION_END_RECOVERY_MS)
    sessionEndRecoveryTimer.unref()
  })
  // 书库管理窗口「用完即走」：主窗口获焦 = 用户已切回，关闭书库窗口释放资源
  // （与书架窗口 desktop:open-book 主动 close 行为对齐）
  win.on('focus', () => {
    if (wins.libraryWindow && !wins.libraryWindow.isDestroyed()) {
      wins.libraryWindow.close()
    }
  })
  win.on('closed', () => {
    // R0910-W：异常隔离——本监听承载退出链（app.quit），不得被任何前置 closed 监听
    // 抛错短路；此处自身异常也只留痕（交 uncaughtException 兜底），不静默取消退出。
    guardClosedCleanup('主窗口退出链', () => {
      wins.mainWindow = null
      // 主窗口是应用核心：关闭即退出（连带销毁书架/书库子窗口，杜绝孤儿窗口 / 僵尸进程）
      app.quit()
    })
  })
  // 专注模式全屏反向同步：作者经系统手势（⌘⌃F/绿按钮）退出全屏时通知渲染层
  //（渲染层据此连带退出专注模式）。只回发事实，不在主进程持有专注语义。
  // 与 render-process-gone 同款：捕获局部 win，闭包不追迟来的 mainWindow 置空。
  const fsWin = win
  win.on('enter-full-screen', () => {
    if (!fsWin.isDestroyed()) fsWin.webContents.send('desktop:fullscreen-change', true)
  })
  win.on('leave-full-screen', () => {
    if (!fsWin.isDestroyed()) fsWin.webContents.send('desktop:fullscreen-change', false)
  })
}

/**
 * before-quit 优雅退出链装配（原 main.ts 生命周期 if 块内注册段，行为零变化）。
 * RB-SV-P2-6：优雅退出。O-4：shutdownStarted 归 runner.beginShutdown（幂等，二次
 * quit 直通）。批 U2：before-quit 走 shutdown 指令——child 内 shutdownStudio（在途
 * 编排 abort/session/end 落库）落定后 shutdown-done 回执退出；3.5s 总超时（E-1，
 * 见 server-manager SHUTDOWN_TOTAL_TIMEOUT_MS）强杀兜底在 manager 内。
 */
export function registerQuitChain(gate: ShutdownGateLike, serverManager: ServerManagerLike): void {
  // R65-48（总六十五轮）：优雅停机在途期间的再次 quit 请求一律 preventDefault——原
  // beginShutdown() 二次返回 false 即放行直通，3.5s 优雅窗口内第二次退出事件直接
  // 强杀 child（在途 chat/self-heal 的 session/end 落库被打断）；首次流程的 finally
  // 会统一 app.quit() 收口。beginShutdown 不复位（runner 生命周期语义），为防拦掉
  // 自己的 quit 成死循环，用本地 quitViaShutdown 区分「finally 里我们自己发起的
  // quit」放行直通。
  // R44-2（四十四轮）：退出链先行渲染层 flush——原顺序 shutdown 先杀 server 再隐式
  // 关窗，渲染层任何保存（含 close 拦截兜底）都打向已死端口必失败，最后一个
  // autosave 间隔内的键入随退出静默丢失。改为 flush（≤CLOSE_FLUSH_BUDGET_MS）→
  // 冲突未决可原生确认取消退出（不 beginShutdown，窗口/server 原样保留）→
  // beginShutdown → shutdown → 收口 destroy 全窗（app.quit() 的隐式关窗会走渲染层
  // beforeunload，preventDefault 类守卫在无监听方时拦死退出链）→ quitViaShutdown
  // 放行 quit。
  // R49-5：quitViaShutdown 是 quit 链私有收口旗（区分「finally 里我们自己发起的
  // quit」放行直通，R65-48），不与 close 链共享；两链共享的在途旗见模块级 R49-5 声明处。
  let quitViaShutdown = false
  app.on('before-quit', (e) => {
    if (quitViaShutdown) {
      // R51-A-1：收口放行前兑现迟到的切库意图（意图在不可回头点之后才置位的边角——
      // 停机在途窗口内的 switch-library → relaunch → 二次 quit 被拦只记旗），
      // 正常退出（无意图）零副作用
      armPendingRelaunchIfAny()
      return // 收口 quit 放行直通
    }
    // R1010-P3（G7-⑦）：session-end 在途的级联 quit 直通——OS 关机/注销收尾期
    // （sessionEnding 已置旗、server 已下发停机、渲染层将死）主窗 closed →
    // app.quit() 会二次进本链：flush 打向已死 server 必落空，conflict/failed 的
    // 原生同步确认无人可答（把进程钉死在 OS 收尾窗口内）。session-end 链已完成
    // 尽力而为三件（并行 flush / 存窗口状态 / 停机指令），此处不再起交互链、不
    // preventDefault，放行原生退出（close 拦截已按 sessionEnding 直关放行）。
    if (sessionEnding) {
      log.info('desktop', 'session-end 在途的级联 quit：放行直通（不再起交互链）')
      return
    }
    e.preventDefault()
    // R49-5（评审四十九轮）：close 链 flush 在途——只拦不另起第二链（同窗双
    // executeJavaScript、极端时序双确认框），置位待 close 链收尾统一汇入 app.quit()
    // （close 链 destroy 后补发；单窗态 window-all-closed 同样触发，幂等收敛）。
    // 不直接放行 quit：在途 flush 会被退出连带打断（保存写一半），丢 flush。
    if (closeFlushInFlight) {
      quitDuringCloseFlush = true
      return
    }
    // flush 在途（本轮已拦）或停机在途（等 finally 统一收口）都只拦不动作
    if (quitFlushInFlight || gate.shuttingDown) return
    quitFlushInFlight = true
    void (async () => {
      // 重评2-P2-3（2026-09-09 全量重评 GLM-5.3）修复：quit 链补存窗口状态——根因：
      // 本链收口 destroy() 全窗（下方 finally）不触发 'close' 事件（Electron 语义），
      // close 拦截首行的 saveWinState 在本链不达；而 Cmd+Q / win 菜单退出 / 崩溃风暴
      // 对话框退出 / 切库 relaunch（relaunch() → app.quit）全汇入本链——退出前的窗口
      // 几何变更随退出静默丢失（session-end 链已有 R40-29 同款补存）。补点在链首：
      // 窗口仍存活、任何 flush/确认/destroy 之前；saveWinState 内部已吞错、幂等
      // （close/session-end 链已存时重写同值），冲突/失败确认取消退出路径多存一次
      // 当前几何亦无副作用。quitViaShutdown 早退分支不另补——该旗只在下方 IIFE 内
      // 置位（补点之后），二次进 quit 链时状态已存过、窗口已销毁。
      saveWinState()
      try {
        const win = wins.mainWindow
        if (win && !win.isDestroyed()) {
          const outcome = await runFlushConfirm(win, {
            budgetMs: CLOSE_FLUSH_BUDGET_MS,
            // R54-A-1：与 close 链同款留痕（超时态 warn/无钩子态 info，「退出前」措辞
            // 原文逐字保留）
            timeoutLog: `退出前 flush 超时（≥${CLOSE_FLUSH_BUDGET_MS}ms）未落定即退出——超时窗内未保存的键入可能丢失`,
            idleLog: '退出前 flush 无钩子/渲染层不可达（非编辑页常态），继续退出',
            failedPrefix: '退出前',
            // R51-A-1：取消 = 丢弃切库意图（退出语义不被劫持成重启）
            // R59 清偿批（R55-A-3）：取消 = 回写旧库（跨会话不残留被取消的新库）
            onCancel: () => {
              quitFlushInFlight = false
              discardPendingRelaunch()
              rollbackCancelledSwitch()
            },
          })
          if (outcome === 'cancel') return
        }
      } catch (err) {
        log.error('desktop', '退出前渲染层 flush 异常（继续退出）', err)
      }
      appTearingDown = true
      // R51-A-1：不可回头点——flush 冲突/失败确认全过、停机将启，此刻兑现切库意图
      //（武装重启 + 交接释放锁）；取消路径到不了这里，意图已在上方丢弃
      armPendingRelaunchIfAny()
      if (!gate.beginShutdown()) {
        quitFlushInFlight = false
        return // 已在优雅停机在途：本 async 流退出，等在途流程的 finally 统一收口
      }
      // R65-40（总六十五轮）：shutdown() 可能 reject（child 已死时 postMessage/kill
      // 抛错等）——原 `void …finally` 无 catch：rejection 成 unhandledRejection（丢
      // 现场）；quit 收口也悬空。包 try/catch + .catch 记日志，finally 仍 quit——
      // 退出收口不因停机失败而挂死。
      try {
        void serverManager
          .shutdown()
          .catch((err) => log.error('desktop', '优雅停机 shutdown 失败（继续退出）', err))
          .finally(() => {
            // R44-2：destroy 直关全部窗口——绕过渲染层 beforeunload（防守卫类
            // preventDefault 拦死隐式关窗）；收尾期 destroy 可抛，逐窗隔离不阻断退出
            for (const w of [wins.mainWindow, wins.shelfWindow, wins.libraryWindow]) {
              try {
                if (w && !w.isDestroyed()) w.destroy()
              } catch {
                /* 单窗销毁失败不阻断其余窗口与退出收口 */
              }
            }
            quitViaShutdown = true
            app.quit()
          })
      } catch (err) {
        // 防御：shutdown 同步抛（当前为 async fn 不可达，防将来重构回归同型挂死）
        log.error('desktop', '优雅停机 shutdown 同步抛错（继续退出）', err)
        armPendingRelaunchIfAny() // R51-A-1：兜底收口同样过不可回头点，切库意图不失
        for (const w of [wins.mainWindow, wins.shelfWindow, wins.libraryWindow]) {
          try {
            if (w && !w.isDestroyed()) w.destroy()
          } catch {
            /* 同上：单窗销毁失败不阻断退出收口 */
          }
        }
        quitViaShutdown = true
        app.quit()
      }
    })()
  })
}
