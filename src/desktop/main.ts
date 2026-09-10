/**
 * Electron 主进程入口（桌面化 #electron；阶段 22 批 U1 起 studio server 拆分至 utilityProcess）。
 *
 * fork server-utility 子进程承载 studio server（127.0.0.1 随机端口，ready 握手回传）
 * → BrowserWindow loadURL。前端 Vue 零改造（fetch /api/...）；driver 会话、SSE 由
 * server-utility 统一承载（main 壳层不直接碰 driver）。main 瘦身为纯壳层：窗口/菜单/IPC/
 * workDir 管理 + serverManager（fork/握手/停启）+ bootstrapRunner（生命周期收口）。
 *
 * 工作目录（书库）管理（批2 起）：
 * - 启动定位：userData 持久化的 current（合法则用）> findWorkDir(cwd) > 弹原生选择器。
 * - 切换书库 = 改持久化 current → app.relaunch() 进程重启
 *   （规避 server 路由模块级单例 + SSE 长连接泄漏，见 Dev/Plans/desktop-workdir-方案.md §2.1/§3.1）。
 *
 * 开发：npm run dev:electron（build:web + tsup + electron .；未打包非 HMR 同走拆分形态，U-4）
 * 打包：electron-builder（dist/web + dist/desktop/{main,server-utility,preload} 进 asar）
 */
import {
  app,
  BrowserWindow,
  session,
  screen,
  ipcMain,
  dialog,
  Menu,
  shell,
  nativeTheme,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  type MessageBoxOptions,
  type BrowserWindowConstructorOptions,
  type IpcMainInvokeEvent,
  type IpcMainEvent,
  type WebContents,
} from 'electron'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises' // R54-A-2：切库可达性预探（异步+超时，不冻主进程）
import { findWorkDir, readBooks } from '../install/books.js'
import { findGitAncestor } from '../install/scaffold.js' // R44-14：git-ancestor 防线与 init（doInitSteps）同源判定
import { atomicWriteFile } from '../fs/atomic.js'
import { resolveWithinRoot } from '../fs/safe-path.js'
import { probeCaseSensitive } from '../fs/case-probe.js' // 平台规范化批 E：大小写敏感卷探测
import { defaultUserDataPath, samePath } from '../fs/user-data-path.js'
import { initialBookArg, initialBookArgvOnly, resolveInitialBook } from './initial-book.js' // RB-SV-P2-4：--book 直进
import { parseContextMenuSpecs, type ContextMenuSpec } from './context-menu.js' // RB-SV-P2-5：IPC 载荷净化
import { createStudioServerManager, ServerBootError } from './server-manager.js' // 阶段 22：server 拆分 utilityProcess
import { createBootstrapRunner } from './bootstrap-runner.js' // O-4：生命周期 runner 可测
import { isBoundsVisibleOnAnyDisplay } from './window-state.js' // R26-86：多屏 bounds 校验纯函数
import { getFonts as getSystemFontList } from 'font-list'
import { createSystemFontCache, fontListWithTimeout } from './font-cache.js' // R77-1（二十五轮批 A）：系统字体 IPC 缓存；R40-28：font-list 超时包裹
import { listWindowsFonts } from './win-fonts.js' // MP2-1（专项重评二轮）：win 自绘枚举（windowsHide，不经 cmd）
import {
  parseStore,
  setCurrent,
  filterValidRecentBudgeted,
  serializeStore,
  emptyStore,
} from './workdir-store.js'
import type { WorkDirStore } from './workdir-store.js'
import { initLogging, log } from '../log/index.js'

const here = dirname(fileURLToPath(import.meta.url)) // dist/desktop/

// win 渲染锐度（F 线 2026-09-05）：GPU 光栅化的合成层（滚动内容/textarea）上 Chromium
// 强制灰度 AA——base.css F0 的 subpixel-antialiased 在 CSS 计算值上正确继承（getComputedStyle
// 已验），但只要走 GPU tile 光栅就被压成灰度，这是「编辑区比浏览器样张糊」的根因。
// 关 GPU 光栅让文本回 CPU 光栅路径，ClearType 子像素恢复（真机放大对比实证：笔画
// 彩边回来、正文明显变实）。win 门：mac 无 ClearType，文本本就灰度渲染，关了只有
// 性能代价无收益（本文件平台分支惯例：titleBarStyle/autoHideMenuBar/字体枚举等同门）；
// 文本为主的写作界面 CPU 光栅代价可忽略，滚动性能留作者真机复核，异常再评估按需白名单。
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-gpu-rasterization')
}

/** 生产模式 CSP：限定所有资源走本地 origin，防渲染层注入外部脚本/样式 */
const CLW_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // CodeMirror / Vue 动态样式注入
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'", // 只连本地 server（SSE + fetch）
].join('; ')

/** X-26（第五十六轮）：渲染进程崩溃自动重载上限（对齐 server child 退避协议的轻量版：
 *  封顶次数与 serverManager 的 RESTART_MAX_ATTEMPTS=3 同值）——崩溃风暴下无限 reload
 *  只会打转（每次 reload 即一新渲染进程起又崩），封顶后停 reload 改载下方静态提示页。 */
const RENDERER_CRASH_MAX_RELOADS = 3
/**
 * S6（五十九轮）：渲染层稳定窗口——did-finish-load 后存活过此窗口即清零崩溃计数
 * （对齐 server-manager STABILITY_RESET_MS / U-2 S-9 先例）。原计数只随窗口重建
 * 归零，长跑偶发 3 次崩溃后第 4 次误触发停摆页。
 */
const RENDERER_CRASH_STABILITY_RESET_MS = 5 * 60_000
/**
 * R51-A-2（五十一轮）：主框架加载失败自愈预算与退避——渲染崩溃自愈的 reload 可能落在
 * server 退避重启窗口（停机 3.5s 优雅窗/启动握手窗）：load 失败后 did-fail-load 无人
 * 处理 → 白屏滞留，server 恢复后无人拉起（打包态无人工出口）。预算独立于渲染崩溃
 * 计数（故障域不同：加载失败≠渲染崩溃），2s 起倍增、15s 封顶共 5 次，总覆盖窗 ≥44s，
 * 足以跨过 server 退避重启全窗；成功载入活满稳定窗后与崩溃计数一并复位。
 */
const RENDERER_LOADFAIL_MAX_RETRIES = 5
const RENDERER_LOADFAIL_BACKOFF_BASE_MS = 2_000
const RENDERER_LOADFAIL_BACKOFF_CAP_MS = 15_000
/** 崩溃封顶后的白屏提示页（data URL 自包含——渲染层/本地 server 均不可信时仍可展示） */
const RENDERER_CRASH_NOTICE_HTML =
  '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;line-height:1.8;color:#333">' +
  '<h2>页面连续崩溃，自动恢复已停止</h2>' +
  '<p>渲染进程短时间内多次异常退出，已停止自动重载。</p>' +
  '<p>请重启 CLWriting；未保存的内容在重启后仍可从自动保存找回。</p></body>'

/**
 * R67-16（十五轮）：渲染崩溃自愈收敛进窗口工厂——此前只挂主窗（dd-P3/C-P3-15 +
 * X-26 退避 + S6 稳定窗口复位），书架/书库子窗口 GPU/内存崩溃停在白屏无自愈。
 * 逻辑原样提取（计数随窗口闭包走、新窗口归零）；label 进日志区分窗口。
 */
