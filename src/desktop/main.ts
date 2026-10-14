/**
 * Electron 主进程入口：fork server-utility 子进程承载 studio server（127.0.0.1 随机端口，
 * ready 握手回传）→ BrowserWindow loadURL；driver 会话与 SSE 全在 child，main 不直接碰 driver。
 * 模块边界（本文件只留模块级副作用时序锚点 + 装配）：窗口工厂/三窗引用 → windows.ts；
 * workdir.json 持久化/目录选择器/切库守卫/relaunch 意图 → workdir-controller.ts；
 * desktop:* IPC + handleTrusted 守卫单点 → ipc.ts；close/quit/session-end 三链 → lifecycle.ts。
 * 其余保留：app.setPath/initLogging/userData 时序、单实例锁 + second-instance、serverManager
 * 装配、bootstrap 启动时序（workDir 定位 → server fork+握手 → 主窗创建 → loadURL）、菜单、
 * 冒烟驱动、进程级退出兜底（信号/uncaughtException/unhandledRejection）。
 * 工作目录（书库）：启动定位 = 持久化 current > findWorkDir(cwd) > /welcome（不弹原生选择器）；
 * 切库 = 改持久化 current → app.relaunch 进程重启（规避 server 路由模块级单例 + SSE 长连接泄漏，
 * 见 Dev/Plans/desktop-workdir-方案.md §2.1/§3.1）。
 * 开发：npm run dev:electron（build:web + tsup + electron .）；打包：electron-builder
 *（dist/web + dist/desktop/{main,server-utility,preload} 进 asar）。
 */
import { app, BrowserWindow, session, screen, dialog, Menu, type MenuItemConstructorOptions } from 'electron'
import { dirname, join } from 'node:path'
import { statSync } from 'node:fs'
import { findWorkDir } from '../install/books.js'
import { sweepAppDataTmpFiles } from '../fs/atomic.js' // 应用级数据目录 tmp 清扫（启动尾段排程，见 scheduleAppDataTmpSweep）
import { appDataHomeDir, instanceKeyForDir, instanceUserDataPath, samePath } from '../fs/user-data-path.js'
import { resolveStartupLibraryDir } from './startup-instance.js' // 多库多窗：pre-setPath 同步解析启动库 + instanceKey
import { spawnLibraryInstance } from './new-instance.js' // 多库多窗·新窗入口：菜单「在新窗口中打开书库…」
import { initialBookArg, resolveInitialBook } from './initial-book.js' // --book 直进——argv 解析为登记书名仍在 main（书架登记表就在手边），
import { createStudioServerManager, ServerBootError } from './server-manager.js' // 阶段 22：server 拆分 utilityProcess
import { createBootstrapRunner } from './bootstrap-runner.js' // 生命周期 runner 可测
import { registerIpc } from './ipc.js' // IPC 注册面拆出
import { createRepeatedSignalExit } from './signal-hard-exit.js' // 重复信号硬退出口
import { acquireAppInstanceGuard } from './app-instance-guard.js' // 提权差异双开文件锁防线（win线并树随行）
import { defaultWindowSize } from './window-state.js' // 首启缺省尺寸/创建下限单源（纯函数，零 Electron 依赖）
import { attachMainWindowLifecycle, registerQuitChain, isAppTearingDown } from './lifecycle.js' // 退出链拆出
import {
  createSecureWindow,
  loadWinState,
  openLibraryWindow,
  openShelfWindow,
  wins,
  // CLW_SMOKE 窗口循环冒烟（e2e 专用、env 严格 opt-in）要白名单登记计数，登记表正本在
  // windows.ts 且无生产命名访问器——故本文件保留对该钩子的生产路径使用。
  __testHooks,
  getDevProxyApplied, // nano：原 let 导出 devProxyApplied 改函数访问器
  reclaimStaleMainWindow, // bootstrap 重跑前的旧主窗回收（见 windows.ts）
  setMainWindow, // 主窗登记单点（写 wins.mainWindow + 入回收面）
} from './windows.js' // 窗口工厂/三窗引用拆出
import {
  BOOTSTRAP_PROBE_TIMEOUT_MS,
  currentWorkDir,
  openLibraryAction,
  overwriteRecentInCache,
  pickLibrary,
  probeDirReachable,
  readStore,
  setBootstrappedWorkDir,
} from './workdir-controller.js' // workdir 控制器拆出
import { filterValidRecentBudgeted } from './workdir-store.js'
import { errMsg, flushLogs, initLogging, log } from '../log/index.js'
import { isApplyUpdateInvocation, parseApplyUpdateArgv, runUpdateHelper } from './update-helper.js' // 阶段 55 更新助手态分流（见下）
import { createUpdateCheckHost, scheduleUpdateMaintenance } from './update-controller.js' // 阶段 55 启动维护 + 更新检查宿主（检查归主进程，见 update-controller 注）

