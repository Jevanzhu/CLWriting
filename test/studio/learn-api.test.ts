/**
 * learn 文风收割端点测（#8.3）：候选入库胶水 + 边界。
 *
 * - POST /learn 无定稿正文 → 400（learnFromBook 返 ok:false）
 * - POST /learn-commit mock 候选 → 入库 文风/样章库/<场景>/（commitSamples 胶水）
 *
 * 复用 api-integration 的 fixture 模式（长篇书）。commitSamples/learnFromBook 内核已测，此处只验端点胶水。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

const BOOK = '收割测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-learn-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 收割测试书\n  genre: 玄幻\nhost: cc\n')

  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const bootR = await fetch(`${baseUrl}/api/boot`)
  token = ((await bootR.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('learn 文风收割端点（#8.3）', () => {
  it('POST /learn 无定稿正文 → 400', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/learn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
    })
    expect(r.status).toBe(400)
    const d = (await r.json()) as { error?: string }
    expect(d.error).toMatch(/没有定稿正文/)
  })

  it('POST /learn-commit mock 样章候选 → 入库 文风/样章库/对话/', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/learn-commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
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
    // 入库文件 文风/样章库/对话/对话-001.md
    expect(existsSync(join(workDir, BOOK, '文风', '样章库', '对话', '对话-001.md'))).toBe(true)
  })

  it('POST /learn-commit 无 token → 403', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/learn-commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ samples: [], quotes: [] }),
    })
    expect(r.status).toBe(403)
  })
})
