import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