function attachRendererCrashSelfHeal(win: BrowserWindow, label: string): void {
  let crashes = 0
  // R51-A-2：主框架加载失败计数与重试计时器句柄（随窗口闭包走，新窗口归零）
  let loadFails = 0
  let failLoadTimer: NodeJS.Timeout | null = null
  // R27-91（二十七轮）：稳定窗口复位计时器的句柄——崩溃要撤销在途复位（互撤），重载要
  // 撤旧排新（不叠）。原实现计时器排定后裸跑：周期短于稳定窗的崩溃循环每次都被上一轮
  // 计时器清零，crashes 永远到不了封顶值（server-manager 同型的 active?.proc===proc
  // 身份校验防的是跨 child 误清零；此处缺的是「窗口内没活满就不得清零」的互撤语义）。
  let stabilityTimer: NodeJS.Timeout | null = null
  win.webContents.on('render-process-gone', (_e, details) => {
    crashes++
    // 崩溃即证明未活满稳定窗——在途复位撤销，计数得以跨轮累计到封顶
    if (stabilityTimer) {
      clearTimeout(stabilityTimer)
      stabilityTimer = null
    }
    // R73-53（二十一轮）：渲染进程异常退出的结构化标记——desktop.yml 启动冒烟 grep
    // 此判定用（一行 ASCII、无中文措辞依赖）。直写 console：打包态 log.* 只落 JSONL
    // 不镜像 stdout，冒烟步重定向的是进程标准流
    console.log(`[CLW_SMOKE] renderer-crash reason=${details.reason} reload=${crashes <= RENDERER_CRASH_MAX_RELOADS}`)
    if (crashes > RENDERER_CRASH_MAX_RELOADS) {
      log.error('desktop', `渲染进程连续崩溃 ${RENDERER_CRASH_MAX_RELOADS} 次自愈后仍异常（${label}，${details.reason}），停止自动重载——载提示页等待人工处理`)
      if (!win.isDestroyed()) {
        // R74-16 连带（批 D 代理范围外上报、主评审收口）：崩溃提示页 loadURL 同为
        // 无人 catch 的 promise（data: URL 失败概率极低但同类）——接日志防丢诊断
        void win.webContents
          .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(RENDERER_CRASH_NOTICE_HTML)}`)
          .catch((e) => {
            log.error('desktop', `崩溃提示页加载失败（${label}）`, e)
          })
      }
      return
    }
    log.error('desktop', `渲染进程崩溃（${label}，${details.reason}，exit=${details.exitCode}），重载窗口自愈（第 ${crashes}/${RENDERER_CRASH_MAX_RELOADS} 次）`)
    if (!win.isDestroyed()) win.webContents.reload()
  })
  // S6（五十九轮）：did-finish-load 后延迟复位崩溃计数——渲染层真正稳定（存活满
  // 稳定窗口且期间无崩溃，R27-91 互撤）才清零，长跑零星崩溃不累计到 3；unref 不拖退出。
  // R51-A-2：加载失败计数同款复位（成功载入 + 稳定窗活满 = 故障域清零）。
  win.webContents.on('did-finish-load', () => {
    if (stabilityTimer) clearTimeout(stabilityTimer) // 上一轮计时器未跑就又重载：撤旧排新不叠
    stabilityTimer = setTimeout(() => {
      stabilityTimer = null
      if (!win.isDestroyed()) {
        crashes = 0
        loadFails = 0
      }
    }, RENDERER_CRASH_STABILITY_RESET_MS)
    stabilityTimer.unref?.()
  })
  // R51-A-2（五十一轮）：主框架加载失败重试——自愈 reload 落在 server 退避重启窗时
  // 加载失败 → did-fail-load 原无人处理 → 白屏滞留（打包态无人工出口）。-3
  // （ERR_ABORTED）是新加载顶替旧加载的常态事件、子框架失败随主框架重载自然收敛，
  // 均不重试；连败撤旧排新只留最新一个重试（预算计数仍累计到封顶）。
  win.webContents.on('did-fail-load', (_e, errorCode: number, _desc: string, _url: string, isMainFrame: boolean) => {
    if (!isMainFrame || errorCode === -3) return
    if (failLoadTimer) {
      clearTimeout(failLoadTimer)
      failLoadTimer = null
    }
    loadFails++
    if (loadFails > RENDERER_LOADFAIL_MAX_RETRIES) {
      log.error('desktop', `主框架加载连续失败 ${RENDERER_LOADFAIL_MAX_RETRIES} 次重试后仍失败（${label}，code=${errorCode}），停止自动重试——等待人工处理`)
      return
    }
    const delay = Math.min(RENDERER_LOADFAIL_BACKOFF_BASE_MS * 2 ** (loadFails - 1), RENDERER_LOADFAIL_BACKOFF_CAP_MS)
    log.error('desktop', `主框架加载失败（${label}，code=${errorCode}），${delay}ms 后重载重试（第 ${loadFails}/${RENDERER_LOADFAIL_MAX_RETRIES} 次）`)
    failLoadTimer = setTimeout(() => {
      failLoadTimer = null
      if (!win.isDestroyed()) win.webContents.reload()
    }, delay)
    failLoadTimer.unref?.()
  })
  // R46-19（四十六轮）：窗口 closed 即撤 stabilityTimer——计时器闭包持有 win 引用，
  // 窗口销毁后至多 5 分钟才随计时器到期释放（回调的 isDestroyed 守卫只防崩不防滞留）。
  // R51-A-2：加载失败重试计时器同款收口。
  win.on('closed', () => {
    // R0910-W：清理体异常隔离——任一 closed 监听抛错会取消同事件后续监听（含主窗
    // app.quit 退出链），本处只做计时器撤销，异常不得外溢。
    guardClosedCleanup(`${label} 自愈计时器`, () => {
      if (stabilityTimer) {
        clearTimeout(stabilityTimer)
        stabilityTimer = null
      }
      if (failLoadTimer) {
        clearTimeout(failLoadTimer)
        failLoadTimer = null
      }
    })
  })
}

// userData 强制统一到定值（大写 CLWriting）。
// Electron 默认目录名跟随 app.name——dev（package.json name=clwriting）与打包
// （electron-builder productName=CLWriting）大小写不一致，macOS/Windows 大小写不敏感
// 侥幸同目录，Linux 上会分裂成两个目录导致配置不互通。见 src/fs/user-data-path.ts。
// 必须在 app.getPath('userData') 首次调用（如下方 stateFile）之前执行。
app.setPath('userData', defaultUserDataPath())
// A4（批 0）：结构化日志——打包态 console 无人看见，尽早切到 JSONL 落盘
// （userData/logs/app-YYYYMMDD.jsonl）；dev 态保留 console 镜像。后续 startServer
// 会再 init 一次（幂等，参数一致）。
initLogging({ logsDir: join(app.getPath('userData'), 'logs'), mirrorConsole: !app.isPackaged })

// Z-P2-8 单实例锁：双开实例会对同一 userData 的 workdir.json / window-state.json
// 读改写互踩（atomic 写只防文件撕裂，防不了语义层竞态）。锁须在 setPath 之后请求，
// 保证 dev/打包两种形态落在同一 userData 上（否则锁会各自为政形同虚设）。
// 第二实例拿不到锁 → app.quit() 并跳过文件底部全部生命周期注册（不进 whenReady、
// 不起 server、不开窗）；持锁实例收到 second-instance 时聚焦已有主窗口。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv: string[]) => {
    // RB-SV-P2-4：第二实例带 --book → 主窗口直达该书（与 desktop:open-book 同通路）
    // R27-97（二十七轮）：只认本次 argv——原 initialBookArg 回落 env 读到的是首实例
    // 的 CLWRITING_INITIAL_BOOK，普通二次拉起（无参双开）被误导航到首实例初书
    const workDir = currentWorkDir() // M-3（第八轮）：bootstrap 实际值优先
    const ref = initialBookArgvOnly(argv)
    if (workDir && ref && mainWindow && !mainWindow.isDestroyed()) {
      // 重评-P3-11（2026-09-09 全量代码重评）：resolveInitialBook→readBooks 同步扫书库，
      // 书库在失联网络卷时冻主进程数秒（R54-A-2/重审-2 同族防线补齐此入口）——预探
      // 先行，'unreachable' log 留痕 + 忽略 book 引用（同族「无物可开」收口口径，
      // 不弹框打断前台应用）；聚焦不受预探影响，保持尾部同步执行。
      void (async () => {
        if ((await probeDirReachable(workDir)) === 'unreachable') {
          log.warn('main', `second-instance 带 --book=${ref}，但书库目录暂不可达（可能是网络卷无响应或已断开）——已忽略直达`)
          return
        }
        const name = resolveInitialBook(workDir, ref)
        if (!name) {
          log.info('main', `second-instance 带 --book=${ref}，但书库内无此登记书——已忽略直达`) // P3：忽略留痕
          return
        }
        // 预探 await 期间窗口可能已关：导航前重验存活（同 open-book 的 isDestroyed 守卫）
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('desktop:navigate', `/book/${encodeURIComponent(name)}`)
        }
      })()
    } else if (ref) {
      // P3（打包修复批）：启动早期（bootstrappedWorkDir 未就绪/无持久化 current）或
      // 主窗不可用时原路径静默吞掉 --book——留痕含被忽略的值，双开排查不再靠猜
      const why = !workDir ? '书库未就绪（bootstrap 未完成且无持久化 current）' : '主窗口不可用'
      log.warn('main', `second-instance 带 --book=${ref}，但${why}——已忽略（聚焦现有窗口）`)
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus()
  })
}

/** 前端静态目录已随 server 拆分下沉 child（server-boot deriveStaticDir，批 U1）。 */

let mainWindow: BrowserWindow | null = null
let shelfWindow: BrowserWindow | null = null
let libraryWindow: BrowserWindow | null = null
let appUrl = '' // 主窗口加载的 url（dev:5173 / packaged server）；书架窗口复用
/** R44-2（四十四轮）：关窗拦截的全局避让旗。session-end（OS 关机/注销）时间窗有限，
 *  close 拦截只会白拖 OS 收尾（停机兜底由 session-end 处理器负责）；退出链
 *  （before-quit）自行先行 flush 并在收口 destroy 全窗，close 事件再拦截是重复动作。
 *  两旗分别由 session-end / before-quit 链路置位，bootstrap() 内的 close 拦截读它们。 */
let sessionEnding = false
let appTearingDown = false
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
/** 阶段 22 批 U1-U3：studio server 已拆至 utilityProcess 子进程（dev HMR 态不起）；
 *  批 U3 起崩溃退避自动重启，3 次自动重启耗尽转原生对话框（U-2：重启服务/退出） */
const serverManager = createStudioServerManager({
  // R55-A-1（五十五轮）：自愈等待期的退出探测——restartPinned 在 shuttingDown 态改
  // 有界等停机收口（观察窗 5s 与停机链最坏预算失配的复合场景自愈拒绝修复），等待/
  // 收口窗口内用户真退出（before-quit 链置位 appTearingDown）则放弃恢复，不在退出
  // 链上 fork 新 child 成孤儿（S-5/S1 同向）
  isProcessExiting: () => appTearingDown,
  // 重审-3（2026-09-07 全量代码重审 §四.3）：重启成功广播——崩溃自动重启
  // （doRestart）/session-end 自愈（restartPinned）钉住端口拉回成功后，向全部存活
  // 窗口发 desktop:server-restarted；渲染层（Book.vue 订阅）sse.resync() 立即断旧
  // 连新 + 重取连接级 sync 快照。此前自愈成功 UI 无感知，SSE 只能等自身退避重连，
  // 「服务已恢复但界面不动」的盲窗随退避时长展开。
  onRestarted: (port) => {
    for (const win of [mainWindow, shelfWindow, libraryWindow]) {
      if (win && !win.isDestroyed()) win.webContents.send('desktop:server-restarted', port)
    }
  },
  onRestartExhausted: async () => {
    // R1010-P3（G7-②）：同步对话框泵原生嵌套消息循环，崩溃风暴路径上主进程事件循环
    // 被冻（三窗口输入/IPC 全停）；改异步 showMessageBox，exit 回调即刻返回，决断
    // 到达前不重启不退出（server-manager 侧 void Promise 适配）。
    const { response: choice } = await dialog.showMessageBox({
      type: 'error',
      title: 'CLWriting 服务异常',
      message: '写作服务连续崩溃，自动重启已停止。',
      detail: '可以选择重新启动服务，或退出应用。未保存内容在服务恢复后仍可从自动保存找回。',
      buttons: ['重启服务', '退出应用'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (choice !== 0) {
      app.quit()
      return 'quit'
    }
    return 'restart'
  },
})
/** S-4（批 U1）：bootstrap-runner「重试前关旧 server」的适配器——close() 即停旧 child
 *  （kill + 等退出由 manager 保证；下一次 start 先等旧 child 退出再 fork）。
 *  P3（打包修复批）：close 返回 stopChild 的 Promise——runner 等其落定再开跑新
 *  bootstrap，不再 fire-and-forget；stopChild 自带 cancelPendingRestart（S-5），
 *  挂起重启随关旧一并作废 */
const legacyStopHandle = { close: () => serverManager.stopChild() }
/** P5-服务端（第七轮）：bootstrap 实际采用的 workDir——before-quit 优雅退出回读用
 *  （readStore().current 可能为 null/失效而实际 workDir 由 findWorkDir 发现） */
let bootstrappedWorkDir: string | null = null

/** M-3（第八轮）：桌面侧统一取「实际运行的书库」——bootstrap 实际采用的 workDir 优先，
 *  store 回读兜底。P5-服务端（第七轮）只修了 before-quit 一点；second-instance --book、
 *  show-in-folder、open-book-dir、open-library-dir 四个入口仍单读 readStore().current，
 *  store.current 为 null/失效而实际跑在 findWorkDir 发现的书库上时全部静默失明。 */
function currentWorkDir(): string | null {
  return bootstrappedWorkDir ?? readStore().current
}

/** 主窗口 bounds 持久化（userData/window-state.json）：关闭时存，启动时恢复。 */
const stateFile = join(app.getPath('userData'), 'window-state.json')
interface WinState {
  bounds: { x: number; y: number; width: number; height: number }
  maximized?: boolean
}
function loadWinState(): WinState | null {
  try {
    const s = JSON.parse(readFileSync(stateFile, 'utf-8')) as WinState
    // R26-86（二十六轮）：校验扩为 getAllDisplays 任一显示器包含即有效（±容差口径
    // 原样保留）——原只对主屏判定，多屏作者窗口常驻副屏：副屏坐标对主屏永远「越界」，
    // 恢复被无条件丢弃、窗口尺寸/位置白丢。判定逻辑抽 window-state.ts 纯函数（可单测）。
    // R1010-P3（G7-④）：校验矩形整屏 bounds → workArea——创建侧缺省/钳制口径
    // （workAreaSize-80/-8）一直按工作区算，校验却按含任务栏/Dock 的整屏：存档底部
    // 压在任务栏区（整屏含、工作区外）此前判有效、恢复即压条。容差 200px 原样保留
    //（轻微出界照旧放行），只多拦「越工作区 >200px」的真离屏态，正常存档不受影响。
    if (isBoundsVisibleOnAnyDisplay(s.bounds, screen.getAllDisplays().map((d) => d.workArea))) return s
  } catch {
    /* 无文件或损坏 → 默认 */
  }
  return null
}
function saveWinState(): void {
  if (!mainWindow) return
  try {
    const maximized = mainWindow.isMaximized()
    // 最大化时存正常（非最大化）bounds，恢复时按 maximized 标志决定是否最大化
    const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds()
    atomicWriteFile(stateFile, JSON.stringify({ bounds, maximized }))
  } catch (e) {
    // R60-B-3（六十轮）：持久化失败留痕——原 catch 零日志，磁盘满/权限/收尾期 getter
    // 抛错全不可见（本文件其余忽略处均留痕，唯此处裸吞，违「失败留痕」纪律）。窗口
    // 状态非关键数据，维持吞错不阻断关窗/停机，warn 级留诊断线索即可。
    log.warn('desktop', `窗口状态持久化失败（window-state.json 未写入）：${e instanceof Error ? e.message : String(e)}`)
  }
}

// ── 工作目录持久化（userData/workdir.json）──────────────

/** 持久化文件路径（Electron userData 目录）。 */
function storePath(): string {
  return join(app.getPath('userData'), 'workdir.json')
}

/** 读 store（含失效 recent 清理）；缺失/损坏 → 空存储。
 *  R47-9（四十七轮）：内存缓存（写时失效）——此前每次调用全量读盘 + 旧同步版
 *  filterValidRecent 逐 recent 项 existsSync+statSync：welcome 态 currentWorkDir 的
 *  ?? 兜底使每次相关 IPC 都重踩，书库在失联网络卷（NAS/SMB「挂载点在而服务器无
 *  响应」态）上时同步阻塞主进程数秒（三窗口输入/IPC 全冻结）。缓存后常态零盘 IO；
 *  recent 有效性过滤只在首读一次执行（workdir.json 系应用管理文件，外部手改重启
 *  可见，可接受）。
 *  R1010-P2-1（2026-09-10 全量重评 GLM-5.3 修复批）：首读不再同步过滤——同步逐条
 *  stat 在 recent 残留失联网络卷时照样冻主进程数十秒（重审-1 probeDirReachable
 *  防线只护 current/cwd，recent 条目在防线外）。readStore 仅 parse 缓存，过滤挪
 *  bootstrap 异步预算一次执行（filterValidRecentBudgeted，超时项保留展示——见其
 *  头注；bootstrap await 先于任何 IPC 注册，早读窗口不存在）。
 *  R48-73（四十八轮）备案（取舍补记）：首读过滤后运行期不再复验——会话内被外部
 *  （或本应用他路径）删除的书库目录会残留展示至重启，R47-9 注释只声明了「外部手改
 *  重启可见」一半。接受依据：点切换有 canSwitchLibraryDir 守卫拦截兜底（失效目录
 *  拒切），残留只污展示面不产行为错；逐次复验即回到 R47-9 要治的 NAS/SMB 同步阻塞。
 *  返回共享引用——调用方（setCurrent/saveCurrent）均为纯函数式建新对象，无 mutate 面。 */
let storeCache: WorkDirStore | null = null
function readStore(): WorkDirStore {
  if (storeCache) return storeCache
  const fp = storePath()
  if (!existsSync(fp)) {
    storeCache = emptyStore()
    return storeCache
  }
  // R61-B-2（六十一轮评审）：文件级读失败容错——此前失败面不对称：parseStore 对内容
  // 损坏已容错（返回 undefined 走默认）、loadWinState 对整个读过程 catch-all，唯
  // readFileSync 本身抛错（权限 EACCES、杀毒/同步盘瞬时锁）无人捕获 → bootstrap 链
  // 抛错 →「启动失败」退出。修复 = 读失败单独 try/catch，按「无存储」降级（与
  // parseStore 失败同款形态：缓存 emptyStore，下次调用不再重读）+ warn 留痕（带路径
  // 与原因）；启动可用性优先，不改变成功路径与缓存语义。
  let raw: string
  try {
    raw = readFileSync(fp, 'utf-8')
  } catch (e) {
    log.warn('desktop', `workdir.json 读取失败（按无存储降级）：${fp} —— ${e instanceof Error ? e.message : String(e)}`)
    storeCache = emptyStore()
    return storeCache
  }
  // R1010-P2-1：仅 parse 缓存（同步零盘 IO 除读文件本身）——recent 失效过滤挪 bootstrap
  // 异步预算执行（见 readStore 头注），失联网络卷不再同步冻首读
  storeCache = parseStore(raw)
  return storeCache
}

/** 原子写 store。R47-9：写后同步刷新缓存（写后即读一致）。 */
function writeStore(store: WorkDirStore): void {
  atomicWriteFile(storePath(), serializeStore(store))
  storeCache = store
}

/** 设新 current（旧入 recent）+ 持久化。 */
function saveCurrent(dir: string): void {
  writeStore(setCurrent(readStore(), dir))
}

/**
 * R51-A-4（五十一轮）：saveCurrent 的契约化包装——IPC 端点响应面是 `{ok,reason}`
 * 信封，而 saveCurrent → atomicWriteFile 可抛（磁盘满/权限/只读卷），裸抛会绕过契约
 * 直达渲染层 invoke 的异常通道（切库静默无反馈、前端拿不到结构化失败）。返回 null =
 * 成功；字符串 = 人话失败原因（调用方转 `{ok:false, reason}`，且不触发 relaunch——
 * 落库失败的切库若照常重启，应用会带着旧 current 重启、用户操作看起来像被吞）。
 * 菜单链 openLibraryAction 同走本包装（R57-A-2，五十七轮）：落库失败弹一次性原生
 * 错误框反馈并中止切换——原「调用点 .catch 留痕兜底」取舍废弃（日志留痕对用户
 * 不可见，点菜单后切换静默失败）。
 */
function saveCurrentSafe(dir: string): string | null {
  try {
    saveCurrent(dir)
    return null
  } catch (e) {
    log.error('main', `workdir.json 持久化失败（切库中止）：${e instanceof Error ? e.message : String(e)}`, e)
    return `书库目录落库失败（workdir.json 写入异常）：${e instanceof Error ? e.message : String(e)}`
  }
}

// R59 清偿批（R55-A-3）：切库回滚基线——三条切库入口（open-library / switch-library /
// 菜单 openLibraryAction）都是「先落库新 current，再 relaunch 走 before-quit 优雅退出」，
// 而退出链的冲突/保存失败原生确认可被取消（R44-19「取消即中止退出、应用原样保留」）。
// 取消后会话内继续跑旧库，workdir.json 却已指向新库——跨会话落入「已被取消」的新库。
// 故切库落库前快照 store 作回滚基线：取消路径回写（rollbackCancelledSwitch），过不可
// 回头点（armPendingRelaunchIfAny，退出既成、新库即用户所愿）即作废。store 对象为
// 不可变更新（setCurrent 纯函数建新对象），持快照引用安全；快照到回滚之间无其他写方
// （writeStore 仅切库链触达）。
let switchRollbackStore: WorkDirStore | null = null

/** 切库链专用落库：快照当前 store → saveCurrentSafe → 成功才武装回滚基线。
 *  三入口共用本函数——武装点收敛一处，新增切库入口漏接即测试面缺口。
 *  快照读失败按无基线处理（快照本身非切换要件）：readStore 原在 saveCurrentSafe
 *  的 try 内（R51-A-4 契约化错误面），此处外提后若裸抛反而放宽了失败语义；
 *  落库失败的契约返回由 saveCurrentSafe 内层 readStore（缓存）原样保住。 */
function saveCurrentArmingRollback(dir: string): string | null {
  let prev: WorkDirStore | null = null
  try {
    prev = readStore()
  } catch {
    prev = null
  }
  const err = saveCurrentSafe(dir)
  if (err) return err
  switchRollbackStore = prev
  return null
}

/** 退出被取消路径调用：回写切库前 store，跨会话不残留被取消的新库。 */
function rollbackCancelledSwitch(): void {
  const prev = switchRollbackStore
  switchRollbackStore = null
  if (!prev) return
  try {
    writeStore(prev)
    log.info('main', `切库的退出被作者取消：workdir.json 已回写为原书库（${prev.current ?? '未选'}），本会话与下次启动均维持原库`)
  } catch (e) {
    // 回滚写失败不另起错误面（退出取消路径），但必须留痕：持久化面仍指向被取消的
    // 新库，「应用原样保留」跨会话已破——留诊断线索供排查（磁盘满/只读卷同因）
    log.error('main', `切库的退出被取消，workdir.json 回写失败（跨会话仍指向被取消的新库）：${e instanceof Error ? e.message : String(e)}`, e)
  }
}

/** 是否合法书库目录（自身含 .clwriting/）。复用 findWorkDir 的判定。
 *  R1W-7（win 平台专项复审 R1）：win 路径大小写不敏感——findWorkDir 返回值与
 *  resolve(dir) 的盘符/目录大小写可能漂移，全等比较会误判「非书库」。 */
function isLibraryDir(dir: string): boolean {
  const found = findWorkDir(dir)
  return found !== null && samePath(found, resolve(dir))
}

/** R41-1（四十一轮）：switch-library 的接受面 = bootstrap 语义（目录存在即可，含
 *  pickLibrary「在此新建」落库的待建空书库），不再要求自身含 .clwriting/——原守卫
 *  直接复用 isLibraryDir 与 bootstrap 分叉：空书库入 recent 后未建首书即退出，最近
 *  列表点回恒被拒，成永久死条目。唯一额外防线：不能是另一书库的子目录（findWorkDir
 *  命中祖先而非自身——防误把书内目录挂成书库根）。
 *  R44-14（四十四轮）：git-ancestor 防线同步——待建空书库（自身及祖先均无
 *  .clwriting/）位于 git 仓库内时，建第一本书会被 doInitSteps 恒拒（init 的 B1
 *  口径），点回即落空壳死胡同，与 pickLibrary「在此新建」同源拒绝。已建成的书库
 *  （findWorkDir 命中自身）不拦：书籍读写不受影响，拦了反而把 R41-1 救活的
 *  recent 条目重新变死条目。 */
function canSwitchLibraryDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false
  } catch {
    return false
  }
  const found = findWorkDir(dir)
  if (found !== null && !samePath(found, resolve(dir))) return false
  if (found === null && findGitAncestor(dir)) return false
  return true
}

/** R54-A-2（五十四轮）：切库可达性预探超时——超过即按「目录暂不可达」契约化拒切，
 *  不再进同步守卫（失联网络卷上 statSync 单点即可冻主进程数十秒）。可注入（测试快进）。 */
const SWITCH_LIBRARY_PROBE_TIMEOUT_MS = Number(process.env['CLW_SWITCH_LIBRARY_PROBE_TIMEOUT_MS']) || 2_000

/** 重审-1（2026-09-07 全量代码重审 §四.1）：bootstrap 工作目录定位预探超时——
 *  store.current / 运行目录指向失联网络卷时，bootstrap 的 statSync / findWorkDir
 *  同步扫描冻主进程（R54-A-2 切库同族的启动侧入口）。可注入（测试快进）。 */
const BOOTSTRAP_PROBE_TIMEOUT_MS = Number(process.env['CLW_BOOTSTRAP_PROBE_TIMEOUT_MS']) || 2_000

/** 预探超时哨兵（Promise.race reject 载体——stat 的真实异常都带 errno code，唯超时无）。 */
const PROBE_TIMEOUT = Symbol('switch-library-probe-timeout')

type DirReachability = 'ok' | 'unreachable' | 'invalid'

/**
 * R54-A-2（五十四轮）：切库守卫前的可达性预探——recent 列表残留失联网络卷（挂载点
 * 在服务器无响应态）时，canSwitchLibraryDir 的 statSync/findWorkDir 同步爬祖 +
 * probeCaseSensitive 的写探针全在主进程同步执行，一点「切换」即冻结三窗 UI 数秒
 *（R47-9 readStore 面已修的同族第三处）。先经 fs/promises stat 异步预探（超时
 * SWITCH_LIBRARY_PROBE_TIMEOUT_MS），同步守卫只在活卷上执行（预探通过后拔线的
 * TOCTOU 残窗仍在，但冻结从「恒现路径」收窄为「预探后瞬断」）。
 * 三态分诊：'ok' = stat 通过；'unreachable' = 超时（失联卷挂死面，唯一冻结形态）；
 * 'invalid' = stat 确定性快速失败（ENOENT/EACCES/ENOTDIR 等，不构成冻结面）——
 * 交回同步守卫走原「目录无效」契约文案，不把普通坏路径误报成网络卷不可达。
 * 重审-1：timeoutMs 参数化——bootstrap 侧预探复用同一函数但走独立超时注入
 * （CLW_BOOTSTRAP_PROBE_TIMEOUT_MS），与切库 knob 解耦。
 */
async function probeDirReachable(dir: string, timeoutMs: number = SWITCH_LIBRARY_PROBE_TIMEOUT_MS): Promise<DirReachability> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      stat(dir),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(PROBE_TIMEOUT), timeoutMs)
      }),
    ])
    return 'ok'
  } catch (e) {
    return e === PROBE_TIMEOUT ? 'unreachable' : 'invalid'
  } finally {
    // R54-A-5 同款卫生：预探通过态清掉超时计时器，不空转滞留
    if (timer) clearTimeout(timer)
  }
}

// ── 目录选择 + 切换 ────────────────────────────────────

/**
 * 弹原生目录选择器选书库。批2：仅接受含 .clwriting/ 的目录；非书库提示后重选或取消。
 * 批3 将扩展：非书库目录二次确认 → 引导建书。
 * E-9c（第五十三轮）：「重新选择」原为无上限递归——反复选非书库目录会无限弹窗；
 * 改循环 + 次数封顶（10 次），超限记 error 日志后返回 null 退出（由调用方按取消处理）。
 * @returns 校验通过的目录绝对路径；取消/超限返回 null
 */
const PICK_LIBRARY_MAX_ATTEMPTS = 10 // E-9c：目录选择循环封顶

/**
 * 平台规范化批 E（2026-09-03）：大小写敏感卷警告——探测目录所在卷敏感性，敏感
 * （mac 大小写敏感 APFS / Linux 常态 / win 按目录敏感标记）时弹确认。书库跨机互拷
 * 依赖「大小写不敏感」前提（win/默认 mac 卷均如此），敏感卷上两台机器各自创建的仅
 * 大小写异名文件会劈裂双存。返回 true = 用户选择换个目录（调用方回选择循环/中止切换）。
 */
async function warnIfCaseSensitive(dir: string): Promise<boolean> {
  // 探测失败（null）fail-open：探测本身不挡书库选择主流程
  if (probeCaseSensitive(dir) !== true) return false
  const parent = mainWindow ?? undefined
  const msgOpts: MessageBoxOptions = {
    type: 'warning',
    title: '该目录在大小写敏感的卷上',
    message: `「${basename(dir)}」所在卷区分文件名大小写`,
    detail:
      'Windows 与 macOS 默认卷均不区分大小写；在大小写敏感卷上使用书库，跨机器互拷时可能出现仅大小写不同的重名文件劈裂（两台机器各留一份），不建议在此使用。',
    buttons: ['仍要使用', '换个目录'],
    defaultId: 1,
    cancelId: 1,
  }
  const choice = parent
    ? await dialog.showMessageBox(parent, msgOpts)
    : await dialog.showMessageBox(msgOpts)
  return choice.response === 1
}
async function pickLibrary(): Promise<string | null> {
  // E-9c：递归改循环 + 封顶——超限退出并报错，不再无限弹窗
  for (let attempt = 1; attempt <= PICK_LIBRARY_MAX_ATTEMPTS; attempt++) {
    const parent = mainWindow ?? undefined
    const openOpts: OpenDialogOptions = {
      title: '选择 CLWriting 书库目录',
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, openOpts)
      : await dialog.showOpenDialog(openOpts)
    const dir = result.canceled ? null : result.filePaths[0]
    if (!dir) return null
    // R61-B-1（六十一轮）：可达性预探先行——失联网络卷不再经 isLibraryDir/findWorkDir
    // 的同步 stat 爬升与 case-probe 同步写探针冻结主进程（与 switch-library 链 R54-A-2
    // 同款防线补齐「打开书库」入口；probeDirReachable 唯一消费点此前仅在切库链）。
    // 命中即原生错误框明确反馈并留在选择循环重选（E-9c 封顶兜底）。
    if ((await probeDirReachable(dir)) === 'unreachable') {
      dialog.showErrorBox(
        '目录无响应',
        `「${basename(dir)}」暂不可达（可能是网络卷无响应或已断开），请重新选择。`,
      )
      continue
    }
    if (isLibraryDir(dir)) {
      // 平台规范化批 E：大小写敏感卷警告（探测失败 fail-open 不拦）——换目录回循环顶
      if (await warnIfCaseSensitive(dir)) continue
      return dir
    }
    // 非书库目录 —— 决策②：二次确认是否在此新建书库
    const msgOpts: MessageBoxOptions = {
      type: 'question',
      title: '在此新建书库？',
      message: `「${basename(dir)}」还不是书库目录`,
      detail: '确认后在此新建 CLWriting 书库：重启后书架为空，建第一本书时会自动建立 .clwriting/ 等结构。',
      buttons: ['在此新建', '重新选择', '取消'],
      defaultId: 0,
      cancelId: 2,
    }
    const choice = parent
      ? await dialog.showMessageBox(parent, msgOpts)
      : await dialog.showMessageBox(msgOpts)
    if (choice.response === 0) {
      // R52-A-1（五十二轮）：嵌套书库防线——「在此新建」目标位于既有书库内部
      //（findWorkDir 命中祖先而非自身）时此前放行：内层 .clwriting/ 建成后抢占
      // workDir 判定（外层书库的 server 端口/锁根/task-gate 单进程单锁契约被内层
      // 篡改面）。与 canSwitchLibraryDir（switch-library 侧同款防线）口径对齐；
      // 命中即原生错误框明确反馈并留在选择循环重选，不落死胡同。
      const foundWork = findWorkDir(dir)
      if (foundWork !== null && !samePath(foundWork, resolve(dir))) {
        dialog.showErrorBox(
          '所选位置在另一书库内部',
          `「${basename(dir)}」位于书库（${foundWork}）内部，不能作为独立书库——嵌套书库会使工作目录判定歧义（建书结构被外层书库吞并）。请选择该书库以外的目录。`,
        )
        continue
      }
      // R44-14（四十四轮）：git-ancestor 防线前移——init 的 doInitSteps 对 git 仓库内
      // 工作目录恒拒绝建书（书文件会被外层 git 版本控制吞掉），此处放行会让作者把
      // 待建空书库落库并重启后，到「建第一本书」才被拒——空壳死胡同（书架恒空、建书
      // 恒拒、recent 里的它也无处可去）。与 init 同源判定（findGitAncestor），命中即
      // 原生错误框明确反馈并留在选择循环重选，不落死胡同。
      const gitRoot = findGitAncestor(dir)
      if (gitRoot) {
        dialog.showErrorBox(
          '所选位置在 git 仓库内',
          `「${basename(dir)}」位于 git 仓库（${gitRoot}）内，不能作为书库——书文件会被外层 git 的版本控制吞掉，建书将被拒绝。请选择 git 仓库外的目录。`,
        )
        continue
      }
      // 新建同样过大小写敏感卷警告（敏感卷上新建 = 后续跨机劈裂的源头）
      if (await warnIfCaseSensitive(dir)) continue
      return dir // 确认在此新建（待建空目录，由调用方持久化 + 重启）
    }
    if (choice.response === 1) continue // 重新选择（E-9c：回到循环顶，受封顶约束）
    return null // 取消
  }
  // E-9c：封顶退出——留痕报错后按取消收口，不无限弹窗困住用户
  log.error('main', `书库目录选择连续 ${PICK_LIBRARY_MAX_ATTEMPTS} 次未选定有效目录，已退出选择流程`)
  return null
}

/** 重启进程以应用新 workDir（规避 server 路由单例，见方案 §3.1）。
 *  R51-A-1（五十一轮）：app.relaunch() 武装与 releaseSingleInstanceLock 均不可回滚——
 *  原实现当场三连（relaunch+release+quit），后续 before-quit 链的 flush 冲突/失败
 *  确认一旦取消（R44-19/重评-1「取消即中止退出、应用原样保留」），应用带着「已释放
 *  单实例锁 + 已武装重启」续跑：真双开可抢入、后续任意一次退出被劫持成重启。改为只
 *  记意图并走优雅退出；真正的武装与锁释放推迟到 before-quit 链的不可回头点
 *  （armPendingRelaunchIfAny），取消路径同步丢弃意图。 */
let pendingRelaunch = false

/** R51-A-1：不可回头点武装——flush 确认全过、appTearingDown 置位处调用；切库意图
 *  在此刻兑现（app.relaunch() + R27-96 显式交接释放锁，锁时序缝隙与最坏结果分析见
 *  原 relaunch 注）。仅切库链带意图时动作，普通退出零副作用。 */
function armPendingRelaunchIfAny(): void {
  // R59 清偿批（R55-A-3）：不可回头点之后新库即用户所愿，回滚基线作废（普通退出
  // 无基线时本行为空操作）
  switchRollbackStore = null
  if (!pendingRelaunch) return
  pendingRelaunch = false
  app.relaunch()
  app.releaseSingleInstanceLock()
}

function relaunch(): void {
  pendingRelaunch = true
  // RB-SV-P2-6：走 before-quit 优雅清理（app.exit 会跳过 before-quit）
  app.quit()
}

/** 打开书库（菜单/前端共用）：选 → 存 → 重启。返回是否已触发切换。
 *  R57-A-2（五十七轮）：落库改走 saveCurrentSafe 契约化包装——原裸 saveCurrent 可抛
 * （磁盘满/权限/只读卷），异常仅被菜单调用点 .catch 记日志，用户点了菜单毫无反馈、
 * 切换静默失败。失败改一次性原生错误框（对齐 switch-library 链 main.ts saveErr 的
 * 契约化失败形态：菜单链无 {ok,reason} 信封可回，原生框即其反馈面），并中止切换
 * （不 relaunch——落库失败若照常重启，应用带旧 current 重启，操作看似被吞）。 */
async function openLibraryAction(): Promise<boolean> {
  const picked = await pickLibrary()
  if (!picked) return false
  // R59 清偿批（R55-A-3）：落库改切库链专用包装（快照武装回滚基线），取消退出可回写
  const saveErr = saveCurrentArmingRollback(picked)
  if (saveErr) {
    dialog.showErrorBox('打开书库目录失败', `${saveErr}\n\n当前书库未切换，应用将继续在原书库上运行。请检查磁盘空间/权限后重试。`)
    return false
  }
  relaunch()
  return true
}

// ── 窗口 ──────────────────────────────────────────────

/** ii 批：安全基线窗口工厂——主窗/书架/书库三处 BrowserWindow 的安全五件套
 *  （contextIsolation + sandbox + nodeIntegration:false + preload + hiddenInset 标题栏）
 *  与纵深防御监听（禁外部导航 + 禁弹新窗）原样重复 3 份，安全配置改一处漏两处是
 *  漂移风险，收敛到此。尺寸/标题/位置由 opts 传入，win 专属生命周期监听由调用方自挂。 */
let devProxyApplied: Promise<void> = Promise.resolve()

// R4-P2-1（2026-09-09 修复批，评审 §四.2）：IPC sender 统一校验——此前 14 个 handler
// 不验 event.sender 身份，渲染层一旦被 XSS 注入即可驱动 open-library/switch-library/
// context-menu/set-fullscreen 等（纵深缺口，CSP/隔离只是缓解不可依赖）。校验面 =
// 白名单 webContents（createSecureWindow 创建时登记、closed 摘除）+ 顶层主帧
//（senderFrame === sender.mainFrame，被注入 iframe 的帧中帧不满足；帧销毁期
// senderFrame 为 null 亦拒）。拒绝即拒（不弹提示不回退上下文），防攻击面试探。
const trustedSenders = new Set<WebContents>()
// R1010b-DSK-P3-5（2026-09-10 内存专项重审修复批）：工厂窗登记集合——兜底反查的判定面。
// WeakSet 不持强引用，窗口销毁随 GC 回收无泄漏面；登记随 trackWindow 单点（createSecureWindow
// 唯一入口），无旁路登记面。
const factoryWindows = new WeakSet<BrowserWindow>()
function trackWindow(win: BrowserWindow): void {
  // R0910-W：先捕获局部引用再登记——窗口销毁后读 win.webContents 抛
  // "Object has been destroyed"（Electron 实测）。本监听是 closed 事件的首个监听，
  // 其抛错会中断 emit 遍历，令后续 closed 清理（自愈计时器撤销 / 子窗引用置空 /
  // 主窗 null→app.quit）全部短路，并经 uncaughtException 提前硬退。局部 ref 口径
  // 同 openShelfWindow/openLibraryWindow（R48-16）。
  const wc = win.webContents
  factoryWindows.add(win)
  trustedSenders.add(wc)
  win.on('closed', () => trustedSenders.delete(wc))
}
/** R0910-W：closed 清理监听异常隔离——EventEmitter.emit 同步遍历监听，任一监听抛错
 *  即中断其余监听（同事件后续清理整体被取消）。清理体包一层：异常只留痕、不连累其余
 *  清理与退出链；无异常时行为与直接调用完全一致。 */
function guardClosedCleanup(label: string, fn: () => void): void {
  try {
    fn()
  } catch (e) {
    log.error('desktop', `窗口 closed 清理监听异常（${label}，已隔离——不影响其余清理与退出链）`, e)
  }
}
/** R0910-W：测试钩子（生产零调用，先例同 src/cache/rebuild.ts __testHooks）——供回归
 *  用例断言窗口关闭后 IPC 白名单登记已摘除。 */
export const __testHooks = {
  trustedSenderCount: (): number => trustedSenders.size,
  hasTrustedSender: (wc: WebContents): boolean => trustedSenders.has(wc),
}
function isTrustedSender(e: IpcMainInvokeEvent | IpcMainEvent | null): boolean {
  // 事件对象缺失（帧销毁期形态/异常调用）一律拒——null 防御防 handler 层 TypeError
  if (!e) return false
  // senderFrame 为空（帧销毁期）一律拒；非顶层主帧（被注入 iframe 的帧中帧
  // senderFrame ≠ sender.mainFrame）拒。
  if (!e.senderFrame || e.senderFrame !== e.sender.mainFrame) return false
  // 主判据：三窗白名单（createSecureWindow 登记、closed 摘除，快路径）。
  if (trustedSenders.has(e.sender)) return true
  // 兜底：Electron 全局反查 + 工厂窗判定。R1010b-DSK-P3-5（2026-09-10 内存专项重审
  // 修复批）：原「能反查到本进程存活窗口即放行」宽于白名单语义——未来若出现绕过工厂
  // 的直建窗口，其 webContents 即 IPC 直通；收窄为反查命中窗须属工厂登记集合（登记面
  // 见 trackWindow），白名单语义 = 「工厂登记 webContents ∪ 工厂窗反查」。
  const win = BrowserWindow.fromWebContents(e.sender)
  return !!win && !win.isDestroyed() && factoryWindows.has(win)
}

function createSecureWindow(opts: BrowserWindowConstructorOptions): BrowserWindow {
  // dev 代理记账 promise（R72-10 / 二十轮 D-7）：dev 态 direct:// 设置于窗口共享的
  // defaultSession，各窗 loadURL 前 await 此 promise——原子窗 fire-and-forget 在
  // 「子窗先于主窗完成设置」的时序下会带着未生效代理加载（SSE 经系统代理 buffer 断流）
  const win = new BrowserWindow({
    // R40-32（四十轮）：hiddenInset 是 darwin 专属值——linux 上非支持值（行为未
    // 定义，纯 dev 形态卫生项），走默认系统标题栏；win 由下方 WCO 分支覆盖为
    // 'hidden'+overlay（分支不动），mac 形态不变。
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    backgroundColor: '#f5f5f5',
    // J5+merge（win→dev 合流，2026-08-29）：autoHideMenuBar 显式平台口径——win true
    //（配合下方 setMenuBarVisibility(false) 双保险），mac/win 外显式 false（Electron
    // 默认即 false 行为不变；隐式 undefined 过不了 kk-P2-8 的跨平台断言）。
    autoHideMenuBar: process.platform === 'win32',
    // J5（win 体验面，2026-08-29 作者指令「外观全面向 mac 靠齐」）：win 走「无框标题栏 +
    // WCO 窗控 overlay」——内容顶到窗口上沿（mac hiddenInset 同形态），最小化/最大化/关闭
    // 由系统画在右上角（近似 mac 红绿灯位，前端拖拽区已就绪无需新开）。overlay 只能
    // 实色（'transparent' 不被 Chromium 接受，实测回落系统亮色底且不跟 nativeTheme），
    // 初值 = light 顶栏底 #f6f6f6，暗色由 boot IPC 立即纠正；弹窗遮罩期间经
    // prefs.setOverlayDimmed 同步压暗（暗页面亮窗控条 = 作者反馈的「窗控突兀」）。
    // 按钮 hover 态由系统绘制。运行时主题/遮罩切换走 desktop:set-titlebar-overlay。
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#f6f6f6',
            symbolColor: '#666666',
            height: 31,
          },
        }
      : {}),
    ...opts,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      // 资源项（非安全项）：纯中文写作应用，Hunspell 词典每渲染进程常驻几 MB
      // 且参与编辑器按键路径——默认开启属纯耗，随工厂一处收敛三窗。
      spellcheck: false,
      ...opts.webPreferences,
      // R76-29（二十四轮 D 域）：安全标志置于 spread 之后——此前 contextIsolation/
      // sandbox/nodeIntegration 排在 ...opts.webPreferences 前，调用方一旦传
      // webPreferences（现三窗均未传，纯防未来）就能静默关掉隔离/沙箱，工厂名
      // 「Secure」失实。三项不可让渡：任何调用方都不得以入参放宽（preload/spellcheck
      // 属资源项仍可覆盖）。
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  // autoHideMenuBar 只保证 Alt 可唤出；初始态再显式隐藏一次（防平台默认差异）
  if (process.platform === 'win32') win.setMenuBarVisibility(false)
  // 纵深防御：禁止导航外部 URL + 禁止弹新窗口（contextIsolation+sandbox 已降险，此为兜底，
  // 防 CSP 被 XSS 绕过后子窗口被导航到外部）
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // R4-P2-1：IPC 白名单登记——三窗共用本工厂，此处单点登记 + closed 摘除
  trackWindow(win)
  // R67-16：渲染崩溃自愈随工厂挂载（三窗同享；原先只挂主窗，书架/书库白屏无自愈）
  attachRendererCrashSelfHeal(win, opts.title ?? '窗口')
  // R1010-P3（G7-③）：preload-error 同款入工厂——原先只挂主窗，书架/书库窗 preload
  // 加载失败（sandbox preload 报错主进程才可见）零留痕。带窗口名区分来源。
  win.webContents.on('preload-error', (_e, preloadPath, err) => {
    log.error('desktop', `preload 加载失败（${opts.title ?? '窗口'}）：${preloadPath}`, err)
  })
  // dev 模式:不经系统代理（防 clash/surge 类 HTTP 代理 buffer SSE 长连接 → driver events 断流）
  // R43-26（四十三轮）：dev 环境变量防线——本文件全部 CLW_DEV_UI 读取统一收紧为
  // 「!!env && !app.isPackaged」形态：宿主 shell 残留的 CLW_DEV_UI=1 在打包态不得再
  // 触发 dev 代理（setProxy direct:// 属开发期行为，与 HMR 同源同门）
  if (!!process.env['CLW_DEV_UI'] && !app.isPackaged) { // R62-45：bracket 统一风格
    // R72-10（二十轮 D-7）：记账供 loadURL 前 await（同值幂等，重复设置无害）
    // R74-16（七十四轮批 D）：setProxy 返回 promise 此前无人 catch——设置失败成
    // unhandledRejection 丢诊断（且 await 方拿到 rejected promise 会二次炸穿书架/
    // 书库窗口加载链）；接日志吞错降级（按系统代理继续，SSE 断流风险留日志可查）
    devProxyApplied = win.webContents.session
      .setProxy({ proxyRules: 'direct://' })
      .catch((e) => {
        log.error('desktop', `dev 代理 direct:// 设置失败（${opts.title ?? '窗口'}），按系统代理继续加载`, e)
      })
  }
  return win
}

