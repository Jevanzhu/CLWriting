/**
 * GET /api/books/:name/tree-issues 树红点聚合端点测（T9b）。
 * 验证两源聚合：机检 red（fm 章号不匹配）+ verdict 驳回；verdict 通过不计入。
 * rebuild 一次循环 checkWithDb 的正确性在此一并覆盖（runCheckForDocument 重构零回归）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { writeAnalysis } from '../../src/document/analysis.js'

const BOOK = '树红点测试书'
let workDir = ''
let bookRoot = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let redDocId = '' // 0001：fm 章号 99 ≠ 文件名 0001 → 机检 red
let verdictDocId = '' // 0002：fm 干净，靠 verdict 驳回/通过切换
const prevDriver = process.env['CLWRITING_DRIVER']

function get(path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: 'GET',
        headers: { 'x-studio-token': token },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-tree-issues-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '定稿', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  // leads.enabled: [] 关闭账本/成长线长程项，隔离出禁词 red 这一确定红源
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 树红点测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\nbudget:\n  calls_per_chapter: 8\n',
    'utf8',
  )
  // 文风铁律硬禁词「玉佩」→ 0001 正文命中即 red
  //（fm 章号 mismatch 走不通：fileName 从 chapter 派生，checkFrontMatter 永不触发）
  mkdirSync(join(bookRoot, '文风'), { recursive: true })
  writeFileSync(join(bookRoot, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n', 'utf8')
  // 0001：正文含禁词「玉佩」→ checkBannedWords 报 banned-word（红）
  writeFileSync(
    join(bookRoot, '定稿', '正文', '0001-红章.md'),
    '---\n章号: 1\n标题: 红章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n主角登场，玉佩发光。\n',
    'utf8',
  )
  // 0002：fm 干净（章号 2 == 文件名 0002），无机检 red
  writeFileSync(
    join(bookRoot, '定稿', '正文', '0002-净章.md'),
    '---\n章号: 2\n标题: 净章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n宗门震动，长老惊叹。\n',
    'utf8',
  )
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  redDocId = generateDocId()
  verdictDocId = generateDocId()
  upsertEntry(m, { id: redDocId, nodeType: 'document', path: '定稿/正文/0001-红章.md', parentId: null })
  upsertEntry(m, { id: verdictDocId, nodeType: 'document', path: '定稿/正文/0002-净章.md', parentId: null })
  writeManifest(manifestPath, m)

  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (prevDriver === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = prevDriver
})

describe('GET /tree-issues 树红点聚合（T9b）', () => {
  it('机检 red + verdict 驳回 两源聚合到 issues', async () => {
    // 0002 落 verdict 驳回信封（作者裁决，model='author'）
    writeAnalysis(bookRoot, verdictDocId, 'review', {
      generatedAt: '2026-07-26T00:00:00Z',
      model: 'author',
      sourceHash: 'sha256:' + '0'.repeat(64),
      payload: { verdict: { approved: false, at: '2026-07-26T00:00:00Z' } },
    })

    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/tree-issues`)
    expect(r.status).toBe(200)
    const j = r.json as {
      ok: boolean
      issues: Record<string, { hasRed: boolean; verdictRejected: boolean }>
    }
    expect(j.ok).toBe(true)
    // 0001：fm 章 99 ≠ 文件名 0001 → hasRed=true
    expect(j.issues[redDocId]).toBeDefined()
    expect(j.issues[redDocId]!.hasRed).toBe(true)
    expect(j.issues[redDocId]!.verdictRejected).toBe(false)
    // 0002：fm 干净 hasRed=false，verdict 驳回 verdictRejected=true
    expect(j.issues[verdictDocId]).toBeDefined()
    expect(j.issues[verdictDocId]!.hasRed).toBe(false)
    expect(j.issues[verdictDocId]!.verdictRejected).toBe(true)
  })

  it('verdict 通过（approved）不计入 issues', async () => {
    // 0002 改 verdict 为通过
    writeAnalysis(bookRoot, verdictDocId, 'review', {
      generatedAt: '2026-07-26T00:00:00Z',
      model: 'author',
      sourceHash: 'sha256:' + '0'.repeat(64),
      payload: { verdict: { approved: true, at: '2026-07-26T00:00:00Z' } },
    })
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/tree-issues`)
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; issues: Record<string, unknown> }
    // 0002 fm 干净 + verdict 通过 → 不入 issues（仅 hasRed 或 verdictRejected 才入）
    expect(j.issues[verdictDocId]).toBeUndefined()
    // 0001 仍 fm red（不受 verdict 影响）
    expect(j.issues[redDocId]).toBeDefined()
  })
})
