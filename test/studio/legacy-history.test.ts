/**
 * legacy 文档历史回归测（方案 A）：
 * 旧书文件无清单登记 → 前端以 legacyId(path) 为 docId。
 * 验证：① 历史端点不再 404（service.resolvePath → adoptLegacyDoc 兜底）；
 *      ② 保存走正常 service.save 并产生修改前快照；③ adopt 落盘进 manifest。
 * 这是「文档ID未登记：legacy:xxx」错误的复现/回归保护。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio；request 走 node:http 形态
 * 保留本地，改绑 studio.baseUrl/studio.token。
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { legacyId } from '../../src/document/stable-id.js'
import { computeRevision } from '../../src/document/revision.js'

const BOOK = 'legacy历史测试书'
/** 磁盘上的旧文件路径（v2 结构：写作/正文/；模拟稳定 ID 上线前就存在的文件）。 */
const LEGACY_CHAPTER = '写作/正文/0099-旧章.md'
/** 前端运行期为该旧文件算的临时 docId：legacy:<sha256(path)[:16]>。 */
const DOCID = legacyId(LEGACY_CHAPTER)

let studio: StudioHarness
let workDir = ''

function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(studio.baseUrl)
    const payload = body === undefined ? '' : JSON.stringify(body)
    const headers: Record<string, string> = { origin: studio.baseUrl, 'x-studio-token': studio.token }
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
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-legacy-',
    dirs: ['写作/正文', '项目'],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: legacy历史测试书\n  genre: 玄幻\nhost: cc\n',
    files: [
      // 旧文件存在于磁盘，但清单不登记 —— legacy 场景的核心
      { rel: LEGACY_CHAPTER, content: '最初的旧内容' },
      { rel: '项目/文档清单.jsonl', content: '{"version":1,"type":"header"}\n' },
    ],
  })
  workDir = studio.workDir
})

afterAll(() => studio.close())

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
