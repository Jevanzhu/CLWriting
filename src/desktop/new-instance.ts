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
 * 子进程 detached（POSIX 独立进程组）+ stdio ignore + unref——父实例退出不牵连子实例。
 */
import { spawn } from 'node:child_process'
import { app } from 'electron'
import { errMsg, log } from '../log/index.js'

/** spawn 新实例打开 dir；返回是否成功发起（失败已 log 留痕）。
 *  注：本函数只保证「进程已发起」——目录有效性守卫由调用方（菜单/导航链）先行，
 *  子实例自身还会走 bootstrap 的可达性判定（不可达则落 welcome 引导）。 */
export function spawnLibraryInstance(dir: string): boolean {
  const args = app.isPackaged ? ['--dir', dir] : [app.getAppPath(), '--dir', dir]
  try {
    const child = spawn(process.execPath, args, {
      // POSIX 独立进程组（父退出不牵连）；Windows 不 detached（免弹新控制台，
      // 且子进程本就不随父退出，见 electron-smoke 同款注释）
      detached: process.platform !== 'win32',
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    log.info('desktop', `已在新窗口中打开书库：${dir}`)
    return true
  } catch (e) {
    log.error('desktop', `在新窗口中打开书库失败：${dir} —— ${errMsg(e)}`, e)
    return false
  }
}
