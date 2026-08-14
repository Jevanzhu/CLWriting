/**
 * POST /documents/batch-finalize 端点集成测（P2-PROD-2 批量定稿）。
 * 验证：批量成功（多个 revision 章一次定稿）+ 部分失败（未登记 docId 不影响其他）
 * + 空/非法 body 400。git setup 复用 finalize-api 范式。
 */
import http from 'node:http'
import { execSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

const BOOK = '批量定稿测试书'
let workDir = ''
let bookRoot = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let ch1DocId = ''
let ch2DocId = ''
let ch3DocId = ''

function postBatch(docIds: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: `/api/books/${encodeURIComponent(BOOK)}/documents/batch-finalize`,
        method: 'POST',
        headers: { 'x-studio-token': token, 'content-type': 'application/json' },
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
    req.end(JSON.stringify({ docIds }))
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-batchfin-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 批量定稿测试书\n  genre: 玄幻\nhost: cc\n',
    'utf8',
  )
  // 3 章初始 commit → final 态；随后 2/3 改脏 → revision 态供批量定稿
  for (const [no, title, body] of [
    [1, '开篇', '天脉异象惊动宗门。'],
    [2, '转折', '弟子林远踏入山门。'],
    [3, '高潮', '玉佩灵光击退妖兽。'],
  ] as const) {
    writeFileSync(
      join(bookRoot, '写作', '正文', `000${no}-${title}.md`),
      `---\n章号: ${no}\n标题: ${title}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n${body}\n`,
      'utf8',
    )
  }
  execSync('git init', { cwd: bookRoot, stdio: 'pipe' })
  execSync('git config user.email t@t.com', { cwd: bookRoot, stdio: 'pipe' })
  execSync('git config user.name t', { cwd: bookRoot, stdio: 'pipe' })
  execSync('git config commit.gpgsign false', { cwd: bookRoot, stdio: 'pipe' })
  execSync('git add -A && git commit -m "ch:0001-0003"', { cwd: bookRoot, stdio: 'pipe' })

  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  ch1DocId = generateDocId()
  ch2DocId = generateDocId()
  ch3DocId = generateDocId()
  upsertEntry(m, { id: ch1DocId, nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null })
  upsertEntry(m, { id: ch2DocId, nodeType: 'document', path: '写作/正文/0002-转折.md', parentId: null })
  upsertEntry(m, { id: ch3DocId, nodeType: 'document', path: '写作/正文/0003-高潮.md', parentId: null })
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
})

describe('POST /documents/batch-finalize（P2-PROD-2）', () => {
  it('多个 revision 章一次批量定稿成功', async () => {
    // 改脏 2/3 两章 → revision 态
    for (const [no, title, body] of [
      [2, '转折', '弟子林远踏入山门，玉佩微光。'],
      [3, '高潮', '玉佩灵光暴涨，击退妖兽，林远震惊。'],
    ] as const) {
      writeFileSync(
        join(bookRoot, '写作', '正文', `000${no}-${title}.md`),
        `---\n章号: ${no}\n标题: ${title}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n${body}\n`,
        'utf8',
      )
    }
    const r = await postBatch([ch2DocId, ch3DocId])
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; results: { docId: string; ok: boolean; status: string; skipped: boolean }[] }
    expect(j.ok).toBe(true)
    expect(j.results).toHaveLength(2)
    expect(j.results.every((x) => x.ok && x.status === 'final' && x.skipped === false)).toBe(true)
    // 两章均不再脏
    const status = execSync('git status --porcelain', { cwd: bookRoot, encoding: 'utf-8' })
    expect(status).not.toContain('0002-转折.md')
    expect(status).not.toContain('0003-高潮.md')
  })

  it('含未登记 docId → 该条失败，其余成功（部分失败不中断）', async () => {
    // 改脏 1 章
    writeFileSync(
      join(bookRoot, '写作', '正文', '0001-开篇.md'),
      '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n天脉异象惊动宗门，长老齐聚。\n',
      'utf8',
    )
    const r = await postBatch([ch1DocId, 'doc_unknown'])
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; results: { docId: string; ok: boolean; error?: string }[] }
    expect(j.results).toHaveLength(2)
    expect(j.results[0]).toMatchObject({ docId: ch1DocId, ok: true })
    expect(j.results[1]).toMatchObject({ docId: 'doc_unknown', ok: false })
    expect(typeof j.results[1]?.error).toBe('string')
  })

  it('空 docIds / 非字符串数组 → 400 BAD_INPUT', async () => {
    expect((await postBatch([])).status).toBe(400)
    expect((await postBatch('x')).status).toBe(400)
    expect((await postBatch([1])).status).toBe(400)
  })
})
