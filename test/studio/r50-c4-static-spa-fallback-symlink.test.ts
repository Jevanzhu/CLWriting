/**
 * R50-C-4（五十轮）回归：SPA fallback 同过 M-9 canonical 判界。
 *
 * 修复前 fallback 分支裸 readFile(join(root, 'index.html'))——绕过主路径
 * resolveWithinRoot 防线，dist/index.html 被换成外指 symlink 时 fallback 直接跟随
 * （主路径请求该文件 403、未知路由 fallback 却把 symlink 目标内容吐回 200 的分歧
 * 行为）。修复后 fallback 同样经 resolveWithinRoot(root, 'index.html')，null 按
 * 主路径口径回 403 BAD_PATH；index.html 整体缺失仍走 404「前端尚未构建」提示。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createStaticHandler } from '../../src/studio/server/static.js'

let root = ''
let outside = ''
let server: http.Server | undefined
let baseUrl = ''

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'clw-r50-c4-static-'))
  outside = mkdtempSync(join(tmpdir(), 'clw-r50-c4-out-'))
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
  if (outside) rmSync(outside, { recursive: true, force: true })
})

// Windows 无 POSIX 权限位/需开发者模式，symlinkSync 直建 EPERM，该守卫语义由 macOS/Linux CI 腿覆盖
// （symlink 构造先例：static.test.ts M-9 / static-branch-error 等文件）
test.skipIf(process.platform === 'win32')('R50-C-4: index.html 被换成外指 symlink + 未知路由 → fallback 403 BAD_PATH（不跟随）', async () => {
  writeFileSync(join(outside, 'evil.html'), '<!doctype html><title>EVIL-OUTSIDE-LEAK</title>')
  unlinkSync(join(root, 'index.html'))
  // dist/index.html 被植入外指 symlink（本地可写前提，与 M-9 主路径同威胁模型）
  symlinkSync(join(outside, 'evil.html'), join(root, 'index.html'))

  const res = await fetch(`${baseUrl}/some/unknown/route`)
  expect(res.status).toBe(403)
  const body = await res.text()
  expect(JSON.parse(body)).toEqual({ code: 'BAD_PATH', error: 'forbidden' })
  expect(body).not.toContain('EVIL-OUTSIDE-LEAK') // 修复前：fallback 跟随 symlink 吐出 root 外内容
})

// 断链 symlink：R51-RED-3（五十一轮，2026-09-06 recover 合并整编失同步）契约随行——
// merged 实现 fallback 走 R50-C-4 canonical 判界，resolveWithinRoot 对断链 realpath
// 失败 fail-closed 返 null → 403 BAD_PATH（实现注释明钉「外指/断链/realpath 失败」
// 同判）；主路径对断链 /index.html 亦 403（stat ENOENT → fallback → 同一守卫），
// 「与主路径断链口径一致、无内容外泄」的原意由 403 如实恢复——原 404 期望系
// pre-merge 词法分支行为（existsSync 判不在 → readFile ENOENT → 404），已不成立。
test.skipIf(process.platform === 'win32')('R50-C-4: index.html 为断链 symlink + 未知路由 → 403 BAD_PATH（与主路径断链口径一致，无内容外泄）', async () => {
  unlinkSync(join(root, 'index.html'))
  symlinkSync(join(outside, 'never-exists.html'), join(root, 'index.html'))

  const res = await fetch(`${baseUrl}/some/unknown/route`)
  expect(res.status).toBe(403)
  const body = await res.text()
  expect(JSON.parse(body)).toEqual({ code: 'BAD_PATH', error: 'forbidden' })
  // 同一断链在主路径直请求同样 403（口径一致断言）
  const direct = await fetch(`${baseUrl}/index.html`)
  expect(direct.status).toBe(403)
  expect(body).not.toContain('前端尚未构建')
})

test('R50-C-4 对照: 正常 index.html + 未知路由 → fallback 200 行为不变', async () => {
  const res = await fetch(`${baseUrl}/some/unknown/route`)
  expect(res.status).toBe(200)
  expect(await res.text()).toContain('<title>Studio</title>')
})

test('R50-C-4 对照: index.html 整体缺失（未建站）+ 未知路由 → 404 建站提示不变', async () => {
  unlinkSync(join(root, 'index.html'))
  const res = await fetch(`${baseUrl}/some/unknown/route`)
  expect(res.status).toBe(404)
  const body = await res.text()
  expect(JSON.parse(body)).toEqual({
    code: 'NOT_FOUND',
    error: '前端尚未构建。请先运行：npm --prefix src/studio/web-next run build',
  })
})
