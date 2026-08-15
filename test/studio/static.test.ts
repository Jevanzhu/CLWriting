import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createStaticHandler } from '../../src/studio/server/static.js'

let root = ''
let server: http.Server | undefined
let baseUrl = ''

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-studio-static-'))
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Studio</title>')
  server = http.createServer(createStaticHandler(root))
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
  }
  if (root) rmSync(root, { recursive: true, force: true })
})

test('static handler rejects malformed uri without killing server', async () => {
  const bad = await fetch(`${baseUrl}/%E0%A4%A`)
  expect(bad.status).toBe(400)
  expect(await bad.text()).toBe('bad request')

  const ok = await fetch(`${baseUrl}/`)
  expect(ok.status).toBe(200)
  expect(await ok.text()).toContain('<title>Studio</title>')
})

test('cache-control: assets 下内容 hash 产物 immutable，其余 no-cache（Y-P2-7）', async () => {
  mkdirSync(join(root, 'assets'), { recursive: true })
  // 文件名带内容 hash 是 vite 产物惯例，判定只看路径在 assets/ 下
  writeFileSync(join(root, 'assets', 'index-B1rKx3Q2.js'), 'console.log(1)')
  writeFileSync(join(root, 'favicon.ico'), 'ico')

  // vite 构建产物（assets/ 下）→ 一年 immutable 长缓存
  const asset = await fetch(`${baseUrl}/assets/index-B1rKx3Q2.js`)
  expect(asset.status).toBe(200)
  expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')

  // SPA 入口（index.html）→ no-cache，保证发版后立即生效
  const html = await fetch(`${baseUrl}/`)
  expect(html.status).toBe(200)
  expect(html.headers.get('cache-control')).toBe('no-cache')

  // 非 assets 静态文件 → no-cache
  const ico = await fetch(`${baseUrl}/favicon.ico`)
  expect(ico.status).toBe(200)
  expect(ico.headers.get('cache-control')).toBe('no-cache')

  // SPA fallback（不存在的路由回 index.html）→ no-cache
  const spa = await fetch(`${baseUrl}/some/deep/route`)
  expect(spa.status).toBe(200)
  expect(spa.headers.get('cache-control')).toBe('no-cache')
})
