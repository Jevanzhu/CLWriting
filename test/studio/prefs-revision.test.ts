/**
 * GG-P2-7 回归测试：PUT /api/library/prefs 乐观并发守卫（global.json revision 保留键）。
 * - 不带 expectedRevision → 200 直通（旧客户端/脚本向后兼容），revision 从 0 起自增
 * - 带匹配 revision → 200 且响应回传自增后的 revision；GET 把保留键从 prefs 剥离单独回传
 * - 带过期 revision → 409 且盘上文件未被覆盖（后写不再静默覆盖先写）
 * - 读路径不受影响：global-defaults 等按键读取方忽略 revision 保留键
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { readGlobalBookDefaults } from '../../src/format/global-defaults.js'

let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

interface ReqOpts {
  method: string
  path: string
  body?: unknown
}
function req<T>(opts: ReqOpts): Promise<{ status: number; json: T }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: opts.path,
        method: opts.method,
        headers: {
          'x-studio-token': token,
          ...(opts.body !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(opts.body)) }
            : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: T = null as T
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON 体 */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    r.on('error', reject)
    if (opts.body !== undefined) r.write(JSON.stringify(opts.body))
    r.end()
  })
}

/** 直读盘上 global.json（断言「未被覆盖」用，绕开 API 层） */
function disk(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(userDataPath, 'global.json'), 'utf8')) as Record<string, unknown>
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-prefs-rev-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-prefs-rev-ud-'))
  server = startServer({ port: 0, workDir, userDataPath })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('GG-P2-7 global.json revision（乐观并发）', () => {
  it('不带 expectedRevision → 200 直通（兼容）；无 revision 的存量文件视为 0，写入自增', async () => {
    // 全新 userData：GET 空偏好 + revision 0
    const g0 = await req<{ prefs: Record<string, unknown>; revision: number }>({ method: 'GET', path: '/api/library/prefs' })
    expect(g0.status).toBe(200)
    expect(g0.json.prefs).toEqual({})
    expect(g0.json.revision).toBe(0)

    // 不带 expectedRevision = 直通（旧客户端/脚本），revision 0 → 1
    const a = await req<{ ok: boolean; revision: number }>({
      method: 'PUT',
      path: '/api/library/prefs',
      body: { prefs: { theme: 'dark', proseSize: 18 } },
    })
    expect(a.status).toBe(200)
    expect(a.json.ok).toBe(true)
    expect(a.json.revision).toBe(1)

    // revision 由服务端计算并随偏好落盘（不采信客户端同名键）
    expect(disk()).toEqual({ theme: 'dark', proseSize: 18, revision: 1 })
  })

  it('带匹配 revision → 200 且响应含自增后的 revision；GET 把保留键从 prefs 剥离', async () => {
    const g1 = await req<{ prefs: Record<string, unknown>; revision: number }>({ method: 'GET', path: '/api/library/prefs' })
    expect(g1.json.revision).toBe(1)
    expect(g1.json.prefs).toEqual({ theme: 'dark', proseSize: 18 })

    const b = await req<{ ok: boolean; revision: number }>({
      method: 'PUT',
      path: '/api/library/prefs',
      body: { prefs: { theme: 'light', proseSize: 19, shelfView: 'list' }, expectedRevision: 1 },
    })
    expect(b.status).toBe(200)
    expect(b.json.revision).toBe(2)

    // GET：prefs 不含 revision 保留键（不混入偏好语义），revision 单独回传
    const g2 = await req<{ prefs: Record<string, unknown>; revision: number }>({ method: 'GET', path: '/api/library/prefs' })
    expect(g2.json.revision).toBe(2)
    expect(g2.json.prefs).toEqual({ theme: 'light', proseSize: 19, shelfView: 'list' })
    expect('revision' in g2.json.prefs).toBe(false)
  })

  it('带过期 revision → 409 且盘上文件未被覆盖；非数字 expectedRevision 同口径 409', async () => {
    const before = disk()

    const stale = await req<{ error: string }>({
      method: 'PUT',
      path: '/api/library/prefs',
      body: { prefs: { theme: 'hacker', 垃圾覆盖: true }, expectedRevision: 0 },
    })
    expect(stale.status).toBe(409)
    expect(stale.json.error).toContain('刷新')

    // 盘上文件原封不动（此前是后写静默覆盖先写——GG-P2-7 修的就是这个）
    expect(disk()).toEqual(before)

    // 非数字 expectedRevision 与 providers.ts P4 同口径：视作失配 409（不静默放行）
    const badType = await req<{ error: string }>({
      method: 'PUT',
      path: '/api/library/prefs',
      body: { prefs: { theme: 'light' }, expectedRevision: '2' },
    })
    expect(badType.status).toBe(409)
    expect(disk()).toEqual(before)

    // 用最新 revision 再写 → 成功且再自增（守卫不放死）
    const ok = await req<{ ok: boolean; revision: number }>({
      method: 'PUT',
      path: '/api/library/prefs',
      body: { prefs: { theme: 'dark', proseSize: 20 }, expectedRevision: 2 },
    })
    expect(ok.status).toBe(200)
    expect(ok.json.revision).toBe(3)
  })

  it('读路径不受影响：global-defaults 按键读取忽略 revision 保留键', async () => {
    const w = await req<{ revision: number }>({
      method: 'PUT',
      path: '/api/library/prefs',
      body: { prefs: { defaultGenre: '仙侠', defaultVolumeSize: 60 } },
    })
    expect(w.status).toBe(200)
    // 盘上文件此刻含 revision 保留键——服务端其余 global.json 读方（三层链中间层）不受影响
    const d = readGlobalBookDefaults(userDataPath)
    expect(d.defaultGenre).toBe('仙侠')
    expect(d.defaultVolumeSize).toBe(60)
  })

  // 第五轮：PUT 是合并写——global.json 存在前端 payload 之外的使用方（按文档手工/脚本
  // 写入的 tokensPerChapter/costPerChapter 预算键）。修复前整体覆写：面板改一次主题
  // （500ms debounce 即 PUT）预算键被静默清掉、预算闸失效
  it('payload 之外的盘上键在 PUT 后存活（合并写，不整体覆写）', async () => {
    // 手工按文档写入预算键（保留当前 revision）
    const before = disk()
    writeFileSync(
      join(userDataPath, 'global.json'),
      JSON.stringify({ ...before, tokensPerChapter: 600_000, costPerChapter: 1.5 }),
      'utf8',
    )

    // 前端全量保存自己已知的键（不含预算键）
    const w = await req<{ ok: boolean; revision: number }>({
      method: 'PUT',
      path: '/api/library/prefs',
      body: { prefs: { theme: 'sepia', proseSize: 21, shelfView: 'grid', defaultGenre: '仙侠', defaultVolumeSize: 60 } },
    })
    expect(w.status).toBe(200)

    const after = disk()
    expect(after['tokensPerChapter']).toBe(600_000) // 修复前：被覆写丢失
    expect(after['costPerChapter']).toBe(1.5)
    expect(after['theme']).toBe('sepia')
    expect(after['revision']).toBe(w.json.revision)
  })
})
