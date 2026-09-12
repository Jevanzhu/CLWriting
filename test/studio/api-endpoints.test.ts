/**
 * P2-TST-3：3 个 API 端点集成测（foreshadows / trace-stats / knowledge）。
 *
 * 起真实 server（port 0）+ 断言响应结构 + 404/403 边界。
 * fixture：最小长篇书（写作/正文 1 章 + 设定/伏笔 1 条 + 无 AI trace）。
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

const BOOK = 'API端点测试书'
let studio: StudioHarness

async function req(method: string, path: string, body?: unknown, withToken = true): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${studio.baseUrl}${path}`, {
    method,
    headers: {
      ...(withToken ? { 'x-studio-token': studio.token } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json: unknown = null
  try {
    json = await r.json()
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, json }
}

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-apiep-',
    dirs: ['写作/正文', '设定/伏笔'],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: API端点测试书\n  genre: 玄幻\nhost: cc\n',
    files: [
      {
        rel: '写作/正文/0001-开篇.md',
        content:
          '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n玉佩在胸前发光。\n',
      },
      {
        rel: '设定/伏笔/玉佩线索.md',
        content: '---\n标题: 玉佩线索\n状态: 未回收\n埋设章号: 1\n重要性: 高\n关联词: 玉佩\n---\n玉佩来历之谜。\n',
      },
    ],
  })
})

afterAll(() => studio.close())

describe('GET /foreshadows', () => {
  it('返回伏笔列表（fm 字段 + 足迹）', async () => {
    const r = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/foreshadows`)
    expect(r.status).toBe(200)
    const j = r.json as { 标题: string; 状态: string; 足迹: unknown }[]
    expect(Array.isArray(j)).toBe(true)
    expect(j.length).toBeGreaterThanOrEqual(1)
    const fs = j.find((x) => x.标题 === '玉佩线索')
    expect(fs).toBeDefined()
    expect(fs!.状态).toBe('未回收')
    // 足迹：正文含「玉佩」→ 足迹非 null
    expect(fs!.足迹).not.toBeNull()
  })

  it('未知书 → 404', async () => {
    const r = await req('GET', '/api/books/不存在/foreshadows')
    expect(r.status).toBe(404)
  })
})

describe('GET /trace-stats', () => {
  it('返回 {total, byTask, ruleHits} 结构（无 trace 数据为空）', async () => {
    const r = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/trace-stats`)
    expect(r.status).toBe(200)
    const j = r.json as { total: number; byTask: unknown; ruleHits: unknown }
    expect(typeof j.total).toBe('number')
    expect(j.byTask).toBeTypeOf('object')
    expect(j.ruleHits).toBeTypeOf('object')
  })

  it('未知书 → 404', async () => {
    const r = await req('GET', '/api/books/不存在/trace-stats')
    expect(r.status).toBe(404)
  })
})

describe('POST /learn + /learn-commit', () => {
  it('learn 产候选（规则打分，无样本 → 空数组）', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/learn`)
    expect(r.status).toBe(200)
    const j = r.json as { samples: unknown[]; quotes: unknown[] }
    expect(Array.isArray(j.samples)).toBe(true)
    expect(Array.isArray(j.quotes)).toBe(true)
  })

  it('learn-commit 空提交 → 200 空文件列表', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/learn-commit`, { samples: [], quotes: [] })
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; sampleFiles: unknown[]; quoteFiles: unknown[] }
    expect(j.ok).toBe(true)
    expect(j.sampleFiles).toEqual([])
    expect(j.quoteFiles).toEqual([])
  })

  it('无 token → 403', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/learn`, undefined, false)
    expect(r.status).toBe(403)
  })

  it('未知书 → 404', async () => {
    const r = await req('POST', '/api/books/不存在/learn')
    expect(r.status).toBe(404)
  })
})