/** 打开独立书架窗口（工作区时管理/切换/建书；单例，重复调用聚焦已存在窗口）。*/
async function openShelfWindow(): Promise<void> {
  // Y-12（第五十七轮）：appUrl 就绪守卫——fork+握手期间（打包冷启动可达秒级）原生
  // 菜单已可点，loadURL 无 scheme 相对路径会以 ERR_INVALID_URL 开出加载失败白窗
  // R44-16（四十四轮）：命中不再静默——冷启动握手期点菜单的 no-op 留痕，可诊断
  if (!appUrl) {
    log.info('desktop', '书架窗口请求早于服务就绪（冷启动握手期），本次打开已忽略')
    return
  }
  if (shelfWindow && !shelfWindow.isDestroyed()) {
    shelfWindow.focus()
    return
  }
  const wa = screen.getPrimaryDisplay().workAreaSize
  // R48-16（四十八轮）：createSecureWindow 后即捕获局部引用——closed 监听与 await 后
  // 复验均用局部，不再读模块变量。两处交错此前都踩模块变量：① dev 态 setProxy 窗口期
  // 本窗关闭，closed 监听把模块变量置 null，await 后 shelfWindow.isDestroyed() 变
  // null 上抛 TypeError；② 两次并发 open 的交错形态，旧栈 await 恢复后读模块变量拿到
  // 新窗重复 loadURL（旧窗 closed 还会把指向新窗的模块变量误置 null）。局部引用 +
  // 「仍指向本窗才置 null」守卫两形态同收。
  const win = createSecureWindow({
    width: Math.min(920, wa.width - 80),
    height: Math.min(640, wa.height - 80),
    // R44-15（四十四轮）：下限按工作区钳制（R1W-10 主窗先例同款 -8 余量）——小屏/
    // 高 DPI 工作区不足 760×500 时原硬下限让子窗出生即超工作区压任务栏
    minWidth: Math.min(760, wa.width - 8),
    minHeight: Math.min(500, wa.height - 8),
    title: '书架',
  })
  shelfWindow = win
  // R47-35（四十七轮）：closed 监听先于 await 挂接——dev 态 setProxy 耗时数十 ms，
  // 恰在此窗关窗则 closed 先于挂接触发，悬空引用已销毁窗口（isDestroyed 自愈重建
  // 兜底在，纯防御收口）；await 后复验存活再 loadURL（R48-16 起复验用局部引用）
  win.on('closed', () => {
    // R0910-W：异常隔离（同 attachRendererCrashSelfHeal）——引用置空不被前置监听抛错短路
    guardClosedCleanup('书架窗口引用置空', () => {
      if (shelfWindow === win) shelfWindow = null
    })
  })
  await devProxyApplied // R72-10（二十轮 D-7）：代理生效后再加载
  if (win.isDestroyed()) return
  // R74-16（七十四轮批 D）：loadURL promise 此前无人 catch——server 恰在此刻崩溃/
  // 端口失效时 rejection 成 unhandledRejection 丢诊断（与 child 侧 fatal 兜底口径
  // 不对称）；接日志留痕（窗口崩溃另有 R67-16 自愈，此处只补诊断）
  win.loadURL(`${appUrl}/shelf?win=shelf`).catch((e) => {
    log.error('desktop', `书架窗口加载失败（${appUrl}/shelf）`, e)
  })
}

