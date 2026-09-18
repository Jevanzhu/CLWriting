/**
 * server keep-alive 治理：keepAliveTimeout/headersTimeout 加固（防 EPIPE）。
 * 根因：Node 默认 keepAliveTimeout=5s,客户端连接池缓存的连接超 5s 被服务端关掉,
 * 客户端复用已 FIN 的 socket 写 → EPIPE（长生成后 POST 大草稿体时偶发）。
 * 加固：keepAliveTimeout=30s 覆盖 AI 生成间隔;headersTimeout 必须 > keepAliveTimeout（Node v19+ 硬约束）。
 */
import { describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'

describe('startServer keep-alive 治理（防 EPIPE）', () => {
  it('keepAliveTimeout 拉长到 ≥30s（覆盖生成间隔）', async () => {
    const server = await startServerSafe({ port: 0 })
    expect(server.keepAliveTimeout).toBeGreaterThanOrEqual(30_000)
    server.close()
  })

  it('headersTimeout > keepAliveTimeout（Node v19+ 硬约束）', async () => {
    const server = await startServerSafe({ port: 0 })
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout!)
    server.close()
  })

  // 0918二轮修复批（D103）：requestTimeout 原依赖 Node 缺省（当前恰 300s）——408 闲置
  // 超时设计（readJson 占闸上限语义）与前端 ~300s 自愈假设以此为前提，显式钉住防默认值
  // 跨版本漂移；三超时齐设一并断言。
  it('requestTimeout 显式钉 300s（三超时齐设，不依赖 Node 默认值）', async () => {
    const server = await startServerSafe({ port: 0 })
    expect(server.requestTimeout).toBe(300_000)
    expect(server.keepAliveTimeout).toBe(30_000)
    expect(server.headersTimeout).toBe(35_000)
    server.close()
  })
})
