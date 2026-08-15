import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportBook } from '../../src/export/index.js'
import { SUBMISSION_TEMPLATES } from '../../src/metrics/short-index.js'

// ── 辅助 fixture ────────────────────────────────

/** 造一个最小长篇书库（book.yaml + 空的 写作/正文/） */
function makeLongBook(title: string): string {
  const root = mkdtempSync(join(tmpdir(), 'export-long-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'book:', `  title: ${title}`, '  genre: 玄幻'].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  return root
}

/** 写一章长篇定稿（front matter + 正文） */
function writeLongChapter(root: string, num: number, title: string, body: string): void {
  writeFileSync(
    join(root, '写作', '正文', `${num}-${title}.md`),
    `---\n章号: ${num}\n标题: ${title}\n---\n${body}`,
    'utf-8',
  )
}

// ── 剥 front matter（#36 §6 净化）─────────────────

test('exportBook: 导出产物不含 front matter', () => {
  const root = makeLongBook('剥fm测试')
  writeLongChapter(root, 1, '北境的雪', '雪落在了城墙上。')
  try {
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(true)
    const merged = readFileSync(join(root, '工作区', '导出', '全本-剥fm测试.md'), 'utf-8')
    // front matter 被剥干净
    expect(merged).not.toContain('---')
    expect(merged).not.toContain('章号')
    // 标题 + 正文保留
    expect(merged).toContain('# 北境的雪')
    expect(merged).toContain('雪落在了城墙上')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── #% 批注行过滤（W0 §6 过渡期，导出不泄漏批注）────

test('exportBook: #% 批注行被过滤', () => {
  const root = makeLongBook('批注过滤')
  writeLongChapter(root, 1, '批注测试', '#% 这是作者批注\n正文内容\n#% 又一条批注')
  try {
    exportBook({ bookRoot: root, format: 'merged' })
    const merged = readFileSync(join(root, '工作区', '导出', '全本-批注过滤.md'), 'utf-8')
    expect(merged).not.toContain('#%')
    expect(merged).not.toContain('作者批注')
    expect(merged).toContain('正文内容')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 长篇正常导出（多章 + both 形态）──────────────

test('exportBook: 长篇多章 both 导出（merged + split）', () => {
  const root = makeLongBook('多章书')
  // 故意倒序写入，验证按章号数值排序（非文件名序）
  writeLongChapter(root, 2, '第二章', '第二章正文。')
  writeLongChapter(root, 1, '第一章', '第一章正文。')
  try {
    const r = exportBook({ bookRoot: root, format: 'both' })
    expect(r.ok).toBe(true)
    expect(r.chapterCount).toBe(2)
    expect(r.unit).toBe('章')

    // merged：含两章、按章号排序、章间 --- 分隔
    const merged = readFileSync(join(root, '工作区', '导出', '全本-多章书.md'), 'utf-8')
    expect(merged).toContain('# 第一章')
    expect(merged).toContain('# 第二章')
    expect(merged.indexOf('第一章')).toBeLessThan(merged.indexOf('第二章'))
    expect(merged).toContain('---') // 章间分隔线

    // split：按章号数值排序 + 3 位补零文件名（长短统一）
    expect(r.files.some((f) => f.includes('分章/001-第一章.md'))).toBe(true)
    expect(r.files.some((f) => f.includes('分章/002-第二章.md'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 短篇分支（kind: short）──────────────────────

test('exportBook: 短篇分支产全本 + 分章 + 投稿视图', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-short-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'kind: short', '', 'book:', '  title: 短篇集', '  genre: 悬疑'].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(root, '写作', '正文', '1-雪夜.md'),
    '---\n章号: 1\n标题: 雪夜\n---\n雪夜的正文。',
    'utf-8',
  )
  try {
    const r = exportBook({ bookRoot: root, format: 'both' })
    expect(r.ok).toBe(true)
    expect(r.unit).toBe('章')
    expect(r.chapterCount).toBe(1)
    // 短篇必出投稿视图
    expect(r.files.some((f) => f.includes('投稿视图-短篇集.md'))).toBe(true)
    // merged 文件名为「全本-」前缀
    expect(r.files.some((f) => f.includes('全本-短篇集.md'))).toBe(true)
    // split 目录为「分章」+ 3 位补零
    expect(r.files.some((f) => f.includes('分章/001-雪夜.md'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 平台配置化（P2-PROD-5）────────────────────────

test('exportBook: 新平台只需注册模板表即生效（配置化，无需改导出代码）', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-platform-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'kind: short', '', 'book:', '  title: 平台书', '  genre: 悬疑'].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '1-雪夜.md'), '---\n章号: 1\n标题: 雪夜\n---\n雪夜的正文。', 'utf-8')
  // 注册一个新平台（模拟新增平台只需加模板表一项）
  const custom = { platform: 'custom', label: '自定义平台', titleStyle: '自定义标题风格', introLength: '99-199 字', sellingPoints: ['自定义卖点'] }
  SUBMISSION_TEMPLATES.custom = custom
  try {
    const r = exportBook({ bookRoot: root, format: 'merged', platform: 'custom' })
    expect(r.ok).toBe(true)
    const view = readFileSync(join(root, '工作区', '导出', '投稿视图-平台书-自定义平台.md'), 'utf-8')
    expect(view).toContain('自定义标题风格')
    expect(view).toContain('99-199 字')
    expect(view).toContain('自定义卖点')
  } finally {
    delete SUBMISSION_TEMPLATES.custom // 清理，不污染其他用例
    rmSync(root, { recursive: true, force: true })
  }
})

test('exportBook: 未知平台 fallback generic（不崩溃）', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-unkplat-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'kind: short', '', 'book:', '  title: 未知平台书', '  genre: 悬疑'].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '1-雪夜.md'), '---\n章号: 1\n标题: 雪夜\n---\n雪夜的正文。', 'utf-8')
  try {
    const r = exportBook({ bookRoot: root, format: 'merged', platform: 'not-exist' })
    expect(r.ok).toBe(true)
    const view = readFileSync(join(root, '工作区', '导出', '投稿视图-未知平台书.md'), 'utf-8')
    expect(view).toContain('平台模板：通用') // generic fallback
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 空正文边界 ──────────────────────────────────

test('exportBook: 无定稿目录 → ok:false', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-nodir-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'book:', '  title: 空书'].join('\n'),
    'utf-8',
  )
  try {
    const r = exportBook({ bookRoot: root })
    expect(r.ok).toBe(false)
    expect(r.chapterCount).toBe(0)
    expect(typeof r.error).toBe('string')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exportBook: 定稿目录存在但无章节文件 → ok:false', () => {
  const root = makeLongBook('空目录书')
  try {
    const r = exportBook({ bookRoot: root })
    expect(r.ok).toBe(false)
    expect(r.chapterCount).toBe(0)
    expect(typeof r.error).toBe('string')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 路径穿越净化（K1）──────────────────────────────

test('exportBook: 书名含路径分隔符 → 文件名净化不越出导出目录', () => {
  // bookTitle 来自 book.yaml（不可信），含 ../ 时须净化，防 join 后上跳到导出目录外
  const root = makeLongBook('../evil')
  writeLongChapter(root, 1, '安全标题', '正文内容。')
  try {
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(true)
    // 路径分隔符被替换为 _，文件路径不含 ../ 穿越
    expect(r.files.every((f) => !f.includes('../'))).toBe(true)
    // 净化后文件确实落在导出目录内（../evil → .._evil）
    const merged = readFileSync(join(root, '工作区', '导出', '全本-.._evil.md'), 'utf-8')
    expect(merged).toContain('安全标题')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── V-P2-2：导出滤未定稿（「导出定稿正文」名要符实）──────────────────

import { readManifest, writeManifest } from '../../src/document/manifest.js'
import type { ManifestEntry } from '../../src/document/manifest.js'

/** 在书库写文档清单（含可选定稿基线）。entry.path 为书仓库相对路径。 */
function writeManifestFile(root: string, entries: ManifestEntry[]): void {
  const m = readManifest(join(root, '项目', '文档清单.jsonl')) // 无文件 → 默认骨架
  for (const e of entries) m.entries.set(e.id, e)
  mkdirSync(join(root, '项目'), { recursive: true })
  writeManifest(join(root, '项目', '文档清单.jsonl'), m)
}

function finalizedEntry(id: string, path: string): ManifestEntry {
  return { id, nodeType: 'document', path, parentId: null, finalizedRevision: 'sha256:fin-' + id }
}

test('exportBook: 未定稿章被滤出导出（V-P2-2），skippedDrafts 计数', () => {
  const root = makeLongBook('滤草稿')
  writeLongChapter(root, 1, '已定稿章', '定稿内容。')
  writeLongChapter(root, 2, '未定稿章', '还在写的半成品。')
  writeManifestFile(root, [
    finalizedEntry('doc_1', '写作/正文/1-已定稿章.md'),
    { id: 'doc_2', nodeType: 'document', path: '写作/正文/2-未定稿章.md', parentId: null },
  ])
  try {
    const r = exportBook({ bookRoot: root, format: 'both' })
    expect(r.ok).toBe(true)
    expect(r.chapterCount).toBe(1)
    expect(r.skippedDrafts).toBe(1)
    const merged = readFileSync(join(root, '工作区', '导出', '全本-滤草稿.md'), 'utf-8')
    expect(merged).toContain('定稿内容')
    expect(merged).not.toContain('半成品')
    expect(r.files.some((f) => f.includes('分章/002-'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exportBook: 全部未定稿 → ok:false + 人话提示', () => {
  const root = makeLongBook('全草稿')
  writeLongChapter(root, 1, '草稿章', '内容。')
  writeManifestFile(root, [{ id: 'doc_1', nodeType: 'document', path: '写作/正文/1-草稿章.md', parentId: null }])
  try {
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未定稿')
    expect(r.skippedDrafts).toBe(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exportBook: 短篇投稿视图同口径滤未定稿', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-shortfin-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'kind: short', '', 'book:', '  title: 短篇滤稿', '  genre: 悬疑'].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '1-成品.md'), '---\n章号: 1\n标题: 成品\n---\n成品正文内容足够长。', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '2-草稿.md'), '---\n章号: 2\n标题: 草稿\n---\n草稿正文内容足够长。', 'utf-8')
  writeManifestFile(root, [finalizedEntry('doc_s1', '写作/正文/1-成品.md')])
  try {
    const r = exportBook({ bookRoot: root, format: 'both' })
    expect(r.ok).toBe(true)
    expect(r.chapterCount).toBe(1)
    const view = readFileSync(join(root, '工作区', '导出', '投稿视图-短篇滤稿.md'), 'utf-8')
    expect(view).toContain('成品')
    expect(view).not.toContain('| 002 |')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── X-P2-4：超长文件名截断 + 单章级问题降级为警告 ──

test('X-P2-4: 超长章标题文件名截断（80 码位封顶），不再因文件名过长写失败', () => {
  const root = makeLongBook('长标题书')
  const longTitle = '长'.repeat(120)
  writeLongChapter(root, 1, longTitle, '正文。')
  try {
    const r = exportBook({ bookRoot: root, format: 'split' })
    expect(r.ok).toBe(true)
    const names = readdirSync(join(root, '工作区', '导出', '分章'))
    expect(names).toHaveLength(1)
    // `001-` + 标题截 80 码位 + `.md`
    expect(Array.from(names[0]!).length).toBe('001-'.length + 80 + '.md'.length)
    // 只有文件名截，内容里标题完整
    const body = readFileSync(join(root, '工作区', '导出', '分章', names[0]!), 'utf-8')
    expect(body.startsWith(`# ${longTitle}`)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('X-P2-4: 个别坏章（解析失败）跳过并记警告，不再拖垮整本导出', () => {
  const root = makeLongBook('坏章降级')
  writeLongChapter(root, 1, '好章', '好章正文。')
  // 无 front matter 的残留草稿 → readChapterDir 解析失败
  writeFileSync(join(root, '写作', '正文', '0002-坏章.md'), '没有 front matter 的草稿文件。', 'utf-8')
  try {
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(true)
    expect(r.chapterCount).toBe(1)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings![0]).toContain('0002-坏章.md')
    const merged = readFileSync(join(root, '工作区', '导出', '全本-坏章降级.md'), 'utf-8')
    expect(merged).toContain('好章正文。')
    expect(merged).not.toContain('草稿文件')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('X-P2-4: 正文为空的单章跳过（警告），其余照常导出', () => {
  const root = makeLongBook('空章降级')
  writeLongChapter(root, 1, '有肉', '有正文的章。')
  writeFileSync(join(root, '写作', '正文', '2-空章.md'), '---\n章号: 2\n标题: 空章\n---\n', 'utf-8')
  try {
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(true)
    expect(r.chapterCount).toBe(1)
    expect(r.warnings![0]).toContain('2-空章.md')
    expect(r.warnings![0]).toContain('正文为空')
    const merged = readFileSync(join(root, '工作区', '导出', '全本-空章降级.md'), 'utf-8')
    expect(merged).toContain('有正文的章。')
    expect(merged).not.toContain('空章')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('X-P2-4: 全部章解析失败 → 整体失败并列出问题文件', () => {
  const root = makeLongBook('全坏')
  writeFileSync(join(root, '写作', '正文', '0001-坏.md'), '没有 front matter。', 'utf-8')
  try {
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('章解析失败')
    expect(r.error).toContain('0001-坏.md')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
