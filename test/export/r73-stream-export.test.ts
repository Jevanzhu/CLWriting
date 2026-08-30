/**
 * R73-37（二十一轮）回归：导出分章读-写流水化。
 *
 * readChapterDir 不再 includeBody 全量驻留（极端大书 OOM 风险），正文改在写循环内
 * 逐章现读即弃。本文件验证行为等价性：
 * 1. 多章 both 导出产物与章数正确（流式单遍不丢章、不串分隔符）；
 * 2. 全部章空正文 → 零产物按失败收口 + 逐章警告（原 exportable 预滤同一信封）；
 * 3. 定稿过滤与空正文警告并存（skippedDrafts 与 writtenCount 互不污染）。
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportBook } from '../../src/export/index.js'
import { writeManifest, upsertEntry, type Manifest } from '../../src/document/manifest.js'

function makeLongBook(title: string): string {
  const root = mkdtempSync(join(tmpdir(), 'r73-export-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'book:', `  title: ${title}`, '  genre: 玄幻'].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  return root
}

function writeLongChapter(root: string, num: number, title: string, body: string): void {
  writeFileSync(
    join(root, '写作', '正文', `${num}-${title}.md`),
    `---\n章号: ${num}\n标题: ${title}\n---\n${body}`,
    'utf-8',
  )
}

function finalizeAll(root: string): void {
  const m: Manifest = { version: 1, entries: new Map() }
  let i = 0
  for (const f of readdirSync(join(root, '写作', '正文'))) {
    if (!f.endsWith('.md')) continue
    upsertEntry(m, {
      id: `doc_r73exp${i++}`,
      nodeType: 'document',
      path: `写作/正文/${f}`,
      parentId: null,
      finalizedRevision: `sha256:r73-${i}`,
      finalizedAt: '2026-08-01T00:00:00Z',
    })
  }
  mkdirSync(join(root, '项目'), { recursive: true })
  writeManifest(join(root, '项目', '文档清单.jsonl'), m)
}

test('R73-37: 多章 both 导出（流式读-写）章数/产物/分隔正确', () => {
  const root = makeLongBook('流水导出')
  for (let n = 1; n <= 5; n++) writeLongChapter(root, n, `第${n}章`, `第${n}章正文内容。`)
  try {
    const r = exportBook({ bookRoot: root, format: 'both' })
    expect(r.ok).toBe(true)
    expect(r.chapterCount).toBe(5)
    const merged = readFileSync(join(root, '工作区', '导出', '全本-流水导出.md'), 'utf-8')
    for (let n = 1; n <= 5; n++) expect(merged).toContain(`# 第${n}章`)
    // 恰好 4 个章间分隔符（跳章不产生多余分隔——readUnitBody 全命中）
    expect(merged.split('\n\n---\n\n')).toHaveLength(5)
    for (let n = 1; n <= 5; n++) {
      expect(existsSync(join(root, '工作区', '导出', '分章', `000${n}-第${n}章.md`))).toBe(true)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R73-37: 定稿过滤后全部章空正文 → 零产物失败信封 + 逐章警告', () => {
  const root = makeLongBook('全空正文')
  writeLongChapter(root, 1, '空一', '')
  writeLongChapter(root, 2, '空二', '')
  finalizeAll(root)
  try {
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(false)
    expect(r.chapterCount).toBe(0)
    // R26-53（二十六轮）：文案如实归因——各章均已定稿，病因是空正文/读取失败
    expect(r.error).toContain('正文全部为空或读取失败')
    expect(r.warnings?.filter((w) => w.includes('正文为空'))).toHaveLength(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R73-37: 定稿过滤 + 空正文章并存 → skippedDrafts 与实际产出互不污染', () => {
  const root = makeLongBook('混合导出')
  writeLongChapter(root, 1, '定稿有肉', '有肉正文。')
  writeLongChapter(root, 2, '定稿空章', '')
  finalizeAll(root) // 只登记在盘的 1、2 两章为已定稿
  // 第 3 章在清单登记后落盘（不定稿）→ skippedDrafts
  writeLongChapter(root, 3, '在写草稿', '草稿正文。')
  try {
    const r = exportBook({ bookRoot: root, format: 'split' })
    expect(r.ok).toBe(true)
    expect(r.chapterCount).toBe(1) // 只有第 1 章实际产出
    expect(r.skippedDrafts).toBe(1) // 第 3 章未定稿
    // 警告按源文件相对路径留痕（2 位源文件名，非分章产物的 4 位前缀）
    expect(r.warnings?.some((w) => w.includes('写作/正文/2-定稿空章.md') && w.includes('正文为空'))).toBe(true)
    expect(existsSync(join(root, '工作区', '导出', '分章', '0001-定稿有肉.md'))).toBe(true)
    expect(existsSync(join(root, '工作区', '导出', '分章', '0003-在写草稿.md'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// R28-16（二十八轮）：零可写章收口的报数如实口径——units.length 是正文区全部章数，
// 跳过草稿/无清单兜底时按它报「有定稿章 N 章」会虚高；有清单报定稿章数并注明跳过，
// 无清单兜底改说正文区口径
test('R28-16: 部分定稿全空 + 草稿并存 → 报定稿章数并注明跳过草稿', () => {
  const root = makeLongBook('如实口径')
  writeLongChapter(root, 1, '定稿空章', '')
  finalizeAll(root) // 只登记在盘的第 1 章为已定稿
  // 第 2、3 章在清单登记后落盘（不定稿）→ skippedDrafts=2
  writeLongChapter(root, 2, '在写草稿一', '草稿正文一。')
  writeLongChapter(root, 3, '在写草稿二', '草稿正文二。')
  try {
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(false)
    expect(r.skippedDrafts).toBe(2)
    // 修复前：units.length=3 → 误报「有定稿章 3 章」；现按定稿集如实报 1 章
    expect(r.error).toContain('有定稿章 1 章')
    expect(r.error).toContain('2 章未定稿已跳过')
    expect(r.error).toContain('正文全部为空或读取失败')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R28-16: 无定稿清单兜底 → 不再误称「有定稿章」，改报正文区口径', () => {
  const root = makeLongBook('无清单口径')
  writeLongChapter(root, 1, '空章', '')
  // 不写文档清单 → finalizedPathSet 返回 null，兜底不过滤
  try {
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('正文区 1 章')
    expect(r.error).toContain('正文全部为空或读取失败')
    expect(r.error).not.toContain('有定稿章')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
