/**
 * V-P1-1 回归：readJson 必须收齐全部 chunk 后一次性解码。
 * 逐 chunk toString 会把跨分块边界的多字节 UTF-8 字符（中文正文常态）切成 U+FFFD，
 * 造成保存链路静默损坏。用 PassThrough 手动按字节切块模拟 TCP 分块。
 */
import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { describe, it, expect } from 'vitest'
import { readJson, HttpError } from '../../src/studio/server/http.js'

function chunkedReq(bufs: Buffer[], limitBytes?: number): Promise<Record<string, unknown>> {
  const stream = new PassThrough()
  const req = stream as unknown as IncomingMessage
  for (const b of bufs) stream.write(b)
  stream.end()
  return limitBytes === undefined ? readJson(req) : readJson(req, limitBytes)
}

/** 在 body 中找一个 CJK 三字节字符的首字节，从字符中间切开 */
function splitInsideHanzi(body: Buffer): [Buffer, Buffer] {
  for (let i = 0; i < body.length - 1; i++) {
    const byte = body[i]
    if (byte !== undefined && byte >= 0xe4 && byte <= 0xe9) {
      return [body.subarray(0, i + 1), body.subarray(i + 1)]
    }
  }
  throw new Error('测试构造失败：body 中没有 CJK 字符')
}

describe('readJson 分块解码（V-P1-1）', () => {
  it('中文字符跨 chunk 边界 → 完整解码，无 U+FFFD', async () => {
    const text = '剑光如虹，横贯长空。'.repeat(2000) // ~36KB，超过回环单 segment 量级
    const body = Buffer.from(JSON.stringify({ content: text }))
    const result = (await chunkedReq(splitInsideHanzi(body))) as { content: string }
    expect(result.content).toBe(text)
  })

  it('逐字符切块（1 chunk = 1 字节）→ 仍完整解码', async () => {
    const text = '他说："你敢！"刀光一闪。'
    const body = Buffer.from(JSON.stringify({ q: text }))
    const single = Array.from(body, (byte) => Buffer.from([byte]))
    const result = (await chunkedReq(single)) as { q: string }
    expect(result.q).toBe(text)
  })

  it('超大请求体 → 413', async () => {
    const body = Buffer.from(JSON.stringify({ content: 'x'.repeat(2048) }))
    await expect(chunkedReq([body], 1024)).rejects.toMatchObject({ status: 413 })
    await expect(chunkedReq([body], 1024)).rejects.toBeInstanceOf(HttpError)
  })

  it('空 body → {}（沿用既有兜底语义）', async () => {
    const result = await chunkedReq([Buffer.from('')])
    expect(result).toEqual({})
  })
})
