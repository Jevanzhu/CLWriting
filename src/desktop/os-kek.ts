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
 * 0918四轮修复批（C404）：①上述失败路径全部 warn 留痕（带路径+病因，不再静默）；
 * ②损坏自愈仅在 providers.json 无 v2 vault 时重建（v2 凭据以本 IKM 封装，重建即
 * 永久不可解——绝不重建，warn 指引），见 loadOrGenerateOsKek/v2VaultPresent 锚注。
 * 五轮重评修复批（D101）：③丢失形态同判——文件**缺失**且 providers.json 持 v2 vault
 * 同样不重建（原直达生成路径静默顶替，跨机迁移场景误导用户重配 key 致可恢复凭据
 * 永久丢失；对称面收口）。
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

/**
 * 取 OS 通道 IKM：无文件则生成并落盘，有则解锁；不可用面 → null（回落 v1 语义）。
 * 0918四轮修复批（C404）：
 * ①全失败路径统一 warn 留痕（带路径与病因）——此前 safeStorage 不可用与「解密结果非
 *   64-hex」两处静默，损坏面零迹可查；
 * ②损坏自愈重建**仅在安全时**：providers.json 无 v2 vault（os IKM 零消费者）才重建
 *   重写——v2 vault 的 DEK 由本 IKM 封装（vault.ts KEK_OS_INFO 通道），重建 = v2 凭据
 *   永久不可解，绝不删除重建，warn 指引（文案口径对齐 VaultOsKeyMissingError「请从
 *   桌面应用启动」）。
 */
export function loadOrGenerateOsKek(userDataPath: string): Buffer | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      // C404①：linux 无钥匙串等环境常态也留痕——「v2 vault 为何回落内置通道」可诊断
      log.warn('desktop', `safeStorage 加密通道不可用（无钥匙串/未受支持后端）——OS 凭据通道回落内置通道（${join(userDataPath, OS_KEK_FILE)} 不受影响）`)
      return null
    }
    const fp = join(userDataPath, OS_KEK_FILE)
    if (existsSync(fp)) {
      const sealed = readSealedHex(fp)
      if (sealed.ok) return Buffer.from(sealed.hex, 'hex')
      // C404②：损坏分诊——providers.json 持有（或疑似持有）v2 凭据 → 绝不重建
      if (v2VaultPresent(userDataPath)) {
        log.warn(
          'desktop',
          `os-kek.json 损坏不可解（${sealed.cause}）：${fp}，且 providers.json 持有系统钥匙串保护的 vault v2 凭据——不重建（重建 = v2 凭据永久不可解），OS 凭据通道回落内置通道。请从桌面应用启动以恢复 OS 凭据通道；确需重建须先备份并删除 providers.json。`,
        )
        return null
      }
      // 无 v2 凭据（providers.json 不存在 / vault v1 内置通道）→ 旧 IKM 零消费者，重建
      // 无损：不手删旧文件，直接走下方生成路径原子写顶替
      log.warn('desktop', `os-kek.json 损坏不可解（${sealed.cause}）：${fp}，且 providers.json 无 v2 凭据（重建无损）——已重建 os-kek.json`)
    } else if (v2VaultPresent(userDataPath)) {
      // 五轮重评修复批（D101）：**丢失**形态同判（C404② 对称面）——os-kek.json 缺失
      //（清理工具误删 / 跨机迁移只拷了 providers.json）且 providers.json 持 v2 凭据时，
      // 原实现直达生成路径：新 IKM 静默落盘顶替、零留痕。旧 IKM 已不在盘，v2 凭据在
      // 丢失瞬间已不可解（重建与否对数据结局等价，故非「代码导致凭据丢失」），但静默
      // 重建的增量伤害实存：①下游 vault 报「密文认证失败」误导用户指向 providers.json
      // 损坏/重装；②跨机迁移场景（原机 os-kek.json 完好、本可恢复）用户被误导重配 key
      // → saveProviders 覆盖 providers.json，可恢复凭据演化为永久丢失；③「绝不重建」
      // 防线只护损坏形态，口径不对称。现对齐损坏分诊：不重建，回落内置通道（server 侧
      // openVault 抛 VaultOsKeyMissingError 引导从桌面应用启动，与损坏形态可区分）。
      log.warn(
        'desktop',
        `os-kek.json 缺失：${fp}，且 providers.json 持有系统钥匙串保护的 vault v2 凭据——不重建（重建 = v2 凭据永久不可解），OS 凭据通道回落内置通道。请从桌面应用启动以恢复 OS 凭据通道（跨机迁移场景须从原机拷贝 os-kek.json）；确需重建须先备份并删除 providers.json。`,
      )
      return null
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

/** C404①：读 + 解锁 sealed hex——失败不再静默，病因随返回体交调用方统一 warn。 */
function readSealedHex(fp: string): { ok: true; hex: string } | { ok: false; cause: string } {
  let raw: OsKekDisk
  try {
    raw = JSON.parse(readFileSync(fp, 'utf8')) as OsKekDisk
  } catch (e) {
    return { ok: false, cause: `JSON 解析失败：${errMsg(e)}` }
  }
  if (raw.v !== 1 || typeof raw.sealed !== 'string') {
    return { ok: false, cause: `形状不识别（v=${String((raw as { v?: unknown }).v)}）` }
  }
  let hex: string
  try {
    hex = safeStorage.decryptString(Buffer.from(raw.sealed, 'base64'))
  } catch (e) {
    return { ok: false, cause: `解密失败（Keychain 拒绝/跨账户恢复）：${errMsg(e)}` }
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    return { ok: false, cause: '解密结果非 64 位 hex（材料形状非法）' }
  }
  return { ok: true, hex }
}

/**
 * C404②：providers.json 是否可能持 v2 vault（os 通道凭据）——判定口径对齐
 * src/ai/provider/vault.ts：openVault 对 `vault.v >= 2` 走 byOs 通道（需 osKeyMaterial），
 * migrateVaultToOsChannel 同步置 v=2 + dek.byOs，故判 `v >= 2 || dek.byOs 在`。文件
 * 不存在 / 无 vault 字段 / v1（byApp 内置通道，os IKM 零消费）→ false = 重建无损。
 * providers.json 在但解析失败 → 视为「v2 存在与否不明」保守返回 true：数据安全优先，
 * 误重建的代价（v2 凭据永久不可解）远大于误不重建（少一次自愈，可修复后重试）。
 * 轻量结构读（不 import ai/provider/store：其写链队列/缓存面不宜进主进程启动路径）。
 */
function v2VaultPresent(userDataPath: string): boolean {
  const pfp = join(userDataPath, 'providers.json')
  if (!existsSync(pfp)) return false
  try {
    const raw = JSON.parse(readFileSync(pfp, 'utf8')) as {
      vault?: { v?: unknown; dek?: { byOs?: unknown } } | null
    }
    const v = raw.vault?.v
    return (typeof v === 'number' && v >= 2) || raw.vault?.dek?.byOs !== undefined
  } catch {
    return true
  }
}