// ── 更新助手态分流（阶段 55）──────────────────────────────
/** 助手退出前等日志落盘的上限——盘面挂起时日志丢行可接受，助手被钉住退出前不可接受 */
const UPDATE_LOG_FLUSH_TIMEOUT_MS = 2000
// 判据只看旗（`--apply-update`）：带旗即绝不进入应用形态——不 setPath、不请求单实例锁、
// 不起 server、不开窗。助手是「旧应用已退出、新版未就位」窗口里唯一活着的进程；它若按
// 应用形态跑起来，会与即将被换名的目录纠缠出双开与锁冲突（自己持有的 userData 锁还可能
// 绊住换名）。故本分支须在任何应用级装配（下方的 homeDir/setPath/单实例锁）之前。
// 出口纪律：两条路径都直接终止进程——模块后续顶层代码（整个应用装配面）不得求值；
// app.exit 是 Electron 语义的立即退出（不发 before-quit），process.exit 兜底两者同发，
// 先到者接管进程终止（同发无副作用）。
if (isApplyUpdateInvocation(process.argv)) {
  // 关掉 Electron 的 asar 层：它把「写向 `*.asar` 目标」也当包体去解析——解压真实便携包的
  // `resources/app.asar` 条目会在 open 即抛 Invalid package（win 真机实测，更新链在打包态
  // 必败）。助手自身代码在分流前已载入完毕、其后只做目标目录的文件搬运与重启，全程不需要
  // asar；本开关只在本进程内生效，重启出的正式应用是独立进程、不受影响。
  process.noAsar = true
  const inv = parseApplyUpdateArgv(process.argv)
  if (!inv) {
    log.error('update', `更新助手参数不完整，放弃本次更新：${process.argv.slice(1).join(' ')}`)
    app.exit(2)
    process.exit(2)
  }
  // 助手自身 cwd 挪出目标目录：旧应用若由双击/快捷方式启动，其 cwd = 应用目录，助手经
  // spawn 继承之——进程 cwd 占住某目录时该目录改名必 EBUSY（win 真机实测：与「谁在运行」
  // 无关，exe 镜像本身不挡）。挪到上级（换名产物的落点）；上级不可达的极端形态维持原
  // cwd，由随后的改名以 target-locked 安全收口。
  try {
    process.chdir(dirname(inv.targetDir))
  } catch {
    /* 见上：安全收口在改名侧 */
  }
  if (inv.logDir) initLogging({ logsDir: inv.logDir, mirrorConsole: !app.isPackaged })
  log.info('update', `更新助手启动：${inv.fromVersion} → ${inv.toVersion}（等待 pid ${inv.pid} 退出）`)
  const outcome = await runUpdateHelper(inv)
  // 结局行与失败原因行须落盘后再退出：process.exit 不等在途异步写泵（win 真机实测——
  // 正是这次丢掉的「更新助手结局：aborted（reason）」与解压错误行）。上限 2s 兜底：
  // 盘面挂起时「日志没落」不该把助手永远钉在退出前（旧应用已退、新版未就位的窗口里
  // 它就是唯一活口）。
  await Promise.race([flushLogs(), new Promise((r) => setTimeout(r, UPDATE_LOG_FLUSH_TIMEOUT_MS))])
  const code = outcome === 'applied' ? 0 : 3
  app.exit(code)
  process.exit(code)
}

/** 生产模式 CSP：限定所有资源走本地 origin，防渲染层注入外部脚本/样式 */
const CLW_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // CodeMirror / Vue 动态样式注入
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'", // 只连本地 server（SSE + fetch）
  // frame-ancestors 显式 'none'——frame-ancestors 不回落
  // default-src（CSP 规范独立指令），缺省即本地端口可被任意页面嵌 iframe（点击劫持
  // /DNS rebinding 纵深；API 侧有 token 兜底，此为页面层防线）
  "frame-ancestors 'none'",
].join('; ')

/** HMR 开发模式判定（CLW_DEV_UI=1 且非打包态）——bootstrap 的 url 选择与 CSP 注入条件
 *  共用同一判据（单源：两处各写一份时，收紧一处漏另一处即「打包态切 HMR」或
 *  「dev 态被 CSP 掐死」）。
 *  防线：打包应用吃到宿主残留 CLW_DEV_UI=1 既不切 HMR 形态（localhost:5173 +
 *  跳过 server fork），也不放行跳过 CSP（Vite 需要的 unsafe-eval 豁免只属于真 dev）。 */
function isDevUi(): boolean {
  return !!process.env['CLW_DEV_UI'] && !app.isPackaged
}

// userData 目录（多库多窗，一库一实例）：Electron 的 userData 落
// `<home>/instances/<instanceKey>`——Electron 原生单实例锁作用域 = userData 目录，
// 「同库单实例、异库多实例」由它自动成立；Chromium 写面/日志/窗口几何/实例守卫随
// 实例目录隔离。应用级数据（providers/vault、global.json、prompts/、事件库、
// workdir.json、studio-token.json）留在共享根 <home>（见 src/fs/user-data-path.ts）。
// 不变量：instanceKey 须在 setPath 之前**同步**算出（库目录禁探测——失联网络卷会冻启动链）；
// 启动库路径 = `--dir` > `<home>/workdir.json`.current > findWorkDir(cwd) > welcome。
// CLW_SMOKE_USER_DATA（打包态冒烟 env 钩子，严格 opt-in）：e2e 打包态冒烟注入临时目录
// 隔离真实用户库——覆盖**共享根**，实例目录嵌套其下；env 未设时走缺省路径，生产零行为差异。
const homeDir = appDataHomeDir()
const startupLibrary = resolveStartupLibraryDir({ argv: process.argv, homeDir, cwd: process.cwd() })
const instanceKey = instanceKeyForDir(startupLibrary.dir)
app.setPath('userData', instanceUserDataPath(instanceKey))
// 结构化日志两段初始化（单写者约束：文件 sink 只归持锁实例）——日志目录随实例目录
// （同机多实例各写各的，互不串扰），但锁判定前只能定输出形态：未持锁实例随后即退，
// 此前若已建文件泵就会与持锁实例同写同一 logs 目录，7 天轮转清理也在两边各跑一次。
// 故先 init 成「只镜像 console、不落盘」——dev 态更早的失败行仍在控制台可见；打包态
// 锁判定前本就没有自身业务行（仅文件锁告警一类），不值得为它开文件泵。
// 文件落盘待锁通过后再 init 一次补挂目录：initLogging 重复调用按最后一次参数生效，
// 支持 null→目录切换（见 src/log/index.ts）。
initLogging({ logsDir: null, mirrorConsole: !app.isPackaged })

