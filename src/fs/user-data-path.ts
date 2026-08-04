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
  if (p === 'win32') return join(homedir(), 'AppData', 'Roaming', APP_DIR_NAME)
  // Linux：XDG_CONFIG_HOME 优先（Electron 同规则），缺省 ~/.config
  const xdg = process.env['XDG_CONFIG_HOME']
  return xdg ? join(xdg, APP_DIR_NAME) : join(homedir(), '.config', APP_DIR_NAME)
}