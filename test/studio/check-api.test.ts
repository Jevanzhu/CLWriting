/**
 * POST /api/books/:name/documents/:docId/check 机检端点集成测（M12 块3 B3.1）。
 * 验证：正文文档 → 200 + CheckReport；非章节文档 → NOT_CHAPTER；未登记 docId → NOT_FOUND。
 */
import http from 'node:http'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { generateDocId } from '../../src/document/stable-id.js'

const BOOK = '机检测试书'
let studio: StudioHarness
let chapterDocId = ''
let nonChapterDocId = ''

function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(studio.baseUrl)
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: 'POST',
        headers: {
          'x-studio-token': studio.token,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
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
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

beforeAll(async () => {
  // manifest 登记 docId——须经 files 选项随起服前置盘：启动迁移会把未定稿书的
  // 定稿/ 文件按清单挪回 写作/ 并改写清单路径（起服后再写清单拿不到迁移）
  chapterDocId = generateDocId()
  nonChapterDocId = generateDocId()
  const manifest =
    '{"version":1,"type":"header"}\n' +
    JSON.stringify({ id: chapterDocId, nodeType: 'document', path: '定稿/正文/0001-开篇.md', parentId: null }) +
    '\n' +
    JSON.stringify({ id: nonChapterDocId, nodeType: 'document', path: '定稿/设定/角色.md', parentId: null }) +
    '\n'
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-check-api-',
    dirs: ['定稿/正文', '定稿/设定', '大纲/悬念', '项目'],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 机检测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    files: [
      // 正文文档（完整章节 fm）
      {
        rel: '定稿/正文/0001-开篇.md',
        content: '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n这是正文内容，主角登场。\n',
      },
      // 非章节文档（设定，fm 无章号/钩子字段）
      { rel: '定稿/设定/角色.md', content: '---\n标题: 角色\n---\n\n主角信息。\n' },
      { rel: '项目/文档清单.jsonl', content: manifest },
    ],
  })
})

afterAll(() => studio.close())

describe('POST /documents/:docId/check 机检（M12 块3 B3.1）', () => {
  it('正文文档 → 200 + CheckReport（含 sections）', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${chapterDocId}/check`, {})
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; report: { sections: unknown[] }; hasRed: boolean }
    expect(j.ok).toBe(true)
    expect(Array.isArray(j.report.sections)).toBe(true)
    expect(j.report.sections.length).toBeGreaterThan(0)
    // hasRed 是布尔（无论红黄）
    expect(typeof j.hasRed).toBe('boolean')
  })

  it('非章节文档（设定，fm 无章号/钩子）→ 400 NOT_CHAPTER', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${nonChapterDocId}/check`, {})
    expect(r.status).toBe(400)
    // N-2（第十二轮）：机检错误信封收编 replyError——{code,error} 无 ok 冗余位
    const j = r.json as { code: string }
    expect(j).not.toHaveProperty('ok')
    expect(j.code).toBe('NOT_CHAPTER')
  })

  it('未登记 docId → 404 NOT_FOUND', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/doc_${'0'.repeat(26)}/check`, {})
    expect(r.status).toBe(404)
    const j = r.json as { ok: boolean; code: string }
    expect(j.code).toBe('NOT_FOUND')
  })
})