// 单实例锁：双开实例会对同一 userData 的 workdir.json / window-state.json
// 读改写互踩（atomic 写只防文件撕裂，防不了语义层竞态）。锁须在 setPath 之后请求，
// 保证 dev/打包两种形态落在同一 userData 上（否则锁会各自为政形同虚设）。
// 第二实例拿不到锁 → app.quit 并跳过文件底部全部生命周期注册（不进 whenReady、
// 不起 server、不开窗）；持锁实例收到 second-instance 时聚焦已有主窗口。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
// 提权差异双开的文件锁补充防线（Electron 锁按会话/提权上下文隔离，
// 管理员/普通用户各开一份时两侧各自持锁 → 双开互踩 userData 语义层）——文件锁跨提权
// 可见（pid 存活探测 EPERM 按存活保守处理），细节见 app-instance-guard.ts 头注。
// 须在 setPath(userData) 之后（同的身份域对齐理由）。fail-open：锁面异常不拦
// 启动（同用户双开仍由 Electron 锁兜底）。
const appInstanceGuard = acquireAppInstanceGuard(app.getPath('userData'))
if (!gotSingleInstanceLock || !appInstanceGuard.acquired) {
  app.quit()
} else {
  // 持锁实例 = 该 logs 目录的唯一写者：此刻补挂文件 sink——JSONL 落盘
  // （userData/logs/app-YYYYMMDD.jsonl）与启动期 7 天轮转清理都随本次调用生效；
  // 第二实例走上一分支，永不落盘、不跑清理。
  initLogging({ logsDir: join(app.getPath('userData'), 'logs'), mirrorConsole: !app.isPackaged })
  // 多实例诊断启动行：instanceKey + 解析来源 + 启动库路径。
  // 置于锁判定之后（本实例确为持锁实例才记）——锁判定前落行会把「未持锁即退」的瞬态
  // 实例行混进持锁实例的日志。
  log.info(
    'desktop',
    `实例启动：key=${instanceKey} 来源=${startupLibrary.source} 书库=${startupLibrary.dir ?? '（引导页）'} 共享根=${homeDir}`,
  )
  app.on('second-instance', (_e, argv: string[]) => {
    // 第二实例带 --book → 主窗口直达该书（与 desktop:open-book 同通路）
    // 只认本次 argv——回落 env 读到的是首实例的
    // CLWRITING_INITIAL_BOOK，普通二次拉起（无参双开）被误导航到首实例初书
    const workDir = currentWorkDir() // bootstrap 实际值优先
    const ref = initialBookArg(argv, { allowEnvFallback: false })
    if (workDir && ref && wins.mainWindow && !wins.mainWindow.isDestroyed()) {
      // resolveInitialBook→readBooks 同步扫书库，书库在失联网络卷时会冻主进程数秒——
      // 预探先行，'unreachable' log 留痕 + 忽略 book 引用（同族「无物可开」收口口径，
      // 不弹框打断前台应用）；聚焦不受预探影响，保持尾部同步执行。
      void (async () => {
        if ((await probeDirReachable(workDir)) === 'unreachable') {
          log.warn(
            'main',
            `second-instance 带 --book=${ref}，但书库目录暂不可达（可能是网络卷无响应或已断开）——已忽略直达`,
          )
          return
        }
        // 目录预探通过 ≠ 同步扫描安全：resolveInitialBook 内 readBooks 是同步
        // readFileSync（<workDir>/.clwriting/books.jsonl，常量未导出，路径与
        // src/install/books.ts BOOKS_FILE 同串勿漂移），网络卷「可达但慢/预探后瞬断」窗下
        // 同步读照样冻主进程秒级，而同步 IO 无法直接超时。故对真实读面再补一道有界预探：
        // 文件 stat 挂死（'unreachable'）即降级忽略直达并留痕；快速失败（'invalid'，如首启
        // 缺 books.jsonl 的 ENOENT）不拦——readBooks 对缺文件本就降级空表，交由既有
        // 「无此登记书」留痕路径收口。预探后瞬断的 TOCTOU 残窗仍在（既定取舍：冻结面从
        // 恒现路径收窄为预探后瞬断窗）。
        if ((await probeDirReachable(join(workDir, '.clwriting', 'books.jsonl'))) === 'unreachable') {
          log.warn(
            'main',
            `second-instance 带 --book=${ref}，但书库登记文件暂不可读（可能是网络卷无响应或已断开）——已忽略直达`,
          )
          return
        }
        const name = resolveInitialBook(workDir, ref)
        if (!name) {
          log.info('main', `second-instance 带 --book=${ref}，但书库内无此登记书——已忽略直达`) // 忽略留痕
          return
        }
        // 预探 await 期间窗口可能已关：导航前重验存活（同 open-book 的 isDestroyed 守卫）
        if (wins.mainWindow && !wins.mainWindow.isDestroyed()) {
          wins.mainWindow.webContents.send('desktop:navigate', `/book/${encodeURIComponent(name)}`)
        }
      })()
    } else if (ref) {
      // 启动早期（bootstrappedWorkDir 未就绪/无持久化 current）或主窗不可用时原路径会
      // 静默吞掉 --book——留痕含被忽略的值
      const why = !workDir ? '书库未就绪（bootstrap 未完成且无持久化 current）' : '主窗口不可用'
      log.warn('main', `second-instance 带 --book=${ref}，但${why}——已忽略（聚焦现有窗口）`)
    }
    if (wins.mainWindow && !wins.mainWindow.isDestroyed()) {
      // mac 上 app.focus 默认只激活不抢焦点，双开拉起可能只聚焦不置前——
      // darwin 补 steal:true 自其他 app 强制夺焦并置前主窗
      if (process.platform === 'darwin') app.focus({ steal: true })
      wins.mainWindow.focus()
    }
  })
}

/** 更新检查宿主（下方 serverManager 之后装配；onRestarted 早于装配求值的静态引用经此转发） */
let updateCheckHost: ReturnType<typeof createUpdateCheckHost> | null = null

/** studio server 已拆至 utilityProcess 子进程（dev HMR 态不起）；崩溃退避自动重启，
 *  3 次自动重启耗尽转原生对话框（重启服务/退出） */
