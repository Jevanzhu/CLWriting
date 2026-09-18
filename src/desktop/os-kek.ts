/**
 * OS 凭据通道 IKM 装置（0918三拍板批 KEK v2）——Electron 主进程专用。
 *
 * safeStorage（mac Keychain / win DPAPI）是主进程专属模块，server 子进程
 *（utilityProcess，纯 Node 环境）拿不到——本模块在主进程生成/解锁 32 字节随机
 * IKM，密文落 userData/os-kek.json（safeStorage 加密 + 0600 原子写），明文经
 * env `CLW_OS_KEK` 注入 server 子进程（CLW_STUDIO_TOKEN 同款不经 argv 纪律）。
 *
 * 不可用面统一回落 null（子进程按 v1 内置通道语义运行，零悬崖）：
 * - safeStorage.isEncryptionAvailable() false（linux 无钥匙串 / 未受支持后端）
 * - os-kek.json 损坏或 decryptString 失败（Keychain 拒绝 / 跨账户恢复）
 * v2 vault 在回落环境打开会抛 VaultOsKeyMissingError（引导从桌面应用启动），
 * 不会静默坏数据。
 */
import { safeStorage } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { log, errMsg } from '../log/index.js'

const OS_KEK_FILE = 'os-kek.json'

interface OsKekDisk {
  v: 1
  /** safeStorage.encryptString(64 字符 hex) 的返回串原样落盘 */
  sealed: string
}

/** 取 OS 通道 IKM：无文件则生成并落盘，有则解锁；不可用面 → null（回落 v1 语义）。 */
export function loadOrGenerateOsKek(userDataPath: string): Buffer | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const fp = join(userDataPath, OS_KEK_FILE)
    if (existsSync(fp)) {
      const raw = JSON.parse(readFileSync(fp, 'utf8')) as OsKekDisk
      if (raw.v !== 1 || typeof raw.sealed !== 'string') {
        log.warn('desktop', `os-kek.json 形状不识别（v=${String((raw as { v?: unknown }).v)}）——OS 凭据通道回落内置通道`)
        return null
      }
      const hex = safeStorage.decryptString(Buffer.from(raw.sealed, 'base64'))
      return /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null
    }
    const hex = randomBytes(32).toString('hex')
    // encryptString 返回 Buffer——JSON 落盘统一 base64（读侧同式解回 Buffer）
    const disk: OsKekDisk = { v: 1, sealed: safeStorage.encryptString(hex).toString('base64') }
    atomicWriteFile(fp, JSON.stringify(disk, null, 2) + '\n', { mode: 0o600, fsync: true })
    return Buffer.from(hex, 'hex')
  } catch (e) {
    // Keychain 拒绝/损坏等——OS 通道不可用即回落（v1 语义），不阻断 server 启动
    log.warn('desktop', `OS 凭据通道初始化失败（回落内置通道）：${errMsg(e)}`)
    return null
  }
}
