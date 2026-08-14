import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const JSON_BODY_LIMIT_BYTES = 1024 * 1024

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 常量时间 token 比较，防 timing attack（长度不同直接返回 false）。 */
export function safeTokenCompare(received: string | string[] | undefined, expected: string): boolean {
  if (typeof received !== 'string') return false
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function checkToken(req: IncomingMessage, token: string): boolean {
  return safeTokenCompare(req.headers['x-studio-token'], token)
}

/** 读取 JSON body；默认 1MB 上限，避免本地 server 被超大请求顶爆内存。 */
export function readJson(
  req: IncomingMessage,
  limitBytes = JSON_BODY_LIMIT_BYTES,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // 缓冲按 Buffer 收集、一次性 concat 后再解码：逐 chunk toString 会把跨分块边界的
    // 多字节 UTF-8 字符（中文正文常态）切成 U+FFFD，造成静默内容损坏（V-P1-1）。
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (c: Buffer) => {
      if (tooLarge) return
      size += c.byteLength
      if (size > limitBytes) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, '请求体过大'))
        return
      }
      const data = Buffer.concat(chunks).toString('utf-8')
      try {
        // 字面 null 体（JSON.parse('null') = null）兜底为 {}，防端点 body['x'] TypeError
        resolve(data.trim() === '' ? {} : (JSON.parse(data) ?? {}))
      } catch (e) {
        reject(new HttpError(400, `请求体不是合法 JSON：${e instanceof Error ? e.message : ''}`))
      }
    })
    req.on('error', (e) => reject(e))
  })
}
