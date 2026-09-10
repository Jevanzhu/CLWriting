/**
 * R1010c-COV-1（2026-09-10 全量独立复审修复批）：config / draft / lead-updates 三端点
 * 错误与边界分支补测——此前 config.ts 分支覆盖 53.57%（数值键校验/回退重生成/写失败
 * 全未触达）、draft.ts 50%（非法 chapter/content/畸形 URL 未触达）、lead-updates.ts
 * 57.14%（闸 409/业务映射 400-404-500 未触达）。全部走真实 startServer HTTP + 真断言
 * （信封 code/文案/回读一致），与 api-error-branches.test.ts 同口径；正向对照仅保留
 * 锚定行为所必需的最小集。
 *
 * 本文件全程无 AI driver（删 CLWRITING_DRIVER + 空 userData 无 providers.json）——
 * 依赖 runSpec 的端点走「生成失败」分支（lead-updates → 500 ERROR）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { startServerSafe } from '../helpers/safe-port.js'
import { acquireTaskGate } from '../../src/studio/server/api/task-gate.js'

let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

// 无 workDir 的服务形态（各端点 NO_WORKDIR 分支专用）
let noworkServer: http.Server | undefined
let noworkBaseUrl = ''
let noworkToken = ''

interface ReqOpts {
  method: string
  path: string
  body?: unknown
  rawBody?: string
  headers?: Record<string, string>
}
function request(base: string, tok: string, opts: ReqOpts): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base)
    const payload = opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined)
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: opts.path,
        method: opts.method,
        headers: {
          'x-studio-token': tok,
          ...(payload !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: any = null
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
    if (payload !== undefined) r.write(payload)
    r.end()
  })
}
function req(opts: ReqOpts): Promise<{ status: number; json: any }> {
  return request(baseUrl, token, opts)
}
function noworkReq(opts: ReqOpts): Promise<{ status: number; json: any }> {
  return request(noworkBaseUrl, noworkToken, opts)
}

/** 建一本最小书（books.jsonl 登记 + 可选 book.yaml 内容；不建 正文 目录） */
function makeBook(name: string, bookYaml = 'kind: long\n', rel = `books/${name}`): string {
  const root = join(workDir, rel)
  mkdirSync(join(root, '项目'), { recursive: true })
  if (bookYaml !== '') writeFileSync(join(root, 'book.yaml'), bookYaml)
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    `${JSON.stringify({ name, path: rel })}\n`,
    { flag: 'a' },
  )
  return root
}

/** 短篇书（kind: short）——lead-updates rejected 分支专用 */
function makeShortBook(name: string): string {
  return makeBook(name, 'kind: short\n')
}

