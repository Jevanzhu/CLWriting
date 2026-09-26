/**
 * 窗口工厂与三窗引用单源（-自 main.ts 拆出——纯移动零逻辑变化）。
 *
 * - 三窗引用 holder（wins）——main/lifecycle/ipc/workdir-controller 跨模块共享可变
 *   窗口引用（原 main.ts 模块级 let，ESM live-binding 不可跨模块赋值，故显式对象承载，
 *   读写语义逐位等价）。
 *
 * 模块级零副作用纪律：任何 app.getPath 读取一律惰性（stateFile）——本文件随 main.ts
 * 的 import 先于其模块体求值，main.ts 的 app.setPath('userData')（dev/打包 userData
 * 统一，见彼处注释）必须先行，提前求值会拿到 Electron 缺省路径（dev 态小写目录分裂）。
 */
import {
  app,
  BrowserWindow,
  screen,
  type BrowserWindowConstructorOptions,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { atomicWriteFile } from '../fs/atomic.js'
import { isBoundsVisibleOnAnyDisplay } from './window-state.js' // 多屏 bounds 校验纯函数
import { errMsg, log } from '../log/index.js'

const here = dirname(fileURLToPath(import.meta.url)) // dist/desktop/

// win 渲染锐度（F 线）：GPU 光栅化的合成层（滚动内容/textarea）上 Chromium
// 强制灰度 AA——base.css 的 subpixel-antialiased 在 CSS 计算值上正确继承（getComputedStyle
// 已验），但只要走 GPU tile 光栅就被压成灰度，这是「编辑区比浏览器样张糊」的根因。
// 关 GPU 光栅让文本回 CPU 光栅路径，ClearType 子像素恢复（真机放大对比实证：笔画
// 彩边回来、正文明显变实）。win 门：mac 无 ClearType，文本本就灰度渲染，关了只有
// 性能代价无收益（本文件平台分支惯例：titleBarStyle/autoHideMenuBar/字体枚举等同门）；
// 文本为主的写作界面 CPU 光栅代价可忽略，滚动性能留作者真机复核，异常再评估按需白名单。
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-gpu-rasterization')
}

/** 渲染进程崩溃自动重载上限（对齐 server child 退避协议的轻量版：
 *  封顶次数与 serverManager 的 RESTART_MAX_ATTEMPTS=3 同值）——崩溃风暴下无限 reload
 *  只会打转（每次 reload 即一新渲染进程起又崩），封顶后停 reload 改载下方静态提示页。 */
const RENDERER_CRASH_MAX_RELOADS = 3
/**
 * 渲染层稳定窗口——did-finish-load 后存活过此窗口即清零崩溃计数
 * （对齐 server-manager STABILITY_RESET_MS / 先例）。原计数只随窗口重建
 * 归零，长跑偶发 3 次崩溃后第 4 次误触发停摆页。
 */
const RENDERER_CRASH_STABILITY_RESET_MS = 5 * 60_000
/**
 * 主框架加载失败自愈预算与退避——渲染崩溃自愈的 reload 可能落在
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
 * 0918二轮修复批（C101）：加载失败封顶后的白屏提示页——同 RENDERER_CRASH_NOTICE_HTML
 * 形态（data URL 自包含，本地 server 不可信时仍可展示），文案区分「页面加载失败
 * （可能服务未就绪）」。此前封顶分支只 log.error + return，对照 render-process-gone
 * 封顶载提示页不对称：触发形态（server 退避重启窗内 5 次加载失败，≥44s 全失败）后
 * 白屏滞留无任何可见提示（生产态菜单无 reload，无人工出口）。
 */
const LOADFAIL_NOTICE_HTML =
  '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;line-height:1.8;color:#333">' +
  '<h2>页面加载失败，自动重试已停止</h2>' +
  '<p>页面连续多次加载失败（可能服务未就绪或已退出），已停止自动重试。</p>' +
  '<p>请重启 CLWriting；未保存的内容在重启后仍可从自动保存找回。</p></body>'

/** 三窗引用 holder（原 main.ts 模块级 let/state，读写语义逐位等价——拆分说明见文件头注）。 */
export const wins = {
  mainWindow: null as BrowserWindow | null,
  shelfWindow: null as BrowserWindow | null,
  libraryWindow: null as BrowserWindow | null,
  /** 主窗口加载的 url（dev:5173 / packaged server）；书架窗口复用（原 appUrl） */
  appUrl: '',
}

