/**
 * win 适配（阶段 21 真机回归，2026-09-01）：测试服务器防「fetch bad port」抖动。
 *
 * 背景：port 0 由 OS 从动态段分配；本机（win 真机）动态段被改为 1024-15000
 * （netsh 实测；Windows 默认 49152-65535），与 fetch（undici/Chromium 同表）的
 * 受限端口黑名单（5060/6000/6566/6665-6669/6697/10080 等）相交——命中时所有
 * fetch 抛 TypeError: bad port，该测试文件随机整红（win 全量首跑
 * state-global-defaults 实证）。默认动态段与黑名单不相交，CI 各腿无此暴露。
 *
 * startServerSafe：同签名包装 startServer——绑 0 后若落黑名单则关服重绑（OS 再
 * 分配，重抽中概率归零）；端口检查在 listening 之后、调用方注册 .once('listening')
 * 之前完成，故调用方原「bind 后 await once(listening)」两行式可安全合并为一行
 * await（listening 已发射，再挂 once 永不触发——这正是本 helper 代等的原因）。
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { startServer, type StudioServerOptions } from '../../src/studio/server/index.js'

/** fetch 受限端口黑名单（Chromium kRestrictedPorts，undici 同表）——本机动态段
 * 1024-15000 内命中 15 个（1719/1720/1723/2049/3659/4045/5060/5061/6000/6566/6665-6669/6697/10080），全表保留防动态段再改。 */
const RESTRICTED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6697, 10080,
])

export async function startServerSafe(opts: StudioServerOptions): Promise<Server> {
  for (let i = 0; i < 32; i++) {
    const server = startServer(opts)
    await new Promise<void>((r) => server.once('listening', r))
    const port = (server.address() as AddressInfo).port
    if (!RESTRICTED_PORTS.has(port)) return server
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
  throw new Error('startServerSafe：连续 32 次抽中受限端口（概率上不可能）——检查本机动态段配置')
}
