/**
 * 跨平台统一 APP 数据目录（userData）解析——dev:app / 打包 / dev:api 三入口共享同一路径。
 *
 * 固定大写 `CLWriting`（对齐 electron-builder.yml productName），避免 Electron 默认
 * 目录名跟随 app.name 造成 dev（package.json name=clwriting）与打包（productName=CLWriting）
 * 大小写分裂——macOS/Windows 大小写不敏感侥幸同一目录，Linux（大小写敏感）上会各建各的，
 * dev 配好的 provider 打包后全丢。
 *
 * 进程职责：
 *  - Electron 主进程（src/desktop/main.ts）：`app.setPath('userData', ...)` 强制统一，
 *    内部逻辑（window-state/workdir/providers）全部走此路径。
 *  - 无 Electron 的脚本（scripts/dev-api.ts）：直接调用本函数。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 统一目录名（大写，与 electron-builder.yml productName 一致）。 */
export const APP_DIR_NAME = 'CLWriting'

/** macOS/Windows/Linux 三平台 APP 数据目录（对齐 Electron 默认 userData 规则）。 */
export function defaultUserDataPath(): string {
  const p = process.platform
  if (p === 'darwin') return join(homedir(), 'Library', 'Application Support', APP_DIR_NAME)
  // R38-22（三十八轮）：win 优先取 %APPDATA%（Electron/系统语义同源；企业域文件夹
  // 重定向场景不再脱节），env 未设（极端裁剪环境）回退原硬拼保持确定性。
  if (p === 'win32') {
    const appdata = process.env['APPDATA']
    return appdata ? join(appdata, APP_DIR_NAME) : join(homedir(), 'AppData', 'Roaming', APP_DIR_NAME)
  }
  // Linux：XDG_CONFIG_HOME 优先（Electron 同规则），缺省 ~/.config
  const xdg = process.env['XDG_CONFIG_HOME']
  return xdg ? join(xdg, APP_DIR_NAME) : join(homedir(), '.config', APP_DIR_NAME)
}

/**
 * R1W-7（win 平台专项复审 R1）：路径同一性判定——win 路径大小写不敏感（盘符/目录
 * 大小写经启动器/手工输入可漂移），win32 双侧 toLowerCase 后比较；posix 全等。
 * document/manifest.ts:250 与 knowledge/manifest.ts:20 既有降口径的同族原语，
 * 供 --book 直达路径匹配 / isLibraryDir 等跨来源路径比较点收编。
 */
export function samePath(a: string, b: string): boolean {
  if (process.platform !== 'win32') return a === b
  return a.toLowerCase() === b.toLowerCase()
}