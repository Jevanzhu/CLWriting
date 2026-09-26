/**
 * Electron 主进程入口（桌面化 #electron；阶段 22 批起 studio server 拆分至 utilityProcess）。
 *
 * fork server-utility 子进程承载 studio server（127.0.0.1 随机端口，ready 握手回传）
 * → BrowserWindow loadURL。前端 Vue 零改造（fetch /api/...）；driver 会话、SSE 由
 * server-utility 统一承载（main 壳层不直接碰 driver）。
 *
 * main 瘦身为真正的纯壳层——窗口/菜单/IPC/workDir 管理
 * 拆出四模块（纯移动零逻辑变化，依赖注入显式参数传递，对齐 workdir-store.ts 零
 * Electron 依赖先例；Electron 绑定层留在需要处）：
 * - windows.ts        窗口工厂（createSecureWindow 安全五件套）+ 三窗引用 holder +
 *                     单例子窗 + window-state 持久化；
 * - workdir-controller.ts  workdir.json 持久化 + 目录选择器/切库守卫 + relaunch 意图；
 * - ipc.ts            IPC 注册面（desktop:* 全部 channel + handleTrusted 守卫单点）；
 * - lifecycle.ts      close/quit/session-end 三条退出链 + 主窗生命周期监听。
 * 本文件保留：app.setPath/initLogging/userData 统一（模块级副作用时序锚点）、单实例锁
 * 与 second-instance、serverManager/bootstrapRunner 装配、bootstrap 启动时序
 * （workDir 定位 → server fork+握手 → 主窗创建 → loadURL）、菜单装配、冒烟驱动、
 * 进程级退出兜底（信号/uncaughtException/unhandledRejection）。
 *
 * 工作目录（书库）管理（起）：
 * - 启动定位：userData 持久化的 current（合法则用）> findWorkDir(cwd) > 弹原生选择器。
 * - 切换书库 = 改持久化 current → app.relaunch 进程重启
 *   （规避 server 路由模块级单例 + SSE 长连接泄漏，见 Dev/Plans/desktop-workdir-方案.md §2.1/§3.1）。
 *
 * 开发：npm run dev:electron（build:web + tsup + electron .；未打包非 HMR 同走拆分形态）
 * 打包：electron-builder（dist/web + dist/desktop/{main,server-utility,preload} 进 asar）
 */
import { app, BrowserWindow, session, screen, dialog, Menu, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { findWorkDir } from '../install/books.js'
import { defaultUserDataPath } from '../fs/user-data-path.js'
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
  // 钩子收敛：原经本文件 re-export 供测试面取用，已删除该 re-export
  //（测试直接动态 import windows.ts 正本）；本文件仍保留对该钩子的**生产路径**使用——
  // CLW_SMOKE 窗口循环冒烟（e2e 专用、env 严格 opt-in）要用白名单登记计数，而登记表
  // 正本在 windows.ts（本批改动面外，无生产命名访问器可取），故留用并如实记因。
  __testHooks,
  getDevProxyApplied, // nano：原 let 导出 devProxyApplied 改函数访问器
} from './windows.js' // 窗口工厂/三窗引用拆出
import {
  BOOTSTRAP_PROBE_TIMEOUT_MS,
  currentWorkDir,
  openLibraryAction,
  overwriteRecentInCache,
  probeDirReachable,
  readStore,
  setBootstrappedWorkDir,
} from './workdir-controller.js' // workdir 控制器拆出
import { filterValidRecentBudgeted } from './workdir-store.js'
import { errMsg, initLogging, log } from '../log/index.js'

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
 *  共用同一判据。
 * dev 环境变量防线——打包应用吃到宿主残留 CLW_DEV_UI=1 不得切
 *  HMR 形态（localhost:5173 + 跳过 server fork）、也不得放行跳过 CSP（Vite 需要的
 * unsafe-eval 豁免只属于真 dev）。bracket 统一风格。
 * （1.0 前质量）：该判据原在 bootstrap 与 whenReady 两处各写一份，
 *  收紧一处漏另一处即「打包态切 HMR」或「dev 态被 CSP 掐死」——收单源函数。 */
function isDevUi(): boolean {
  return !!process.env['CLW_DEV_UI'] && !app.isPackaged
}

