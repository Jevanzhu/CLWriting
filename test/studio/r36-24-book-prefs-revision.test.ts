/**
 * R36-24（三十六轮批 D）：putBookPrefs 乐观并发守卫回归
 * （PUT /api/books/:name/prefs，.clwriting/prefs.json revision 保留键）。
 *
 * 机理：书级 prefs.json 此前无锁并发整份覆盖（仅布局类数据），与全局 prefs 409 恢复
 * 链防御不对称。修复按「轻修 a」口径：revision 保留键 + revisionError + 409
 * REVISION_CONFLICT，实现逐位参照全局 prefs（GG-P2-7）——expectedRevision 可选，
 * 不带则直通（旧客户端/脚本向后兼容），GET 把保留键从 prefs 剥离单独回传。
 *
 * 覆盖：
 * - 不带 expectedRevision → 200 直通（兼容），revision 从 0 起自增
 * - 带匹配 revision → 200 且响应回传自增后的 revision；GET 不混入保留键
 * - 带过期 revision / 非数字 → 409 且盘上文件未被覆盖（后写不再静默覆盖先写）
 * - 客户端传入的同名 revision 键不采信（服务端计算覆盖）
 * - 合并写语义保留（盘上额外键不被清掉）
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { doInit } from '../../src/install/init.js'

let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
const BOOK = '布局测试'

/** 预建一本测试书（.clwriting/books.jsonl 登记；prefs.json 不预建——缺省空读路径） */
let bookPrefsPath = ''

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

/** 直读盘上 .clwriting/prefs.json（断言「未被覆盖」用，绕开 API 层） */
function disk(): Record<string, unknown> {
  return JSON.parse(readFileSync(bookPrefsPath, 'utf8')) as Record<string, unknown>
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-book-prefs-rev-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-book-prefs-rev-ud-'))
  const init = doInit({ workDir, name: BOOK, genre: '玄幻' })
  if (!init.ok) throw new Error(init.reason)
  bookPrefsPath = join(init.bookRoot, '.clwriting', 'prefs.json')
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

const prefsUrl = (): string => `/api/books/${encodeURIComponent(BOOK)}/prefs`

describe('R36-24 books.prefs revision（乐观并发）', () => {
  it('不带 expectedRevision → 200 直通（兼容）；无 revision 存量视为 0，写入自增', async () => {
    const g0 = await req<{ prefs: Record<string, unknown>; revision: number }>({ method: 'GET', path: prefsUrl() })
    expect(g0.status).toBe(200)
    expect(g0.json.prefs).toEqual({})
    expect(g0.json.revision).toBe(0)

    // 不带 expectedRevision = 直通（旧客户端/脚本），revision 0 → 1
    const a = await req<{ ok: boolean; revision: number }>({
      method: 'PUT',
      path: prefsUrl(),
      body: { prefs: { leftWidth: 360, leftOpen: true } },
    })
    expect(a.status).toBe(200)
    expect(a.json.ok).toBe(true)
    expect(a.json.revision).toBe(1)
    // 盘上保留键由服务端管理（不采信客户端同名键）
    expect(disk()).toEqual({ leftWidth: 360, leftOpen: true, revision: 1 })
  })

  it('带匹配 revision → 200 且响应含自增后的 revision；GET 把保留键从 prefs 剥离', async () => {
    const g1 = await req<{ prefs: Record<string, unknown>; revision: number }>({ method: 'GET', path: prefsUrl() })
    expect(g1.json.revision).toBe(1)

    const b = await req<{ ok: boolean; revision: number }>({
      method: 'PUT',
      path: prefsUrl(),
      body: { prefs: { rightOpen: false }, expectedRevision: 1 },
    })
    expect(b.status).toBe(200)
    expect(b.json.revision).toBe(2)
    // 合并写：既有键保留（对齐全局 prefs 第五轮口径——prefs.json 可能有 payload 之外的使用方）
    expect(disk()).toEqual({ leftWidth: 360, leftOpen: true, rightOpen: false, revision: 2 })

    const g2 = await req<{ prefs: Record<string, unknown>; revision: number }>({ method: 'GET', path: prefsUrl() })
    expect(g2.json.revision).toBe(2)
    expect('revision' in g2.json.prefs).toBe(false)
    expect(g2.json.prefs).toEqual({ leftWidth: 360, leftOpen: true, rightOpen: false })
  })

  it('带过期 revision → 409 且盘上文件未被覆盖；非数字 expectedRevision 同口径 409（守卫不放死）', async () => {
    const before = disk()

    const stale = await req<{ code: string; error: string }>({
      method: 'PUT',
      path: prefsUrl(),
      body: { prefs: { leftOpen: false, 垃圾覆盖: true }, expectedRevision: 0 },
    })
    expect(stale.status).toBe(409)
    expect(stale.json.code).toBe('REVISION_CONFLICT')
    expect(stale.json.error).toContain('刷新')
    // 盘上文件原封不动（修复前是后写静默覆盖先写）
    expect(disk()).toEqual(before)

    // 非数字 expectedRevision 与全局 prefs/providers P4 同口径：视作失配 409
    const badType = await req<{ code: string }>({
      method: 'PUT',
      path: prefsUrl(),
      body: { prefs: { leftOpen: false }, expectedRevision: '2' },
    })
    expect(badType.status).toBe(409)
    expect(disk()).toEqual(before)

    // 用最新 revision 再写 → 成功且再自增（守卫不放死）
    const ok = await req<{ ok: boolean; revision: number }>({
      method: 'PUT',
      path: prefsUrl(),
      body: { prefs: { leftOpen: false }, expectedRevision: 2 },
    })
    expect(ok.status).toBe(200)
    expect(ok.json.revision).toBe(3)
  })

  it('客户端传入的同名 revision 键不采信（服务端计算覆盖），GET 剥离后不进 prefs', async () => {
    const r = await req<{ ok: boolean; revision: number }>({
      method: 'PUT',
      path: prefsUrl(),
      body: { prefs: { revision: 999, treeExpanded: ['x'] }, expectedRevision: 3 },
    })
    expect(r.status).toBe(200)
    expect(r.json.revision).toBe(4)
    expect(disk().revision).toBe(4)
    const g = await req<{ prefs: Record<string, unknown>; revision: number }>({ method: 'GET', path: prefsUrl() })
    expect(g.json.revision).toBe(4)
    expect('revision' in g.json.prefs).toBe(false)
    expect(g.json.prefs['treeExpanded']).toEqual(['x'])
  })
})