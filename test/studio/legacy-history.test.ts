/**
 * legacy 文档历史回归测（方案 A）：
 * 旧书文件无清单登记 → 前端以 legacyId(path) 为 docId。
 * 验证：① 历史端点不再 404（service.resolvePath → adoptLegacyDoc 兜底）；
 *      ② 保存走正常 service.save 并产生修改前快照；③ adopt 落盘进 manifest。
 * 这是「文档ID未登记：legacy:xxx」错误的复现/回归保护。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { legacyId } from '../../src/document/stable-id.js'
import { computeRevision } from '../../src/document/revision.js'

const BOOK = 'legacy历史测试书'
/** 磁盘上的旧文件路径（v2 结构：写作/正文/；模拟稳定 ID 上线前就存在的文件）。 */
const LEGACY_CHAPTER = '写作/正文/0099-旧章.md'
/** 前端运行期为该旧文件算的临时 docId：legacy:<sha256(path)[:16]>。 */
const DOCID = legacyId(LEGACY_CHAPTER)

let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = body === undefined ? '' : JSON.stringify(body)
    const headers: Record<string, string> = { origin: baseUrl, 'x-studio-token': token }
    if (payload) headers['content-type'] = 'application/json'
    const req = http.request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c.toString('utf-8')))
      res.on('end', () => {
        let json: unknown = null
        try {
          json = JSON.parse(data)
        } catch {
          /* 非 JSON 响应留 null */
        }
        resolve({ status: res.statusCode ?? 0, json })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const api = (p: string) => `/api/books/${encodeURIComponent(BOOK)}${p}`
/** docId 含冒号，encodeURIComponent 编码为 %3A，后端 router decodeURIComponent 还原。 */
const docPath = (sub: string) => api(`/documents/${encodeURIComponent(DOCID)}${sub}`)

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-legacy-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: legacy历史测试书\n  genre: 玄幻\nhost: cc\n',
  )
  // 旧文件存在于磁盘，但清单不登记 —— legacy 场景的核心
  writeFileSync(join(bookRoot, LEGACY_CHAPTER), '最初的旧内容')
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(join(bookRoot, '项目', '文档清单.jsonl'), '{"version":1,"type":"header"}\n')

  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('legacy 文档历史恢复正常（方案 A）', () => {
  it('未登记 legacy docId：历史端点不再 404（adopt 兜底）', async () => {
    const r = await request('GET', docPath('/snapshots'))
    expect(r.status).toBe(200)
    expect((r.json as { entries: unknown[] }).entries).toHaveLength(0)
  })

  it('保存 legacy 文档 → 200 + 落盘（走正常 service.save）', async () => {
    const expected = computeRevision(join(workDir, BOOK, LEGACY_CHAPTER))
    const r = await request('PUT', docPath('/content'), {
      content: '改后的新内容',
      expectedRevision: expected,
      operationId: 'op1',
      origin: 'manual',
    })
    expect(r.status).toBe(200)
    expect((r.json as { revision: string }).revision).toMatch(/^sha256:/)
    expect(readFileSync(join(workDir, BOOK, LEGACY_CHAPTER), 'utf-8')).toBe('改后的新内容')
  })

  it('保存后历史列表非空，且快照是修改前的旧内容（章修改前留底）', async () => {
    const list = await request('GET', docPath('/snapshots'))
    const entries = (list.json as { entries: { id: string; origin: string }[] }).entries
    expect(entries.length).toBeGreaterThanOrEqual(1)
    expect(entries[0]!.origin).toBe('manual')
    const snap = await request('GET', docPath(`/snapshots/${entries[0]!.id}`))
    expect((snap.json as { content: string }).content).toBe('最初的旧内容')
  })

  it('adopt 已落盘：manifest 含 legacy 条目', async () => {
    const text = readFileSync(join(workDir, BOOK, '项目', '文档清单.jsonl'), 'utf-8')
    expect(text).toContain(DOCID)
    expect(text).toContain(LEGACY_CHAPTER)
  })
})
