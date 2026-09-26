/**
 * 阶段 24 章节结构操作批 B / S3：saveDraft 结构键保形回补（draft-pipeline.ts 路径②）
 * 端点级回归。
 *
 * draft-save 是「AI 产出强覆盖」通道——组装方可能不带 序/并入，saveDraft 锁内写盘前
 * preserveStructureFmIn 对盘上既有键回补，防结构键在强覆盖时静默丢失（self-heal 组装
 * 侧另有显式透传，两道共保）。incoming 已显式含键则不覆写（显式产出优先）。
 * 范式同 draft-save-drain-chaining.test.ts（bootStudio + 本地 postDraft fetch 包装）。
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { splitFrontMatter, parseFlat } from '../../src/format/frontmatter.js'

const BOOK = '保形回补书'
let studio: StudioHarness

function postDraft(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return fetch(`${studio.baseUrl}/api/books/${encodeURIComponent(BOOK)}/draft-save`, {
    method: 'POST',
    headers: { 'x-studio-token': studio.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }))
}

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-struct-fm-draft-',
    dirs: ['写作/正文/第一卷', '工作区'],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: 保形回补书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
  })
})

afterAll(() => studio.close())

/** 预置第 2 章（fm 含结构键，供强覆盖回补；resolveDraftPath 按 fm 章号定位命中） */
const CH2 = '写作/正文/第一卷/0002-第2章.md'
function seedChapter2(): void {
  writeFileSync(join(studio.bookRoot, CH2), '---\n章号: 2\n标题: 第2章\n序: 7\n并入: [5]\n---\n第2章旧正文。\n')
}

/** 断言前置：取内容 fm 的平铺键值（须有 fm） */
const fmOf = (content: string): Map<string, unknown> => {
  const split = splitFrontMatter(content)
  if (split === null) throw new Error('断言前置：落盘内容应有 front matter')
  return parseFlat(split.fmRaw)
}

describe('阶段 24 S3：draft-save 强覆盖的 序/并入 保形回补', () => {
  it('新稿 fm 不带结构键 → 200 且落盘回补 序: 7 / 并入: [5]，新稿正文在（旧正文被强覆盖）', async () => {
    seedChapter2()
    const r = await postDraft({
      chapter: 2,
      content: '---\n章号: 2\n标题: 第2章新稿\n---\nAI 重写的新稿正文。\n',
    })
    expect(r.status).toBe(200)
    expect(r.json['ok']).toBe(true)
    expect(r.json['path']).toBe(CH2) // 覆盖既有章（非新建第二份）
    const disk = readFileSync(join(studio.bookRoot, CH2), 'utf-8')
    expect(disk).toContain('序: 7')
    expect(disk).toContain('并入: [5]')
    expect(disk).toContain('AI 重写的新稿正文。')
    expect(disk).not.toContain('第2章旧正文。')
    const fm = fmOf(disk)
    expect(fm.get('序')).toBe(7)
    // parseFlat 内联数组项为 string（parseMergedInto 才归一 number[]）——此处锁盘上文本形态
    expect(fm.get('并入')).toEqual(['5'])
  })

  it('新稿自带 序: 9（与盘上 7 不同）→ 落盘保持 9（incoming 已含键不覆写），并入: [5] 仍回补', async () => {
    seedChapter2()
    const r = await postDraft({
      chapter: 2,
      content: '---\n章号: 2\n标题: 第2章新稿\n序: 9\n---\n新稿正文（显式带序）。\n',
    })
    expect(r.status).toBe(200)
    const disk = readFileSync(join(studio.bookRoot, CH2), 'utf-8')
    expect(disk).toContain('序: 9')
    expect(disk).not.toContain('序: 7')
    expect(disk).toContain('并入: [5]')
    const fm = fmOf(disk)
    expect(fm.get('序')).toBe(9)
    expect(fm.get('并入')).toEqual(['5'])
  })
})
