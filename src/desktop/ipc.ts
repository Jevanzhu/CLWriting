/**
 * IPC 注册面（复审-0914-优化修复批 F1 自 main.ts 拆出——纯移动零逻辑变化）。
 *
 */
import {
  BrowserWindow,
  Menu,
  ipcMain,
  nativeTheme,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, realpathSync } from 'node:fs'
import { errMsg, log } from '../log/index.js'
import { getFonts as getSystemFontList } from 'font-list'
import { resolveWithinRoot } from '../fs/safe-path.js'
import { parseContextMenuSpecs, type ContextMenuSpec } from './context-menu.js' // RB-SV-P2-5：IPC 载荷净化
import { createSystemFontCache, fontListWithTimeout, darwinFontListCommand, linuxFontListCommand } from './font-cache.js' // R77-1（二十五轮批 A）：系统字体 IPC 缓存；R40-28：font-list 超时包裹；R0911-A-P2-1：darwin 自管 spawn 二进制解析；C201：linux fc-list 自管 spawn
import { listWindowsFonts } from './win-fonts.js' // MP2-1（专项重评二轮）：win 自绘枚举（windowsHide，不经 cmd）
import { isTrustedSender, openLibraryWindow, openShelfWindow, wins } from './windows.js'
import {
  canSwitchLibraryDir,
  currentWorkDir,
  findBookEntry,
  pickLibrary,
  probeDirReachable,
  readStore,
  relaunch,
  resolveReachableWorkDir,
  saveCurrentArmingRollback,
  warnIfCaseSensitive,
} from './workdir-controller.js'

const here = dirname(fileURLToPath(import.meta.url)) // dist/desktop/

// O-11（第十三轮）：IPC 响应回程窗口——handle 返回值需先送达渲染进程再 relaunch
//（quit 链会销毁 webContents，响应晚到前端拿到 undefined）；100ms 为覆盖慢机往返的
// 经验值（原两处裸魔数收编单源），改小前先在慢机实测。
const RELAUNCH_DELAY_MS = 100

/** 0918四轮修复批（C405）：relaunch 延迟 timer 句柄单槽登记——原 open-library /
 *  switch-library 两处裸排 `setTimeout(relaunch, …)` 不留句柄：不可清、不可 unref，
 *  违本文件 timer 纪律（R46-19 闭包持引用滞留 / R54-A-5 卫生；对齐
 *  contextMenuCancelTimers 声明处 R1010b-DSK-P3-6 的句柄登记口径）。单槽收口：
 *  响应回程窗（RELAUNCH_DELAY_MS）内重复触发 = 前次响应已废，排新清旧不叠加；
 *  触发后自清；unref 不拖退出。 */
let relaunchDelayTimer: ReturnType<typeof setTimeout> | null = null
function armRelaunchDelayTimer(): void {
  if (relaunchDelayTimer) clearTimeout(relaunchDelayTimer)
  const timer = setTimeout(() => {
    relaunchDelayTimer = null
    relaunch()
  }, RELAUNCH_DELAY_MS)
  timer.unref?.()
  relaunchDelayTimer = timer
}

/** R50-A-2（五十轮）：context-menu 取消补发延迟——macOS NSMenu 先关菜单再派发
 *  action，click 可能晚于 popup 关闭回调不止一个宏任务拍（原 setTimeout(0) 的单拍
 *  竞窗里 null 取消常先到，渲染层 once 只认第一条 → 菜单动作被吞）。放宽到 100ms
 *  让 click 稳定抢先；取消回执晚 100ms 对渲染侧无感（只是收尾态）。 */
