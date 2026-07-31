/**
 * server keep-alive 治理：keepAliveTimeout/headersTimeout 加固（防 EPIPE）。
 * 根因：Node 默认 keepAliveTimeout=5s,客户端连接池缓存的连接超 5s 被服务端关掉,
 * 客户端复用已 FIN 的 socket 写 → EPIPE（长生成后 POST 大草稿体时偶发）。
 * 加固：keepAliveTimeout=30s 覆盖 AI 生成间隔;headersTimeout 必须 > keepAliveTimeout（Node v19+ 硬约束）。
 */
import { describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

describe('startServer keep-alive 治理（防 EPIPE）', () => {
  it('keepAliveTimeout 拉长到 ≥30s（覆盖生成间隔）', () => {
    const server = startServer({ port: 0 })
    expect(server.keepAliveTimeout).toBeGreaterThanOrEqual(30_000)
    server.close()
  })

  it('headersTimeout > keepAliveTimeout（Node v19+ 硬约束）', () => {
    const server = startServer({ port: 0 })
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout!)
    server.close()
  })
})