/** 打开独立书库管理窗口（切换/最近/新建书库；单例聚焦）。*/
async function openLibraryWindow(): Promise<void> {
  // Y-12：同 openShelfWindow 的 appUrl 就绪守卫（R44-16：命中留痕不静默）
  if (!appUrl) {
    log.info('desktop', '书库窗口请求早于服务就绪（冷启动握手期），本次打开已忽略')
    return
  }
  if (libraryWindow && !libraryWindow.isDestroyed()) {
    libraryWindow.focus()
    return
  }
  const wa = screen.getPrimaryDisplay().workAreaSize
  const libW = Math.min(720, wa.width - 80)
  const libH = Math.min(560, wa.height - 80)
  // 初始位置：居中于主窗口（主窗口 bounds 中心 − 书库半宽/半高）
  let x: number | undefined
  let y: number | undefined
  if (mainWindow && !mainWindow.isDestroyed()) {
    const b = mainWindow.getBounds()
    x = Math.round(b.x + (b.width - libW) / 2)
    y = Math.round(b.y + (b.height - libH) / 2)
  }
  // R48-16（四十八轮）：同 openShelfWindow——createSecureWindow 后即捕获局部引用，
  // closed 监听（仍指向本窗才置 null）与 await 后复验均用局部
  const win = createSecureWindow({
    width: libW,
    height: libH,
    x,
    y,
    // R44-15（四十四轮）：同书架窗——下限按工作区钳制（R1W-10 主窗先例同款 -8 余量）
    minWidth: Math.min(560, wa.width - 8),
    minHeight: Math.min(440, wa.height - 8),
    title: '书库',
  })
  libraryWindow = win
  // R47-35（四十七轮）：closed 监听先于 await 挂接（openShelfWindow 同款——dev 态
  // setProxy 窗口内关窗的悬空引用防御收口）；await 后复验存活再 loadURL
  win.on('closed', () => {
    // R0910-W：异常隔离（同 attachRendererCrashSelfHeal）——引用置空不被前置监听抛错短路
    guardClosedCleanup('书库窗口引用置空', () => {
      if (libraryWindow === win) libraryWindow = null
    })
  })
  await devProxyApplied // R72-10（二十轮 D-7）：代理生效后再加载
  // R74-16（七十四轮批 D）：同 openShelfWindow——loadURL promise 接日志防丢诊断
  if (win.isDestroyed()) return
  win.loadURL(`${appUrl}/library?win=library`).catch((e) => {
    log.error('desktop', `书库窗口加载失败（${appUrl}/library）`, e)
  })
}

