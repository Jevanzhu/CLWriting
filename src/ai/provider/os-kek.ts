/**
 * OS 凭据通道 IKM——env 注入解析。
 *
 * safeStorage（mac Keychain / win DPAPI）只能在 Electron 主进程使用，而 server 跑在
 * utilityProcess 子进程——主进程经 env `CLW_OS_KEK` 注入 32 字节 hex（server-manager
 * launch 时 loadOrGenerateOsKek 产出并注入；CLW_STUDIO_TOKEN 同款不经 argv 纪律）。
 *
 * 无 env（纯 node dev:api / server-main / 测试未设）→ null = v1 内置通道语义，行为与
 * KEK v2 之前逐位一致。铁律「默认值显式 resolve」：解析规则唯一且无隐式 fallback
 *（非 64 hex 视同缺失，不猜测不截断）。
 */

/** 32 字节 hex = 64 字符（主进程 randomBytes(32).toString('hex') 产出形态） */
const HEX_32_RE = /^[0-9a-f]{64}$/i
const OS_KEK_ENV = 'CLW_OS_KEK'

export function osKeyMaterial(): Buffer | null {
  const hex = process.env[OS_KEK_ENV]
  if (!hex || !HEX_32_RE.test(hex)) return null
  return Buffer.from(hex, 'hex')
}
