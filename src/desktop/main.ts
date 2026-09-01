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
} from 'electron'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { findWorkDir, readBooks } from '../install/books.js'
import { atomicWriteFile } from '../fs/atomic.js'
import { resolveWithinRoot } from '../fs/safe-path.js'
import { defaultUserDataPath, samePath } from '../fs/user-data-path.js'
import { initialBookArg, initialBookArgvOnly, resolveInitialBook } from './initial-book.js' // RB-SV-P2-4：--book 直进
import { parseContextMenuSpecs, type ContextMenuSpec } from './context-menu.js' // RB-SV-P2-5：IPC 载荷净化
import { createStudioServerManager, ServerBootError } from './server-manager.js' // 阶段 22：server 拆分 utilityProcess
import { createBootstrapRunner } from './bootstrap-runner.js' // O-4：生命周期 runner 可测
import { isBoundsVisibleOnAnyDisplay } from './window-state.js' // R26-86：多屏 bounds 校验纯函数
import { getFonts as getSystemFontList } from 'font-list'
import { createSystemFontCache } from './font-cache.js' // R77-1（二十五轮批 A）：系统字体 IPC 缓存
import {
  parseStore,
  setCurrent,
  filterValidRecent,
  serializeStore,
  emptyStore,
} from './workdir-store.js'
import type { WorkDirStore } from './workdir-store.js'
import { initLogging, log } from '../log/index.js'

