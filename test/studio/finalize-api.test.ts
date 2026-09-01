/**
 * POST /documents/:docId/finalize 端点集成测（P1 定稿）。
 * 验证路由接线 + 状态码映射：成功 200、未登记 404、非定稿区 400。
 * git setup 复用 tree-issues 范式（bookRoot 内 git init → 状态派生对齐）。
 */
import http from 'node:http'
import { execSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

const BOOK = '定稿确认测试书'
let workDir = ''
let bookRoot = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let ch1DocId = '' // 写作/正文/0001

function postFinalize(docId: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(docId)}/finalize`,
        method: 'POST',
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
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-finalize-'))
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
    'spec_version: 1\nkind: long\nbook:\n  title: 定稿确认测试书\n  genre: 玄幻\nhost: cc\n',
    'utf8',
  )
  // 0001 初始 commit → final 态；随后改脏 → revision 态供定稿
  writeFileSync(
    join(bookRoot, '写作', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n天脉异象惊动宗门。\n',
    'utf8',
  )
  execSync('git init', { cwd: bookRoot, stdio: 'pipe' })
  execSync('git config user.email t@t.com', { cwd: bookRoot, stdio: 'pipe' })
  execSync('git config user.name t', { cwd: bookRoot, stdio: 'pipe' })
  execSync('git config commit.gpgsign false', { cwd: bookRoot, stdio: 'pipe' })
  execSync('git add -A && git commit -m "ch:0001 开篇"', { cwd: bookRoot, stdio: 'pipe' })

  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  ch1DocId = generateDocId()
  upsertEntry(m, { id: ch1DocId, nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null })
  writeManifest(manifestPath, m)

  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('POST /documents/:docId/finalize（P1 定稿确认）', () => {
  it('revision 态正文 → 200 skipped:false，commit 后 git 干净', async () => {
    // 改脏 → revision 态
    writeFileSync(join(bookRoot, '写作', '正文', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n修改后的正文。\n', 'utf8')
    const r = await postFinalize(ch1DocId)
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; status: string; skipped: boolean }
    expect(j.ok).toBe(true)
    expect(j.status).toBe('final')
    expect(j.skipped).toBe(false)
    // commit 只定稿目标章：正文文件不再脏（项目/ 清单等 untracked 文件不受牵连）
    const status = execSync('git status --porcelain', { cwd: bookRoot, encoding: 'utf-8' })
    expect(status).not.toContain('0001-开篇.md')
  })

  it('已 final（git 干净）→ 200 skipped:true 幂等', async () => {
    const r = await postFinalize(ch1DocId)
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; status: string; skipped: boolean }
    expect(j.ok).toBe(true)
    expect(j.status).toBe('final')
    expect(j.skipped).toBe(true)
  })

  it('未登记 docId → 404 NOT_FOUND', async () => {
    const r = await postFinalize('doc_unknown')
    expect(r.status).toBe(404)
    expect((r.json as { code: string }).code).toBe('NOT_FOUND')
  })
})