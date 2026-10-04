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
 *
 * 多库多窗（同机多库并排）目录分工：
 *  - **共享根** `appDataHomeDir()` = 上述目录，应用级数据（providers/vault、global.json、
 *    prompts/、事件库、workdir.json、studio-token.json）随根走，跨库共享；
 *  - **实例目录** `instanceUserDataPath(key)` = `<home>/instances/<key>`，Electron 的
 *    userData 指向此处——Chromium 写面、logs/、window-state.json、app-instance.lock
 *    随实例走（同库单实例、异库多实例由 Electron 原生锁自动成立）。
 */
import { homedir } from 'node:os'
import { statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { platformCaseFold } from './safe-path.js'

/** 统一目录名（大写，与 electron-builder.yml productName 一致）。 */
export const APP_DIR_NAME = 'CLWriting'

/** macOS/Windows/Linux 三平台 APP 数据目录（对齐 Electron 默认 userData 规则）。 */
export function defaultUserDataPath(): string {
  const p = process.platform
  if (p === 'darwin') return join(homedir(), 'Library', 'Application Support', APP_DIR_NAME)
  // win 优先取 %APPDATA%（Electron/系统语义同源；企业域文件夹
  // 重定向场景不再脱节），env 未设（极端裁剪环境）回退原硬拼保持确定性。
  if (p === 'win32') {
    const appdata = process.env['APPDATA']
    return appdata ? join(appdata, APP_DIR_NAME) : join(homedir(), 'AppData', 'Roaming', APP_DIR_NAME)
  }
  // Linux：XDG_CONFIG_HOME 优先（Electron 同规则），缺省 ~/.config
  const xdg = process.env['XDG_CONFIG_HOME']
  return xdg ? join(xdg, APP_DIR_NAME) : join(homedir(), '.config', APP_DIR_NAME)
}

/** 应用级数据根（跨库共享）。CLW_SMOKE_USER_DATA（e2e 隔离钩子）覆盖本根，
 *  实例目录嵌套其下——覆盖语义与拆分前一致（冒烟注入临时目录隔离真实用户数据）。 */
export function appDataHomeDir(): string {
  return process.env['CLW_SMOKE_USER_DATA'] || defaultUserDataPath()
}

/** 实例目录（Electron userData）：`<home>/instances/<instanceKey>`。
 *  每库一实例一目录——Chromium 写面/日志/窗口几何/实例守卫随 key 隔离，
 *  「同库单实例、异库多实例」由 Electron 原生锁（作用域 = userData 目录）自动成立。 */
export function instanceUserDataPath(instanceKey: string): string {
  return join(appDataHomeDir(), 'instances', instanceKey)
}

/** 无书库（欢迎态）实例的固定 key——与库 key（hex hash）不同形，天然不撞。 */
export const WELCOME_INSTANCE_KEY = 'welcome'

/** 库路径 → 实例 key：平台折叠后的路径 hash。
 *  折叠（platformCaseFold：win/darwin 小写、linux 全等）覆盖盘符/大小写漂移——
 *  同一物理库的两种拼写在 win/mac 上归同 key（linux 大小写敏感，异名合法共存不折叠）。
 *  darwin 叠 NFC 归一（与 samePath 的 darwin 臂同口径）——mac APFS 惯存 NFD，外部
 *  输入的分解形路径与 NFC 形态登记指向同一物理目录；缺此归一会让同库派生两个 key，
 *  「同库单实例」防线被拼写绕过，且 main.ts 的「key 与实际库不一致」诊断（用 samePath
 *  判定）反而判「一致」不告警。win32 维持纯小写（NTFS 对 NFC/NFD 敏感、是不同文件，
 *  不得折叠——samePath 同款注）；linux 全等不变。
 *  取 16 位 hex（64bit）——碰撞面仅「同机上两个不同库撞 key」，概率可忽略；
 *  key 会进目录名，hex 免非法字符/大小写歧义。
 *  约束（勿改）：必须在 `app.setPath('userData')` 之前**同步**算出——不得用 bookHash
 *  （`events/store-migrate.ts` 的 trueCasePath 逐段 readdirSync，失联网络卷会同步冻结
 *  主进程启动链；本函数零磁盘 IO）。 */
export function libraryInstanceKey(dir: string): string {
  const folded = platformCaseFold(process.platform === 'darwin' ? dir.normalize('NFC') : dir)
  return createHash('sha256').update(folded).digest('hex').slice(0, 16)
}

/**
 * （win 平台专项）：路径同一性判定——win 路径大小写不敏感（盘符/目录
 * 大小写经启动器/手工输入可漂移），win32 双侧 toLowerCase 后比较；posix 全等。
 * document/manifest.ts:250 与 knowledge/manifest.ts:20 既有降口径的同族原语，
 * 供 --book 直达路径匹配 / isLibraryDir 等跨来源路径比较点收编。
 * 折叠面扩至 darwin（与 safe-path.platformCaseFold 单源同批
 * 同口径）——mac 默认卷 APFS 不敏感，字符串口径在 darwin 折叠后与物理语义一致；
 * linux 维持全等（敏感 FS 合法异名共存）。
 * mac适配：darwin 臂叠 NFC 归一——mac APFS 惯存 NFD，外部输入的
 * 分解形路径与 NFC 形态登记指向同一物理目录；win32 维持纯 toLowerCase（NTFS 对
 * NFC/NFD 敏感、是不同文件，不得折叠）；linux 全等不变。
 */
export function samePath(a: string, b: string): boolean {
  const p = process.platform
  if (p === 'linux') return a === b
  if (p === 'win32') return a.toLowerCase() === b.toLowerCase()
  return a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase() // darwin
}

/**
 * 路径物理同一性判定（dev+ino）——samePath 的物理身份升级版。
 * 大小写不敏感卷（win NTFS / mac APFS 默认）上仅大小写不同的两条路径指向同一物理
 * 目录，但 samePath 的字符串口径在 posix 全等不折叠（mac 默认卷恰是「字符串异形、
 * 物理同库」形态，win32 折叠只是凑巧覆盖）。对齐书级改名（api/books.ts）与
 * 文档移动（document/service.ts）的 dev+inode 口径：两侧 statSync 成功且
 * dev+ino 相等 → 同一物理位置；大小写敏感卷上的异名路径 stat 必给出不同 ino，
 * 天然放行合法异名库。stat 任一失败（ENOENT/EACCES 等）回退 samePath 字符串
 * 口径——磁盘不可探测时维持既有判重面（不比字符串口径更宽）。
 */
export function samePhysicalPath(a: string, b: string): boolean {
  try {
    const sa = statSync(a)
    const sb = statSync(b)
    return sa.dev === sb.dev && sa.ino === sb.ino
  } catch {
    return samePath(a, b)
  }
}
