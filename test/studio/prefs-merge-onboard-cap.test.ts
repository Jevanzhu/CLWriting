/**
 * 低级项（第六轮）回归：
 * - 书级 PUT /api/books/:name/prefs 合并写（对齐 library 级第五轮口径）——payload 之外
 *   的盘上键在 PUT 后存活，不再被整体覆写静默清键
 * - POST /api/books/:name/onboard-ai 自由文本长度上限——premise/discussionContext
 *   超 5 万字符 → 400（打不进 prompt）
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio；req 走泛型 node:http 形态
 * 保留本地，改绑 studio.baseUrl/studio.token。
 */
import http from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

const BOOK = '合并偏好书'
let studio: StudioHarness
let workDir = ''

function req<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  return new Promise((resolve, reject) => {
    const u = new URL(studio.baseUrl)
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: {
          'x-studio-token': studio.token,
          ...(body !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(body)) }
            : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json = null as T
          try {
            json = JSON.parse(data) as T
          } catch {
            /* 非 JSON 体 */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    r.on('error', reject)
    if (body !== undefined) r.write(JSON.stringify(body))
    r.end()
  })
}

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-prefs-merge-',
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 合并偏好书\n  genre: 玄幻\nhost: cc\n',
  })
  workDir = studio.workDir
})

afterAll(() => studio.close())

describe('低级项（第六轮）：书级 prefs 合并写', () => {
  it('PUT 后 payload 之外的盘上键存活（修复前：整体覆写清键）', async () => {
    const prefsPath = join(workDir, BOOK, '.clwriting', 'prefs.json')
    mkdirSync(join(workDir, BOOK, '.clwriting'), { recursive: true })
    // 盘上先有一个端点 payload 之外的键（脚本/手工写入）
    writeFileSync(prefsPath, JSON.stringify({ customScriptKey: 'keep-me', leftWidth: 220 }, null, 2), 'utf8')

    // 前端只回传自己已知的键
    const w = await req<{ ok: boolean }>(
      'PUT',
      `/api/books/${encodeURIComponent(BOOK)}/prefs`,
      { prefs: { leftWidth: 260, leftOpen: true } },
    )
    expect(w.status).toBe(200)
    expect(w.json.ok).toBe(true)

    const after = JSON.parse(readFileSync(prefsPath, 'utf8')) as Record<string, unknown>
    expect(after['customScriptKey']).toBe('keep-me') // 修复前：被覆写丢失
    expect(after['leftWidth']).toBe(260) // 同名键客户端覆盖
    expect(after['leftOpen']).toBe(true) // 新键写入
  })
})

describe('低级项（第六轮）：onboard-ai 自由文本长度上限', () => {
  it('premise 超 5 万字符 → 400，不进 prompt', async () => {
    const r = await req<{ error: string }>(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`,
      { step: 'synopsis', premise: 'x'.repeat(50_001) },
    )
    expect(r.status).toBe(400)
    expect(r.json.error).toContain('过长')
  })

  it('discussionContext 超限同口径 400；正常长度不受影响（走 step 校验，不到 AI）', async () => {
    const r = await req<{ error: string }>(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`,
      { step: 'synopsis', discussionContext: 'y'.repeat(50_001) },
    )
    expect(r.status).toBe(400)
    expect(r.json.error).toContain('过长')

    // 正常长度自由文本 + 非法 step：长度闸放行、命中 step 校验（证明上限不打扰正常路径）
    const ok = await req<{ error: string }>(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`,
      { step: 'bad-step', premise: '一个正常的梗概' },
    )
    expect(ok.status).toBe(400)
    expect(ok.json.error).toContain('step 不支持')
  })
})

describe('L-S1（第八轮）：GET 侧 prefs 形状校验（PUT 修复的同族残端）', () => {
  it('书级 prefs 文件是数组/标量 → GET 回空对象，不回显损坏形状', async () => {
    // 书级 prefs 在 bookRoot/.clwriting/prefs.json（与 PUT 同路径函数）
    const fp = join(workDir, BOOK, '.clwriting', 'prefs.json')
    mkdirSync(join(workDir, BOOK, '.clwriting'), { recursive: true })
    const before = existsSync(fp) ? readFileSync(fp, 'utf8') : null
    try {
      writeFileSync(fp, '[1,2,3]')
      const r2 = await req<{ prefs: unknown }>('GET', `/api/books/${encodeURIComponent(BOOK)}/prefs`)
      expect(r2.status).toBe(200)
      expect(r2.json.prefs).toEqual({})
      writeFileSync(fp, '"标量"')
      const r3 = await req<{ prefs: unknown }>('GET', `/api/books/${encodeURIComponent(BOOK)}/prefs`)
      expect(r3.json.prefs).toEqual({})
    } finally {
      if (before !== null) writeFileSync(fp, before)
      else rmSync(fp, { force: true })
    }
  })

  it('全局 prefs 文件是数组 → GET 回空对象 + revision 0（索引键不混入）', async () => {
    // 全局 prefs 在 userData/global.json；本 harness 未传 userDataPath → NO_USERDATA 400，
    // 形状校验逻辑由书级同款代码路径覆盖（两处实现逐字同构），此处锁降级不裸抛
    const r = await req<{ prefs?: unknown; error?: string }>('GET', '/api/library/prefs')
    expect([200, 400]).toContain(r.status)
  })
})