/** R44-2：close/quit 拦截里渲染层 flush 的总预算——本机服务下保存链毫秒级，预算只兜
 *  渲染层挂起/死循环（executeJavaScript 永不 resolve）不拖死关窗与退出。 */
const CLOSE_FLUSH_BUDGET_MS = 4_000

/** R50-A-2（五十轮）：context-menu 取消补发延迟——macOS NSMenu 先关菜单再派发
 *  action，click 可能晚于 popup 关闭回调不止一个宏任务拍（原 setTimeout(0) 的单拍
 *  竞窗里 null 取消常先到，渲染层 once 只认第一条 → 菜单动作被吞）。放宽到 100ms
 *  让 click 稳定抢先；取消回执晚 100ms 对渲染侧无感（只是收尾态）。 */
const CONTEXT_MENU_CANCEL_DELAY_MS = 100
/** R1010b-DSK-P3-6（2026-09-10 内存专项重审修复批）：取消补发 timer 句柄（模块级单槽）
 *  ——原 popup callback 内裸排 setTimeout 不留句柄：不可清、不可 unref，违本文件 timer
 *  纪律（R46-19 闭包持引用滞留 / R54-A-5 卫生），菜单连续开关时旧补发叠跑。排新清旧 +
 *  unref（不拖退出），消费点见 desktop:context-menu 的 popup callback。 */
let contextMenuCancelTimer: ReturnType<typeof setTimeout> | null = null

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
 *  flush + 预算」竞速单源——超时以哨兵 reject 分流（与 probeDirReachable 的
 *  PROBE_TIMEOUT 同款，替代此前各链「旗 + null 双信号」），并以 FLUSH_BUDGET_TIMEOUT
 *  哨兵回填结果，供调用方与 null（无钩子）分流、同权放行；race 落定即 clearTimeout
 * （R54-A-5 计时器卫生收编于此）。flushRendererBeforeClose 自吞异常不 reject，catch
 *  仅可能收到哨兵（非哨兵照抛，防御性）。 */
const FLUSH_BUDGET_TIMEOUT = Symbol('flush-budget-timeout')
async function flushRendererWithBudget(
  target: BrowserWindow,
  budgetMs: number,
): Promise<{ conflict: string[]; failed: string[] } | null | typeof FLUSH_BUDGET_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      flushRendererBeforeClose(target),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(FLUSH_BUDGET_TIMEOUT), budgetMs)
      }),
    ])
  } catch (e) {
    if (e !== FLUSH_BUDGET_TIMEOUT) throw e
    return FLUSH_BUDGET_TIMEOUT
  } finally {
    if (timer) clearTimeout(timer)
  }
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

/** R0910-W（2026-09-10 修复批）：真实 Electron 窗口循环冒烟——仅当
 *  CLW_SMOKE_WINDOW_CYCLE=1 时由 bootstrap 末段（[CLW_SMOKE] ready 之后）调用，
 *  保证 app 已 ready 再动窗口。目的：把 R0910-W 修复的缺陷类（closed 清理监听在
 *  销毁态 webContents 上抛错 → 中断 emit 遍历令其余清理/白名单摘除短路）由真实
 *  Electron 进程兜住——单测假件只能锁单测口径，真实销毁语义（closed 后读
 *  webContents 抛 "Object has been destroyed"）唯有真实进程可复现。
 *  复用 createSecureWindow 工厂：安全五件套 + trackWindow（白名单登记 + closed 摘除）
 *  与生产完全同链，不另起第二份安全配置。
 *  契约输出串（CI 驱动 grep 硬绑定，勿改）：成功 [CLW_SMOKE] window-cycle-ok
 *  （exit 0）；超时 [CLW_SMOKE] window-cycle-timeout（exit 非 0）；未捕获异常
 *  [CLW_SMOKE] crash <message>（经 uncaughtException 首行，见其处理器）。
 *  严格 opt-in：env 未设置为 '1' 时本函数零调用（不建窗/不打日志/不改时序）。 */
const SMOKE_WINDOW_CYCLE_TIMEOUT_MS = 15_000
function runSmokeWindowCycle(): void {
  // 基线：冒烟态此刻仅主窗在白名单——关窗后应回落至此值
  const baseline = __testHooks.trustedSenderCount()
  let settled = false
  const finish = (code: number, line: string): void => {
    if (settled) return // 超时/关闭/加载失败多路可能竞速，只认首个落定
    settled = true
    clearTimeout(hardTimeout)
    console.log(line)
    app.exit(code)
  }
  // 有界超时：窗口关闭链若被炸穿（本冒烟正是要兜的缺陷类），不能钉死 CI
  const hardTimeout = setTimeout(() => finish(1, '[CLW_SMOKE] window-cycle-timeout'), SMOKE_WINDOW_CYCLE_TIMEOUT_MS)
  hardTimeout.unref?.()
  try {
    // 复用生产工厂（安全选项零重复）；show:false 无窗口闪现，适合 headless
    const probe = createSecureWindow({ show: false, title: 'smoke-window-cycle' })
    // 先捕获局部 wc 引用——窗口销毁后读 probe.webContents 会抛（R0910-W 根因形态）
    const wc = probe.webContents
    probe.on('closed', () => {
      // closed emit 已同步跑完 trackWindow 摘除等清理；延迟一拍让 Electron 侧销毁落定
      setTimeout(() => {
        try {
          if (!probe.isDestroyed()) return finish(1, '[CLW_SMOKE] window-cycle-fail')
          if (__testHooks.hasTrustedSender(wc)) return finish(1, '[CLW_SMOKE] window-cycle-fail') // 白名单登记未摘除
          if (__testHooks.trustedSenderCount() !== baseline) return finish(1, '[CLW_SMOKE] window-cycle-fail')
          finish(0, '[CLW_SMOKE] window-cycle-ok')
        } catch (e) {
          log.error('desktop', '冒烟窗口循环：关闭后校验异常', e)
          finish(1, '[CLW_SMOKE] window-cycle-fail')
        }
      }, 200)
    })
    // about:blank 不依赖 server（裸 Electron 进程亦可跑通）；加载落定后再关
    void probe.loadURL('about:blank').then(
      () => probe.close(),
      (e) => {
        log.error('desktop', '冒烟窗口循环：about:blank 加载失败', e)
        finish(1, '[CLW_SMOKE] window-cycle-fail')
      },
    )
  } catch (e) {
    log.error('desktop', '冒烟窗口循环：创建窗口失败', e)
    finish(1, '[CLW_SMOKE] window-cycle-fail')
  }
}