const CONTEXT_MENU_CANCEL_DELAY_MS = 100
/** R1010b-DSK-P3-6（2026-09-10 内存专项重审修复批）：取消补发 timer 句柄登记——
 *  原 popup callback 内裸排 setTimeout 不留句柄：不可清、不可 unref，违本文件 timer
 *  纪律（R46-19 闭包持引用滞留 / R54-A-5 卫生），菜单连续开关时旧补发叠跑。排新清旧 +
 *  unref（不拖退出），消费点见 desktop:context-menu 的 popup callback。
 *  R0912（重评-0911c P3）：单槽改 per-sender 分槽——单槽下 A 窗排定的取消补发会被
 *  B 窗菜单关闭回调 clearTimeout 清掉（100ms 内双窗先后关菜单），A 的渲染层 once
 *  收不到 null 挂等到下次开菜单；按 webContents 分槽互不干扰。sendOnce 自带
 *  isDestroyed 守卫（N-4），窗销毁后的迟到触发无害；条目仅在重排/触发时清理，
 *  残留上界 = 窗口数（个位数）。
 *  P3（复审-0914-优化修复批）：类型引用统一为已 import 的 WebContents（原
 *  Electron.WebContents 全限定形态）。 */
const contextMenuCancelTimers = new Map<WebContents, ReturnType<typeof setTimeout>>()
/**
 * 0918二轮修复批（C106）：取消补发条目的销毁摘除——原条目仅在重排/触发时清理，窗口
 * 正常销毁（closed）不摘除：Map 强引用 WebContents 滞留至进程尾（上界 = 窗口数，个
 * 位数）。取「destroyed 监听摘除」方案（WeakMap 化对 timer 可清理性无增益——值仍需
 * 可 clearTimeout，键 WeakRef 化复杂度高）；登记面 WeakSet 不持强引用且防重复挂监听
 * （每次 popup 都挂会叠监听）。
 */
const contextMenuCancelWired = new WeakSet<WebContents>()

/**
 * 0918二轮修复批（C106）：取消补发 timer 的武装单点——排新清旧 + unref 原语义
 * （R1010b-DSK-P3-6/R0912，见 contextMenuCancelTimers 声明处）+ 首次写入时给该
 * webContents 挂 'destroyed' 摘除（清 timer + 删条目，强引用随销毁释放）。
 */
function armContextMenuCancelTimer(wc: WebContents, fire: () => void): void {
  const prev = contextMenuCancelTimers.get(wc)
  if (prev) clearTimeout(prev)
  const timer = setTimeout(() => {
    contextMenuCancelTimers.delete(wc)
    fire()
  }, CONTEXT_MENU_CANCEL_DELAY_MS)
  timer.unref?.()
  contextMenuCancelTimers.set(wc, timer)
  if (!contextMenuCancelWired.has(wc)) {
    contextMenuCancelWired.add(wc)
    wc.on('destroyed', () => {
      const t = contextMenuCancelTimers.get(wc)
      if (t) clearTimeout(t)
      contextMenuCancelTimers.delete(wc)
    })
  }
}

/** 0918二轮修复批（C106）：测试钩子（生产零调用，先例同 windows.ts __testHooks）——
 *  供回归用例断言窗口销毁后取消补发条目已摘除。 */
export const __testHooks = {
  cancelTimerCount: (): number => contextMenuCancelTimers.size,
  hasCancelTimer: (wc: WebContents): boolean => contextMenuCancelTimers.has(wc),
}

/**
 * F2（复审-0914-优化修复批）：可信 sender 守卫接线单点——原 14 个 handler 各自首行
 * `if (!isTrustedSender(e)) return`，收敛为 handleTrusted/onTrusted 包装。拒绝语义
 * 逐位不变：untrusted 即静默返回 undefined（不弹提示不回退上下文，R4-P2-1 口径），
 * handler 不执行。
 */
function handleTrusted(channel: string, handler: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (e, ...args: unknown[]) => (isTrustedSender(e) ? handler(e, ...args) : undefined))
}
function onTrusted(channel: string, listener: (e: IpcMainEvent, ...args: unknown[]) => void): void {
  ipcMain.on(channel, (e, ...args: unknown[]) => {
    if (isTrustedSender(e)) listener(e, ...args)
  })
}