/**
 * 渲染崩溃自愈收敛进窗口工厂——此前只挂主窗（dd-/ +
 * 退避 + 稳定窗口复位），书架/书库子窗口 GPU/内存崩溃停在白屏无自愈。
 * 逻辑原样提取（计数随窗口闭包走、新窗口归零）；label 进日志区分窗口。
 */
function attachRendererCrashSelfHeal(win: BrowserWindow, label: string): void {
  let crashes = 0
  // 主框架加载失败计数与重试计时器句柄（随窗口闭包走，新窗口归零）
  let loadFails = 0
  let failLoadTimer: NodeJS.Timeout | null = null
  // 稳定窗口复位计时器的句柄——崩溃要撤销在途复位（互撤），重载要
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
    // 渲染进程异常退出的结构化标记——desktop.yml 启动冒烟 grep
    // 此判定用（一行 ASCII、无中文措辞依赖）。直写 console：打包态 log.* 只落 JSONL
    // 不镜像 stdout，冒烟步重定向的是进程标准流
    console.log(`[CLW_SMOKE] renderer-crash reason=${details.reason} reload=${crashes <= RENDERER_CRASH_MAX_RELOADS}`)
    if (crashes > RENDERER_CRASH_MAX_RELOADS) {
      log.error(
        'desktop',
        `渲染进程连续崩溃 ${RENDERER_CRASH_MAX_RELOADS} 次自愈后仍异常（${label}，${details.reason}），停止自动重载——载提示页等待人工处理`,
      )
      if (!win.isDestroyed()) {
        // 连带（批 D 代理范围外上报、主评审收口）：崩溃提示页 loadURL 同为
        // 无人 catch 的 promise（data: URL 失败概率极低但同类）——接日志防丢诊断
        void win.webContents
          .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(RENDERER_CRASH_NOTICE_HTML)}`)
          .catch((e) => {
            log.error('desktop', `崩溃提示页加载失败（${label}）`, e)
          })
      }
      return
    }
    log.error(
      'desktop',
      `渲染进程崩溃（${label}，${details.reason}，exit=${details.exitCode}），重载窗口自愈（第 ${crashes}/${RENDERER_CRASH_MAX_RELOADS} 次）`,
    )
    if (!win.isDestroyed()) win.webContents.reload()
  })
  // did-finish-load 后延迟复位崩溃计数——渲染层真正稳定（存活满
  // 稳定窗口且期间无崩溃，互撤）才清零，长跑零星崩溃不累计到 3；unref 不拖退出。
  // 加载失败计数同款复位（成功载入 + 稳定窗活满 = 故障域清零）。
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
  // 主框架加载失败重试——自愈 reload 落在 server 退避重启窗时
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
      log.error(
        'desktop',
        `主框架加载连续失败 ${RENDERER_LOADFAIL_MAX_RETRIES} 次重试后仍失败（${label}，code=${errorCode}），停止自动重试——载提示页等待人工处理`,
      )
      // 0918二轮修复批（C101）：封顶不再白屏滞留——对齐 render-process-gone 封顶口径
      // （同款：loadURL promise 接日志防丢诊断）
      if (!win.isDestroyed()) {
        void win.webContents
          .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADFAIL_NOTICE_HTML)}`)
          .catch((e) => {
            log.error('desktop', `加载失败提示页加载失败（${label}）`, e)
          })
      }
      return
    }
    const delay = Math.min(RENDERER_LOADFAIL_BACKOFF_BASE_MS * 2 ** (loadFails - 1), RENDERER_LOADFAIL_BACKOFF_CAP_MS)
    log.error(
      'desktop',
      `主框架加载失败（${label}，code=${errorCode}），${delay}ms 后重载重试（第 ${loadFails}/${RENDERER_LOADFAIL_MAX_RETRIES} 次）`,
    )
    failLoadTimer = setTimeout(() => {
      failLoadTimer = null
      if (!win.isDestroyed()) win.webContents.reload()
    }, delay)
    failLoadTimer.unref?.()
  })
  // 窗口 closed 即撤 stabilityTimer——计时器闭包持有 win 引用，
  // 窗口销毁后至多 5 分钟才随计时器到期释放（回调的 isDestroyed 守卫只防崩不防滞留）。
  // 加载失败重试计时器同款收口。
  win.on('closed', () => {
    // 清理体异常隔离——任一 closed 监听抛错会取消同事件后续监听（含主窗
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

// （修复批，评审 §四.2）：IPC sender 统一校验——此前 14 个 handler
// 不验 event.sender 身份，渲染层一旦被 XSS 注入即可驱动 open-library/switch-library/
// context-menu/set-fullscreen 等（纵深缺口，CSP/隔离只是缓解不可依赖）。校验面 =
// 白名单 webContents（createSecureWindow 创建时登记、closed 摘除）+ 顶层主帧
//（senderFrame === sender.mainFrame，被注入 iframe 的帧中帧不满足；帧销毁期
// senderFrame 为 null 亦拒）。拒绝即拒（不弹提示不回退上下文），防攻击面试探。
const trustedSenders = new Set<WebContents>()
// （修复批）：工厂窗登记集合——兜底反查的判定面。
// WeakSet 不持强引用，窗口销毁随 GC 回收无泄漏面；登记随 trackWindow 单点（createSecureWindow
// 唯一入口），无旁路登记面。
const factoryWindows = new WeakSet<BrowserWindow>()
function trackWindow(win: BrowserWindow): void {
  // 先捕获局部引用再登记——窗口销毁后读 win.webContents 抛
  // "Object has been destroyed"（Electron 实测）。本监听是 closed 事件的首个监听，
  // 其抛错会中断 emit 遍历，令后续 closed 清理（自愈计时器撤销 / 子窗引用置空 /
  // 主窗 null→app.quit）全部短路，并经 uncaughtException 提前硬退。局部 ref 口径
  // 同 openShelfWindow/openLibraryWindow。
  const wc = win.webContents
  factoryWindows.add(win)
  trustedSenders.add(wc)
  win.on('closed', () => trustedSenders.delete(wc))
}
/** closed 清理监听异常隔离——EventEmitter.emit 同步遍历监听，任一监听抛错
 *  即中断其余监听（同事件后续清理整体被取消）。清理体包一层：异常只留痕、不连累其余
 *  清理与退出链；无异常时行为与直接调用完全一致。 */
function guardClosedCleanup(label: string, fn: () => void): void {
  try {
    fn()
  } catch (e) {
    log.error('desktop', `窗口 closed 清理监听异常（${label}，已隔离——不影响其余清理与退出链）`, e)
  }
}
/** 测试钩子（生产零调用，先例同 src/cache/rebuild.ts __testHooks）——供回归
 *  用例断言窗口关闭后 IPC 白名单登记已摘除。经 main.ts 原样 re-export（测试面不变）。 */
export const __testHooks = {
  trustedSenderCount: (): number => trustedSenders.size,
  hasTrustedSender: (wc: WebContents): boolean => trustedSenders.has(wc),
}
export { isTrustedSender, guardClosedCleanup }

function isTrustedSender(e: IpcMainInvokeEvent | IpcMainEvent | null): boolean {
  // 事件对象缺失（帧销毁期形态/异常调用）一律拒——null 防御防 handler 层 TypeError
  if (!e) return false
  // senderFrame 为空（帧销毁期）一律拒；非顶层主帧（被注入 iframe 的帧中帧
  // senderFrame ≠ sender.mainFrame）拒。
  if (!e.senderFrame || e.senderFrame !== e.sender.mainFrame) return false
  // 主判据：三窗白名单（createSecureWindow 登记、closed 摘除，快路径）。
  if (trustedSenders.has(e.sender)) return true
  // 兜底：Electron 全局反查 + 工厂窗判定。（
  // 修复批）：原「能反查到本进程存活窗口即放行」宽于白名单语义——未来若出现绕过工厂
  // 的直建窗口，其 webContents 即 IPC 直通；收窄为反查命中窗须属工厂登记集合（登记面
  // 见 trackWindow），白名单语义 = 「工厂登记 webContents ∪ 工厂窗反查」。
  const win = BrowserWindow.fromWebContents(e.sender)
  return !!win && !win.isDestroyed() && factoryWindows.has(win)
}

// ii 批：安全基线窗口工厂——主窗/书架/书库三处 BrowserWindow 的安全五件套
// （contextIsolation + sandbox + nodeIntegration:false + preload + hiddenInset 标题栏）
// 与纵深防御监听（禁外部导航 + 禁弹新窗）原样重复 3 份，安全配置改一处漏两处是
// 漂移风险，收敛到此。尺寸/标题/位置由 opts 传入，win 专属生命周期监听由调用方自挂。
// 导出：main.ts bootstrap 主窗 loadURL 前 await 同一记账 promise（收敛，
// 省一次 session setProxy 往返）。
// nano ：原 export let 模块级可变导出（值随 createSecureWindow
// 运行期改写，可变绑定语义外溢到导入方）——收窄为函数访问器：写点唯一（工厂 dev 分支
// 单点 setDevProxyApplied）、读方经 getDevProxyApplied；调用点（本文件工厂/子窗骨架、
// main.ts bootstrap）随批收编，读写语义逐位不变。
let devProxyApplied: Promise<void> = Promise.resolve()
/** dev 代理记账 promise 读取器（各窗 loadURL 前 await，原 let 直读改函数访问）。 */
export function getDevProxyApplied(): Promise<void> {
  return devProxyApplied
}
/** dev 代理记账 promise 写入器（仅 createSecureWindow 工厂 dev 分支调用）。 */
export function setDevProxyApplied(p: Promise<void>): void {
  devProxyApplied = p
}

export { createSecureWindow }

function createSecureWindow(opts: BrowserWindowConstructorOptions): BrowserWindow {
  // dev 代理记账 promise（/ 二十轮）：dev 态 direct: 设置于窗口共享的
  // defaultSession，各窗 loadURL 前 await 此 promise——原子窗 fire-and-forget 在
  // 「子窗先于主窗完成设置」的时序下会带着未生效代理加载（SSE 经系统代理 buffer 断流）
  const win = new BrowserWindow({
    // hiddenInset 是 darwin 专属值——linux 上非支持值（行为未
    // 定义，纯 dev 形态卫生项），走默认系统标题栏；win 由下方 WCO 分支覆盖为
    // 'hidden'+overlay（分支不动），mac 形态不变。
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    backgroundColor: '#f5f5f5',
    // +merge（win→dev 合流）：autoHideMenuBar 显式平台口径——win true
    //（配合下方 setMenuBarVisibility(false) 双保险），mac/win 外显式 false（Electron
    // 默认即 false 行为不变；隐式 undefined 过不了 kk- 的跨平台断言）。
    autoHideMenuBar: process.platform === 'win32',
    // （win 体验面， 作者指令「外观全面向 mac 靠齐」）：win 走「无框标题栏 +
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
      // （二十四轮 D 域）：安全标志置于 spread 之后——此前 contextIsolation/
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
  // IPC 白名单登记——三窗共用本工厂，此处单点登记 + closed 摘除
  trackWindow(win)
  // 渲染崩溃自愈随工厂挂载（三窗同享；原先只挂主窗，书架/书库白屏无自愈）
  attachRendererCrashSelfHeal(win, opts.title ?? '窗口')
  // （-③）：preload-error 同款入工厂——原先只挂主窗，书架/书库窗 preload
  // 加载失败（sandbox preload 报错主进程才可见）零留痕。带窗口名区分来源。
  win.webContents.on('preload-error', (_e, preloadPath, err) => {
    log.error('desktop', `preload 加载失败（${opts.title ?? '窗口'}）：${preloadPath}`, err)
  })
  // dev 模式:不经系统代理（防 clash/surge 类 HTTP 代理 buffer SSE 长连接 → driver events 断流）
  // dev 环境变量防线——本文件全部 CLW_DEV_UI 读取统一收紧为
  // 「!!env && !app.isPackaged」形态：宿主 shell 残留的 CLW_DEV_UI=1 在打包态不得再
  // 触发 dev 代理（setProxy direct:// 属开发期行为，与 HMR 同源同门）
  if (!!process.env['CLW_DEV_UI'] && !app.isPackaged) {
    // bracket 统一风格
    // 记账供 loadURL 前 await（同值幂等，重复设置无害）
    // setProxy 返回 promise 此前无人 catch——设置失败成
    // unhandledRejection 丢诊断（且 await 方拿到 rejected promise 会二次炸穿书架/
    // 书库窗口加载链）；接日志吞错降级（按系统代理继续，SSE 断流风险留日志可查）
    // nano ：let 导出改访问器后经 setter 写入（写点唯一）
    setDevProxyApplied(
      win.webContents.session.setProxy({ proxyRules: 'direct://' }).catch((e) => {
        log.error('desktop', `dev 代理 direct:// 设置失败（${opts.title ?? '窗口'}），按系统代理继续加载`, e)
      }),
    )
  }
  return win
}

/** 主窗口 bounds 持久化（userData/window-state.json）：关闭时存，启动时恢复。 */
// 惰性求值（模块级零副作用纪律见文件头注）：首次读写时才解析——届时 main.ts 的
// app.setPath('userData') 必已执行（bootstrap/关窗链均晚于模块装配）。
let stateFile: string | null = null
function windowStateFile(): string {
  return (stateFile ??= join(app.getPath('userData'), 'window-state.json'))
}
interface WinState {
  bounds: { x: number; y: number; width: number; height: number }
  maximized?: boolean
}
function loadWinState(): WinState | null {
  try {
    const s = JSON.parse(readFileSync(windowStateFile(), 'utf-8')) as WinState
    // 校验扩为 getAllDisplays 任一显示器包含即有效（±容差口径
    // 原样保留）——原只对主屏判定，多屏作者窗口常驻副屏：副屏坐标对主屏永远「越界」，
    // 恢复被无条件丢弃、窗口尺寸/位置白丢。判定逻辑抽 window-state.ts 纯函数（可单测）。
    // （-④）：校验矩形整屏 bounds → workArea——创建侧缺省/钳制口径
    // （workAreaSize-80/-8）一直按工作区算，校验却按含任务栏/Dock 的整屏：存档底部
    // 压在任务栏区（整屏含、工作区外）此前判有效、恢复即压条。容差 200px 原样保留
    //（轻微出界照旧放行），只多拦「越工作区 >200px」的真离屏态，正常存档不受影响。
    if (
      isBoundsVisibleOnAnyDisplay(
        s.bounds,
        screen.getAllDisplays().map((d) => d.workArea),
      )
    )
      return s
  } catch {
    /* 无文件或损坏 → 默认 */
  }
  return null
}
function saveWinState(): void {
  const mainWindow = wins.mainWindow
  if (!mainWindow) return
  try {
    const maximized = mainWindow.isMaximized()
    // 最大化时存正常（非最大化）bounds，恢复时按 maximized 标志决定是否最大化
    const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds()
    atomicWriteFile(windowStateFile(), JSON.stringify({ bounds, maximized }))
  } catch (e) {
    // 持久化失败留痕——原 catch 零日志，磁盘满/权限/收尾期 getter
    // 抛错全不可见（本文件其余忽略处均留痕，唯此处裸吞，违「失败留痕」纪律）。窗口
    // 状态非关键数据，维持吞错不阻断关窗/停机，warn 级留诊断线索即可。
    log.warn('desktop', `窗口状态持久化失败（window-state.json 未写入）：${errMsg(e)}`)
  }
}
export { loadWinState, saveWinState }

/**
 * F2d单例子窗打开骨架——openShelfWindow/openLibraryWindow
 * 原两份逐行双写（appUrl 就绪守卫/单例聚焦/workArea 尺寸/closed 置空/devProxyApplied
 * 复验/loadURL 接日志）收敛单源，差异以 spec 参数注入。时序与文案逐位不变：
 * 守卫留痕 → 单例聚焦 → workArea 读取与尺寸/位置计算 → 建窗 → 引用登记 → closed
 * 监听（仍指向本窗才置 null，局部引用口径）→ await getDevProxyApplied→
 * 存活复验 → loadURL 接日志。
 */
interface SingletonWindowSpec {
  /** 现存窗口引用读/写（wins.shelfWindow / wins.libraryWindow 的取址闭包） */
  ref: () => BrowserWindow | null
  setRef: (w: BrowserWindow | null) => void
  /** /：appUrl 未就绪命中守卫的 info 留痕文案（书架/书库措辞各一） */
  appUrlGuardLog: string
  /** closed 清理体隔离标签（「书架窗口引用置空」/「书库窗口引用置空」） */
  cleanupLabel: string
  title: string
  /** 尺寸/下限计算（wa = 主屏工作区；钳制口径在调用方闭包内原样保留） */
  sizes: (wa: { width: number; height: number }) => {
    width: number
    height: number
    minWidth: number
    minHeight: number
  }
  /** 初始位置（书库窗居中于主窗；书架窗无——缺省系统定位） */
  position?: (wa: { width: number; height: number }) => { x?: number; y?: number }
  /** 路由（/shelf?win=shelf / /library?win=library）与加载失败留痕前缀 */
  route: string
  loadFailTitle: string
}

async function openSingletonWindow(spec: SingletonWindowSpec): Promise<void> {
  // appUrl 就绪守卫——fork+握手期间（打包冷启动可达秒级）原生
  // 菜单已可点，loadURL 无 scheme 相对路径会以 ERR_INVALID_URL 开出加载失败白窗
  // 命中不再静默——冷启动握手期点菜单的 no-op 留痕，可诊断
  if (!wins.appUrl) {
    log.info('desktop', spec.appUrlGuardLog)
    return
  }
  const existing = spec.ref()
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return
  }
  const wa = screen.getPrimaryDisplay().workAreaSize
  const pos = spec.position?.(wa) ?? {}
  // createSecureWindow 后即捕获局部引用——closed 监听与 await 后
  // 复验均用局部，不再读模块变量。两处交错此前都踩模块变量：① dev 态 setProxy 窗口期
  // 本窗关闭，closed 监听把模块变量置 null，await 后 isDestroyed 变 null 上抛
  // TypeError；② 两次并发 open 的交错形态，旧栈 await 恢复后读模块变量拿到新窗重复
  // loadURL（旧窗 closed 还会把指向新窗的模块变量误置 null）。局部引用 + 「仍指向本窗
  // 才置 null」守卫两形态同收。
  const win = createSecureWindow({
    ...spec.sizes(wa),
    ...pos,
    title: spec.title,
  })
  spec.setRef(win)
  // closed 监听先于 await 挂接——dev 态 setProxy 耗时数十 ms，
  // 恰在此窗关窗则 closed 先于挂接触发，悬空引用已销毁窗口（isDestroyed 自愈重建
  // 兜底在，纯防御收口）；await 后复验存活再 loadURL（起复验用局部引用）
  win.on('closed', () => {
    // 异常隔离（同 attachRendererCrashSelfHeal）——引用置空不被前置监听抛错短路
    guardClosedCleanup(spec.cleanupLabel, () => {
      if (spec.ref() === win) spec.setRef(null)
    })
  })
  await getDevProxyApplied() // 代理生效后再加载（nano ：改函数访问器）
  // loadURL promise 无人 catch——server 恰在此刻崩溃/端口失效
  // 时 rejection 成 unhandledRejection 丢诊断；接日志留痕（窗口崩溃另有自愈）
  if (win.isDestroyed()) return
  const url = `${wins.appUrl}${spec.route}`
  win.loadURL(url).catch((e) => {
    log.error('desktop', `${spec.loadFailTitle}（${url}）`, e)
  })
}

/** 打开独立书架窗口（工作区时管理/切换/建书；单例，重复调用聚焦已存在窗口）。*/
export async function openShelfWindow(): Promise<void> {
  await openSingletonWindow({
    ref: () => wins.shelfWindow,
    setRef: (w) => {
      wins.shelfWindow = w
    },
    appUrlGuardLog: '书架窗口请求早于服务就绪（冷启动握手期），本次打开已忽略',
    cleanupLabel: '书架窗口引用置空',
    title: '书架',
    // 下限按工作区钳制（主窗先例同款 -8 余量）——小屏/
    // 高 DPI 工作区不足 760×500 时原硬下限让子窗出生即超工作区压任务栏
    sizes: (wa) => ({
      width: Math.min(920, wa.width - 80),
      height: Math.min(640, wa.height - 80),
      minWidth: Math.min(760, wa.width - 8),
      minHeight: Math.min(500, wa.height - 8),
    }),
    route: '/shelf?win=shelf',
    loadFailTitle: '书架窗口加载失败',
  })
}

/** 打开独立书库管理窗口（切换/最近/新建书库；单例聚焦）。*/
export async function openLibraryWindow(): Promise<void> {
  await openSingletonWindow({
    ref: () => wins.libraryWindow,
    setRef: (w) => {
      wins.libraryWindow = w
    },
    appUrlGuardLog: '书库窗口请求早于服务就绪（冷启动握手期），本次打开已忽略',
    cleanupLabel: '书库窗口引用置空',
    title: '书库',
    // 同书架窗——下限按工作区钳制（主窗先例同款 -8 余量）
    sizes: (wa) => ({
      width: Math.min(720, wa.width - 80),
      height: Math.min(560, wa.height - 80),
      minWidth: Math.min(560, wa.width - 8),
      minHeight: Math.min(440, wa.height - 8),
    }),
    // 初始位置：居中于主窗口（主窗口 bounds 中心 − 书库半宽/半高）
    position: (wa) => {
      const libW = Math.min(720, wa.width - 80)
      const libH = Math.min(560, wa.height - 80)
      let x: number | undefined
      let y: number | undefined
      if (wins.mainWindow && !wins.mainWindow.isDestroyed()) {
        const b = wins.mainWindow.getBounds()
        x = Math.round(b.x + (b.width - libW) / 2)
        y = Math.round(b.y + (b.height - libH) / 2)
      }
      return { x, y }
    },
    route: '/library?win=library',
    loadFailTitle: '书库管理窗口加载失败',
  })
}