async function bootstrap(): Promise<void> {
  // 工作目录定位：持久化 current（合法书库 或 决策②待建空目录，目录存在即用）> findWorkDir(cwd)
  // 不再启动时弹原生选择器：无书库 → 主窗口加载 /welcome 起始页引导新建 / 打开。
  const store = readStore()
  // R1010-P2-1（2026-09-10 全量重评 GLM-5.3 修复批）：recent 失效过滤在此异步预算一次
  // 执行——原 readStore 首读内联同步过滤（existsSync+statSync 逐条），recent 残留失联
  // 网络卷时 bootstrap 首行即同步冻主进程数十秒；重审-1 probeDirReachable 防线只护
  // current/cwd，recent 条目在防线外。超时项保留展示（失联≠失效，择库守卫预探拦截
  // 兜底，R48-73 取舍口径不变）；并行预算 ≤ MAX_RECENT 条，总延迟 = 单条预算。
  // 此处先于任何 IPC 注册（下方 registerIpc 在窗口就绪后），早读窗口不存在。
  if (store.recent.length > 0) {
    storeCache = await filterValidRecentBudgeted(store, { timeoutMs: BOOTSTRAP_PROBE_TIMEOUT_MS })
  }
  let workDir: string | null = null
  // R72-10（二十轮 D-1）：持久化 workDir 由仅 existsSync 改目录校验——指向普通文件时
  // 原样采信会静默空书架无引导；失效回落 findWorkDir(cwd)，仍无 → /welcome 引导
  // 重审-1（2026-09-07 全量代码重审 §四.1）：current 先经可达性预探——指向失联网络卷
  // （挂载点在服务器无响应态）时，下方 statSync 单点即可同步冻主进程数十秒
  // （R54-A-2 切库同族的启动侧入口）。'unreachable' 原生错误框留痕 + 回落发现链
  // （不退出——作者可切到可用书库）；'invalid'（确定性坏路径）与预探通过后的瞬断
  // 均维持原回落语义（TOCTOU 残窗与切库预探同口径收窄，非消灭）。
  if (store.current) {
    const reach = await probeDirReachable(store.current, BOOTSTRAP_PROBE_TIMEOUT_MS)
    if (reach === 'ok') {
      try {
        if (statSync(store.current).isDirectory()) workDir = store.current
      } catch {
        /* 预探通过后的瞬断 → 走回落 */
      }
    } else if (reach === 'unreachable') {
      dialog.showErrorBox(
        '书库目录无响应',
        `上次的书库目录暂不可达（可能是网络卷无响应或已断开）：\n${store.current}\n\n本次启动改为自动寻找可用书库；恢复挂载后可在「书库管理」切回。`,
      )
    }
  }
  if (!workDir) {
    // 重审-1 同款防线：findWorkDir 同步爬祖扫描——cwd 也在失联卷上时同样冻结主进程，
    // 预探不可达即跳过发现（workDir 留 null → /welcome 引导，维持「启动零弹选择器」口径）
    if ((await probeDirReachable(process.cwd(), BOOTSTRAP_PROBE_TIMEOUT_MS)) !== 'unreachable') {
      workDir = findWorkDir(process.cwd())
    } else {
      dialog.showErrorBox('运行目录无响应', '应用运行目录暂不可达（可能位于已断开的网络卷），本次启动进入引导页；恢复挂载后重启应用即可。')
    }
  }
  // P5-服务端（第七轮）：记录 bootstrap 实际采用的 workDir——before-quit 原先回读
  // readStore().current，store.current 为 null/失效而 workDir 由 findWorkDir 发现时，
  // 退出拿到 null：不 abort 任何在途 chat/self-heal、不等后台任务（孤儿会话只能靠
  // 10 分钟宽限修复）。退出以启动时实际值优先，store 回读兜底
  // R47-9（四十七轮）：welcome 态 workDir 可为 null，currentWorkDir 的 ?? 兜底因此
  // 走 readStore——缓存（见 readStore 注）就位后该兜底零盘 IO，null/'' 语义维持原状
  bootstrappedWorkDir = workDir
  const needsWelcome = !workDir

  // HMR 开发模式：CLW_DEV_UI=1 时加载 Vite dev server（localhost:5173），前端改动实时热更新；
  // 不起 server，API 由独立 dev:api(7878) 提供（Vite proxy 转发）。IPC/preload 照常，桌面能力完整。
  // R43-26（四十三轮）：dev 环境变量防线——devUi 真值判断要求非打包态（app.isPackaged）：
  // 打包应用吃到宿主残留 CLW_DEV_UI=1 不再切 HMR 形态（localhost:5173 + 跳过 server fork）
  const devUi = !!process.env['CLW_DEV_UI'] && !app.isPackaged // R62-45：bracket 统一风格
  // R50-A-1（五十轮）：本 bootstrap 轮是否 fork 了 studio server——session-end 观察
  // 窗自愈据它判「dev HMR 态只复位旗、不拉服务」（dev 态 API 由独立 dev:api 进程供给）
  let serverStarted = false
  if (devUi) {
    appUrl = 'http://localhost:5173'
  } else {
    // RB-SV-P2-4：--book 直进——argv 解析为登记书名仍在 main（书架登记表就在手边），
    // 下沉为 --book 参数由 child 在 startServer 前调 setInitialBook（U-1 附带；
    // dev HMR 态不起 server，boot 由独立 dev-api 提供，此项不生效）
    let initialName: string | null = null
    if (workDir) {
      // R53-A-3（五十三轮）：env 回落仅非打包态生效——打包态宿主残留 CLWRITING_INITIAL_BOOK
      // 不再让普通启动被意外直达（R43-26 devUi 防线同款口径）
      const ref = initialBookArg(process.argv, { allowEnvFallback: !app.isPackaged })
      if (ref) initialName = resolveInitialBook(workDir, ref)
    }
    // 阶段 22 批 U1：fork server-utility 子进程 + ready 端口握手（时序等价拆分前的
    // await listenPort——loadURL 仍发生在 server ready 之后，验收门 2）
    let port: number
    try {
      port = await serverManager.start({
        workDir,
        userDataPath: app.getPath('userData'),
        book: initialName,
        mirrorConsole: !app.isPackaged,
      })
      serverStarted = true // R50-A-1：session-end 观察窗自愈的「有服务可拉回」判据
    } catch (e) {
      // 时序 2（仅首次启动）：boot-error（如 EADDRINUSE）→ 原生错误对话框（复用
      // server-main 拆分前中文口径）→ 上抛走 onError app.quit()
      if (e instanceof ServerBootError) {
        dialog.showErrorBox('CLWriting 服务启动失败', `${e.message}\n\n应用即将退出。`)
      }
      throw e
    }
    appUrl = `http://127.0.0.1:${port}`
  }

  // 主窗口 bounds：优先恢复上次尺寸/位置，无记录时默认 1532×1237
  // （三栏 + 编辑区留白充足），小屏按工作区 -80px 兜底；min 1200×760 保三栏不挤。
  const saved = loadWinState()
  const wa = screen.getPrimaryDisplay().workAreaSize
  const winW = saved?.bounds.width ?? Math.min(1532, wa.width - 80)
  const winH = saved?.bounds.height ?? Math.min(1237, wa.height - 80)
  mainWindow = createSecureWindow({
    width: winW,
    height: winH,
    x: saved?.bounds.x,
    y: saved?.bounds.y,
    // R1W-10（win 平台专项复审 R1）：下限不得超过可用工作区——1366×768（工作区
    // ≈728px）上原 760 硬下限让窗口出生即压任务栏；大屏产品意图（1200×760 保三栏
    // 不挤）原样保留，仅在小屏按可用空间收口。恢复侧 WIN_MIN_HEIGHT 随行收口。
    minWidth: Math.min(1200, wa.width - 8),
    minHeight: Math.min(760, wa.height - 8),
    title: 'CLWriting',
  })
  if (saved?.maximized) mainWindow.maximize()
  // R44-2（四十四轮）：关窗兜底——首轮 close 先 preventDefault，经渲染层钩子异步
  // flush（页面未死，异步保存链全通）落定/短超时后 destroy() 真正关窗（destroy 不再
  // 触发 beforeunload，链路单次不循环）。退出链（before-quit）已先行 flush 并在收口
  // destroy 全窗，session-end 时间窗有限，两者都直接放行。
  // R49-5（评审四十九轮）：在途旗（closeFlushInFlight/quitFlushInFlight）与 quit 汇入
  // 旗（quitDuringCloseFlush）为模块级——原 closeFlushInFlight 居本闭包、quit 链旗居
  // 生命周期 if 块，两链互不可见才撞出双 flush；复位闸从「cancel 路径手工复位」改为
  // 链路收尾统一复位（destroy 后 close 不再触发，复位无副作用），并兼作 quit 汇入点。
  mainWindow.on('close', (e) => {
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
      const win = mainWindow
      if (!win || win.isDestroyed()) {
        // R49-5：退化形态（窗口先于本链销毁）也复位，防在途旗卡死后续 quit 汇入
        closeFlushInFlight = false
        return
      }
      // R54-A-1（五十四轮）：超时与「无钩子/渲染层不可达」此前同落 res===null 静默
      // destroy——保存链慢盘/server 退避窗下超时窗内的最后键入静默丢失且零诊断线索
      //（session-end 链 R53-A-1 已有留痕，三链不对称可证非设计）；超时态补 warn。
      // R54 复审顺手项①：race 收敛 flushRendererWithBudget 单源（哨兵分流超时 +
      // 落定即清理计时器——R54-A-5 卫生随函数收编），超时/无钩子两态日志见下；
      // 哨兵归一化回 null 后进下游（conflict/failed 守卫沿用 null 假值语义）。
      const raced = await flushRendererWithBudget(win, CLOSE_FLUSH_BUDGET_MS)
      const res = raced === FLUSH_BUDGET_TIMEOUT ? null : raced
      if (raced === FLUSH_BUDGET_TIMEOUT) {
        log.warn('desktop', `关窗兜底 flush 超时（≥${CLOSE_FLUSH_BUDGET_MS}ms）未落定即关窗——超时窗内未保存的键入可能丢失`)
      } else if (raced === null) {
        log.info('desktop', '关窗兜底 flush 无钩子/渲染层不可达（非编辑页常态），直接关窗')
      }
      // R1010b-DSK-P2-1（2026-09-10 内存专项重审修复批）：flush 落定后补停机复查——
      // 上方首行闸只护「close 事件到达时旗已置位」，护不住「close 先到 → flush 在途 →
      // 旗后置」竞窗：红叉 → flush 在途 → OS 关机触发 session-end 置 sessionEnding →
      // flush 随后落定 → 同步确认框在 OS 会话收尾有限窗口内弹出，进程被钉死到强杀
      //（R53-A-1「停机窗口内无人可答」同因，该口径此前只落在 session-end 链自身，未
      // 回灌 close 链）。三种时序：① sessionEnding（OS 关机/注销收尾在途）——确认
      // 无人可答，必须跳过；② appTearingDown（before-quit 链已自行 flush+确认全过、
      // 置位进入停机收尾，将统一 destroy 全窗）——交互权在 quit 链，close 链不重复
      // 询问；③ 两旗皆假——正常关窗，确认照旧。命中即 warn 留痕未落净清单（对齐
      // R53-A-1「只留痕不弹窗」）后直落下方 destroy 收口。
      const skipConfirms = sessionEnding || appTearingDown
      if (skipConfirms && res && (res.conflict.length > 0 || res.failed.length > 0)) {
        log.warn(
          'desktop',
          `关窗兜底 flush 落定但${sessionEnding ? 'OS 停机' : '应用退出收尾'}已在途，跳过冲突/失败确认直接关窗（停机窗口内无人可答）：冲突 ${res.conflict.length} 个、保存失败 ${res.failed.length} 个`,
        )
      }
      if (res && res.conflict.length > 0 && !win.isDestroyed() && !skipConfirms) {
        // R44-19（四十四轮）收口：冲突未决的本地修改无法代存，原生确认给作者最后一念
        if (!confirmDiscardConflicts(win, res.conflict.length)) {
          closeFlushInFlight = false
          // R49-5：作者放弃关窗 → 待汇入的退出请求一并作废（与 quit 链自身 cancel
          // 「取消即中止退出、应用原样保留」语义一致）
          quitDuringCloseFlush = false
          return
        }
      }
      if (res && res.failed.length > 0 && !win.isDestroyed() && !skipConfirms) {
        // 重评-1（全库代码重评审 2026-09-05）：保存失败（failed = 保存失败的 docId
        // 列表）与冲突同属「flush 未落净」——原实现 failed 零消费，保存失败恰逢
        // 关窗时编辑增量静默丢失。先留痕失败清单（只是文档 id，供诊断），再弹原生
        // 确认给作者最后一念；取消路径与冲突取消完全同款（旗复位 + 待汇入退出作废）
        log.error('desktop', `关窗兜底 flush 有 ${res.failed.length} 个文档保存失败（${res.failed.join(', ')}），需作者确认是否放弃未落盘修改`)
        if (!confirmDiscardFailed(win, res.failed.length)) {
          closeFlushInFlight = false
          quitDuringCloseFlush = false
          return
        }
      }
      try {
        if (!win.isDestroyed()) win.destroy()
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
  mainWindow.on('session-end', () => {
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
      const win = mainWindow
      if (!win || win.isDestroyed()) return
      // R54 复审顺手项①：race 收敛 flushRendererWithBudget 单源（超时哨兵/落定清理，
      // R54-A-5 卫生随函数收编）；未落定（无钩子/超时）恒 info，尽力而为不拖停机。
      const res = await flushRendererWithBudget(win, SESSION_END_FLUSH_BUDGET_MS)
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
      if (!serverStarted) return // dev HMR 态无 server（API 由独立 dev:api 进程供给）
      if (!mainWindow || mainWindow.isDestroyed()) return // 窗已不在：退出链接管，不白 fork
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
  mainWindow.on('focus', () => {
    if (libraryWindow && !libraryWindow.isDestroyed()) {
      libraryWindow.close()
    }
  })
  mainWindow.on('closed', () => {
    // R0910-W：异常隔离——本监听承载退出链（app.quit），不得被任何前置 closed 监听
    // 抛错短路；此处自身异常也只留痕（交 uncaughtException 兜底），不静默取消退出。
    guardClosedCleanup('主窗口退出链', () => {
      mainWindow = null
      // 主窗口是应用核心：关闭即退出（连带销毁书架/书库子窗口，杜绝孤儿窗口 / 僵尸进程）
      app.quit()
    })
  })
  // 专注模式全屏反向同步：作者经系统手势（⌘⌃F/绿按钮）退出全屏时通知渲染层
  //（渲染层据此连带退出专注模式）。只回发事实，不在主进程持有专注语义。
  // 与 render-process-gone 同款：捕获局部 win，闭包不追迟来的 mainWindow 置空。
  const fsWin = mainWindow
  mainWindow.on('enter-full-screen', () => {
    if (!fsWin.isDestroyed()) fsWin.webContents.send('desktop:fullscreen-change', true)
  })
  mainWindow.on('leave-full-screen', () => {
    if (!fsWin.isDestroyed()) fsWin.webContents.send('desktop:fullscreen-change', false)
  })
  // R1010-P3（G7-③）：preload-error 监听移入 createSecureWindow 工厂（三窗同享，
  // 带窗口名）——原主窗专属块随此删除。
  // R67-16（十五轮）：渲染崩溃自愈已随 createSecureWindow 工厂挂载（原主窗专属块
  // 删除——attachRendererCrashSelfHeal 原样承接 dd-P3/X-26 退避 + S6 稳定复位），
  // 书架/书库子窗口同享。R1010-P3（G7-③）：preload-error 监听亦随工厂挂载（下方
  // 原主窗专属块删除），三窗同享。
  // 纵深防御监听与 dev 代理已由 createSecureWindow 统一挂载；此处 await 一次保证
  // 主窗首载前代理确定生效（工厂内是 fire-and-forget，此处 loadURL 前须确定）
  // R32-24（三十二轮）：工厂侧 setProxy 失败仅降级留日志（见 createSecureWindow），
  // 此处裸 await 同因异果——失败会炸启动。补 catch 降级（dev 代理缺 direct:// 归零
  // 只影响 HMR 场景的代理一致性，不阻断首载），与工厂侧同口径。
  if (devUi) {
    // R32-24（三十二轮）：工厂侧 setProxy 失败仅降级留日志（见 createSecureWindow），
    // 此处裸 await 同因异果——失败会炸启动。补 catch 降级（dev 代理缺 direct:// 归零
    // 只影响 HMR 场景的代理一致性，不阻断首载），与工厂侧同口径。
    //（win 线 R33-65 同因独立修复，代码同形，合并取一份。）
    try {
      await mainWindow.webContents.session.setProxy({ proxyRules: 'direct://' })
    } catch (e) {
      log.warn('desktop', `dev 代理归零失败（继续首载）：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // R60-B-1（六十轮）：主窗 loadURL 本地留痕——ready 回传后、首载落定前 server 崩溃
  //（退避重启窗）的窄竞 rejection 此前直穿 bootstrap reject，onError 只见「启动失败」
  // 一行、缺首载 URL 现场（书架/书库窗 R74-16 均已 .catch 留痕，唯主窗裸奔，不对称）。
  // 镜像补 catch 记日志后仍原样上抛——「bootstrap reject → 启动失败 + quit」为固化
  // 设计路径（main.test 时序 2；bootstrap-runner 第九轮 L-3 亦按此失败面设计），不吞。
  const mainUrl = needsWelcome ? `${appUrl}/welcome` : appUrl
  try {
    await mainWindow.loadURL(mainUrl)
  } catch (e) {
    log.error('desktop', `主窗口加载失败（${mainUrl}）`, e)
    throw e
  }
  // L1（二轮复审）：改走 logger——打包态 mirrorConsole=false，console.log 此前在生产
  // 完全不可见（终端无人看、又不进 JSONL 日志）
  log.info('desktop', `CLWriting ${devUi ? 'dev（HMR）' : '桌面版'}已启动 → ${appUrl}${needsWelcome ? '/welcome' : ''}`)
  // R73-53（二十一轮）：启动完成的结构化标记——desktop.yml 启动冒烟 grep 此判定用
  // （一行 ASCII、无中文措辞依赖）。直写 console：打包态 log.* 只落 JSONL 不镜像
  // stdout，冒烟步重定向的是进程标准流
  console.log('[CLW_SMOKE] ready')
  // R0910-W：真实 Electron 窗口循环冒烟（严格 opt-in）——app ready 且主窗首载落定后
  // 才跑；env 未设为 '1' 时零调用（不建窗/不打日志/不改时序，生产行为逐字节不变）。
  if (process.env['CLW_SMOKE_WINDOW_CYCLE'] === '1') {
    runSmokeWindowCycle()
  }
}

// ── IPC（供 preload 调用）──────────────────────────────

// O-11（第十三轮）：IPC 响应回程窗口——handle 返回值需先送达渲染进程再 relaunch
//（quit 链会销毁 webContents，响应晚到前端拿到 undefined）；100ms 为覆盖慢机往返的
// 经验值（原两处裸魔数收编单源），改小前先在慢机实测。
const RELAUNCH_DELAY_MS = 100

function registerIpc(): void {
  // 弹选择器打开书库
  ipcMain.handle('desktop:open-library', async (e) => {
    if (!isTrustedSender(e)) return
    const picked = await pickLibrary()
    if (!picked) return { ok: false as const, canceled: true as const }
    // R51-A-4（五十一轮）：落库失败转契约化失败，不再裸抛绕过 {ok,reason} 信封
    // R59 清偿批（R55-A-3）：改切库链专用包装——快照武装回滚基线（取消退出可回写）
    const saveErr = saveCurrentArmingRollback(picked)
    if (saveErr) return { ok: false as const, reason: saveErr }
    setTimeout(relaunch, RELAUNCH_DELAY_MS) // 延迟重启，让响应先回渲染进程
    return { ok: true as const }
  })
  // 切换到最近列表中的书库
  ipcMain.handle('desktop:switch-library', async (e, path: unknown) => {
    if (!isTrustedSender(e)) return
    // R54-A-2（五十四轮）：可达性预探先行——失联网络卷残留条目不再冻结主进程（见
    // probeDirReachable 注）；超时态契约化拒切，确定性失败交回同步守卫走原契约文案
    if (typeof path !== 'string') {
      return { ok: false as const, reason: '目录无效或是另一书库的子目录' }
    }
    if ((await probeDirReachable(path)) === 'unreachable') {
      return { ok: false as const, reason: '目录暂不可达（可能是网络卷无响应或已断开），请稍后重试' }
    }
    // R41-1：守卫改 canSwitchLibraryDir（bootstrap 接受面 + 他库子目录防线）——
    // 待建空书库不再被误拒（原 reason「目录无效或不是书库」的分叉口径随行废止）
    if (!canSwitchLibraryDir(path)) {
      return { ok: false as const, reason: '目录无效或是另一书库的子目录' }
    }
    // 平台规范化批 E：切书库同过大小写敏感卷警告（探测失败 fail-open 不拦）
    if (await warnIfCaseSensitive(path)) {
      return { ok: false as const, reason: '已取消：目录在大小写敏感的卷上（如需使用请重新切换并选择「仍要使用」）' }
    }
    // R51-A-4（五十一轮）：落库失败转契约化失败（同 open-library），不触发 relaunch
    // R59 清偿批（R55-A-3）：改切库链专用包装——快照武装回滚基线（取消退出可回写）
    const saveErr = saveCurrentArmingRollback(path)
    if (saveErr) return { ok: false as const, reason: saveErr }
    setTimeout(relaunch, RELAUNCH_DELAY_MS)
    return { ok: true as const }
  })
  // R48-73（四十八轮）：recent 缓存首读过滤后运行期不复验（取舍备案见 readStore 头
  // 注——失效目录残留展示至重启，切换守卫 canSwitchLibraryDir 拦截兜底）
  ipcMain.handle('desktop:get-recent', (e) => {
    if (!isTrustedSender(e)) return
    return readStore().recent
  })
  // Y-11（第五十七轮）：M-3 第五入口漏网——改走 currentWorkDir()（bootstrap 实际值
  // 优先），否则 store.current 为 null/失效而 bootstrap 跑在 findWorkDir 发现的书库上时，
  // 书库管理窗口拿到与实际运行不一致的展示口径
  ipcMain.handle('desktop:get-current', (e) => {
    if (!isTrustedSender(e)) return
    return currentWorkDir()
  })
  // 在系统文件管理器中显示文档（electron only；浏览器版前端隐藏此项）
  // 重审-2（2026-09-07 全量代码重审 §四.2）：三入口（show-in-folder/open-book-dir/
  // open-library-dir）readBooks/realpathSync 同步扫书库——书库在失联网络卷时一点
  // 即冻主进程（R54-A-2/R61-B-1 切库链同款防线补齐）：handler 改 async，先经
  // probeDirReachable 预探，'unreachable' 原生错误框 + return（'invalid' 落回原
  // 静默守卫语义——readBooks/realpath 失败本就按「无物可开」收口）。
  ipcMain.handle('desktop:show-in-folder', async (e, bookName: unknown, relPath: unknown) => {
    if (!isTrustedSender(e)) return
    if (typeof bookName !== 'string' || typeof relPath !== 'string') return
    if (relPath.includes('\0')) return
    const workDir = currentWorkDir() // M-3（第八轮）：bootstrap 实际值优先
    if (!workDir) return
    if ((await probeDirReachable(workDir)) === 'unreachable') {
      dialog.showErrorBox('目录无响应', '书库目录暂不可达（可能是网络卷无响应或已断开），请稍后重试。')
      return
    }
    const entry = readBooks(workDir).find((b) => b.name === bookName)
    if (!entry) return
    // 防路径穿越：relPath 必须落在 bookRoot 内（批 6 统一：resolveWithinRoot =
    // resolve/relative 防穿越 + symlink 双侧 realpath 校验，存在时 abs 即 realpath）
    const bookRoot = resolve(workDir, entry.path)
    // 防 books.jsonl 被篡改致 bookRoot 越出 workDir（与 open-book-dir 同口径）
    if (!resolveWithinRoot(workDir, entry.path)) return
    const safe = resolveWithinRoot(bookRoot, relPath)
    if (!safe) return
    // 目标存在才可在文件管理器中显示（abs 已是 realpath，无需再解析）
    if (existsSync(safe.abs)) shell.showItemInFolder(safe.abs)
  })
  // 在系统文件管理器中打开书库根目录（设置弹窗「打开书库目录」入口；浏览器版前端隐藏）
  // 重审-2：同 show-in-folder——readBooks 同步扫书库前的失联卷预探
  ipcMain.handle('desktop:open-book-dir', async (e, bookName: unknown) => {
    if (!isTrustedSender(e)) return
    if (typeof bookName !== 'string' || bookName.includes('\0')) return
    const workDir = currentWorkDir() // M-3（第八轮）：bootstrap 实际值优先
    if (!workDir) return
    if ((await probeDirReachable(workDir)) === 'unreachable') {
      dialog.showErrorBox('目录无响应', '书库目录暂不可达（可能是网络卷无响应或已断开），请稍后重试。')
      return
    }
    const entry = readBooks(workDir).find((b) => b.name === bookName)
    if (!entry) return
    // 路径校验：entry.path 来自 books.jsonl，防 `..`/symlink 越出 workDir 打开任意目录
    // （批 6 统一：resolveWithinRoot = 防穿越 + symlink 双侧 realpath，X-P3a 同口径）
    const safe = resolveWithinRoot(workDir, entry.path)
    if (!safe || !existsSync(safe.abs)) return // realpath 失败/不存在 = 无物可开
    void shell.openPath(safe.abs)
  })
  // 枚举系统已装字体（设置弹窗字体下拉用；font-list 跨平台封装系统命令，disableQuoting 返回裸名便于直拼 CSS）
  // R77-1（二十五轮批 A）：TTL 缓存降半档——系统字体枚举是跨平台系统命令（mac 自带
  // 二进制 / win PowerShell），渲染层重载（设置弹窗重开）/第二窗口重复 invoke 会逐次
  // 重跑；主进程侧补 60s TTL + 在途合并（font-cache.ts）。失败不缓存，此处 catch 返回
  // [] 的兜底语义不变。
  // MP2-1（专项重评二轮修复批）：win 走自绘枚举——font-list 上游 getByPowerShell 经
  // cmd.exe exec 未设 windowsHide，win 打包态打开字体下拉闪控制台黑窗；win-fonts.ts
  // 以 spawn('powershell.exe', [args], { windowsHide: true }) 直起（口径对齐 font-list
  // 的 disableQuoting 裸名），mac/linux 维持 font-list（无闪窗面）。
  // R40-28（四十轮）：mac/linux 的 font-list 调用包超时（win 已走 win-fonts 自带
  // 10s 超时 + kill，R39-5）——osascript/系统命令挂起时字体下拉悬死；font-list 不
  // 暴露子进程句柄，超时只 reject 不 kill（残留记档见 font-cache.ts 头注）。
  // R48-17（四十八轮）备案：本处不传 deps——PM-12 的「超时必杀」（deps.command 自管
  // spawn）生产不可达，mac/linux 超时仍只放弃等待、孤儿进程残留未收口，接线待台账
  // PM-12 拍板（mac asar 路径需打包态验证），不代办拍板项；会话级熔断生产已生效
  //（fontListWithTimeout 缺省路径即包裹，R48-74 起 win 侧 listWindowsFonts 亦套用）。
  const loadFontList = () =>
    process.platform === 'win32' ? listWindowsFonts() : fontListWithTimeout(() => getSystemFontList({ disableQuoting: true }))
  const loadSystemFonts = createSystemFontCache(loadFontList)
  ipcMain.handle('desktop:get-system-fonts', async (e) => {
    if (!isTrustedSender(e)) return
    try {
      return await loadSystemFonts()
    } catch (e) {
      log.error('desktop', `get-system-fonts 失败：${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  })
  // 打开独立书架窗口（ribbon 书架按钮调用）
  ipcMain.handle('desktop:open-shelf', (e) => {
    if (!isTrustedSender(e)) return
    // R30-24（三十轮）：openShelfWindow 是 async（内部 await devProxyApplied）——此前
    // fire-and-forget 裸调，窗工厂早期抛错成主进程 unhandledRejection 丢诊断。对齐
    // R74-16 的 loadURL 口径：promise 接日志留痕（handler 同步返回，invoke 端不悬等待、
    // 错误不外抛到渲染层，窗口崩溃另有 R67-16 自愈兜底）
    openShelfWindow().catch((e) => {
      log.error('desktop', `书架窗口打开失败`, e)
    })
  })
  // 书架窗口选书 → 主窗口加载该书并聚焦，关闭书架窗口
  ipcMain.handle('desktop:open-book', (e, name: unknown) => {
    if (!isTrustedSender(e)) return
    if (typeof name !== 'string') return
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop:navigate', `/book/${encodeURIComponent(name)}`)
      mainWindow.focus()
    }
    if (shelfWindow && !shelfWindow.isDestroyed()) {
      shelfWindow.close()
    }
  })
  // 打开独立书库管理窗口（ribbon 书库按钮调用）
  ipcMain.handle('desktop:open-library-window', (e) => {
    if (!isTrustedSender(e)) return
    // R30-24（三十轮）：同 open-shelf——async 工厂 promise 接日志，防 unhandledRejection
    openLibraryWindow().catch((e) => {
      log.error('desktop', `书库管理窗口打开失败`, e)
    })
  })
  // 在系统文件管理器中打开当前书库根目录
  // 重审-2：同 show-in-folder——realpathSync 同步解析前的失联卷预探
  ipcMain.handle('desktop:open-library-dir', async (e) => {
    if (!isTrustedSender(e)) return
    const workDir = currentWorkDir() // M-3（第八轮）：bootstrap 实际值优先
    if (!workDir) return
    if ((await probeDirReachable(workDir)) === 'unreachable') {
      dialog.showErrorBox('目录无响应', '书库目录暂不可达（可能是网络卷无响应或已断开），请稍后重试。')
      return
    }
    // ii 批：与 open-book-dir 同口径——realpath 解析后再开（store.current 持久化值若被
    // 改成指向外部的 symlink/失效路径，不再原样透传给 shell.openPath）
    try {
      void shell.openPath(realpathSync(workDir))
    } catch {
      // realpath 失败 = 目录不存在，无物可开
    }
  })
  // ── 原生右键菜单 ──
  ipcMain.on('desktop:context-menu', (event, specs: unknown) => {
    if (!isTrustedSender(event)) return
    // R64-29（十二轮）：补 isDestroyed——fromWebContents 命中与 menu.popup 之间存在
    // 微窗口，窗口关闭后 popup 同步抛「Object has been destroyed」（对齐 663-664 行
    // set-fullscreen 守卫）
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    // RB-SV-P2-5：载荷形状校验前置——非数组/无合法项整体忽略（弹不了菜单但不崩主进程）
    const items = parseContextMenuSpecs(specs)
    if (!items || items.length === 0) return
    let sent = false
    function sendOnce(key: string | null): void {
      if (sent) return
      sent = true
      // N-4（第十二轮）：菜单滞留期间窗口可被关闭（click 晚于菜单关闭、popup 回调的
      // setTimeout 也晚一拍）——webContents 随窗销毁后再 send 会抛「Object has been
      // destroyed」（判 send 的目标本体 event.sender，比 win 更精确；同文件
      // second-instance/open-book 的 isDestroyed 守卫同款）
      if (event.sender.isDestroyed()) return
      event.sender.send('desktop:context-menu-select', key)
    }
    function build(s: ContextMenuSpec): MenuItemConstructorOptions {
      if (s.separator) return { type: 'separator' }
      const item: MenuItemConstructorOptions = {
        label: s.label,
        enabled: s.disabled !== true,
        click: () => { sendOnce(s.key ?? null) },
      }
      if (s.accelerator) item.accelerator = s.accelerator
      if (s.submenu && s.submenu.length) item.submenu = s.submenu.map(build)
      return item
    }
    const menu = Menu.buildFromTemplate(items.map(build))
    // popup 非阻塞：菜单关闭走 callback，点选走 click。macOS 下 NSMenu 先关
    // 菜单再派发 action，click 可能晚于 callback——callback 里延迟补发 null（取消），
    // 给 click 抢先 sendOnce 的机会（延迟宽度见 CONTEXT_MENU_CANCEL_DELAY_MS 头注，
    // R50-A-2：0ms 单拍竞窗实测可被 NSMenu 迟派发穿透）。渲染侧是
    // ipcRenderer.once，只认第一条消息，抢先发 null 会吞掉整个菜单动作。
    menu.popup({
      window: win,
      callback: () => {
        // R1010b-DSK-P3-6：排新清旧 + unref（句柄纪律见 contextMenuCancelTimer 声明处）
        if (contextMenuCancelTimer) clearTimeout(contextMenuCancelTimer)
        contextMenuCancelTimer = setTimeout(() => {
          contextMenuCancelTimer = null
          sendOnce(null)
        }, CONTEXT_MENU_CANCEL_DELAY_MS)
        contextMenuCancelTimer.unref?.()
      },
    })
  })
  // ── 专注模式全屏 ──
  // 渲染层进入/退出专注时驱动原生全屏。不走 HTML5 Fullscreen API：菜单加速键路径
  // 在渲染层无用户手势会被拒，setFullScreen 无此限制。作用于发起调用的窗口本体。
  ipcMain.handle('desktop:set-fullscreen', (event, flag: unknown) => {
    if (!isTrustedSender(event)) return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    win.setFullScreen(flag === true)
  })
  // ── win 窗控 overlay 颜色随主题（J5，2026-08-29）──
  // 无框标题栏的系统窗控底色须与顶栏一致（light #f6f6f6 / dark #262626）；主题切换时
  // 渲染层经此 IPC 改发起窗口的 overlay。非 win（含 mac）no-op；参数非字符串忽略。
  ipcMain.handle(
    'desktop:set-titlebar-overlay',
    (event, o: { color?: unknown; symbolColor?: unknown; dark?: unknown }) => {
      if (!isTrustedSender(event)) return
      // R74-21（七十四轮批 D）：颜色格式白名单——此前只验 typeof，任意长/任意内容
      // 字符串直达 Electron setTitleBarOverlay 靠内部抛错兜底（catch 吞掉无痕）。
      // 只认 #RGB/#RGBA/#RRGGBB/#RRGGBBAA 形态 + 字面量 'transparent'
      // （2026-08-31 窗控底色改透明后主题切换仍需合法通过），白名单外回显式错误；
      // 校验置于平台守卫前，与 isInvalidBookName 的「跨平台统一拒绝」口径一致
      //（mac 上也拦，行为一致更简单且可测）
      // R38-20（三十八轮）：原 {3,8} 放行 5/7 位非法 hex（如 #12345——Electron 内部
      // 校验抛错被 catch 吞、深浅色切换静默失效），收紧为 CSS 合法位数集合 3/4/6/8。
      const hexColor = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
      const validColor = (v: unknown): v is string =>
        v === 'transparent' || (typeof v === 'string' && hexColor.test(v))
      if (o?.color !== undefined && !validColor(o.color)) {
        return { ok: false as const, reason: '标题栏底色格式非法（须为 #RGB/#RRGGBB 或 transparent）' }
      }
      if (o?.symbolColor !== undefined && !validColor(o.symbolColor)) {
        return { ok: false as const, reason: '标题栏符号色格式非法（须为 #RGB/#RRGGBB 或 transparent）' }
      }
      // 窗控按钮的底色由 DWM/Chromium 按 nativeTheme 绘制（overlay 透明时尤甚）——
      // 应用主题切换必须同步系统主题源，否则暗色应用顶着亮色按钮（作者反馈「突兀」）
      if (typeof o?.dark === 'boolean') {
        nativeTheme.themeSource = o.dark ? 'dark' : 'light'
      }
      if (process.platform !== 'win32') return
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return
      const patch: { color?: string; symbolColor?: string } = {}
      if (typeof o?.color === 'string') patch.color = o.color
      if (typeof o?.symbolColor === 'string') patch.symbolColor = o.symbolColor
      if (Object.keys(patch).length === 0) return
      try {
        win.setTitleBarOverlay(patch)
      } catch {
        // WCO 未启用（如 opts 覆盖掉 overlay）时 setTitleBarOverlay 抛错——忽略，
        // 窗控仍按创建时颜色渲染，属可降级外观项
      }
    },
  )
}

// ── 原生菜单 ──────────────────────────────────────────

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  /** 业务菜单项 click → 发 actionKey 给主窗口（前端 useAppActions.dispatch 消费）。
   *  actionKey 须与 web-next/src/composables/useAppActions.ts 的 id 一致。
   *  R32-22（三十二轮）：此前发往聚焦窗口——书架/书库等子窗口聚焦时（macOS 菜单恒
   *  全局可点）action 发进子窗口静默丢失（子窗口无 useAppActions 接线）。固定发
   *  mainWindow + isDestroyed 判（退出/崩溃窗口期菜单仍可点）。
   *（win 线 R33-66 的「无聚焦窗口回退」场景已由 mainWindow ?? 首窗回退覆盖——
   *  不回退 getFocusedWindow，否则子窗口聚焦时重引入 R32-22 已修的静默丢失。） */
  function action(key: string): Pick<MenuItemConstructorOptions, 'click'> {
    return {
      click: () => {
        const target = mainWindow ?? BrowserWindow.getAllWindows()[0]
        if (target && !target.isDestroyed()) target.webContents.send('desktop:menu-action', key)
      },
    }
  }
  const macAppMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      // macOS 肌肉记忆：偏好设置置于 app 菜单
      { label: '偏好设置…', accelerator: 'CmdOrCtrl+,', ...action('settings') },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [macAppMenu] : []),
    {
      label: '文件',
      submenu: [
        { label: '新建书…', accelerator: 'CmdOrCtrl+N', ...action('new-book') },
        {
          label: '打开书库目录…',
          accelerator: 'CmdOrCtrl+O',
          // R39-6（三十九轮）：async 工厂 promise 接日志——与上方 openShelfWindow/
          // openLibraryWindow（R30-24 口径）同款；裸 void 调用下 dialog reject 成
          // unhandledRejection（Node 15+ 默认 throw）→ uncaughtException exit(1)，
          // 点一次菜单 = 应用静默退出
          click: () => {
            openLibraryAction().catch((e) => {
              log.error('desktop', '打开书库目录失败', e)
            })
          },
        },
        { label: '导出…', accelerator: 'CmdOrCtrl+E', ...action('export') },
        { type: 'separator' },
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '切换左栏', accelerator: 'CmdOrCtrl+B', ...action('toggle-left') },
        { label: '切换右栏', accelerator: 'CmdOrCtrl+Shift+B', ...action('toggle-right') },
        { label: '专注模式', accelerator: 'CmdOrCtrl+Shift+F', ...action('focus') },
        { type: 'separator' },
        { label: '切换亮/暗主题', ...action('theme') },
        { type: 'separator' },
        // reload 系仅 dev 保留（V-P1-2）：生产下误触整页重载会丢未保存编辑，兜底保存不保证全救回
        ...(app.isPackaged ? [] : [{ role: 'reload' as const }, { role: 'forceReload' as const }]),
        // 开发者工具仅 dev 显示（打包后隐藏）
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        // R39-7（三十九轮）：zoom 是 macOS 专属 role（NSWindow performZoom:）——
        // win/linux 上是无动作死菜单项。非 mac 用最大化/还原 toggle 替代；目标窗
        // 解析与上方 action() 同口径（mainWindow ?? 首窗，R32-22 不回退 getFocusedWindow）。
        ...(isMac
          ? [{ role: 'zoom' as const }]
          : [
              {
                label: '最大化/还原',
                click: () => {
                  const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
                  if (win && !win.isDestroyed()) {
                    if (win.isMaximized()) win.unmaximize()
                    else win.maximize()
                  }
                },
              } as MenuItemConstructorOptions,
            ]),
        { type: 'separator' },
        // 书架/书库管理直接主进程开窗（不绕前端 dispatch）
        // R30-24（三十轮）：同 ipc handler 口径——async 工厂 promise 接日志防
        // unhandledRejection（click 回调与 invoke 回调同款裸浮调用面）
        { label: '书架', click: () => { openShelfWindow().catch((e) => { log.error('desktop', `书架窗口打开失败`, e) }) } },
        { label: '书库管理', click: () => { openLibraryWindow().catch((e) => { log.error('desktop', `书库管理窗口打开失败`, e) }) } },
      ],
    },
    // macOS 的「关于」在 app 菜单；非 mac 单独「帮助」菜单承载
    ...(isMac
      ? []
      : [
          {
            label: '帮助',
            submenu: [{ role: 'about' as const }],
          } as MenuItemConstructorOptions,
        ]),
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── 生命周期 ──────────────────────────────────────────

// Z-P2-8：单实例锁守卫——第二实例已在顶部 app.quit()，跳过全部生命周期注册，
// 防退出竞态中 whenReady/activate 仍触发 bootstrap（起 server/开窗/读写状态文件）
if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    // 生产模式注入 CSP（开发 HMR 模式跳过——Vite 依赖 unsafe-eval/unsafe-inline）
    // R43-26（四十三轮）：CSP 注入条件同步收紧——与 devUi 同形（!!env && !app.isPackaged）
    // 取反：打包态恒注入 CSP，宿主残留 CLW_DEV_UI 不再放行跳过（Vite 需要的豁免只属于真 dev）
    if (!(!!process.env['CLW_DEV_UI'] && !app.isPackaged)) { // R62-45：bracket 统一风格
      session.defaultSession.webRequest.onHeadersReceived((_d, cb) => {
        cb({
          responseHeaders: {
            ..._d.responseHeaders,
            'Content-Security-Policy': [CLW_CSP],
          },
        })
      })
    }
    registerIpc()
    buildMenu()
    runBootstrap((e) => {
      log.error('desktop', `启动失败：${e instanceof Error ? e.message : String(e)}`, e)
      app.quit()
    })
  }).catch((e) => {
    // P5-服务端（第七轮）：whenReady 回调同步段抛错原先变 unhandledRejection，绕过
    // runBootstrap 的错误通道（app 挂无窗口态）——链尾兜底走同一出路
    log.error('desktop', `whenReady 回调失败：${e instanceof Error ? e.message : String(e)}`, e)
    app.quit()
  })

  // Y-P2-7：bootstrap 并发重入防护——macOS 启动慢时点 dock 图标，activate 只判
  // mainWindow === null 会并发二次 bootstrap（双主窗口 + 双 server child）；
  // 只挡「进行中」，完成/失败后仍可重试（保 activate 重建窗口语义）。
  // O-4（第十三轮）：三段守卫语义抽 createBootstrapRunner 可测（Y-P2-7 重入挡 +
  // 第九轮 L-3 重试关旧 server + 低-8 退出竞态直通），销第十轮 M-6 留账
  // S-4（批 U1）：deps 换轨——「重试前关旧 server」经 legacyStopHandle 停旧 child
  const bootstrapRunner = createBootstrapRunner(
    {
      // R48-75（四十八轮）：getMainWindow 死接线删除——R-14 后 runner 判据为「存在旧
      // server 即关」，窗口引用不再被读取（接口谎称有用的残留随批清理）
      // P3（打包修复批）：child 已崩但退避重启在途时 isRunning() 为 false——原判据
      // 会漏取 legacyStopHandle，既不关旧也不取消挂起重启（S-5 语义旁路）；补
      // hasPendingRestart() 使「重试前关旧」覆盖重启在途窗口
      getStudioServer: () =>
        serverManager.isRunning() || serverManager.hasPendingRestart() ? legacyStopHandle : null,
      setStudioServer: () => undefined, // child 生命周期归 serverManager 自持
    },
    () => bootstrap(),
  )
  function runBootstrap(onError?: (e: unknown) => void): void {
    bootstrapRunner.runBootstrap(onError)
  }

  // 桌面应用：关窗即退出（停 server）
  app.on('window-all-closed', () => {
    app.quit()
  })

  // R1W-9（win 平台专项复审 R1）：进程级退出兜底——dev 控制台 Ctrl+C（SIGINT）/
  // Ctrl+Break（SIGBREAK）此前直接硬杀，跳过 before-quit 优雅停机链；改为走
  // app.quit() 复用既有幂等链（quitViaShutdown 门防重入，重复信号安全）。
  // R38-19（三十八轮）：补 SIGTERM——`kill <pid>`/进程管理器/IDE 停止按钮的默认
  // 信号（mac/linux）同属「硬杀跳过优雅停机链」的 R1W-9 动机面，与 SIGINT 同款一行。
  process.on('SIGINT', () => app.quit())
  process.on('SIGBREAK', () => app.quit())
  process.on('SIGTERM', () => app.quit())
  // 主进程未捕获异常：打包态 GUI 的 stderr 无人可见——先留痕 JSONL 日志（延迟一拍
  // 让日志泵落盘），再保持与默认崩溃等价的退出语义（不吞、不续跑半坏状态）。
  process.on('uncaughtException', (err) => {
    // R0910-W：真实 Electron 窗口循环冒烟——崩溃串须先于既有退出路径打出（CI 驱动
    // grep 用）；仅 opt-in 态输出，env 未设时零副作用。
    if (process.env['CLW_SMOKE_WINDOW_CYCLE'] === '1') {
      console.log(`[CLW_SMOKE] crash ${err instanceof Error ? err.message : String(err)}`)
    }
    log.error('desktop', '主进程未捕获异常，即将退出', err)
    // R44-17（四十四轮）：200ms 窗内对 server child best-effort kill——父进程崩溃硬退
    // 时 utilityProcess 子进程不被连带收尸（win 上成孤儿继续持端口/会话锁，原全靠
    // 事件库 10min 孤儿宽限兜底）。stopChild 幂等且 child 已死形态安全，失败不影响
    // 退出语义（账面级缺口由 10min 宽限与 .版本 快照兜底，正文无损）。
    // R0910-W（2026-09-10 修复批）：原实现 stopChild fire-and-forget 后固定 200ms 裸退
    // ——stopChild 内含停机 settle 竞速（预算 2s），200ms 到点常早于 kill 下发/收口，
    // best-effort 停机被自身截断；清理链来源的异常（窗口 closed 监听等）同经此路，
    // 裸退还会打断在途优雅停机收尾。改为「停机落定即退、到点兜底强退」：stopChild
    // 落定后延迟一拍（让日志泵落盘）再 process.exit，未落定则由既有 200ms 兜底硬退。
    // 留痕 / 不吞 / 半坏状态不续跑的退出语义不变。
    const backstop = setTimeout(() => process.exit(1), 200)
    void serverManager
      .stopChild()
      .catch(() => {})
      .then(() => {
        // 已落定：撤 200ms 兜底，延迟一拍让日志泵落盘后硬退（原「延迟一拍」语义）
        clearTimeout(backstop)
        setTimeout(() => process.exit(1), 0)
      })
  })
  // R38-23（三十八轮）：unhandledRejection 最后防线——各调用点已有 .catch 纪律，
  // 本兜底只 log 不退出（漏网 rejection 不再静默无痕；退出语义维持 uncaughtException
  // 独占，避免把可自愈的异步失败升级成崩溃）。
  process.on('unhandledRejection', (reason) => {
    log.error('desktop', '主进程未处理的 promise rejection（已记录，不退出）', reason)
  })

  // RB-SV-P2-6：优雅退出。O-4：shutdownStarted 归 runner.beginShutdown（幂等，二次
  // quit 直通）。批 U2：before-quit 走 shutdown 指令——child 内 shutdownStudio（在途
  // 编排 abort/session/end 落库）落定后 shutdown-done 回执退出；3.5s 总超时（E-1，
  // 见 server-manager SHUTDOWN_TOTAL_TIMEOUT_MS）强杀兜底在
  // manager 内（与拆分前 before-quit 口径一致）。
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
    if (quitFlushInFlight || bootstrapRunner.shuttingDown) return
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
        const win = mainWindow
        if (win && !win.isDestroyed()) {
          // R54-A-1（五十四轮）：与 close 链同款留痕（超时态 warn/无钩子态 info，此前
          // res===null 静默继续退出）；R54 复审顺手项①：race 收敛 flushRendererWithBudget
          // 单源（哨兵分流超时 + 落定清理计时器——R54-A-5 卫生随函数收编）；哨兵归一化
          // 回 null 后进下游（conflict/failed 守卫沿用 null 假值语义）。
          const raced = await flushRendererWithBudget(win, CLOSE_FLUSH_BUDGET_MS)
          const res = raced === FLUSH_BUDGET_TIMEOUT ? null : raced
          if (raced === FLUSH_BUDGET_TIMEOUT) {
            log.warn('desktop', `退出前 flush 超时（≥${CLOSE_FLUSH_BUDGET_MS}ms）未落定即退出——超时窗内未保存的键入可能丢失`)
          } else if (raced === null) {
            log.info('desktop', '退出前 flush 无钩子/渲染层不可达（非编辑页常态），继续退出')
          }
          if (res && res.conflict.length > 0 && !win.isDestroyed()) {
            // R44-19（四十四轮）收口：冲突未决给原生确认，取消即中止退出（应用原样保留）
            if (!confirmDiscardConflicts(win, res.conflict.length)) {
              quitFlushInFlight = false
              pendingRelaunch = false // R51-A-1：取消 = 丢弃切库意图（退出语义不被劫持成重启）
              rollbackCancelledSwitch() // R59 清偿批（R55-A-3）：取消 = 回写旧库（跨会话不残留被取消的新库）
              return
            }
          }
          if (res && res.failed.length > 0 && !win.isDestroyed()) {
            // 重评-1（全库代码重评审 2026-09-05）：保存失败与冲突同属「flush 未落净」
            // ——原实现 failed 零消费，退出时编辑增量静默丢失。留痕失败清单后弹原生
            // 确认（与 close 链对称），取消即中止退出、应用原样保留（与冲突取消同款）
            log.error('desktop', `退出前 flush 有 ${res.failed.length} 个文档保存失败（${res.failed.join(', ')}），需作者确认是否放弃未落盘修改`)
            if (!confirmDiscardFailed(win, res.failed.length)) {
              quitFlushInFlight = false
              pendingRelaunch = false // R51-A-1：取消 = 丢弃切库意图（同上）
              rollbackCancelledSwitch() // R59 清偿批（R55-A-3）：取消 = 回写旧库（同上）
              return
            }
          }
        }
      } catch (err) {
        log.error('desktop', '退出前渲染层 flush 异常（继续退出）', err)
      }
      appTearingDown = true
      // R51-A-1：不可回头点——flush 冲突/失败确认全过、停机将启，此刻兑现切库意图
      //（武装重启 + 交接释放锁）；取消路径到不了这里，意图已在上方丢弃
      armPendingRelaunchIfAny()
      if (!bootstrapRunner.beginShutdown()) {
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
            for (const w of [mainWindow, shelfWindow, libraryWindow]) {
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
        for (const w of [mainWindow, shelfWindow, libraryWindow]) {
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

  app.on('activate', () => {
    // 低-8（第十轮）：退出途中不再重 bootstrap——before-quit 的 3.5s 优雅退出窗口内
    // （shuttingDown 已置位）macOS dock 点击仍会触发 activate，若只判
    // mainWindow === null 会在退出半途再起 server/开窗（与 Z-P2-8 退出竞态同族）
    if (bootstrapRunner.shuttingDown) return
    if (mainWindow === null) {
      runBootstrap((e) => log.error('desktop', '重启失败', e))
    }
  })
}