export function registerIpc(): void {
  // 弹选择器打开书库
  handleTrusted('desktop:open-library', async () => {
    const picked = await pickLibrary()
    if (!picked) return { ok: false as const, canceled: true as const }
    // R51-A-4（五十一轮）：落库失败转契约化失败，不再裸抛绕过 {ok,reason} 信封
    // R59 清偿批（R55-A-3）：改切库链专用包装——快照武装回滚基线（取消退出可回写）
    const saveErr = saveCurrentArmingRollback(picked)
    if (saveErr) return { ok: false as const, reason: saveErr }
    // 0918四轮修复批（C405）：延迟重启改单槽句柄排程（C405 锚注见 armRelaunchDelayTimer）
    armRelaunchDelayTimer()
    return { ok: true as const }
  })
  // 切换到最近列表中的书库
  handleTrusted('desktop:switch-library', async (_e, path: unknown) => {
    // R54-A-2（五十四轮）：可达性预探先行——失联网络卷残留条目不再冻结主进程（见
    // probeDirReachable 注）；超时态契约化拒切，确定性失败交回同步守卫走原契约文案
    if (typeof path !== 'string') {
      return { ok: false as const, reason: '目录无效或是另一书库的子目录' }
    }
    // 0918二轮修复批（C102）：相对路径拒收——handler 原只验 typeof string，'./foo' 类
    // 相对路径在恰存在于主进程 cwd 时可过 probeDirReachable/canSwitchLibraryDir 守卫
    //（statSync/findWorkDir 均按 cwd 解析）并原样落库 workdir.json，下次经不同 cwd
    // 启动书库定位漂移。入口加 isAbsolute 校验，BAD_INPUT 人话错误（先于预探——
    // 相对路径的可达性判定本身就在错误的 cwd 基准上）。
    if (!isAbsolute(path)) {
      return { ok: false as const, reason: '书库路径必须是绝对路径' }
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
    // 0918四轮修复批（C405）：延迟重启改单槽句柄排程（原裸 setTimeout 违 timer 纪律）
    armRelaunchDelayTimer()
    return { ok: true as const }
  })
  // R48-73（四十八轮）：recent 缓存首读过滤后运行期不复验（取舍备案见 workdir-controller
  // readStore 头注——失效目录残留展示至重启，切换守卫 canSwitchLibraryDir 拦截兜底）
  handleTrusted('desktop:get-recent', () => {
    return readStore().recent
  })
  // Y-11（第五十七轮）：M-3 第五入口漏网——改走 currentWorkDir()（bootstrap 实际值
  // 优先），否则 store.current 为 null/失效而 bootstrap 跑在 findWorkDir 发现的书库上时，
  // 书库管理窗口拿到与实际运行不一致的展示口径
  handleTrusted('desktop:get-current', () => {
    return currentWorkDir()
  })
  // 在系统文件管理器中显示文档（electron only；浏览器版前端隐藏此项）
  // 重审-2（2026-09-07 全量代码重审 §四.2）：三入口（show-in-folder/open-book-dir/
  // open-library-dir）readBooks/realpathSync 同步扫书库——书库在失联网络卷时一点
  // 即冻主进程（R54-A-2/R61-B-1 切库链同款防线补齐）：handler 改 async，先经
  // probeDirReachable 预探，'unreachable' 原生错误框 + return（'invalid' 落回原
  // 静默守卫语义——readBooks/realpath 失败本就按「无物可开」收口）。
  // F2（复审-0914-优化修复批）：判空+预探+错误框三写收敛 resolveReachableWorkDir、
  // readBooks().find 两写收敛 findBookEntry（workdir-controller，语义逐位不变）。
  handleTrusted('desktop:show-in-folder', async (_e, bookName: unknown, relPath: unknown) => {
    if (typeof bookName !== 'string' || typeof relPath !== 'string') return
    if (relPath.includes('\0')) return
    const workDir = await resolveReachableWorkDir()
    if (!workDir) return
    const entry = findBookEntry(workDir, bookName)
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
  handleTrusted('desktop:open-book-dir', async (_e, bookName: unknown) => {
    if (typeof bookName !== 'string' || bookName.includes('\0')) return
    const workDir = await resolveReachableWorkDir()
    if (!workDir) return
    const entry = findBookEntry(workDir, bookName)
    if (!entry) return
    // 路径校验：entry.path 来自 books.jsonl，防 `..`/symlink 越出 workDir 打开任意目录
    // （批 6 统一：resolveWithinRoot = 防穿越 + symlink 双侧 realpath，X-P3a 同口径）
    const safe = resolveWithinRoot(workDir, entry.path)
    if (!safe || !existsSync(safe.abs)) return // realpath 失败/不存在 = 无物可开
    // R0913-win P3-11（win线并树随行）：openPath 的结果字符串（失败时非空）此前被丢弃——打开失败零反馈
    void shell.openPath(safe.abs).then((err) => {
      if (err) log.warn('desktop', `打开书目录失败（${safe.abs}）：${err}`)
    })
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
  // R0911-A-P2-1/A-P3-4（2026-09-11 全量重评 GLM-5.3 修复批）：R48-17 备案的两项随本批
  // 收口——①二进制随包分发：fontlist 原生二进制构建期由 tsup onSuccess 拷入
  // dist/desktop/（darwin 腿）+ electron-builder asarUnpack 外置，font-list 上游
  // path.join(__dirname,'fontlist') 的 execFile 自此真有文件可执行（此前打包态恒
  // ENOENT 回落 system_profiler 慢路径，慢机触 10s 超时连败熔断、下拉返空）；
  // ②PM-12 kill 接线（台账待拍板项随作者「全部修复」指令落地，原「打包态路径不可解」
  // 拍板理由随①失效）：mac 注入 deps.command 走自管 spawn——超时必杀（孤儿进程残留
  // 收口），启动面失败（二进制缺失/不可执行）自动回落 load（font-list 自带
  // system_profiler 回落链保持可达，与纯 font-list 行为一致）；win 不变（win-fonts
  // 自带超时 kill）。C201（0918三轮修复批）：linux 由「维持 load」改注入
  // linuxFontListCommand()——fc-list 挂死时 load 路径（font-list 不暴露子进程句柄）
  // 只能放弃等待、子进程成孤儿；自管 spawn 超时 TERM→2s→KILL 升级链收口，命令与
  // 行口径解析逐字对齐 font-list libs/linux 上游，fc-list 缺失（ENOENT）自动回落
  // load（上游 whereis fc-list/fc-list2 兜底探测链保持可达）。打包态实测复验仍留
  // 台账（build:desktop:dir + 手装 DMG 验字体下拉）。
  const loadFontList = () =>
    process.platform === 'win32'
      ? listWindowsFonts()
      : fontListWithTimeout(
          () => getSystemFontList({ disableQuoting: true }),
          process.platform === 'darwin'
            ? darwinFontListCommand(here)
            : process.platform === 'linux'
              ? linuxFontListCommand()
              : undefined,
        )
  const loadSystemFonts = createSystemFontCache(loadFontList)
  handleTrusted('desktop:get-system-fonts', async () => {
    try {
      return await loadSystemFonts()
    } catch (err) {
      log.error('desktop', `get-system-fonts 失败：${errMsg(err)}`)
      return []
    }
  })
  // 打开独立书架窗口（ribbon 书架按钮调用）
  handleTrusted('desktop:open-shelf', () => {
    // R30-24（三十轮）：openShelfWindow 是 async（内部 await devProxyApplied）——此前
    // fire-and-forget 裸调，窗工厂早期抛错成主进程 unhandledRejection 丢诊断。对齐
    // R74-16 的 loadURL 口径：promise 接日志留痕（handler 同步返回，invoke 端不悬等待、
    // 错误不外抛到渲染层，窗口崩溃另有 R67-16 自愈兜底）
    openShelfWindow().catch((e) => {
      log.error('desktop', '书架窗口打开失败', e)
    })
  })
  // 书架窗口选书 → 主窗口加载该书并聚焦，关闭书架窗口
  handleTrusted('desktop:open-book', (_e, name: unknown) => {
    if (typeof name !== 'string') return
    // 复审-0913-源码 P3：与 show-in-folder 同款 \0 防御对称（IPC 入参边界收口）
    if (name.includes('\0')) return
    if (wins.mainWindow && !wins.mainWindow.isDestroyed()) {
      wins.mainWindow.webContents.send('desktop:navigate', `/book/${encodeURIComponent(name)}`)
      wins.mainWindow.focus()
    }
    if (wins.shelfWindow && !wins.shelfWindow.isDestroyed()) {
      wins.shelfWindow.close()
    }
  })
  // 打开独立书库管理窗口（ribbon 书库按钮调用）
  handleTrusted('desktop:open-library-window', () => {
    // R30-24（三十轮）：同 open-shelf——async 工厂 promise 接日志，防 unhandledRejection
    openLibraryWindow().catch((e) => {
      log.error('desktop', '书库管理窗口打开失败', e)
    })
  })
  // 在系统文件管理器中打开当前书库根目录
  // 重审-2：同 show-in-folder——realpathSync 同步解析前的失联卷预探
  handleTrusted('desktop:open-library-dir', async () => {
    const workDir = await resolveReachableWorkDir()
    if (!workDir) return
    // ii 批：与 open-book-dir 同口径——realpath 解析后再开（store.current 持久化值若被
    // 改成指向外部的 symlink/失效路径，不再原样透传给 shell.openPath）
    try {
      // R0913-win P3-11（win线并树随行）：同 open-book-dir——失败结果字符串留痕（openPath 不 reject，
      // try/catch 管不到 promise 结果）
      void shell.openPath(realpathSync(workDir)).then((err) => {
        if (err) log.warn('desktop', `打开书库目录失败（${workDir}）：${err}`)
      })
    } catch {
      // realpath 失败 = 目录不存在，无物可开
    }
  })
  // ── 原生右键菜单 ──
  onTrusted('desktop:context-menu', (event, specs: unknown) => {
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
        // R1010b-DSK-P3-6：排新清旧 + unref（句柄纪律见 contextMenuCancelTimers 声明处）
        // R0912：per-sender 分槽（单槽跨窗互清缺陷见声明处）——本窗重排只清本窗旧句柄
        // 0918二轮修复批（C106）：排程体收编 armContextMenuCancelTimer——写入点单点
        // 接线 webContents destroyed 摘除（强引用滞留收口，见其声明处）
        armContextMenuCancelTimer(event.sender, () => sendOnce(null))
      },
    })
  })
  // ── 专注模式全屏 ──
  // 渲染层进入/退出专注时驱动原生全屏。不走 HTML5 Fullscreen API：菜单加速键路径
  // 在渲染层无用户手势会被拒，setFullScreen 无此限制。作用于发起调用的窗口本体。
  handleTrusted('desktop:set-fullscreen', (event, flag: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    win.setFullScreen(flag === true)
  })
  // ── win 窗控 overlay 颜色随主题（J5，2026-08-29）──
  // 无框标题栏的系统窗控底色须与顶栏一致（light #f6f6f6 / dark #262626）；主题切换时
  // 渲染层经此 IPC 改发起窗口的 overlay。非 win（含 mac）no-op；参数非字符串忽略。
  handleTrusted(
    'desktop:set-titlebar-overlay',
    (event, ...args: unknown[]) => {
      const o = args[0] as { color?: unknown; symbolColor?: unknown; dark?: unknown } | undefined
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
      return // D204（0918三轮修复批）：显式收尾——本 handler 混合返回 {ok:false} 与 void，noImplicitReturns 要求全路径显式
    },
  )
}
