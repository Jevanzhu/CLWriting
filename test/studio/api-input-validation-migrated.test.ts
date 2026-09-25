/**
 * R0916-7-P3-13 迁移点表驱动回归：style / files / books / snapshots 四处「handler 内联
 * readJson + as 断言」的端点迁到 gate（前置门）+ parse（body 校验）后的行为锚。
 *
 * 每行两组：非法体 → 400 且文案指字段；合法体 → 照常（旧状态码 / 响应体形状不变）。
 * 另附「前置门优先」行：迁移刻意保住的既有错误优先级（找书 404 / 白名单 BAD_PATH /
 * 版本 404 仍先于 body 400）——这些行是 gate 存在理由的可执行说明。
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

const BOOK = '迁移校验书'
const CHAPTER = '写作/正文/0001-开篇.md'

let studio: StudioHarness
const bp = (suffix: string, book = BOOK): string => `/api/books/${encodeURIComponent(book)}${suffix}`

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-p313-migrated-',
    dirs: ['大纲', '设定', '文风/条目', '写作/正文', '项目'],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 迁移校验书\n  genre: 玄幻\nhost: cc\n',
    files: [
      { rel: '大纲/总纲.md', content: '# 总纲\n原始内容' },
      {
        rel: '项目/文档清单.jsonl',
        content:
          [
            '{"version":1,"type":"header"}',
            `{"id":"doc_1","nodeType":"document","path":"${CHAPTER}","parentId":null,"status":"draft"}`,
          ].join('\n') + '\n',
      },
    ],
  })
})

afterAll(() => studio.close())

describe('P3-13 ③-1 建书 POST /api/books（name 校验随 parse 前置）', () => {
  it('name 缺失/空白 → 400「书名不能为空」', async () => {
    const r = await studio.req('POST', '/api/books', { name: '   ' })
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ code: 'BAD_INPUT', error: '书名不能为空' })
  })

  it('name 含路径穿越 → 400 且码仍为 BAD_PATH（HttpError 透传码，不压成 BAD_INPUT）', async () => {
    const r = await studio.req('POST', '/api/books', { name: '../evil' })
    expect(r.status).toBe(400)
    expect((r.json as { code: string }).code).toBe('BAD_PATH')
  })

  it('合法体照常 → 200（kind 缺省 long，响应形状不变）', async () => {
    const r = await studio.req('POST', '/api/books', { name: '表驱动新书', genre: '科幻' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ name: '表驱动新书', kind: 'long', path: '长篇/表驱动新书' })
  })
})

describe('P3-13 ③-2 写全文 PUT /api/books/:name/file（content 必填随 parse）', () => {
  const filePath = (rel: string): string => bp(`/file?file=${encodeURIComponent(rel)}`)

  it('缺 content（含空对象体）→ 400「缺少 content」', async () => {
    const r = await studio.req('PUT', filePath('大纲/总纲.md'), {})
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ code: 'BAD_INPUT', error: '缺少 content' })
  })

  it('content 类型错（数字）→ 400 同一文案', async () => {
    const r = await studio.req('PUT', filePath('大纲/总纲.md'), { content: 42 })
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ code: 'BAD_INPUT', error: '缺少 content' })
  })

  it('合法体照常 → 200 + 新指纹，内容落盘', async () => {
    const r = await studio.req('PUT', filePath('大纲/总纲.md'), { content: '# 总纲\n表驱动写入' })
    expect(r.status).toBe(200)
    expect(String((r.json as { revision: string }).revision)).toMatch(/^sha256:/)
    expect(readFileSync(join(studio.bookRoot, '大纲', '总纲.md'), 'utf-8')).toContain('表驱动写入')
  })

  it('前置门优先：白名单外路径（正文）即便体合法 → 400 BAD_PATH（gate 先于 parse）', async () => {
    const r = await studio.req('PUT', filePath(CHAPTER), { content: '# 篡改' })
    expect(r.status).toBe(400)
    expect((r.json as { code: string }).code).toBe('BAD_PATH')
    expect(String((r.json as { error: string }).error)).toContain('正文请走文档保存协议')
  })

  it('前置门优先：非法体 + 白名单外路径 → 仍是 400 BAD_PATH（不因体非法改判）', async () => {
    const r = await studio.req('PUT', filePath(CHAPTER), {})
    expect(r.status).toBe(400)
    expect((r.json as { code: string }).code).toBe('BAD_PATH')
  })
})

describe('P3-13 ③-3 文风四端点（body 形状与目录守卫随 parse）', () => {
  it('前置门优先：不存在的书 + 非法体 → 404（找书仍先于 body 400）', async () => {
    const r = await studio.req('POST', bp('/style/entries', '不存在的书'), { 类型: '妙笔', 正文: 'x' })
    expect(r.status).toBe(404)
  })

  it('entries.post 类型非法 → 400 文案指类型', async () => {
    const r = await studio.req('POST', bp('/style/entries'), { 类型: '妙笔', 正文: 'x' })
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ code: 'BAD_INPUT', error: '类型须为 样章/手法/反例/禁词' })
  })

  it('entries.post 正文空白 → 400「正文为空」', async () => {
    const r = await studio.req('POST', bp('/style/entries'), { 类型: '手法', 正文: '   ' })
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ code: 'BAD_INPUT', error: '正文为空' })
  })

  it('entries.post 合法体照常 → 200 + 条目落盘（缺省场景归「通用」）', async () => {
    const r = await studio.req('POST', bp('/style/entries'), { 类型: '手法', 正文: '对话不用提示语' })
    expect(r.status).toBe(200)
    expect((r.json as { path: string }).path).toBe('文风/条目/手法/通用-001.md')
  })

  it('entries.delete 穿越路径 → 400 文案指 path（守卫随 parse）', async () => {
    const r = await studio.req('DELETE', bp('/style/entries'), { path: '文风/条目/../../book.yaml' })
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ code: 'BAD_INPUT', error: 'path 须在 文风/条目/ 内' })
  })

  it('entries.delete 缺 path → 400 同一文案', async () => {
    const r = await studio.req('DELETE', bp('/style/entries'), {})
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ code: 'BAD_INPUT', error: 'path 须在 文风/条目/ 内' })
  })

  it('entries.delete 合法体照常 → 200（幂等删：目标不存在不报错）', async () => {
    const r = await studio.req('DELETE', bp('/style/entries'), { path: '文风/条目/手法/不存在-001.md' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true })
  })

  it('candidates.confirm 目录外路径 → 400 文案指 path；合法体走到业务 404（候选不存在）', async () => {
    const bad = await studio.req('POST', bp('/style/candidates/confirm'), { path: '文风/条目/样章/通用-001.md' })
    expect(bad.status).toBe(400)
    expect(bad.json).toEqual({ code: 'BAD_INPUT', error: 'path 须在 文风/候选/ 内' })

    const ok = await studio.req('POST', bp('/style/candidates/confirm'), { path: '文风/候选/不存在.md' })
    expect(ok.status).toBe(404)
    expect(ok.json).toEqual({ code: 'NOT_FOUND', error: '候选不存在或已损坏' })
  })

  it('candidates.ignore 同两格（守卫与业务失败形状一致）', async () => {
    const bad = await studio.req('POST', bp('/style/candidates/ignore'), { path: '文风/条目/样章/通用-001.md' })
    expect(bad.status).toBe(400)
    expect(bad.json).toEqual({ code: 'BAD_INPUT', error: 'path 须在 文风/候选/ 内' })

    const ok = await studio.req('POST', bp('/style/candidates/ignore'), { path: '文风/候选/不存在.md' })
    expect(ok.status).toBe(404)
    expect(ok.json).toEqual({ code: 'NOT_FOUND', error: '候选不存在或已损坏' })
  })
})

describe('P3-13 ③-4 快照恢复 POST .../snapshots/:id/restore（expectedRevision 必填随 parse）', () => {
  /** 存一版正文（首次 expectedRevision=null = 建档语义），回响应体 */
  async function save(content: string, expectedRevision: string | null): Promise<{ revision: string }> {
    const r = await studio.req('PUT', bp('/documents/doc_1/content'), {
      content,
      expectedRevision,
      operationId: `p313-${content}`,
      origin: 'manual',
    })
    expect(r.status).toBe(200)
    return r.json as { revision: string }
  }

  it('前置门优先：未登记 docId + 非法体 → 404（找文档仍先于 body 400）', async () => {
    const r = await studio.req('POST', bp('/documents/doc_unknown/snapshots/0000000000ZZZZZZZZZZZZZZZZ/restore'), {})
    expect(r.status).toBe(404)
  })

  it('前置门优先：版本不存在 + 非法体 → 404「版本不存在」（版本门先于 body 400）', async () => {
    const r = await studio.req('POST', bp('/documents/doc_1/snapshots/0000000000ZZZZZZZZZZZZZZZZ/restore'), {})
    expect(r.status).toBe(404)
    expect(r.json).toEqual({ code: 'NOT_FOUND', error: '版本不存在' })
  })

  it('缺 expectedRevision → 400；类型错 → 400 同一文案', async () => {
    const v1 = await save('第一版正文', null)
    const v2 = await save('第二版正文', v1.revision)
    const list = await studio.req('GET', bp('/documents/doc_1/snapshots'))
    const id = (list.json as { entries: { id: string }[] }).entries[0]!.id

    for (const body of [{}, { expectedRevision: 42 }]) {
      const r = await studio.req('POST', bp(`/documents/doc_1/snapshots/${id}/restore`), body)
      expect(r.status).toBe(400)
      expect(r.json).toEqual({ code: 'BAD_INPUT', error: 'expectedRevision 必填' })
    }

    // 合法体照常 → 200，正文回到该快照版
    const ok = await studio.req('POST', bp(`/documents/doc_1/snapshots/${id}/restore`), {
      expectedRevision: v2.revision,
    })
    expect(ok.status).toBe(200)
    expect((ok.json as { ok: boolean }).ok).toBe(true)
    expect(readFileSync(join(studio.bookRoot, CHAPTER), 'utf-8')).toBe('第一版正文')
  })
})