const here = dirname(fileURLToPath(import.meta.url)) // dist/desktop/

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
  win.webContents.on('did-finish-load', () => {
    if (stabilityTimer) clearTimeout(stabilityTimer) // 上一轮计时器未跑就又重载：撤旧排新不叠
    stabilityTimer = setTimeout(() => {
      stabilityTimer = null
      if (!win.isDestroyed()) crashes = 0
    }, RENDERER_CRASH_STABILITY_RESET_MS)
    stabilityTimer.unref?.()
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
      const name = resolveInitialBook(workDir, ref)
      if (name) mainWindow.webContents.send('desktop:navigate', `/book/${encodeURIComponent(name)}`)
      else log.info('main', `second-instance 带 --book=${ref}，但书库内无此登记书——已忽略直达`) // P3：忽略留痕
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
/** 阶段 22 批 U1-U3：studio server 已拆至 utilityProcess 子进程（dev HMR 态不起）；
 *  批 U3 起崩溃退避自动重启，3 次自动重启耗尽转原生对话框（U-2：重启服务/退出） */
const serverManager = createStudioServerManager({
  onRestartExhausted: () => {
    // 同步对话框：崩溃风暴路径上无在途状态可等，用户决断即收口
    const choice = dialog.showMessageBoxSync({
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
    if (isBoundsVisibleOnAnyDisplay(s.bounds, screen.getAllDisplays().map((d) => d.bounds))) return s
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
  } catch {
    /* 忽略 */
  }
}

// ── 工作目录持久化（userData/workdir.json）──────────────

/** 持久化文件路径（Electron userData 目录）。 */
function storePath(): string {
  return join(app.getPath('userData'), 'workdir.json')
}

/** 读 store（含失效 recent 清理）；缺失/损坏 → 空存储。 */
function readStore(): WorkDirStore {
  const fp = storePath()
  if (!existsSync(fp)) return emptyStore()
  return filterValidRecent(parseStore(readFileSync(fp, 'utf-8')))
}

/** 原子写 store。 */
function writeStore(store: WorkDirStore): void {
  atomicWriteFile(storePath(), serializeStore(store))
}

/** 设新 current（旧入 recent）+ 持久化。 */
function saveCurrent(dir: string): void {
  writeStore(setCurrent(readStore(), dir))
}

/** 是否合法书库目录（自身含 .clwriting/）。复用 findWorkDir 的判定。
 *  R1W-7（win 平台专项复审 R1）：win 路径大小写不敏感——findWorkDir 返回值与
 *  resolve(dir) 的盘符/目录大小写可能漂移，全等比较会误判「非书库」。 */
function isLibraryDir(dir: string): boolean {
  const found = findWorkDir(dir)
  return found !== null && samePath(found, resolve(dir))
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
    if (isLibraryDir(dir)) return dir
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
    if (choice.response === 0) return dir // 确认在此新建（待建空目录，由调用方持久化 + 重启）
    if (choice.response === 1) continue // 重新选择（E-9c：回到循环顶，受封顶约束）
    return null // 取消
  }
  // E-9c：封顶退出——留痕报错后按取消收口，不无限弹窗困住用户
  log.error('main', `书库目录选择连续 ${PICK_LIBRARY_MAX_ATTEMPTS} 次未选定有效目录，已退出选择流程`)
  return null
}

/** 重启进程以应用新 workDir（规避 server 路由单例，见方案 §3.1）。 */
function relaunch(): void {
  app.relaunch()
  // R27-96（二十七轮）：显式释放单实例锁再退出——relaunch 的新实例在旧进程退出后
  // 立即拉起并 requestSingleInstanceLock，而锁随进程退出释放存在时序缝隙：新实例
  // 扑空 → 自我 app.quit() → 切书库后无任何实例存活（死局）。显式交接释放消除缝隙；
  // 释放窗内用户恰好真双开的最坏结果也只是一方拿到锁退出另一方存活，无死局。
  app.releaseSingleInstanceLock()
  // RB-SV-P2-6：走 before-quit 优雅清理（app.exit 会跳过 before-quit）
  app.quit()
}

/** 打开书库（菜单/前端共用）：选 → 存 → 重启。返回是否已触发切换。 */
async function openLibraryAction(): Promise<boolean> {
  const picked = await pickLibrary()
  if (!picked) return false
  saveCurrent(picked)
  relaunch()
  return true
}

// ── 窗口 ──────────────────────────────────────────────

/** ii 批：安全基线窗口工厂——主窗/书架/书库三处 BrowserWindow 的安全五件套
 *  （contextIsolation + sandbox + nodeIntegration:false + preload + hiddenInset 标题栏）
 *  与纵深防御监听（禁外部导航 + 禁弹新窗）原样重复 3 份，安全配置改一处漏两处是
 *  漂移风险，收敛到此。尺寸/标题/位置由 opts 传入，win 专属生命周期监听由调用方自挂。 */
let devProxyApplied: Promise<void> = Promise.resolve()

function createSecureWindow(opts: BrowserWindowConstructorOptions): BrowserWindow {
  // dev 代理记账 promise（R72-10 / 二十轮 D-7）：dev 态 direct:// 设置于窗口共享的
  // defaultSession，各窗 loadURL 前 await 此 promise——原子窗 fire-and-forget 在
  // 「子窗先于主窗完成设置」的时序下会带着未生效代理加载（SSE 经系统代理 buffer 断流）
  const win = new BrowserWindow({
    titleBarStyle: 'hiddenInset',
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
  // R67-16：渲染崩溃自愈随工厂挂载（三窗同享；原先只挂主窗，书架/书库白屏无自愈）
  attachRendererCrashSelfHeal(win, opts.title ?? '窗口')
  // dev 模式:不经系统代理（防 clash/surge 类 HTTP 代理 buffer SSE 长连接 → driver events 断流）
  if (process.env['CLW_DEV_UI']) { // R62-45：bracket 统一风格
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
  if (!appUrl) return
  if (shelfWindow && !shelfWindow.isDestroyed()) {
    shelfWindow.focus()
    return
  }
  const wa = screen.getPrimaryDisplay().workAreaSize
  shelfWindow = createSecureWindow({
    width: Math.min(920, wa.width - 80),
    height: Math.min(640, wa.height - 80),
    minWidth: 760,
    minHeight: 500,
    title: '书架',
  })
  await devProxyApplied // R72-10（二十轮 D-7）：代理生效后再加载
  // R74-16（七十四轮批 D）：loadURL promise 此前无人 catch——server 恰在此刻崩溃/
  // 端口失效时 rejection 成 unhandledRejection 丢诊断（与 child 侧 fatal 兜底口径
  // 不对称）；接日志留痕（窗口崩溃另有 R67-16 自愈，此处只补诊断）
  shelfWindow.loadURL(`${appUrl}/shelf?win=shelf`).catch((e) => {
    log.error('desktop', `书架窗口加载失败（${appUrl}/shelf）`, e)
  })
  shelfWindow.on('closed', () => {
    shelfWindow = null
  })
}

/** 打开独立书库管理窗口（切换/最近/新建书库；单例聚焦）。*/
async function openLibraryWindow(): Promise<void> {
  // Y-12：同 openShelfWindow 的 appUrl 就绪守卫
  if (!appUrl) return
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
  libraryWindow = createSecureWindow({
    width: libW,
    height: libH,
    x,
    y,
    minWidth: 560,
    minHeight: 440,
    title: '书库',
  })
  await devProxyApplied // R72-10（二十轮 D-7）：代理生效后再加载
  // R74-16（七十四轮批 D）：同 openShelfWindow——loadURL promise 接日志防丢诊断
  libraryWindow.loadURL(`${appUrl}/library?win=library`).catch((e) => {
    log.error('desktop', `书库窗口加载失败（${appUrl}/library）`, e)
  })
  libraryWindow.on('closed', () => {
    libraryWindow = null
  })
}

async function bootstrap(): Promise<void> {
  // 工作目录定位：持久化 current（合法书库 或 决策②待建空目录，目录存在即用）> findWorkDir(cwd)
  // 不再启动时弹原生选择器：无书库 → 主窗口加载 /welcome 起始页引导新建 / 打开。
  const store = readStore()
  let workDir: string | null = null
  // R72-10（二十轮 D-1）：持久化 workDir 由仅 existsSync 改目录校验——指向普通文件时
  // 原样采信会静默空书架无引导；失效回落 findWorkDir(cwd)，仍无 → /welcome 引导
  const currentIsDir = (() => {
    if (!store.current) return false
    try {
      return statSync(store.current).isDirectory()
    } catch {
      return false
    }
  })()
  if (store.current && currentIsDir) {
    workDir = store.current
  } else {
    workDir = findWorkDir(process.cwd())
  }
  // P5-服务端（第七轮）：记录 bootstrap 实际采用的 workDir——before-quit 原先回读
  // readStore().current，store.current 为 null/失效而 workDir 由 findWorkDir 发现时，
  // 退出拿到 null：不 abort 任何在途 chat/self-heal、不等后台任务（孤儿会话只能靠
  // 10 分钟宽限修复）。退出以启动时实际值优先，store 回读兜底
  bootstrappedWorkDir = workDir
  const needsWelcome = !workDir

  // HMR 开发模式：CLW_DEV_UI=1 时加载 Vite dev server（localhost:5173），前端改动实时热更新；
  // 不起 server，API 由独立 dev:api(7878) 提供（Vite proxy 转发）。IPC/preload 照常，桌面能力完整。
  const devUi = !!process.env['CLW_DEV_UI'] // R62-45：bracket 统一风格
  if (devUi) {
    appUrl = 'http://localhost:5173'
  } else {
    // RB-SV-P2-4：--book 直进——argv 解析为登记书名仍在 main（书架登记表就在手边），
    // 下沉为 --book 参数由 child 在 startServer 前调 setInitialBook（U-1 附带；
    // dev HMR 态不起 server，boot 由独立 dev-api 提供，此项不生效）
    let initialName: string | null = null
    if (workDir) {
      const ref = initialBookArg(process.argv)
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
  mainWindow.on('close', () => {
    saveWinState()
  })
  // R1W-9（win 平台专项复审 R1）：win 会话收尾兜底——OS 关机/重启/注销对主窗发
  // session-end（不可阻止，时间窗有限），此前整条优雅停机链被跳过、utility child
  // 随进程硬死（在途 session/end 落库全失，靠 10min 孤儿会话宽限兜底）。尽力下发
  // 停机指令（shutdown 内部有 3.5s 总超时，不会拖住 OS 收尾）。
  mainWindow.on('session-end', () => {
    void serverManager.shutdown().catch((err) => log.error('desktop', 'session-end 停机失败（OS 即将收尾）', err))
  })
  // 书库管理窗口「用完即走」：主窗口获焦 = 用户已切回，关闭书库窗口释放资源
  // （与书架窗口 desktop:open-book 主动 close 行为对齐）
  mainWindow.on('focus', () => {
    if (libraryWindow && !libraryWindow.isDestroyed()) {
      libraryWindow.close()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    // 主窗口是应用核心：关闭即退出（连带销毁书架/书库子窗口，杜绝孤儿窗口 / 僵尸进程）
    app.quit()
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
  // 捕获 preload 加载错误（sandbox preload 失败时主进程可见，便于排查）
  mainWindow.webContents.on('preload-error', (_e, p, err) => {
    log.error('desktop', `preload 加载失败：${p}`, err)
  })
  // R67-16（十五轮）：渲染崩溃自愈已随 createSecureWindow 工厂挂载（原主窗专属块
  // 删除——attachRendererCrashSelfHeal 原样承接 dd-P3/X-26 退避 + S6 稳定复位），
  // 书架/书库子窗口同享。
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
  await mainWindow.loadURL(needsWelcome ? `${appUrl}/welcome` : appUrl)
  // L1（二轮复审）：改走 logger——打包态 mirrorConsole=false，console.log 此前在生产
  // 完全不可见（终端无人看、又不进 JSONL 日志）
  log.info('desktop', `CLWriting ${devUi ? 'dev（HMR）' : '桌面版'}已启动 → ${appUrl}${needsWelcome ? '/welcome' : ''}`)
  // R73-53（二十一轮）：启动完成的结构化标记——desktop.yml 启动冒烟 grep 此判定用
  // （一行 ASCII、无中文措辞依赖）。直写 console：打包态 log.* 只落 JSONL 不镜像
  // stdout，冒烟步重定向的是进程标准流
  console.log('[CLW_SMOKE] ready')
}

// ── IPC（供 preload 调用）──────────────────────────────

// O-11（第十三轮）：IPC 响应回程窗口——handle 返回值需先送达渲染进程再 relaunch
//（quit 链会销毁 webContents，响应晚到前端拿到 undefined）；100ms 为覆盖慢机往返的
// 经验值（原两处裸魔数收编单源），改小前先在慢机实测。
const RELAUNCH_DELAY_MS = 100

function registerIpc(): void {
  // 弹选择器打开书库
  ipcMain.handle('desktop:open-library', async () => {
    const picked = await pickLibrary()
    if (!picked) return { ok: false as const, canceled: true as const }
    saveCurrent(picked)
    setTimeout(relaunch, RELAUNCH_DELAY_MS) // 延迟重启，让响应先回渲染进程
    return { ok: true as const }
  })
  // 切换到最近列表中的书库
  ipcMain.handle('desktop:switch-library', async (_e, path: unknown) => {
    if (typeof path !== 'string' || !isLibraryDir(path)) {
      return { ok: false as const, reason: '目录无效或不是书库' }
    }
    saveCurrent(path)
    setTimeout(relaunch, RELAUNCH_DELAY_MS)
    return { ok: true as const }
  })
  ipcMain.handle('desktop:get-recent', () => readStore().recent)
  // Y-11（第五十七轮）：M-3 第五入口漏网——改走 currentWorkDir()（bootstrap 实际值
  // 优先），否则 store.current 为 null/失效而 bootstrap 跑在 findWorkDir 发现的书库上时，
  // 书库管理窗口拿到与实际运行不一致的展示口径
  ipcMain.handle('desktop:get-current', () => currentWorkDir())
  // 在系统文件管理器中显示文档（electron only；浏览器版前端隐藏此项）
  ipcMain.handle('desktop:show-in-folder', (_e, bookName: unknown, relPath: unknown) => {
    if (typeof bookName !== 'string' || typeof relPath !== 'string') return
    if (relPath.includes('\0')) return
    const workDir = currentWorkDir() // M-3（第八轮）：bootstrap 实际值优先
    if (!workDir) return
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
  ipcMain.handle('desktop:open-book-dir', (_e, bookName: unknown) => {
    if (typeof bookName !== 'string' || bookName.includes('\0')) return
    const workDir = currentWorkDir() // M-3（第八轮）：bootstrap 实际值优先
    if (!workDir) return
    const entry = readBooks(workDir).find((b) => b.name === bookName)
    if (!entry) return
    // 路径校验：entry.path 来自 books.jsonl，防 `..`/symlink 越出 workDir 打开任意目录
    // （批 6 统一：resolveWithinRoot = 防穿越 + symlink 双侧 realpath，X-P3a 同口径）
    const safe = resolveWithinRoot(workDir, entry.path)
    if (!safe || !existsSync(safe.abs)) return // realpath 失败/不存在 = 无物可开
    void shell.openPath(safe.abs)
  })
  // 枚举系统已装字体（设置弹窗字体下拉用；font-list 跨平台封装系统命令，disableQuoting 返回裸名便于直拼 CSS）
  // R77-1（二十五轮批 A）：TTL 缓存降半档——系统字体枚举是跨平台系统命令（mac osascript /
  // win 注册表），渲染层重载（设置弹窗重开）/第二窗口重复 invoke 会逐次重跑；主进程侧补
  // 60s TTL + 在途合并（font-cache.ts）。失败不缓存，此处 catch 返回 [] 的兜底语义不变。
  const loadSystemFonts = createSystemFontCache(() => getSystemFontList({ disableQuoting: true }))
  ipcMain.handle('desktop:get-system-fonts', async () => {
    try {
      return await loadSystemFonts()
    } catch (e) {
      log.error('desktop', `get-system-fonts 失败：${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  })
  // 打开独立书架窗口（ribbon 书架按钮调用）
  ipcMain.handle('desktop:open-shelf', () => {
    // R30-24（三十轮）：openShelfWindow 是 async（内部 await devProxyApplied）——此前
    // fire-and-forget 裸调，窗工厂早期抛错成主进程 unhandledRejection 丢诊断。对齐
    // R74-16 的 loadURL 口径：promise 接日志留痕（handler 同步返回，invoke 端不悬等待、
    // 错误不外抛到渲染层，窗口崩溃另有 R67-16 自愈兜底）
    openShelfWindow().catch((e) => {
      log.error('desktop', `书架窗口打开失败`, e)
    })
  })
  // 书架窗口选书 → 主窗口加载该书并聚焦，关闭书架窗口
  ipcMain.handle('desktop:open-book', (_e, name: unknown) => {
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
  ipcMain.handle('desktop:open-library-window', () => {
    // R30-24（三十轮）：同 open-shelf——async 工厂 promise 接日志，防 unhandledRejection
    openLibraryWindow().catch((e) => {
      log.error('desktop', `书库管理窗口打开失败`, e)
    })
  })
  // 在系统文件管理器中打开当前书库根目录
  ipcMain.handle('desktop:open-library-dir', () => {
    const workDir = currentWorkDir() // M-3（第八轮）：bootstrap 实际值优先
    if (!workDir) return
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
    // 菜单再派发 action，click 可能晚于 callback —— 故 callback 里延后一拍
    // 才补发 null（取消），给 click 抢先 sendOnce 的机会。渲染侧是
    // ipcRenderer.once，只认第一条消息，抢先发 null 会吞掉整个菜单动作。
    menu.popup({
      window: win,
      callback: () => {
        setTimeout(() => sendOnce(null), 0)
      },
    })
  })
  // ── 专注模式全屏 ──
  // 渲染层进入/退出专注时驱动原生全屏。不走 HTML5 Fullscreen API：菜单加速键路径
  // 在渲染层无用户手势会被拒，setFullScreen 无此限制。作用于发起调用的窗口本体。
  ipcMain.handle('desktop:set-fullscreen', (event, flag: unknown) => {
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
      // R74-21（七十四轮批 D）：颜色格式白名单——此前只验 typeof，任意长/任意内容
      // 字符串直达 Electron setTitleBarOverlay 靠内部抛错兜底（catch 吞掉无痕）。
      // 只认 #RGB/#RGBA/#RRGGBB/#RRGGBBAA 形态（3-8 位十六进制）+ 字面量 'transparent'
      // （2026-08-31 窗控底色改透明后主题切换仍需合法通过），白名单外回显式错误；
      // 校验置于平台守卫前，与 isInvalidBookName 的「跨平台统一拒绝」口径一致
      //（mac 上也拦，行为一致更简单且可测）
      const hexColor = /^#[0-9a-fA-F]{3,8}$/
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
          click: () => void openLibraryAction(),
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
        { role: 'zoom' },
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
    if (!process.env['CLW_DEV_UI']) { // R62-45：bracket 统一风格
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
      getMainWindow: () => mainWindow,
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
  process.on('SIGINT', () => app.quit())
  process.on('SIGBREAK', () => app.quit())
  // 主进程未捕获异常：打包态 GUI 的 stderr 无人可见——先留痕 JSONL 日志（延迟一拍
  // 让日志泵落盘），再保持与默认崩溃等价的退出语义（不吞、不续跑半坏状态）。
  process.on('uncaughtException', (err) => {
    log.error('desktop', '主进程未捕获异常，即将退出', err)
    setTimeout(() => process.exit(1), 200)
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
  let quitViaShutdown = false
  app.on('before-quit', (e) => {
    if (quitViaShutdown) return // 收口 quit 放行直通
    e.preventDefault()
    if (!bootstrapRunner.beginShutdown()) return // 已在优雅停机在途：拦下等 finally 统一收口
    // R65-40（总六十五轮）：shutdown() 可能 reject（child 已死时 postMessage/kill
    // 抛错等）——原 `void …finally` 无 catch：rejection 成 unhandledRejection（丢
    // 现场）；quit 收口也悬空。包 try/catch + .catch 记日志，finally 仍 quit——
    // 退出收口不因停机失败而挂死。
    try {
      void serverManager
        .shutdown()
        .catch((err) => log.error('desktop', '优雅停机 shutdown 失败（继续退出）', err))
        .finally(() => {
          quitViaShutdown = true
          app.quit()
        })
    } catch (err) {
      // 防御：shutdown 同步抛（当前为 async fn 不可达，防将来重构回归同型挂死）
      log.error('desktop', '优雅停机 shutdown 同步抛错（继续退出）', err)
      quitViaShutdown = true
      app.quit()
    }
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
