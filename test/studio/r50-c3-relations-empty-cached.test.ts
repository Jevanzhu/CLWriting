/**
 * R50-C-3（五十轮）回归：/relations/mine 空产出时 cached:false。
 *
 * 修复前 `if (!relations.length) return reply(res, 200, { ok: true, cached: true,
 * relations: [] })`——该分支已真实跑完一次 AI 梳理（花钱）但结果为空，cached:true
 * 会把「花了钱的空产出」误标为「本地缓存命中」。修复后 cached:false。空结果是否落盘：
 * dev←recover 合并批收编 R48-77——空产出也是合法产出，同样落盘 relations.json（下次
 * force=false 走缓存不再重复付费；缓存随 chapterCount 变化失效，force 可强制重梳）。
 *
 * runSpec mock 注入空/非空产出（端点其余链路——互斥闸/材料收集/回复形状——全真）。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio（post 走裸 http.request，保留本地）。
 */
import http from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { runSpec } from '../../src/ai/tasks/spec.js'
import type { SpecOutput } from '../../src/ai/tasks/spec.js'
import type { TaskResult } from '../../src/ai/runner.js'

vi.mock('../../src/ai/tasks/spec.js', () => ({
  runSpec: vi.fn(),
}))
const runSpecMock = vi.mocked(runSpec)

/** 构造 runSpec 成功产出（TaskOk 必填字段齐备；settings.ts 只消费 data.input）。 */
function specOk(input: unknown): TaskResult<SpecOutput> {
  return {
    ok: true,
    data: { input, text: '', stopReason: 'end_turn' },
    ctrl: new AbortController(),
    usage: null,
    runId: 'r50-c3-test-run',
    model: null,
  }
}

const BOOK = 'R50空关系书'
let studio: StudioHarness

function post(path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(studio.baseUrl)
    const payload = body === undefined ? '' : JSON.stringify(body)
    const headers: Record<string, string> = { origin: studio.baseUrl, 'x-studio-token': studio.token }
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(Buffer.byteLength(payload))
    }
    const req = http.request({ host: u.hostname, port: u.port, path, method: 'POST', headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c.toString('utf8')))
      res.on('end', () => {
        let json: unknown = null
        try {
          json = JSON.parse(data)
        } catch {
          /* 非 JSON */
        }
        resolve({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-r50-c3-',
    dirs: ['设定'],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: R50空关系书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    // 名册非空 → buildMineContext 有材料可梳理（过 400 BAD_INPUT 材料闸）
    files: [{ rel: '设定/名册.md', content: '- 林远：主角\n' }],
  })
})

afterAll(() => studio.close())

describe('R50-C-3：/relations/mine 空产出 → cached:false（非缓存命中）', () => {
  it('AI 梳理产出空 relations → 200 + cached:false + 落盘缓存（R48-77 合流：空产出也是合法产出，防重复付费）', async () => {
    runSpecMock.mockResolvedValueOnce(specOk({ relations: [] }))
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/relations/mine`, { force: true })
    expect(r.status).toBe(200)
    // R50-C-3 语义保真：该次已真实付费跑完 AI——cached 如实 false（修复前误标 true）
    expect(r.json).toEqual({ ok: true, cached: false, relations: [] })
    // R48-77（dev←recover 合并批收编）：空结果同样落盘——下次非 force 走缓存不再烧 AI
    expect(existsSync(join(studio.bookRoot, '.clwriting', 'relations.json'))).toBe(true)
    const hit = await post(`/api/books/${encodeURIComponent(BOOK)}/relations/mine`, {})
    expect(hit.status).toBe(200)
    expect((hit.json as { cached: boolean }).cached).toBe(true)
    expect((hit.json as { relations: unknown[] }).relations).toHaveLength(0)
    expect(runSpecMock).toHaveBeenCalledTimes(1)
  })

  it('对照：非空产出 → 200 + cached:false + 落盘；随后非 force 请求 → cached:true（真缓存命中）', async () => {
    runSpecMock.mockResolvedValueOnce(specOk({ relations: [{ from: '林远', to: '赵衡', type: '仇敌' }] }))
    const mined = await post(`/api/books/${encodeURIComponent(BOOK)}/relations/mine`, { force: true })
    expect(mined.status).toBe(200)
    expect((mined.json as { cached: boolean }).cached).toBe(false)
    expect((mined.json as { relations: unknown[] }).relations).toHaveLength(1)
    expect(existsSync(join(studio.bookRoot, '.clwriting', 'relations.json'))).toBe(true)

    // 真·缓存命中分支不受本修复影响（cached:true 语义仍留给磁盘缓存复用）
    const hit = await post(`/api/books/${encodeURIComponent(BOOK)}/relations/mine`, {})
    expect(hit.status).toBe(200)
    expect((hit.json as { cached: boolean }).cached).toBe(true)
    // 累计两次（本测 force 梳理一次）——缓存命中未再跑 AI
    expect(runSpecMock).toHaveBeenCalledTimes(2)
  })
})
