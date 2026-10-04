/**
 * 在新窗口中打开书库（多库多窗）——spawn 一个带 `--dir` 的新应用实例。
 *
 * 形态：一库一实例（多进程）。子实例启动链（见 main.ts / startup-instance.ts）按
 * `--dir` 解析库 → 派生 instanceKey → userData 落到 `<home>/instances/<key>`——
 * 与父实例不同目录即不同 Electron 锁域，两实例并行；目标库已被打开时子实例拿不到锁，
 * 由 Electron 把那个实例的窗口拉到前台后自身退出（聚焦语义，零额外代码）。
 *
 * 打包/dev 双形态（先例 scripts/electron-smoke.mjs:104-106）：
 *  - 打包：`<execPath> --dir <p>`（可执行文件即应用本体）；
 *  - dev：`<execPath> <appPath> --dir <p>`（electron 二进制 + 应用目录参数）。
 * 子进程 detached（两平台同款：Windows 上非 detached 的子进程会自动加入运行时为父进程
 * 自建的 KILL_ON_JOB_CLOSE Job，父实例退出即被 OS 静默硬杀，见下注）+ stdio ignore +
 * unref——父实例退出不牵连子实例。
 *
 * 失败面：spawn 的启动失败（ENOENT/EACCES/EMFILE 等）是**异步
 * 'error' 事件**——不监听会被 EventEmitter 抛出 → main 的 uncaughtException 链退出
 * 整个应用。故以 'spawn'（子进程已拉起）/ 'error' 二择一落定 Promise：false =
 * 未发起（调用方走错误框 / {ok:false,reason} 契约面），失败不再反噬主进程。
 * 注：返回后不追踪子进程后续——「目标库已开、子实例拿不到锁自行退出」是正常路径，
 * 父实例零感知（聚焦由 Electron 完成）。
 *
 * dev HMR 形态例外：CLW_DEV_UI=1 时本实例不起 studio server（渲染层连独立 dev:api
 * 的固定单库，见 main.ts isDevUi），spawn 出的子实例同形态——多库多窗在 dev HMR
 * 形态不成立，属开发面既定边界（产品面只认打包/常规 dev 形态）。
 */
import { spawn } from 'node:child_process'
import { app } from 'electron'
import { errMsg, log } from '../log/index.js'

/** spawn 新实例打开 dir；true = 子进程已成功拉起，false = 未发起（已 log 留痕）。
 *  注：本函数只保证「进程已拉起」——目录有效性守卫由调用方（菜单/导航链）先行，
 *  子实例自身还会走 bootstrap 的可达性判定（不可达则落 welcome 引导）。 */
export function spawnLibraryInstance(dir: string): Promise<boolean> {
  const args = app.isPackaged ? ['--dir', dir] : [app.getAppPath(), '--dir', dir]
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(process.execPath, args, {
        // 两平台一律 detached：Windows 上非 detached 的子进程会自动加入运行时（libuv）
        // 为父进程自建的 KILL_ON_JOB_CLOSE Job（句柄由父进程持有），父实例退出
        // （正常关窗/崩溃同款）时子实例被 OS 静默硬杀、无任何退出链——「父退子存」
        // 只有 DETACHED_PROCESS + 脱离该 Job 才成立。
        detached: true,
        // 不设 windowsHide：目标是 GUI 子系统程序（electron.exe / CLWriting.exe），
        // 本无控制台窗可隐；而 windowsHide 会置 STARTUPINFO 的 SW_HIDE，Chromium 取
        // 它作首个顶层窗口的初始显示状态——新实例主窗出生即隐藏（实测主窗存在但
        // IsWindowVisible=false）。不继承父控制台已由 DETACHED_PROCESS 保证，无需再隐。
        stdio: 'ignore',
      })
    } catch (e) {
      log.error('desktop', `在新窗口中打开书库失败：${dir} —— ${errMsg(e)}`, e)
      resolve(false)
      return
    }
    // 'spawn' / 'error' 二择一先到先落（settled 防理论双发）——'error' 有监听即被消费，
    // 不再升级为 uncaughtException
    let settled = false
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref() // 父实例退出不牵连子实例
      log.info('desktop', `已在新窗口中打开书库：${dir}`)
      resolve(true)
    })
    child.once('error', (e) => {
      if (settled) return
      settled = true
      log.error('desktop', `在新窗口中打开书库失败：${dir} —— ${errMsg(e)}`, e)
      resolve(false)
    })
  })
}
