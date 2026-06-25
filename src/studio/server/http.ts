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

export function checkToken(req: IncomingMessage, token: string): boolean {
  return req.headers['x-studio-token'] === token
}

/** 读取 JSON body；默认 1MB 上限，避免本地 server 被超大请求顶爆内存。 */
export function readJson(
  req: IncomingMessage,
  limitBytes = JSON_BODY_LIMIT_BYTES,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    let tooLarge = false
    req.on('data', (c: Buffer) => {
      if (tooLarge) return
      size += c.byteLength
      if (size > limitBytes) {
        tooLarge = true
        data = ''
        return
      }
      data += c.toString('utf-8')
    })
    req.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, '请求体过大'))
        return
      }
      try {
        resolve(data.trim() === '' ? {} : JSON.parse(data))
      } catch {
        resolve({})
      }
    })
    req.on('error', (e) => reject(e))
  })
}