const serverManager = createStudioServerManager({
  // 自愈等待期的退出探测——restartPinned 在停机流程中改为有界等收口；等待/收口窗口内
  // 用户真退出（退出链进入 tearing-down 相位）则放弃恢复，不在退出链上 fork 新 child
  // 成孤儿。相位正本在 lifecycle.ts，经 isAppTearingDown() 读数。
  isProcessExiting: () => isAppTearingDown(),
  // 重启成功广播——崩溃自动重启（doRestart）/session-end 自愈（restartPinned）钉住端口
  // 拉回成功后，向全部存活窗口发 desktop:server-restarted；渲染层（Book.vue 订阅）
  // sse.resync 立即断旧连新 + 重取连接级 sync 快照。无广播时自愈成功 UI 无感知，SSE
  // 只能等自身退避重连，「服务已恢复但界面不动」的盲窗随退避时长展开。
  onRestarted: (port) => {
    for (const win of [wins.mainWindow, wins.shelfWindow, wins.libraryWindow]) {
      if (win && !win.isDestroyed()) win.webContents.send('desktop:server-restarted', port)
    }
    // 新 child 的更新检查模块态是空的——不补发则「已检查/有新版本」结论随重启丢失，
    // 用户看到角标消失且直到下次检查（本 app 生命周期只排一次）都不会再出现
    updateCheckHost?.pushLastResult()
  },
  onRestartExhausted: async () => {
    // 同步对话框泵原生嵌套消息循环，崩溃风暴路径上主进程事件循环会被冻（三窗口输入/
    // IPC 全停）；故用异步 showMessageBox，exit 回调即刻返回，决断到达前不重启不退出
    //（server-manager 侧 void Promise 适配）。
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
/** bootstrap-runner「重试前关旧 server」的适配器——close() 即停旧 child（kill + 等退出由
 *  manager 保证；下一次 start 先等旧 child 退出再 fork）。close 返回 stopChild 的 Promise——
 *  runner 等其落定再开跑新 bootstrap（不 fire-and-forget）；stopChild 自带
 *  cancelPendingRestart，挂起重启随关旧一并作废 */
const legacyStopHandle = { close: () => serverManager.stopChild() }

/** 真实 Electron 窗口循环冒烟——仅当 CLW_SMOKE_WINDOW_CYCLE=1 时由 bootstrap 末段
 * （[CLW_SMOKE] ready 之后）调用，保证 app 已 ready 再动窗口。目的：把「closed 清理监听
 * 在销毁态 webContents 上抛错 → 中断 emit 遍历令其余清理/白名单摘除短路」这类缺陷由真实
 * Electron 进程兜住——单测假件只能锁单测口径，真实销毁语义（closed 后读 webContents 抛
 * "Object has been destroyed"）唯有真实进程可复现。复用 createSecureWindow 工厂：安全
 * 五件套 + trackWindow（白名单登记 + closed 摘除）与生产完全同链。
 * 契约输出串（CI 驱动 grep 硬绑定，勿改）：成功 [CLW_SMOKE] window-cycle-ok（exit 0）；
 * 超时 [CLW_SMOKE] window-cycle-timeout（exit 非 0）；未捕获异常 [CLW_SMOKE] crash
 * <message>（经 uncaughtException 首行，见其处理器）。
 * 严格 opt-in：env 未设置为 '1' 时本函数零调用（不建窗/不打日志/不改时序）。 */
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
    // 先捕获局部 wc 引用——窗口销毁后读 probe.webContents 会抛（根因形态）
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
  // recent 失效过滤在此异步预算一次执行——readStore 首读内联同步过滤（existsSync+statSync
  // 逐条）时，recent 残留失联网络卷会让 bootstrap 首行即同步冻主进程数十秒；
  // probeDirReachable 防线只护 current/cwd，recent 条目在防线外。超时项保留展示
  //（失联≠失效，择库守卫预探拦截）；并行预算 ≤ MAX_RECENT 条，总延迟 = 单条预算。
  // 此刻无 renderer sender 到达（窗口要等 bootstrap 定出 workDir 后才创建、渲染层尚未
  // 加载），不构成 IPC 并发面——同步冻住的是主进程自身。
  if (store.recent.length > 0) {
    const filtered = await filterValidRecentBudgeted(store, { timeoutMs: BOOTSTRAP_PROBE_TIMEOUT_MS })
    // 整覆只回填 recent 字段——await 窗内菜单/IPC 链的并发写（saveCurrent→writeStore 换
    // storeCache 对象）会被旧 store 的整对象赋值回滚（内存面丢 current，盘面与内存面自此
    // 分叉直到重启）；展开当下 storeCache 只覆写 recent。?? store：类型收窄兜底
    //（readStore 已建缓存，此分支 storeCache 恒非空且 !== null）。
    // storeCache 正本在 workdir-controller，经 overwriteRecentInCache 写。
    overwriteRecentInCache(store, filtered.recent)
  }
  let workDir: string | null = null
  // --dir 显式指定（spawn 新窗口/命令行直达）优先于持久化 current，且不回落 cwd——
  // 显式意图；不可用即引导页（回落会打开一个与用户意图无关的库）。其余来源维持原链。
  const argDir = startupLibrary.source === 'arg' ? startupLibrary.dir : null
  const launchCandidate = argDir ?? store.current
  // 持久化 workDir 须做目录校验——仅 existsSync 时指向普通文件会被静默采信为「空书架
  // 无引导」；失效回落 findWorkDir(cwd)，仍无 → /welcome 引导。current 先经可达性预探：
  // 指向失联网络卷（挂载点在服务器无响应态）时，下方 statSync 单点即可同步冻主进程数十秒。
  // 'unreachable' 原生错误框留痕 + 回落发现链（不退出——作者可切到可用书库）；'invalid'
  //（确定性坏路径）与预探通过后的瞬断均维持原回落语义（TOCTOU 残窗同口径收窄，非消灭）。
  if (launchCandidate) {
    const reach = await probeDirReachable(launchCandidate, BOOTSTRAP_PROBE_TIMEOUT_MS)
    if (reach === 'ok') {
      try {
        if (statSync(launchCandidate).isDirectory()) workDir = launchCandidate
      } catch {
        /* 预探通过后的瞬断 → 走回落（arg 形态回落 = 引导页） */
      }
    } else if (reach === 'unreachable') {
      dialog.showErrorBox(
        '书库目录无响应',
        argDir
          ? `本次要打开的书库目录暂不可达（可能是网络卷无响应或已断开）：\n${argDir}\n\n本次启动进入引导页；恢复挂载后重新打开即可。`
          : `上次的书库目录暂不可达（可能是网络卷无响应或已断开）：\n${store.current}\n\n本次启动改为自动寻找可用书库；恢复挂载后可在「书库管理」切回。`,
      )
    }
    if (argDir && !workDir && reach !== 'unreachable') {
      // --dir 无效（非目录/确定性坏路径/瞬断）：显式意图落空 → 引导页明确交代，不静默
      dialog.showErrorBox(
        '书库目录不可用',
        `本次要打开的书库目录无法使用：\n${argDir}\n\n应用将进入引导页，可重新选择书库。`,
      )
    }
  }
  if (!workDir && !argDir) {
    // -1 同款防线：findWorkDir 同步爬祖扫描——cwd 也在失联卷上时同样冻结主进程，
    // 预探不可达即跳过发现（workDir 留 null → /welcome 引导，维持「启动零弹选择器」口径）
    if ((await probeDirReachable(process.cwd(), BOOTSTRAP_PROBE_TIMEOUT_MS)) !== 'unreachable') {
      workDir = findWorkDir(process.cwd())
    } else {
      dialog.showErrorBox(
        '运行目录无响应',
        '应用运行目录暂不可达（可能位于已断开的网络卷），本次启动进入引导页；恢复挂载后重启应用即可。',
      )
    }
  }
  // 实例 key 与 bootstrap 实际采用库不一致（current 失效 → 回落 cwd 发现的残余形态）：
  // Electron 原生锁落在错误的 key 域，本会话「同库单实例」防线降级。故补挂一道实例守卫到
  // **实际采用库**的实例目录——此后任何以该库为 key 的实例启动时经 acquireAppInstanceGuard
  // 见他实例在持而自退，防线恢复。锁面异常 fail-open（不拦启动）。
  if (workDir && startupLibrary.dir && !samePath(workDir, startupLibrary.dir)) {
    log.warn(
      'desktop',
      `实例 key 按启动解析的库派生（${startupLibrary.dir}），bootstrap 实际采用 ${workDir}——已补挂实例守卫到实际库（同库单实例防线恢复）`,
    )
    try {
      const actualKey = instanceKeyForDir(workDir)
      if (actualKey !== instanceKey) {
        const supplement = acquireAppInstanceGuard(instanceUserDataPath(actualKey))
        if (!supplement.acquired) {
          // 实际库已有他实例在跑（正常 key 形态）——本实例是「降级双开」的后到者：
          // 明确交代并自退，不静默双开同库（本进程并非该库的锁主，跨进程聚焦不可达，
          // 故只拒启本实例，不能把已开窗口拉到前台）。
          log.error('desktop', `实际采用的书库已在另一窗口打开（${workDir}）——本实例退出，避免同库双开`)
          dialog.showErrorBox(
            '书库已在其他窗口打开',
            `本窗口要打开的书库已在另一个窗口打开：\n${workDir}\n\n请使用已打开的窗口；本窗口即将关闭。`,
          )
          app.quit()
          return
        }
      }
    } catch (e) {
      log.warn('desktop', `实例守卫补挂失败（fail-open，不拦启动）：${errMsg(e)}`)
    }
  }
  // 服务端记录 bootstrap 实际采用的 workDir——退出时若回读 readStore.current，在
  // store.current 为 null/失效而 workDir 由 findWorkDir 发现时会拿到 null：不 abort 任何
  // 在途 chat/self-heal、不等后台任务（孤儿会话只能靠 32 分钟宽限修复，ORPHAN_GRACE_MS
  // 见 events/store.ts）。退出以启动时实际值优先，store 回读兜底。
  // welcome 态 workDir 可为 null，currentWorkDir 的 ?? 兜底因此走 readStore——缓存就位后
  // 该兜底零盘 IO，null/'' 语义维持原状。bootstrappedWorkDir 正本在 workdir-controller，
  // 经 setter 记账。
  setBootstrappedWorkDir(workDir)
  const needsWelcome = !workDir

  // HMR 开发模式：CLW_DEV_UI=1 时加载 Vite dev server（localhost:5173），前端改动实时热更新；
  // 不起 server，API 由独立 dev:api(7878) 提供（Vite proxy 转发）。IPC/preload 照常，桌面能力完整。
  // 判据见 isDevUi（打包态吃到宿主残留 CLW_DEV_UI 不切 HMR 形态）。
  const devUi = isDevUi()
  // 本 bootstrap 轮是否 fork 了 studio server——session-end 观察
  // 窗自愈据它判「dev HMR 态只复位旗、不拉服务」（dev 态 API 由独立 dev:api 进程供给）
  let serverStarted = false
  if (devUi) {
    wins.appUrl = 'http://localhost:5173'
  } else {
    // --book 直进——argv 解析为登记书名仍在 main（书架登记表就在手边），
    // 下沉为 --book 参数由 child 在 startServer 前调 setInitialBook（附带；
    // dev HMR 态不起 server，boot 由独立 dev-api 提供，此项不生效）
    let initialName: string | null = null
    if (workDir) {
      // env 回落仅非打包态生效——打包态宿主残留 CLWRITING_INITIAL_BOOK
      // 不再让普通启动被意外直达（devUi 防线同款口径）
      const ref = initialBookArg(process.argv, { allowEnvFallback: !app.isPackaged })
      if (ref) initialName = resolveInitialBook(workDir, ref)
    }
    // fork server-utility 子进程 + ready 端口握手（时序等价拆分前的
    // await listenPort——loadURL 仍发生在 server ready 之后，验收门 2）
    let port: number
    try {
      port = await serverManager.start({
        workDir,
        // 共享根（非 Electron userData）——server 的应用级数据（providers/vault、
        // global.json、prompts/、事件库、studio-token.json）跨库共享；Electron 的
        // userData 已随实例目录（多库多窗目录拆分），两者在此显式解耦。
        userDataPath: homeDir,
        book: initialName,
        mirrorConsole: !app.isPackaged,
        // 阶段 53：版本号下发子进程（child 无 app 对象）——更新检查的当前版本基准
        appVersion: app.getVersion(),
      })
      serverStarted = true // session-end 观察窗自愈的「有服务可拉回」判据
    } catch (e) {
      // 时序 2（仅首次启动）：boot-error（如 EADDRINUSE）→ 原生错误对话框（复用
      // server-main 拆分前中文口径）→ 上抛走 onError app.quit
      if (e instanceof ServerBootError) {
        dialog.showErrorBox('CLWriting 服务启动失败', `${e.message}\n\n应用即将退出。`)
      }
      throw e
    }
    wins.appUrl = `http://127.0.0.1:${port}`
  }

  // 主窗口 bounds：优先恢复上次尺寸/位置；无记录时缺省按工作区占比取（宽 60%/
  // 高 80%，随分辨率自适应——不同机器首开窗口比例一致，大屏不再钉死 1532×1237
  // 定值）。缺省与 minWidth/minHeight（1200×760 保三栏不挤；下限不得超过
  // 可用工作区——1366×768 上原 760 硬下限出生即压任务栏，小屏按 wa-8 收口。恢复侧
  // WIN_MIN_HEIGHT 随行收口）统一在 window-state.defaultWindowSize 单源。
  const saved = loadWinState()
  const wa = screen.getPrimaryDisplay().workAreaSize
  const { width: defW, height: defH, minWidth, minHeight } = defaultWindowSize(wa)
  const mainWindow = createSecureWindow({
    width: saved?.bounds.width ?? defW,
    height: saved?.bounds.height ?? defH,
    x: saved?.bounds.x,
    y: saved?.bounds.y,
    minWidth,
    minHeight,
    title: 'CLWriting',
  })
  // 登记主窗（写 wins.mainWindow + 入历轮主窗回收面，见 windows.ts）：单点登记防
  // 「建了窗却漏进回收面」——重跑 bootstrap 时旧窗若不在回收面，就永久脱管
  setMainWindow(mainWindow)
  if (saved?.maximized) mainWindow.maximize()
  // 关窗兜底——首轮 close 先 preventDefault，经渲染层钩子异步
  // flush（页面未死，异步保存链全通）落定/短超时后 destroy 真正关窗（destroy 不再
  // 触发 beforeunload，链路单次不循环）。退出链（before-quit）已先行 flush 并在收口
  // destroy 全窗，session-end 时间窗有限，两者都直接放行。
  // 退出链相位与待汇入退出请求为 lifecycle 模块级显式状态机（ExitPhase + exitChain；
  // 读数 isCloseFlushInFlight / isQuitChainEngaged / isQuitReleased / isExitPassthrough
  // 为正本）——close/session-end/focus/closed/全屏反向同步监听统一经
  // attachMainWindowLifecycle 挂载。
  attachMainWindowLifecycle(mainWindow, {
    serverManager,
    isServerStarted: () => serverStarted,
  })
  // 纵深防御监听与 dev 代理已由 createSecureWindow 统一挂载；此处 await 一次保证
  // 主窗首载前代理确定生效（工厂内是 fire-and-forget，此处 loadURL 前须确定）
  if (devUi) {
    // 主窗 dev 态二次 setProxy（形态）删除
    // ——改 await 工厂侧记账 promise getDevProxyApplied()（nano 起为函数访问器；
    // createSecureWindow 对主窗以同
    // 一 devUi 条件 fire-and-forget setProxy direct:// 并记账，同值幂等）。省一次
    // session setProxy 往返；失败面同序降级（工厂侧 catch 记 error 后按系统
    // 代理继续首载，不再炸启动），Promise 形态 = setProxy.catch(...) 恒 resolve 的
    // Promise<void>，await 不抛。
    await getDevProxyApplied()
  }
  // 主窗 loadURL 本地留痕——ready 回传后、首载落定前 server 崩溃
  //（退避重启窗）的窄竞 rejection 此前直穿 bootstrap reject，onError 只见「启动失败」
  // 一行、缺首载 URL 现场（书架/书库窗均已 .catch 留痕，唯主窗裸奔，不对称）。
  // 镜像补 catch 记日志后仍原样上抛——「bootstrap reject → 启动失败 + quit」为固化
  // 设计路径（main.test 时序 2；bootstrap-runner 亦按此失败面设计），不吞。
  const mainUrl = needsWelcome ? `${wins.appUrl}/welcome` : wins.appUrl
  try {
    await mainWindow.loadURL(mainUrl)
  } catch (e) {
    log.error('desktop', `主窗口加载失败（${mainUrl}）`, e)
    throw e
  }
  // 改走 logger——打包态 mirrorConsole=false，console.log 此前在生产
  // 完全不可见（终端无人看、又不进 JSONL 日志）
  log.info(
    'desktop',
    `CLWriting ${devUi ? 'dev（HMR）' : '桌面版'}已启动 → ${wins.appUrl}${needsWelcome ? '/welcome' : ''}`,
  )
  // 启动完成的结构化标记——desktop.yml 启动冒烟 grep 此判定用
  // （一行 ASCII、无中文措辞依赖）。直写 console：打包态 log.* 只落 JSONL 不镜像
  // stdout，冒烟步重定向的是进程标准流
  console.log('[CLW_SMOKE] ready')
  // 真实 Electron 窗口循环冒烟（严格 opt-in）——app ready 且主窗首载落定后
  // 才跑；env 未设为 '1' 时零调用（不建窗/不打日志/不改时序，生产行为逐字节不变）。
  if (process.env['CLW_SMOKE_WINDOW_CYCLE'] === '1') {
    runSmokeWindowCycle()
  }
  // 首载落定后的应用级 tmp 清扫（共享根 + 实例目录；异步让出、失败留痕，见排程函数注）
  scheduleAppDataTmpSweep()
  // 更新残留清扫（旧版本目录 / 旧版更新包；打包态才跑，见 update-controller 注）
  scheduleUpdateMaintenance()
  // 更新检查宿主（延迟跑一次 + 结果下发子进程；检查走 net.fetch 与下载腿同通道受系统代理）
  if (!updateCheckHost) {
    updateCheckHost = createUpdateCheckHost({ push: (message) => serverManager.postMessage(message) })
  }
  updateCheckHost.scheduleCheck()
}

/** 应用级数据目录 tmp 清扫是否已排过（bootstrap 会因 activate/失败重试重跑，清扫一次即可） */
let appDataTmpSweepScheduled = false

/** 启动尾段的 tmp 清扫排程：共享根（providers/global/workdir/诊断包…的 atomic 写落点）
 *  与**本实例目录**（window-state/日志目录所在的 Electron userData）各扫一次。
 *
 *  为何挂在启动尾段而不是启动前：sweepAppDataTmpFiles 内部逐目录让出，且此处
 *  fire-and-forget 不 await——建窗与首载已完成，清扫不占启动关键路径（书库根的同款清扫
 *  在进门健康检查里是另一挂点，两处目录互不重叠）。清扫失败只留痕（函数内 best-effort），
 *  绝不把启动链带红。
 *  实例目录取 app.getPath('userData')（本进程已 setPath 的权威值），共享根取
 *  appDataHomeDir()；两者在测试态可重合，清扫函数内已按目录去重。 */
function scheduleAppDataTmpSweep(): void {
  if (appDataTmpSweepScheduled) return
  appDataTmpSweepScheduled = true
  void sweepAppDataTmpFiles([appDataHomeDir(), app.getPath('userData')]).catch((e) => {
    log.warn('desktop', `应用数据目录 tmp 清扫排程异常（不影响启动）：${errMsg(e)}`)
  })
}

// ── 原生菜单 ──────────────────────────────────────────

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  /** 业务菜单项 click → 发 actionKey 给主窗口（前端 useAppActions.dispatch 消费）。
   *  actionKey 须与 web-next/src/composables/useAppActions.ts 的 id 一致。
   * 此前发往聚焦窗口——书架/书库等子窗口聚焦时（macOS 菜单恒
   *  全局可点）action 发进子窗口静默丢失（子窗口无 useAppActions 接线）。固定发
   *  mainWindow + isDestroyed 判（退出/崩溃窗口期菜单仍可点）。
   *（win 线的「无聚焦窗口回退」场景已由 mainWindow ?? 首窗回退覆盖——
   * 不回退 getFocusedWindow，否则子窗口聚焦时重引入已修的静默丢失。）
   * `?? getAllWindows()[0]` 首窗回退删除——主窗销毁窗口期
   *  （close 拦截 flush/退出链在途）首窗可能是无 useAppActions 接线的子窗，动作发进
   *  子窗即静默丢失；回退限主窗存在才发送，主窗不存在 log.warn 留痕（动作丢弃可见）。 */
  function action(key: string): Pick<MenuItemConstructorOptions, 'click'> {
    return {
      click: () => {
        const target = wins.mainWindow
        if (!target || target.isDestroyed()) {
          log.warn('desktop', `菜单动作 ${key} 无主窗可发（主窗不存在或已销毁）——本次已丢弃`)
          return
        }
        target.webContents.send('desktop:menu-action', key)
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
          // async 工厂 promise 接日志——与上方 openShelfWindow/
          // openLibraryWindow（口径）同款；裸 void 调用下 dialog reject 成
          // unhandledRejection（Node 15+ 默认 throw）→ uncaughtException exit(1)，
          // 点一次菜单 = 应用静默退出
          click: () => {
            openLibraryAction().catch((e) => {
              log.error('desktop', '打开书库目录失败', e)
            })
          },
        },
        {
          // 多库多窗·新窗入口：当前窗口不动，spawn 新实例并以 --dir 指向所选书库。
          // 校验链复用 pickLibrary（书库校验/大小写敏感卷警告/「在此新建」引导）。
          label: '在新窗口中打开书库…',
          click: () => {
            void (async () => {
              const dir = await pickLibrary()
              if (!dir) return
              // spawn 成败经 'spawn'/'error' 事件落定（失败已消费不再反噬主进程，见 new-instance 头注）
              if (!(await spawnLibraryInstance(dir))) {
                dialog.showErrorBox('打开新窗口失败', `无法在新窗口中打开书库：\n${dir}\n\n请重试或查看日志。`)
              }
            })().catch((e) => {
              log.error('desktop', '在新窗口中打开书库失败', e)
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
        // mac适配：⌘F 查找此前仅在编辑器聚焦时由 CM searchKeymap 响应，
        // 焦点在外时按 ⌘F（及右键菜单「查找」的暗示）完全无响应——补系统菜单项走
        // action('find') 统一转发，前端 useAppActions 'find' 动作接 EditorView.openSearch
        { label: '查找…', accelerator: 'CmdOrCtrl+F', ...action('find') },
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
        // reload 系仅 dev 保留：生产下误触整页重载会丢未保存编辑，兜底保存不保证全救回
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
        // zoom 是 macOS 专属 role（NSWindow performZoom:）——
        // win/linux 上是无动作死菜单项。非 mac 用最大化/还原 toggle 替代；目标窗
        // 解析与上方 action() 同口径（mainWindow ?? 首窗不回退 getFocusedWindow）。
        ...(isMac
          ? [{ role: 'zoom' as const }]
          : [
              {
                label: '最大化/还原',
                click: () => {
                  const win = wins.mainWindow ?? BrowserWindow.getAllWindows()[0]
                  if (win && !win.isDestroyed()) {
                    if (win.isMaximized()) win.unmaximize()
                    else win.maximize()
                  }
                },
              } as MenuItemConstructorOptions,
            ]),
        { type: 'separator' },
        // 书架/书库管理直接主进程开窗（不绕前端 dispatch）
        // 同 ipc handler 口径——async 工厂 promise 接日志防
        // unhandledRejection（click 回调与 invoke 回调同款裸浮调用面）
        {
          label: '书架',
          click: () => {
            openShelfWindow().catch((e) => {
              log.error('desktop', '书架窗口打开失败', e)
            })
          },
        },
        {
          label: '书库管理',
          click: () => {
            openLibraryWindow().catch((e) => {
              log.error('desktop', '书库管理窗口打开失败', e)
            })
          },
        },
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

// 单实例锁守卫——第二实例已在顶部 app.quit()，跳过全部生命周期注册，
// 防退出竞态中 whenReady/activate 仍触发 bootstrap（起 server/开窗/读写状态文件）
// 守卫补消费文件锁标志——原只看
// gotSingleInstanceLock，跨提权双开（Electron 锁按提权上下文隔离、双方各持，正是
// 文件锁防线要堵的场景）时第二实例 gotSingleInstanceLock=true 而
// appInstanceGuard.acquired=false：顶部 quit 照发但退出是异步的，本守卫放行使生命周期
// 全注册（瞬态起 server child/开窗/写 workdir.json），文件锁防线要关闭的语义层竞态重开。
// 双标志与门与顶部 :235 同款（guard 异常时 fail-open 返回 acquired:true，放行语义不变）。
if (gotSingleInstanceLock && appInstanceGuard.acquired) {
  app
    .whenReady()
    .then(() => {
      // 生产模式注入 CSP（开发 HMR 模式跳过——Vite 依赖 unsafe-eval/unsafe-inline）；
      // 判据同 isDevUi（打包态恒注入 CSP，宿主残留 CLW_DEV_UI 不放行跳过）
      if (!isDevUi()) {
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
        log.error('desktop', `启动失败：${errMsg(e)}`, e)
        app.quit()
      })
    })
    .catch((e) => {
      // 服务端：whenReady 回调同步段抛错原先变 unhandledRejection，绕过
      // runBootstrap 的错误通道（app 挂无窗口态）——链尾兜底走同一出路
      log.error('desktop', `whenReady 回调失败：${errMsg(e)}`, e)
      app.quit()
    })

  // bootstrap 并发重入防护——macOS 启动慢时点 dock 图标，activate 只判
  // mainWindow === null 会并发二次 bootstrap（双主窗口 + 双 server child）；
  // 只挡「进行中」，完成/失败后仍可重试（保 activate 重建窗口语义）。
  // deps 换轨——「重试前关旧 server」经 legacyStopHandle 停旧 child
  const bootstrapRunner = createBootstrapRunner(
    {
      // （打包）：child 已崩但退避重启在途时 isRunning() 为 false——原判据
      // 会漏取 legacyStopHandle，既不关旧也不取消挂起重启（语义旁路）；补
      // hasPendingRestart 使「重试前关旧」覆盖重启在途窗口
      getStudioServer: () => (serverManager.isRunning() || serverManager.hasPendingRestart() ? legacyStopHandle : null),
      // 重跑前回收旧主窗（详情见 windows.ts reclaimStaleMainWindow 头注）
      reclaimStaleMainWindow,
    },
    () => bootstrap(),
  )
  function runBootstrap(onError?: (e: unknown) => void): void {
    bootstrapRunner.runBootstrap(onError)
  }

  // 桌面应用：关窗即退出（停 server）。本行是无条件 quit，与「关窗不退出、靠 activate
  // 重建」互斥——activate 分支的「无窗重建」链因此生产不可达（判据见该分支内登记）。
  app.on('window-all-closed', () => {
    app.quit()
  })

  // 进程级退出兜底——dev 控制台 Ctrl+C（SIGINT）/Ctrl+Break（SIGBREAK）/SIGTERM 直接硬杀
  // 会跳过 before-quit 优雅停机链；改为走 app.quit 复用既有幂等链（退出链 releasing 相位
  // 直通 + 幂等门防重入，重复信号安全）。
  // SIGTERM 在 win 上无投递机制（外部 TerminateProcess 不进 JS handler），本行实际仅
  // POSIX 生效；win 的硬杀面由 SIGBREAK 与 uncaughtException backstop 兜底。保留本行为
  // 三平台对齐与跨平台宿主预留，非缺陷。
  // 三行注册经 createRepeatedSignalExit——同型信号第二次到达直接 killNow + exit(1) 硬退
  //（逻辑正本与动机见 signal-hard-exit.ts 头注）；首次语义（app.quit 单次优雅链）不变。
  const onExitSignal = createRepeatedSignalExit({
    requestGracefulQuit: () => app.quit(),
    killNow: () => serverManager.killNow(),
    exit: (code) => process.exit(code),
  })
  process.on('SIGINT', () => onExitSignal('SIGINT'))
  process.on('SIGBREAK', () => onExitSignal('SIGBREAK'))
  process.on('SIGTERM', () => onExitSignal('SIGTERM'))
  // 主进程未捕获异常：打包态 GUI 的 stderr 无人可见——先留痕 JSONL 日志（延迟一拍
  // 让日志泵落盘），再保持与默认崩溃等价的退出语义（不吞、不续跑半坏状态）。
  process.on('uncaughtException', (err) => {
    // 真实 Electron 窗口循环冒烟——崩溃串须先于既有退出路径打出（CI 驱动
    // grep 用）；仅 opt-in 态输出，env 未设时零副作用。
    if (process.env['CLW_SMOKE_WINDOW_CYCLE'] === '1') {
      console.log(`[CLW_SMOKE] crash ${errMsg(err)}`)
    }
    log.error('desktop', '主进程未捕获异常，即将退出', err)
    // 200ms 窗内对 server child best-effort kill——父进程崩溃硬退
    // 时 utilityProcess 子进程不被连带收尸（win 上成孤儿继续持端口/会话锁，原全靠
    // 事件库 10min 孤儿宽限兜底）。stopChild 幂等且 child 已死形态安全，失败不影响
    // 退出语义（账面级缺口由 10min 宽限与 .版本 快照兜底，正文无损）。
    // （#35）：200ms 到点 stopChild 可能仍在 settle 竞速窗内
    // （预算 2s，kill 尚未发出）——裸 process.exit 会把 child 留成孤儿。到点先经
    // killNow 对在途 child/在途 fork 同步发出 kill 信号（fire-and-forget，不等待
    // 收口——uncaughtException 后必须退出不悬挂），再硬退；kill 已发出的形态下重复
    // kill 为无害幂等。硬约束不破：退出不被 stopChild 拖延（200ms 上限保留）。
    const backstop = setTimeout(() => {
      serverManager.killNow()
      process.exit(1)
    }, 200)
    void serverManager
      .stopChild()
      .catch(() => {})
      .then(() => {
        // 已落定：撤 200ms 兜底，延迟一拍让日志泵落盘后硬退（原「延迟一拍」语义）
        clearTimeout(backstop)
        setTimeout(() => process.exit(1), 0)
      })
  })
  // unhandledRejection 最后防线——各调用点已有 .catch 纪律，
  // 本兜底只 log 不退出（漏网 rejection 不再静默无痕；退出语义维持 uncaughtException
  // 独占，避免把可自愈的异步失败升级成崩溃）。
  process.on('unhandledRejection', (reason) => {
    log.error('desktop', '主进程未处理的 promise rejection（已记录，不退出）', reason)
  })

  // 优雅退出链装配（处理器正本在 lifecycle.ts；装配时序为契约：注册位次
  // 介于 unhandledRejection 与 activate 之间）。
  registerQuitChain(bootstrapRunner, serverManager)

  app.on('activate', () => {
    // 低-8：退出途中不再重 bootstrap——before-quit 的 3.5s 优雅退出窗口内
    // （shuttingDown 已置位）macOS dock 点击仍会触发 activate，若只判
    // mainWindow === null 会在退出半途再起 server/开窗（与退出竞态同族）
    if (bootstrapRunner.shuttingDown) return
    if (wins.mainWindow === null) {
      // 重试失败只留痕不退出（与首启失败 app.quit 的差异系有意）：activate 只在 macOS
      // 触发，dock 图标恒在——失败后用户再点一次即可重试；此处若 quit，反而把一次可恢复
      // 的重试升级成进程退场。首启失败无重试入口（win/linux 无 activate），故必须退出。
      //
      // 生产可达性登记：本分支当前**生产不可达**，勿据其在场推断存在「无窗重建」链。
      // 判据：mainWindow 置 null 的唯一生产点在 lifecycle.ts 主窗 closed 监听（置 null 后
      // 同一回调内即 app.quit），而 window-all-closed 无条件 quit、quit 链会把
      // bootstrapRunner.shuttingDown 置位——activate 到达时上面第一行守卫必先 return。
      // 仅测试直接置 wins.mainWindow = null（test/desktop/main-lifecycle-exit.test.ts）
      // 能驱动本分支，故保留不删（删掉即丢该路径的回归锚）；若将来放开「关窗不退出」，
      // 本分支就是重建入口，届时须同时复核 window-all-closed 与 shuttingDown 守卫。
      runBootstrap((e) => log.error('desktop', '重启失败', e))
    }
  })
}
