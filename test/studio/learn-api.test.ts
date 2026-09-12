/**
 * learn 文风收割端点测（#8.3）：候选入库胶水 + 边界。
 *
 * - POST /learn 无定稿正文 → 400（learnFromBook 返 ok:false）
 * - POST /learn-commit mock 候选 → 入库 文风/条目/样章/（commitSamples 胶水，S8）
 *
 * 复用 api-integration 的 fixture 模式（长篇书）。commitSamples/learnFromBook 内核已测，此处只验端点胶水。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio；请求是裸 fetch（大写
 * X-Studio-Token、无 origin 的本地形态），保留原样、改绑 studio.baseUrl/studio.token。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

const BOOK = '收割测试书'
let studio: StudioHarness
let workDir = ''

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-learn-',
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 收割测试书\n  genre: 玄幻\nhost: cc\n',
  })
  workDir = studio.workDir
})

afterAll(() => studio.close())

describe('learn 文风收割端点（#8.3）', () => {
  it('POST /learn 无定稿正文 → 400', async () => {
    const r = await fetch(`${studio.baseUrl}/api/books/${encodeURIComponent(BOOK)}/learn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': studio.token },
    })
    expect(r.status).toBe(400)
    const d = (await r.json()) as { error?: string }
    expect(d.error).toMatch(/没有定稿正文/)
  })

  it('POST /learn-commit mock 样章候选 → 入库 文风/条目/样章/', async () => {
    const r = await fetch(`${studio.baseUrl}/api/books/${encodeURIComponent(BOOK)}/learn-commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': studio.token },
      body: JSON.stringify({
        samples: [
          { 场景: '对话', 正文: '「你去哪？」「去找真相。」', 出处: '《收割测试书》第 1 章', 章号: 1, 打分: 80 },
        ],
        quotes: [],
      }),
    })
    expect(r.ok).toBe(true)
    const d = (await r.json()) as { ok?: boolean; sampleFiles?: string[] }
    expect(d.ok).toBe(true)
    expect(d.sampleFiles).toHaveLength(1)
    // 入库文件为条目库样章条目（S8：样章库退场）
    expect(existsSync(join(workDir, BOOK, '文风', '条目', '样章', '对话-001.md'))).toBe(true)
  })

  it('POST /learn-commit 无 token → 403', async () => {
    const r = await fetch(`${studio.baseUrl}/api/books/${encodeURIComponent(BOOK)}/learn-commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ samples: [], quotes: [] }),
    })
    expect(r.status).toBe(403)
  })

  // 重评2-P3-⑤a（2026-09-09 全量重评 GLM-5.3）：learn-commit 逐项条目数上限——
  // 原仅受 readJson 1MB 总量约束，超长数组逐条 commit 秒级阻塞；上限 400 对齐
  // 批量定稿 BATCH_FINALIZE_MAX_DOCS 先例，超限回 422 业务信封且零入库。
  it('重评2-P3-⑤a：learn-commit 条目数超上限 → 422 {code,error} 信封，不入库', async () => {
    const itemDir = join(workDir, BOOK, '文风', '条目', '样章')
    const before = existsSync(itemDir) ? readdirSync(itemDir).length : 0
    // samples 401 条（> 400）+ quotes 401 条——两数组各自超限都拒
    const items = Array.from({ length: 401 }, (_, i) => ({
      场景: '对话',
      正文: `「样本${i}。」`,
      出处: `《收割测试书》第 ${i + 1} 章`,
    }))
    for (const body of [{ samples: items, quotes: [] }, { samples: [], quotes: items }]) {
      const r = await fetch(`${studio.baseUrl}/api/books/${encodeURIComponent(BOOK)}/learn-commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Studio-Token': studio.token },
        body: JSON.stringify(body),
      })
      expect(r.status).toBe(422)
      const d = (await r.json()) as { code?: string; error?: string }
      expect(d.code).toBe('TOO_MANY_ITEMS')
      expect(d.error).toContain('400')
    }
    // 零入库：目录条目数与请求前一致（超限在过滤/commit 前早拒）
    const after = existsSync(itemDir) ? readdirSync(itemDir).length : 0
    expect(after).toBe(before)
  })
})
