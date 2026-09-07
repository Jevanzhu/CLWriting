/**
 * R59 清偿批（R55-E-2）回归：静态托管 MIME 表补常见安全类型。
 *
 * 修复前：MIME 表缺 .txt/.webp/.gif/.woff，命中回落 application/octet-stream，
 * 浏览器对未知类型一律弹下载（.woff 字体在部分浏览器还会被拒载）。当前构建产物
 * 不含此类文件（零实害），但 dist 内手工放置的说明书/字体等会踩中。
 *
 * 修复后：四类映射标准 MIME 值；未登记扩展名仍回落 octet-stream（不放宽）。
 * .woff2/.svg/.ico 顺检已在表内（本文件一并锁定，防将来误删）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createStaticHandler } from '../../src/studio/server/static.js'

let root = ''
let server: http.Server | undefined
let baseUrl = ''

async function start(): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'clwriting-backlog-mime-'))
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, '说明.txt'), '纯文本说明', 'utf-8')
  writeFileSync(join(root, 'assets', 'pic.webp'), 'webp-bytes')
  writeFileSync(join(root, 'assets', 'ani.gif'), 'gif-bytes')
  writeFileSync(join(root, 'assets', 'font.woff'), 'woff-bytes')
  writeFileSync(join(root, 'assets', 'font.woff2'), 'woff2-bytes')
  writeFileSync(join(root, 'assets', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf-8')
  writeFileSync(join(root, 'favicon.ico'), 'ico-bytes')
  writeFileSync(join(root, 'assets', 'blob.xyz'), 'unknown-bytes')
  server = http.createServer(createStaticHandler(root))
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
  }
  if (root) rmSync(root, { recursive: true, force: true })
})

test('R55-E-2: 新增 .txt/.webp/.gif/.woff 按标准 MIME 返回（修复前回落 octet-stream 变下载）', async () => {
  baseUrl = await start()
  const cases: Array<[string, string]> = [
    ['/说明.txt', 'text/plain; charset=utf-8'],
    ['/assets/pic.webp', 'image/webp'],
    ['/assets/ani.gif', 'image/gif'],
    ['/assets/font.woff', 'font/woff'],
  ]
  for (const [path, expected] of cases) {
    const res = await fetch(`${baseUrl}${path}`)
    expect(res.status, path).toBe(200)
    expect(res.headers.get('content-type'), path).toBe(expected)
  }
})

test('R55-E-2 顺检: .woff2/.svg/.ico 既有映射不回归', async () => {
  baseUrl = await start()
  const cases: Array<[string, string]> = [
    ['/assets/font.woff2', 'font/woff2'],
    ['/assets/icon.svg', 'image/svg+xml'],
    ['/favicon.ico', 'image/x-icon'],
  ]
  for (const [path, expected] of cases) {
    const res = await fetch(`${baseUrl}${path}`)
    expect(res.status, path).toBe(200)
    expect(res.headers.get('content-type'), path).toBe(expected)
  }
})

test('R55-E-2: 未登记扩展名仍回落 application/octet-stream（不放宽回落口径）', async () => {
  baseUrl = await start()
  const res = await fetch(`${baseUrl}/assets/blob.xyz`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('application/octet-stream')
})