beforeAll(async () => {
  delete process.env.CLWRITING_DRIVER
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-cov-cd-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-cov-cd-ud-'))
  server = await startServerSafe({ port: 0, workDir, userDataPath })
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  token = ((await (await fetch(`${baseUrl}/api/boot`)).json()) as { token: string }).token

  noworkServer = startServer({ port: 0 })
  await new Promise<void>((r) => noworkServer!.once('listening', r))
  noworkBaseUrl = `http://127.0.0.1:${(noworkServer!.address() as AddressInfo).port}`
  noworkToken = ((await (await fetch(`${noworkBaseUrl}/api/boot`)).json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (noworkServer) await new Promise<void>((r) => noworkServer!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

// ── config 端点（book.yaml 结构化读写）──────────────────────────

describe('R1010c-COV-1：config 端点校验与回退分支', () => {
  it('GET /config 不存在的书 → 404 NOT_FOUND；无 workDir 服务 → 400 NO_WORKDIR', async () => {
    const miss = await req({ method: 'GET', path: `/api/books/${encodeURIComponent('无此书')}/config` })
    expect(miss.status).toBe(404)
    expect(miss.json.code).toBe('NOT_FOUND')
    const nw = await noworkReq({ method: 'GET', path: `/api/books/x/config` })
    expect(nw.status).toBe(400)
    expect(nw.json.code).toBe('NO_WORKDIR')
  })

  it('PUT /config 不存在的书 → 404；无 workDir 服务 → 400 NO_WORKDIR', async () => {
    const miss = await req({
      method: 'PUT',
      path: `/api/books/${encodeURIComponent('无此书')}/config`,
      body: { config: { book: { title: 'x' } } },
    })
    expect(miss.status).toBe(404)
    expect(miss.json.code).toBe('NOT_FOUND')
    const nw = await noworkReq({ method: 'PUT', path: '/api/books/x/config', body: { config: { book: { title: 'x' } } } })
    expect(nw.status).toBe(400)
    expect(nw.json.code).toBe('NO_WORKDIR')
  })

  it('PUT config 缺失 / book.title 非字符串 / 空白标题 → 400 BAD_INPUT 三态', async () => {
    makeBook('配置校验书')
    const p = `/api/books/${encodeURIComponent('配置校验书')}/config`
    for (const body of [{}, { config: 42 }, { config: { book: { title: 123 } } }, { config: { book: { title: '   ' } } }]) {
      const r = await req({ method: 'PUT', path: p, body })
      expect(r.status).toBe(400)
      expect(r.json.code).toBe('BAD_INPUT')
    }
  })

  it('PUT 标题含控制字符（换行）→ 400 BAD_INPUT', async () => {
    makeBook('配置控制字符书')
    const r = await req({
      method: 'PUT',
      path: `/api/books/${encodeURIComponent('配置控制字符书')}/config`,
      body: { config: { book: { title: '坏\n标题' } } },
    })
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('BAD_INPUT')
    expect(r.json.error).toContain('控制字符')
  })

  it('PUT 已知数值键非法值 → 400 且文案点名键（target_words/batch_size/max_days/max_count）', async () => {
    makeBook('配置数值键书')
    const p = `/api/books/${encodeURIComponent('配置数值键书')}/config`
    const cases: Array<[unknown, string]> = [
      [{ book: { title: '数值书', target_words: -1 } }, 'target_words'],
      [{ book: { title: '数值书' }, budget: { calls_per_chapter: Number.NaN } }, 'calls_per_chapter'],
      [{ book: { title: '数值书' }, auto: { batch_size: 0 } }, 'batch_size'],
      [{ book: { title: '数值书' }, snapshots: { max_days: 0 } }, 'max_days'],
      [{ book: { title: '数值书' }, snapshots: { max_count: '很多' } }, 'max_count'],
    ]
    for (const [extra, key] of cases) {
      const r = await req({ method: 'PUT', path: p, body: { config: extra } })
      expect(r.status).toBe(400)
      expect(r.json.code).toBe('BAD_INPUT')
      expect(r.json.error).toContain(key)
    }
  })

  it('PUT expectedRevision 失配 → 409 REVISION_CONFLICT（乐观并发守门）', async () => {
    makeBook('配置并发书')
    const r = await req({
      method: 'PUT',
      path: `/api/books/${encodeURIComponent('配置并发书')}/config`,
      body: { config: { book: { title: '并发书' } }, expectedRevision: 12345 },
    })
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('REVISION_CONFLICT')
  })

  it('PUT 合法 config → 200 带新 revision，GET 回读 title/revision 一致', async () => {
    makeBook('配置正向书', 'kind: long\nbook:\n  title: 旧名\n')
    const p = `/api/books/${encodeURIComponent('配置正向书')}/config`
    const before = await req({ method: 'GET', path: p })
    expect(before.status).toBe(200)
    expect(before.json.revision).not.toBe(0)
    // config 须为完整 BookConfig（spec_version/leads/budget/growth 必填——patch 与
    // stringify 回落都直读 leads.enabled / growth.realm_span_max，残缺形状触发 500
    // 而非 200，payload 形状与 api-integration 同口径）
    const put = await req({
      method: 'PUT',
      path: p,
      body: { config: { spec_version: 1, book: { title: '新名' }, leads: { enabled: [] }, budget: {}, growth: {} } },
    })
    expect(put.status).toBe(200)
    expect(put.json.ok).toBe(true)
    expect(typeof put.json.revision).toBe('number')
    const after = await req({ method: 'GET', path: p })
    expect(after.json.config.book.title).toBe('新名')
    // 保注释补丁写：文件级回读确认 revision 与 PUT 回传一致（同内容同指纹）
    expect(after.json.revision).toBe(put.json.revision)
  })

  it('PUT 现文件不可解析 → 回落全量重生成，保存后 book.yaml 修复为合法（200 + 可读回）', async () => {
    makeBook('配置损坏书', 'kind: long\n  孤儿子行\n')
    const p = `/api/books/${encodeURIComponent('配置损坏书')}/config`
    const r = await req({
      method: 'PUT',
      path: p,
      body: { config: { spec_version: 1, book: { title: '修复书' }, leads: { enabled: [] }, budget: {}, growth: {} } },
    })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    const got = await req({ method: 'GET', path: p })
    expect(got.status).toBe(200)
    expect(got.json.config.book.title).toBe('修复书')
  })

  it('PUT book.yaml 是目录（读/写全失败）→ 500 IO_ERROR 写失败（读指纹回落 0、重生成回落全走）', async () => {
    const root = makeBook('配置目录书', '')
    rmSync(join(root, 'book.yaml'), { force: true })
    mkdirSync(join(root, 'book.yaml'))
    const r = await req({
      method: 'PUT',
      path: `/api/books/${encodeURIComponent('配置目录书')}/config`,
      // 完整 config——确保 500 确来自「写 book.yaml 失败」分支而非 config 残缺被
      // stringify 抛错（前者才是本用例要钉的分支）
      body: { config: { spec_version: 1, book: { title: '写不进' }, leads: { enabled: [] }, budget: {}, growth: {} } },
    })
    expect(r.status).toBe(500)
    expect(r.json.code).toBe('IO_ERROR')
    expect(r.json.error).toContain('写 book.yaml 失败')
  })
})

// ── draft 端点（草稿落盘 + prompt 组装）────────────────────────

describe('R1010c-COV-1：draft 端点入参与边界分支', () => {
  it('POST draft-save 不存在的书 → 404；无 workDir 服务 → 400 NO_WORKDIR', async () => {
    const miss = await req({
      method: 'POST',
      path: `/api/books/${encodeURIComponent('无此书')}/draft-save`,
      body: { chapter: 1, content: '正文' },
    })
    expect(miss.status).toBe(404)
    expect(miss.json.code).toBe('NOT_FOUND')
    const nw = await noworkReq({ method: 'POST', path: '/api/books/x/draft-save', body: { chapter: 1, content: '正文' } })
    expect(nw.status).toBe(400)
    expect(nw.json.code).toBe('NO_WORKDIR')
  })

  it('POST draft-save 非整数章 / 零章 → 400 BAD_INPUT', async () => {
    makeBook('草稿校验书')
    const p = `/api/books/${encodeURIComponent('草稿校验书')}/draft-save`
    for (const chapter of [1.5, 0, -3]) {
      const r = await req({ method: 'POST', path: p, body: { chapter, content: '正文' } })
      expect(r.status).toBe(400)
      expect(r.json.code).toBe('BAD_INPUT')
      expect(r.json.error).toContain('chapter')
    }
  })

  it('POST draft-save content 非字符串 / 空白 → 400 BAD_INPUT', async () => {
    const p = `/api/books/${encodeURIComponent('草稿校验书')}/draft-save`
    for (const content of [123, '   ']) {
      const r = await req({ method: 'POST', path: p, body: { chapter: 1, content } })
      expect(r.status).toBe(400)
      expect(r.json.code).toBe('BAD_INPUT')
      expect(r.json.error).toContain('content')
    }
  })

  it('POST draft-save 正文目录被文件占位 → 500 IO_ERROR 落盘失败', async () => {
    const root = makeBook('草稿占位书')
    mkdirSync(join(root, '写作'), { recursive: true })
    writeFileSync(join(root, '写作', '正文'), '不是目录')
    const r = await req({
      method: 'POST',
      path: `/api/books/${encodeURIComponent('草稿占位书')}/draft-save`,
      body: { chapter: 1, content: '正文内容' },
    })
    expect(r.status).toBe(500)
    expect(r.json.code).toBe('IO_ERROR')
    expect(r.json.error).toContain('落盘失败')
  })

  it('GET draft-prompt 不存在的书 → 404；无 workDir 服务 → 400 NO_WORKDIR', async () => {
    const miss = await req({ method: 'GET', path: `/api/books/${encodeURIComponent('无此书')}/draft-prompt` })
    expect(miss.status).toBe(404)
    expect(miss.json.code).toBe('NOT_FOUND')
    const nw = await noworkReq({ method: 'GET', path: '/api/books/x/draft-prompt' })
    expect(nw.status).toBe(400)
    expect(nw.json.code).toBe('NO_WORKDIR')
  })

  it('GET draft-prompt 畸形 URL（非法百分号编码）→ 400 BAD_INPUT', async () => {
    makeBook('草稿prompt书')
    const r = await req({ method: 'GET', path: `/api/books/${encodeURIComponent('草稿prompt书')}/draft-prompt?chapter=%zz` })
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('BAD_INPUT')
  })

  it('GET draft-prompt 缺省章号 → 200 回 prompt+files；显式 chapter=2 → 200；非法章 → 400', async () => {
    const base = `/api/books/${encodeURIComponent('草稿prompt书')}/draft-prompt`
    const dflt = await req({ method: 'GET', path: base })
    expect(dflt.status).toBe(200)
    expect(typeof dflt.json.prompt).toBe('string')
    expect(Array.isArray(dflt.json.files)).toBe(true)
    const ch2 = await req({ method: 'GET', path: `${base}?chapter=2` })
    expect(ch2.status).toBe(200)
    expect(typeof ch2.json.prompt).toBe('string')
    for (const chapter of ['abc', '0']) {
      const bad = await req({ method: 'GET', path: `${base}?chapter=${chapter}` })
      expect(bad.status).toBe(400)
      expect(bad.json.code).toBe('BAD_INPUT')
      expect(bad.json.error).toContain('chapter')
    }
  })
})

// ── lead-updates 端点（账本推进生成）───────────────────────────

describe('R1010c-COV-1：lead-updates 闸与业务映射分支', () => {
  it('POST 不存在的书 → 404；无 workDir 服务 → 400 NO_WORKDIR', async () => {
    const miss = await req({
      method: 'POST',
      path: `/api/books/${encodeURIComponent('无此书')}/lead-updates`,
      body: { chapter: 1 },
    })
    expect(miss.status).toBe(404)
    expect(miss.json.code).toBe('NOT_FOUND')
    const nw = await noworkReq({ method: 'POST', path: '/api/books/x/lead-updates', body: { chapter: 1 } })
    expect(nw.status).toBe(400)
    expect(nw.json.code).toBe('NO_WORKDIR')
  })

  it('本书闸已被占（同 action 在途）→ 409 BUSY', async () => {
    makeBook('账本闸书')
    const release = acquireTaskGate('账本闸书', 'lead-updates')
    try {
      const r = await req({
        method: 'POST',
        path: `/api/books/${encodeURIComponent('账本闸书')}/lead-updates`,
        body: { chapter: 1 },
      })
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('BUSY')
      expect(r.json.error).toContain('账本推进')
    } finally {
      release?.()
    }
  })

  it('chapter 非法 → 400 BAD_INPUT', async () => {
    makeBook('账本校验书')
    const p = `/api/books/${encodeURIComponent('账本校验书')}/lead-updates`
    for (const chapter of [0, '二', 2.5]) {
      const r = await req({ method: 'POST', path: p, body: { chapter } })
      expect(r.status).toBe(400)
      expect(r.json.code).toBe('BAD_INPUT')
      expect(r.json.error).toContain('chapter')
    }
  })

  it('短篇书 → 业务拒绝映射 400 BAD_INPUT（账本推进仅长篇）', async () => {
    makeShortBook('账本短篇书')
    const r = await req({
      method: 'POST',
      path: `/api/books/${encodeURIComponent('账本短篇书')}/lead-updates`,
      body: { chapter: 1 },
    })
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('BAD_INPUT')
    expect(r.json.error).toContain('长篇')
  })

  it('长篇第 999 章正文不存在 → 映射 404 NOT_FOUND', async () => {
    makeBook('账本缺章书')
    const r = await req({
      method: 'POST',
      path: `/api/books/${encodeURIComponent('账本缺章书')}/lead-updates`,
      body: { chapter: 999 },
    })
    expect(r.status).toBe(404)
    expect(r.json.code).toBe('NOT_FOUND')
    expect(r.json.error).toContain('999')
  })

  it('长篇有正文但 AI 生成失败（无 driver）→ 映射 500 ERROR', async () => {
    const root = makeBook('账本生成书')
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    writeFileSync(
      join(root, '写作', '正文', '0001-开篇.md'),
      '---\n章号: 1\n标题: 开篇\n---\n林远推开门，雨声灌了进来。',
    )
    const r = await req({
      method: 'POST',
      path: `/api/books/${encodeURIComponent('账本生成书')}/lead-updates`,
      body: { chapter: 1 },
    })
    expect(r.status).toBe(500)
    expect(r.json.code).toBe('ERROR')
  })
})

// 防呆：确认临时工作目录确有登记（makeBook 助手自检，不属端点断言）
describe('R1010c-COV-1：fixture 自检', () => {
  it('books.jsonl 登记文件存在', () => {
    expect(existsSync(join(workDir, '.clwriting', 'books.jsonl'))).toBe(true)
    expect(readFileSync(join(workDir, '.clwriting', 'books.jsonl'), 'utf8').length).toBeGreaterThan(0)
  })
})
