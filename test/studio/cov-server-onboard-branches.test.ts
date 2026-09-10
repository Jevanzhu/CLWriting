/**
 * R1010c-COV-2（2026-09-10 全量独立复审修复批）：onboard-ai / onboard-save 分支补测——
 * 此前 onboard.ts 分支覆盖 54.28%（步校验/realm 成长线门/premise 长度门/GEN_FAIL/
 * 落盘失败/保存闸 等未触达；buildOnboardPrompt 各步 prompt 模板臂全空）。
 *
 * AI 生成走 CLWRITING_DRIVER=mock 快路（ONBOARD_SPEC 自带 mock 文本，纯定时器零大模型），
 * 生成失败分支（GEN_FAIL）在用例内临时删 driver + 空 userData（无 providers.json）触发。
 * 全部真实 HTTP + 真断言（信封 code / 落盘回读 / 步路径）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { acquireTaskGate } from '../../src/studio/server/api/task-gate.js'

let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

let prevDriver: string | undefined

interface ReqOpts {
  method: string
  path: string
  body?: unknown
}
function request(base: string, tok: string, opts: ReqOpts): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base)
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined
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

function makeBook(name: string, bookYaml: string): string {
  const root = join(workDir, 'books', name)
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), bookYaml)
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    `${JSON.stringify({ name, path: `books/${name}` })}\n`,
    { flag: 'a' },
  )
  return root
}

const LONG = 'kind: long\nbook:\n  title: 设定长篇\ngenre: 玄幻\n'
const LONG_GROWTH = 'kind: long\nbook:\n  title: 成长线书\nleads:\n  enabled: [成长线]\n'
const SHORT = 'kind: short\nbook:\n  title: 短篇书\n'

beforeAll(async () => {
  prevDriver = process.env.CLWRITING_DRIVER
  process.env.CLWRITING_DRIVER = 'mock'
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-cov-ob-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-cov-ob-ud-'))
  server = await startServerSafe({ port: 0, workDir, userDataPath })
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  token = ((await (await fetch(`${baseUrl}/api/boot`)).json()) as { token: string }).token
  makeBook('设定长篇', LONG)
  makeBook('成长线书', LONG_GROWTH)
  makeBook('短篇书', SHORT)
})

afterAll(async () => {
  if (prevDriver === undefined) delete process.env.CLWRITING_DRIVER
  else process.env.CLWRITING_DRIVER = prevDriver
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('R1010c-COV-2：onboard-ai 入参与闸分支', () => {
  it('不存在的书 → 404 NOT_FOUND', async () => {
    const r = await req({ method: 'POST', path: `/api/books/${encodeURIComponent('无此书')}/onboard-ai`, body: { step: 'synopsis' } })
    expect(r.status).toBe(404)
    expect(r.json.code).toBe('NOT_FOUND')
  })

  it('本书闸已被占 → 409 BUSY', async () => {
    const release = acquireTaskGate('设定长篇', 'onboard-ai')
    try {
      const r = await req({ method: 'POST', path: `/api/books/${encodeURIComponent('设定长篇')}/onboard-ai`, body: { step: 'synopsis' } })
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('BUSY')
      expect(r.json.error).toContain('AI 设定任务')
    } finally {
      release?.()
    }
  })

  it('step 缺失/未知/原型链键 → 400 BAD_INPUT step 不支持', async () => {
    const p = `/api/books/${encodeURIComponent('设定长篇')}/onboard-ai`
    for (const body of [{}, { step: '不存在的步' }, { step: 'constructor' }]) {
      const r = await req({ method: 'POST', path: p, body })
      expect(r.status).toBe(400)
      expect(r.json.code).toBe('BAD_INPUT')
      expect(r.json.error).toContain('step 不支持')
    }
  })

  it('book.yaml 损坏 → 500 IO_ERROR 读 book.yaml 失败', async () => {
    makeBook('设定坏配置书', 'kind: long\n  孤儿子行\n')
    const r = await req({ method: 'POST', path: `/api/books/${encodeURIComponent('设定坏配置书')}/onboard-ai`, body: { step: 'synopsis' } })
    expect(r.status).toBe(500)
    expect(r.json.code).toBe('IO_ERROR')
    expect(r.json.error).toContain('book.yaml')
  })

  it('realm 步非成长线书 → 400 BAD_INPUT', async () => {
    const r = await req({ method: 'POST', path: `/api/books/${encodeURIComponent('设定长篇')}/onboard-ai`, body: { step: 'realm' } })
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('BAD_INPUT')
    expect(r.json.error).toContain('成长线')
  })

  it('premise 超长（>5 万字符）→ 400 BAD_INPUT 过长', async () => {
    const r = await req({
      method: 'POST',
      path: `/api/books/${encodeURIComponent('设定长篇')}/onboard-ai`,
      body: { step: 'synopsis', premise: '长'.repeat(50_001) },
    })
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('BAD_INPUT')
    expect(r.json.error).toContain('过长')
  })

  it('AI 生成失败（无 driver 无 providers）→ 500 GEN_FAIL', async () => {
    delete process.env.CLWRITING_DRIVER
    try {
      const r = await req({ method: 'POST', path: `/api/books/${encodeURIComponent('设定长篇')}/onboard-ai`, body: { step: 'synopsis' } })
      expect(r.status).toBe(500)
      expect(r.json.code).toBe('GEN_FAIL')
    } finally {
      process.env.CLWRITING_DRIVER = 'mock'
    }
  })

  it('premise + discussionContext 注入 synopsis → 200 落盘 大纲/总纲.md（回读一致）', async () => {
    const r = await req({
      method: 'POST',
      path: `/api/books/${encodeURIComponent('设定长篇')}/onboard-ai`,
      body: { step: 'synopsis', premise: '少年修真复仇', discussionContext: '主角用剑' },
    })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.step).toBe('synopsis')
    expect(r.json.path).toBe('大纲/总纲.md')
    expect(r.json.words).toBeGreaterThan(0)
    const saved = readFileSync(join(workDir, 'books', '设定长篇', '大纲', '总纲.md'), 'utf8')
    expect(saved).toContain('mock 设定')
  })

  it('长篇各步逐一生成 → 各 200 且落盘对应路径（characters/world/realm/volume/leads-seed/style-*）', async () => {
    const steps: Array<[string, string, string]> = [
      ['characters', '设定长篇', '设定/名册.md'],
      ['world', '设定长篇', '设定/世界观.md'],
      ['realm', '成长线书', '设定/境界体系.md'],
      ['volume', '设定长篇', '大纲/卷纲/卷纲_第1卷.md'],
      ['leads-seed', '设定长篇', '大纲/账本种子.md'],
      ['style-sample', '设定长篇', '文风/样章库.md'],
      ['style-rules', '设定长篇', '文风/文风铁律.md'],
      ['style-quotes', '设定长篇', '文风/金句库.md'],
    ]
    for (const [step, book, relPath] of steps) {
      const r = await req({ method: 'POST', path: `/api/books/${encodeURIComponent(book)}/onboard-ai`, body: { step } })
      expect(r.status, step).toBe(200)
      expect(r.json.step).toBe(step)
      expect(r.json.path).toBe(relPath)
      expect(existsSync(join(workDir, 'books', book, relPath)), relPath).toBe(true)
    }
  })

  it('短篇 first-outline → 200 落盘 大纲/首章细纲.md', async () => {
    const r = await req({ method: 'POST', path: `/api/books/${encodeURIComponent('短篇书')}/onboard-ai`, body: { step: 'first-outline' } })
    expect(r.status).toBe(200)
    expect(r.json.path).toBe('大纲/首章细纲.md')
  })

  it('目标文件被目录占位 → 落盘失败 500 IO_ERROR', async () => {
    const root = makeBook('设定占位书', LONG)
    mkdirSync(join(root, '设定', '名册.md'), { recursive: true })
    const r = await req({ method: 'POST', path: `/api/books/${encodeURIComponent('设定占位书')}/onboard-ai`, body: { step: 'characters' } })
    expect(r.status).toBe(500)
    expect(r.json.code).toBe('IO_ERROR')
    expect(r.json.error).toContain('落盘失败')
  })
})

describe('R1010c-COV-2：onboard-save 分支', () => {
  it('不存在的书 → 404；step 缺失/未知 → 400；content 缺失/空白 → 400', async () => {
    const miss = await req({
      method: 'POST',
      path: `/api/books/${encodeURIComponent('无此书')}/onboard-save`,
      body: { step: 'synopsis', content: 'x' },
    })
    expect(miss.status).toBe(404)
    const p = `/api/books/${encodeURIComponent('设定长篇')}/onboard-save`
    for (const body of [{ content: 'x' }, { step: '不存在的步', content: 'x' }]) {
      const r = await req({ method: 'POST', path: p, body })
      expect(r.status).toBe(400)
      expect(r.json.code).toBe('BAD_INPUT')
      expect(r.json.error).toContain('step 不支持')
    }
    for (const content of [undefined, '', '   ']) {
      const r = await req({ method: 'POST', path: p, body: { step: 'synopsis', content } })
      expect(r.status).toBe(400)
      expect(r.json.code).toBe('BAD_INPUT')
      expect(r.json.error).toContain('content 为空')
    }
  })

  it('保存闸被占 → 409 BUSY', async () => {
    const release = acquireTaskGate('设定长篇', 'onboard-save')
    try {
      const r = await req({
        method: 'POST',
        path: `/api/books/${encodeURIComponent('设定长篇')}/onboard-save`,
        body: { step: 'synopsis', content: '# 新总纲' },
      })
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('BUSY')
      expect(r.json.error).toContain('保存')
    } finally {
      release?.()
    }
  })

  it('首存 → 200 无 snapshotted（空文件无留底）；再存 → 200 snapshotted:true（覆盖留底）', async () => {
    makeBook('保存留底书', LONG)
    const p = `/api/books/${encodeURIComponent('保存留底书')}/onboard-save`
    const first = await req({ method: 'POST', path: p, body: { step: 'style-rules', content: '# 铁律一\n- 正文纯文本' } })
    expect(first.status).toBe(200)
    expect(first.json.ok).toBe(true)
    expect(first.json.path).toBe('文风/文风铁律.md')
    expect(first.json.snapshotted).toBeUndefined()
    const second = await req({ method: 'POST', path: p, body: { step: 'style-rules', content: '# 铁律二\n- 对话标签 < 30%' } })
    expect(second.status).toBe(200)
    expect(second.json.snapshotted).toBe(true)
    const saved = readFileSync(join(workDir, 'books', '保存留底书', '文风', '文风铁律.md'), 'utf8')
    expect(saved).toContain('铁律二')
  })

  it('目标文件被目录占位 → 保存落盘失败 500 IO_ERROR', async () => {
    const root = makeBook('保存占位书', LONG)
    mkdirSync(join(root, '设定', '名册.md'), { recursive: true })
    const r = await req({
      method: 'POST',
      path: `/api/books/${encodeURIComponent('保存占位书')}/onboard-save`,
      body: { step: 'characters', content: '# 名册' },
    })
    expect(r.status).toBe(500)
    expect(r.json.code).toBe('IO_ERROR')
    expect(r.json.error).toContain('落盘失败')
  })
})
