/**
 * R-19（第十六轮）回归：req.url → URL 统一安全解析（parseRequestUrl，Q-1/N-3 口径收编）。
 *
 * 六处 handler 裸调 `new URL(req.url, base)` 此前各管各；畸形请求行（llhttp 接受的
 * absolute-form，如 `GET http://[bad HTTP/1.1`）会让 new URL 抛 TypeError。收编后
 * 畸形 URL 返 null → 调用方回 400 BAD_INPUT 信封（与 static.ts Q-1 同款）；
 * router.ts dispatch 同源接入（此前裸抛落外层 catch 变 500）。
 */
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseRequestUrl } from '../../src/studio/server/http.js'

function fakeReq(url: string | undefined): { url: string | undefined } {
  return { url }
}

describe('R-19: parseRequestUrl 单元', () => {
  it('正常路径/query → URL 对象', () => {
    const u = parseRequestUrl(fakeReq('/api/books/x/foreshadows?q=%E7%8E%89') as never)
    expect(u).not.toBeNull()
    expect(u!.pathname).toBe('/api/books/x/foreshadows')
    expect(u!.searchParams.get('q')).toBe('玉')
  })

  it('畸形 URL（absolute-form 坏主机）→ null（不抛 TypeError）', () => {
    expect(parseRequestUrl(fakeReq('http://[bad') as never)).toBeNull()
  })

  it('url 缺失（undefined）→ 兜底解析 "/"，不抛', () => {
    const u = parseRequestUrl(fakeReq(undefined) as never)
    expect(u).not.toBeNull()
    expect(u!.pathname).toBe('/')
  })
})

// 集成：畸形请求行穿过 server → 400 BAD_INPUT 信封（不再 500/挂死）
let server: http.Server | undefined
let root = ''

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-parse-url-'))
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>S</title>')
  server = http.createServer((_req, res) => {
    res.writeHead(200)
    res.end('ok')
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('R-19: 畸形请求行经真实 HTTP server（llhttp 层确认可达性）', () => {
  it('absolute-form 坏 URL 能到达应用层（llhttp 放行）→ 收编后必被 parseRequestUrl 拦为 null', async () => {
    const address = server!.address() as AddressInfo
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(address.port, '127.0.0.1')
      const timer = setTimeout(() => reject(new Error('无响应')), 2_000)
      sock.on('connect', () => {
        sock.write(`GET http://[bad HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\n\r\n`)
      })
      sock.on('data', (d) => {
        clearTimeout(timer)
        resolve(d.toString('latin1'))
        sock.destroy()
      })
      sock.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
    expect(raw.startsWith('HTTP/1.1')).toBe(true)
    // llhttp 接受该请求行（应用层可见）——即 Q-1/静态分支与 R-19 各收编点的可达前提
    expect(parseRequestUrl(fakeReq('http://[bad') as never)).toBeNull()
  })
})