// userData 强制统一到定值（大写 CLWriting）。
// Electron 默认目录名跟随 app.name——dev（package.json name=clwriting）与打包
// （electron-builder productName=CLWriting）大小写不一致，macOS/Windows 大小写不敏感
// 侥幸同目录，Linux 上会分裂成两个目录导致配置不互通。见 src/fs/user-data-path.ts。
// 必须在 app.getPath('userData') 首次调用（如下方 initLogging 与拆分后各模块的
// stateFile/storePath 惰性求值）之前执行。
// CLW_SMOKE_USER_DATA（打包态冒烟 env 钩子，先例对齐 CLW_SMOKE_WINDOW_CYCLE 的
// 严格 opt-in 口径）：e2e 打包态冒烟（test/e2e/packaged-app-smoke.spec.ts）注入临时
// 目录隔离真实用户库（~/Library/Application Support/CLWriting）；env 未设时走缺省
// 路径，生产零行为差异。
if (process.env['CLW_SMOKE_USER_DATA']) {
  app.setPath('userData', process.env['CLW_SMOKE_USER_DATA'])
} else {
  app.setPath('userData', defaultUserDataPath())
}
// 结构化日志——打包态 console 无人看见，尽早切到 JSONL 落盘
// （userData/logs/app-YYYYMMDD.jsonl）；dev 态保留 console 镜像。后续 startServer
// 会再 init 一次（幂等，参数一致）。
initLogging({ logsDir: join(app.getPath('userData'), 'logs'), mirrorConsole: !app.isPackaged })

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
  app.on('second-instance', (_e, argv: string[]) => {
    // 第二实例带 --book → 主窗口直达该书（与 desktop:open-book 同通路）
    // 只认本次 argv——回落 env 读到的是首实例的
    // CLWRITING_INITIAL_BOOK，普通二次拉起（无参双开）被误导航到首实例初书
    const workDir = currentWorkDir() // bootstrap 实际值优先
    const ref = initialBookArg(argv, { allowEnvFallback: false })
    if (workDir && ref && wins.mainWindow && !wins.mainWindow.isDestroyed()) {
      // -（全量代码）：resolveInitialBook→readBooks 同步扫书库，
      // 书库在失联网络卷时冻主进程数秒（/-2 同族防线补齐此入口）——预探
      // 先行，'unreachable' log 留痕 + 忽略 book 引用（同族「无物可开」收口口径，
      // 不弹框打断前台应用）；聚焦不受预探影响，保持尾部同步执行。
      void (async () => {
        if ((await probeDirReachable(workDir)) === 'unreachable') {
          log.warn(
            'main',
            `second-instance 带 --book=${ref}，但书库目录暂不可达（可能是网络卷无响应或已断开）——已忽略直达`,
          )
          return
        }
        // 目录预探通过 ≠ 同步扫描安全——resolveInitialBook
        // 内 readBooks 是同步 readFileSync（<workDir>/.clwriting/books.jsonl，常量未导出，
        // 路径与 src/install/books.ts BOOKS_FILE 同串勿漂移），网络卷「可达但慢/预探后
        // 瞬断」窗下同步读照样冻主进程秒级，而同步 IO 无法直接超时。按同族防线
        // 口径对真实读面补一道有界预探：文件 stat 挂死（'unreachable'）即降级忽略直达并
        // 留痕；快速失败（'invalid'，如首启缺 books.jsonl 的 ENOENT）不拦——readBooks 对
        // 缺文件本就降级空表，交由既有「无此登记书」留痕路径收口。预探后瞬断的 TOCTOU
        // 残窗仍在（同族防线既定取舍：冻结面从恒现路径收窄为预探后瞬断窗）。
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
      // （打包）：启动早期（bootstrappedWorkDir 未就绪/无持久化 current）或
      // 主窗不可用时原路径静默吞掉 --book——留痕含被忽略的值，双开排查不再靠猜
      const why = !workDir ? '书库未就绪（bootstrap 未完成且无持久化 current）' : '主窗口不可用'
      log.warn('main', `second-instance 带 --book=${ref}，但${why}——已忽略（聚焦现有窗口）`)
    }
    if (wins.mainWindow && !wins.mainWindow.isDestroyed()) {
      // （#36）：mac 上 app.focus 默认只激活不抢焦点，双开拉起
      // 可能只聚焦不置前——darwin 补 steal:true 自其他 app 强制夺焦并置前主窗
      if (process.platform === 'darwin') app.focus({ steal: true })
      wins.mainWindow.focus()
    }
  })
}

/** studio server 已拆至 utilityProcess 子进程（dev HMR 态不起）；
 *  批起崩溃退避自动重启，3 次自动重启耗尽转原生对话框（重启服务/退出） */
const serverManager = createStudioServerManager({
  // 自愈等待期的退出探测——restartPinned 在 shuttingDown 态改
  // 有界等停机收口（观察窗 5s 与停机链最坏预算失配的复合场景自愈拒绝修复），等待/
  // 收口窗口内用户真退出（before-quit 链置位 appTearingDown）则放弃恢复，不在退出
  // 链上 fork 新 child 成孤儿。拆分后旗正本在 lifecycle.ts，经
  // isAppTearingDown 读数（语义逐位不变）。
  isProcessExiting: () => isAppTearingDown(),
  // （§四.3）：重启成功广播——崩溃自动重启
  // （doRestart）/session-end 自愈（restartPinned）钉住端口拉回成功后，向全部存活
  // 窗口发 desktop:server-restarted；渲染层（Book.vue 订阅）sse.resync 立即断旧
  // 连新 + 重取连接级 sync 快照。此前自愈成功 UI 无感知，SSE 只能等自身退避重连，
  // 「服务已恢复但界面不动」的盲窗随退避时长展开。
  onRestarted: (port) => {
    for (const win of [wins.mainWindow, wins.shelfWindow, wins.libraryWindow]) {
      if (win && !win.isDestroyed()) win.webContents.send('desktop:server-restarted', port)
    }
  },
  onRestartExhausted: async () => {
    // （-②）：同步对话框泵原生嵌套消息循环，崩溃风暴路径上主进程事件循环
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
/** bootstrap-runner「重试前关旧 server」的适配器——close() 即停旧 child
 *  （kill + 等退出由 manager 保证；下一次 start 先等旧 child 退出再 fork）。
 * （打包）：close 返回 stopChild 的 Promise——runner 等其落定再开跑新
 * bootstrap，不再 fire-and-forget；stopChild 自带 cancelPendingRestart，
 *  挂起重启随关旧一并作废 */
const legacyStopHandle = { close: () => serverManager.stopChild() }

/** 真实 Electron 窗口循环冒烟——仅当
 *  CLW_SMOKE_WINDOW_CYCLE=1 时由 bootstrap 末段（[CLW_SMOKE] ready 之后）调用，
 * 保证 app 已 ready 再动窗口。目的：把修复的缺陷类（closed 清理监听在
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
  // recent 失效过滤在此异步预算一次
  // 执行——原 readStore 首读内联同步过滤（existsSync+statSync 逐条），recent 残留失联
  // 网络卷时 bootstrap 首行即同步冻主进程数十秒；-1 probeDirReachable 防线只护
  // current/cwd，recent 条目在防线外。超时项保留展示（失联≠失效，择库守卫预探拦截
  // 兜底取舍口径不变）；并行预算 ≤ MAX_RECENT 条，总延迟 = 单条预算。
  // 本行原注「此处先于任何 IPC
  // 注册（下方 registerIpc 在窗口就绪后）」与实际相反——registerIpc 在 whenReady
  // 同步段先于 runBootstrap 执行（IPC handler 已注册）。早读窗口不存在的真实依据：
  // 窗口要到 bootstrap 定出 workDir 后才创建、渲染层尚未加载，这些 await 期间没有
  // renderer sender 到达，不构成 IPC 并发面（同步冻住的是主进程自身，见上段动机）。
  if (store.recent.length > 0) {
    const filtered = await filterValidRecentBudgeted(store, { timeoutMs: BOOTSTRAP_PROBE_TIMEOUT_MS })
    // 整覆改仅回填 recent 字段——await 窗内
    // 菜单/IPC 链的并发写（saveCurrent→writeStore 换 storeCache 对象）会被旧 store 的
    // 整对象赋值回滚（内存面丢 current，盘面与内存面自此分叉直到重启）；展开当下
    // storeCache 只覆写 recent，并发写不再被内存面回滚。?? store：类型收窄兜底
    //（bootstrap 首行 readStore 已建缓存，此分支 storeCache 恒非空且 !== null）。
    // （拆分注记：storeCache 正本在 workdir-controller，经 overwriteRecentInCache 写。）
    overwriteRecentInCache(store, filtered.recent)
  }
  let workDir: string | null = null
  // 持久化 workDir 由仅 existsSync 改目录校验——指向普通文件时
  // 原样采信会静默空书架无引导；失效回落 findWorkDir(cwd)，仍无 → /welcome 引导
  // （§四.1）：current 先经可达性预探——指向失联网络卷
  // （挂载点在服务器无响应态）时，下方 statSync 单点即可同步冻主进程数十秒
  // （切库同族的启动侧入口）。'unreachable' 原生错误框留痕 + 回落发现链
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
  // 服务端：记录 bootstrap 实际采用的 workDir——before-quit 原先回读
  // readStore.current，store.current 为 null/失效而 workDir 由 findWorkDir 发现时，
  // 退出拿到 null：不 abort 任何在途 chat/self-heal、不等后台任务（孤儿会话只能靠
  // 10 分钟宽限修复）。退出以启动时实际值优先，store 回读兜底
  // welcome 态 workDir 可为 null，currentWorkDir 的 ?? 兜底因此
  // 走 readStore——缓存（见 readStore 注）就位后该兜底零盘 IO，null/'' 语义维持原状
  // （拆分注记：bootstrappedWorkDir 正本在 workdir-controller，经 setter 记账）
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
        userDataPath: app.getPath('userData'),
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
  wins.mainWindow = mainWindow
  if (saved?.maximized) mainWindow.maximize()
  // 关窗兜底——首轮 close 先 preventDefault，经渲染层钩子异步
  // flush（页面未死，异步保存链全通）落定/短超时后 destroy 真正关窗（destroy 不再
  // 触发 beforeunload，链路单次不循环）。退出链（before-quit）已先行 flush 并在收口
  // destroy 全窗，session-end 时间窗有限，两者都直接放行。
  // （评审四十九轮）：在途旗（closeFlushInFlight/quitFlushInFlight）与 quit 汇入
  // 旗（quitDuringCloseFlush）为 lifecycle 模块级（正本随 close/session-end/quit 三链
  // 拆出）——close/session-end/focus/closed/全屏反向同步监听统一经
  // attachMainWindowLifecycle 挂载（拆分，处理器语义逐位不变）。
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

  // （win 平台专项）：进程级退出兜底——dev 控制台 Ctrl+C（SIGINT）/
  // Ctrl+Break（SIGBREAK）此前直接硬杀，跳过 before-quit 优雅停机链；改为走
  // app.quit 复用既有幂等链（quitViaShutdown 门防重入，重复信号安全）。
  // 补 SIGTERM——`kill <pid>`/进程管理器/IDE 停止按钮的默认
  // 信号（mac/linux）同属「硬杀跳过优雅停机链」的动机面，与 SIGINT 同款一行。
  // （备注级事实收口）：SIGTERM 在 win 上无投递机制（外部
  // TerminateProcess 不进 JS handler），本行实际仅 POSIX 生效；win 的硬杀面已由
  // SIGBREAK（Ctrl+Break）与 uncaughtException backstop 兜底。保留本行为三平台
  // 对齐与跨平台宿主（如 win 下经 POSIX 兼容层运行）预留，非缺陷。
  // 三行注册改经 createRepeatedSignalExit——同型信号第二次
  // 到达直接 killNow + exit(1) 硬退（逻辑正本与动机见 signal-hard-exit.ts 头注）；
  // 首次语义不变（app.quit 单次优雅链，unref 语义不受影响）。
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

  // 优雅退出链装配（处理器正本在 lifecycle.ts——拆分，行为零变化；
  // 沿革注释随处理器迁走，此处保留装配时序：注册位次与拆分前 app.on('before-quit')
  // 一致，介于 unhandledRejection 与 activate 之间）。
  registerQuitChain(bootstrapRunner, serverManager)

  app.on('activate', () => {
    // 低-8：退出途中不再重 bootstrap——before-quit 的 3.5s 优雅退出窗口内
    // （shuttingDown 已置位）macOS dock 点击仍会触发 activate，若只判
    // mainWindow === null 会在退出半途再起 server/开窗（与退出竞态同族）
    if (bootstrapRunner.shuttingDown) return
    if (wins.mainWindow === null) {
      runBootstrap((e) => log.error('desktop', '重启失败', e))
    }
  })
}
