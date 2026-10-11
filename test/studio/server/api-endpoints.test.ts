/**
 * P2-TST-3：3 个 API 端点集成测（foreshadows / trace-stats / knowledge）。
 *
 * 起真实 server（port 0）+ 断言响应结构 + 404/403 边界。
 * fixture：最小长篇书（写作/正文 1 章 + 设定/伏笔 1 条 + 无 AI trace）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../../helpers/studio-server.js'
import { traceStatsCache } from '../../../src/studio/server/api/trace-stats.js'
import { costStatsCache } from '../../../src/studio/server/api/cost-stats.js'
import { openSessionStore, bookHash } from '../../../src/events/store.js'
import { llmCallEvent } from '../../../src/events/chain-bridge.js'

const BOOK = 'API端点测试书'
let studio: StudioHarness
/** 独立用户数据目录（事件库）——写源失效回归锚要种 llm/call 事件 */
let userDataPath: string

async function req(
  method: string,
  path: string,
  body?: unknown,
  withToken = true,
): Promise<{ status: number; json: unknown }> {
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
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-apiep-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-apiep-',
    userDataPath,
    dirs: ['写作/正文', '设定/伏笔'],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: API端点测试书\n  genre: 玄幻\nhost: cc\n',
    files: [
      {
        rel: '写作/正文/0001-开篇.md',
        content: '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n玉佩在胸前发光。\n',
      },
      {
        rel: '设定/伏笔/玉佩线索.md',
        content: '---\n标题: 玉佩线索\n状态: 未回收\n埋设章号: 1\n重要性: 高\n关联词: 玉佩\n---\n玉佩来历之谜。\n',
      },
    ],
  })
})

afterAll(async () => {
  await studio.close()
  rmSync(userDataPath, { recursive: true, force: true })
})

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

// ── P1-15：stats 端点结果缓存（写源探针即时失效 + 5s TTL 兜底）─────────
// 两聚合均为全事件库全量扫；修复前每请求重算。命中观测读导出缓存实例 stats().misses
// （生产实例即观测面，同 settings-overview-ttl-gates 先例）。探针口径见
// src/studio/server/stats-signature.ts——事件库/rule-hits 文件指纹变化即失效。

describe('P1-15: stats 端点结果缓存（写源指纹不变 → 二次 GET 命中）', () => {
  it('trace-stats：写源未变时二次 GET 不重算且响应一致', async () => {
    const p = `/api/books/${encodeURIComponent(BOOK)}/trace-stats`
    // 预热：首取可能建事件库（建库改变文件指纹），先走一次把指纹带到稳态
    await req('GET', p)
    traceStatsCache.forgetPrefix(studio.bookRoot)
    traceStatsCache.resetStats()
    const r1 = await req('GET', p)
    expect(r1.status).toBe(200)
    const missesAfterFirst = traceStatsCache.stats().misses
    const r2 = await req('GET', p)
    expect(r2.status).toBe(200)
    expect(r2.json).toEqual(r1.json)
    expect(traceStatsCache.stats().misses).toBe(missesAfterFirst)
  })

  it('cost-stats：同款（二次 GET 不重聚合）', async () => {
    const p = `/api/books/${encodeURIComponent(BOOK)}/cost-stats`
    await req('GET', p)
    costStatsCache.forgetPrefix(studio.bookRoot)
    costStatsCache.resetStats()
    const r1 = await req('GET', p)
    expect(r1.status).toBe(200)
    const missesAfterFirst = costStatsCache.stats().misses
    const r2 = await req('GET', p)
    expect(r2.status).toBe(200)
    expect(r2.json).toEqual(r1.json)
    expect(costStatsCache.stats().misses).toBe(missesAfterFirst)
  })

  // 写源变化即刻失效——纯 TTL 缓存的回归面：AI 任务收尾追加 llm/call 事件后，
  // TTL 窗内下一次 GET 曾命中旧壳（新任务跑完用量卡短暂仍显示「暂无 AI 调用记录」）。
  it('写源变化即刻失效：种入 llm/call 事件 → TTL 窗内 GET 重算（不陈旧命中）', async () => {
    const p = `/api/books/${encodeURIComponent(BOOK)}/trace-stats`
    const r0 = await req('GET', p)
    expect((r0.json as { total: number }).total).toBe(0)
    // 模拟 AI 任务收尾：追加一条 llm/call 事件后关库（checkpoint → 库文件指纹变化）
    const store = openSessionStore(userDataPath, studio.bookRoot)!
    store.appendEvents(store.workspaceSession(bookHash(studio.bookRoot)), [
      llmCallEvent({
        runId: 'r-signature-regression',
        task: 'check',
        tierKind: 'craft',
        model: 'mock-model',
        attempt: 0,
        stopReason: 'done',
        durationMs: 1,
        ok: true,
      }),
    ])
    store.close()
    const r1 = await req('GET', p)
    expect((r1.json as { total: number }).total).toBe(1)
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
