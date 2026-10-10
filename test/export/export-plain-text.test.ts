/**
 * txt 导出（纯文本面）——口径（2026-10-10 拍板）：
 * - 净化 = 剥 Markdown 呈现层标记（行首标题/引用、行内成对标记），正文语义零改写；
 *   列表标记 / `---` 分隔线 / 表格不剥；
 * - 规范形 = UTF-8 无 BOM + LF（canonicalizeText 收口）；
 * - 落点 = `工作区/导出/纯文本/`（md 面清旧/归档按目录作用域隔断，互不动对方的稿）；
 * - 短篇投稿视图为 Markdown 策划视图，不进 txt 面。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { exportBook, type ExportOutput } from '../../src/export/index.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { computeRevision } from '../../src/document/revision.js'
import { scaffoldBook } from '../helpers/book.js'

const BOOK_YAML = 'spec_version: 1\nkind: long\nbook:\n  title: 纯文本书\n  genre: 玄幻\nhost: cc\n'

let root = ''

beforeEach(() => {
  root = scaffoldBook({ name: '纯文本书', dirs: ['写作/正文'], config: BOOK_YAML }).root
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

/** 写一章并登记定稿基线（定稿过滤生效的前提） */
const addChapter = (bookRoot: string, no: number, title: string, body: string): void => {
  const rel = `写作/正文/${String(no).padStart(4, '0')}-${title}.md`
  const abs = join(bookRoot, rel)
  writeFileSync(abs, `---\n章号: ${no}\n标题: ${title}\n钩子类型: 悬念钩\n---\n\n${body}\n`)
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  upsertEntry(m, {
    id: generateDocId(),
    nodeType: 'document',
    path: rel,
    parentId: null,
    finalizedRevision: computeRevision(abs),
    finalizedAt: new Date().toISOString(),
  })
  writeManifest(manifestPath, m)
}

const txtDir = (): string => join(root, '工作区', '导出', '纯文本')
const mergedTxt = (): string => join(txtDir(), '全本-纯文本书.txt')

describe('txt 导出 · 合并', () => {
  it('落 导出/纯文本/全本-书名.txt——无 `#` 标记、章间空段分隔、UTF-8 无 BOM + LF', () => {
    addChapter(root, 1, '甲', '正文一')
    addChapter(root, 2, '乙', '正文二')
    const r = exportBook({ bookRoot: root, format: 'merged', output: 'txt' })
    expect(r.ok).toBe(true)
    expect(r.files).toEqual(['工作区/导出/纯文本/全本-纯文本书.txt'])
    const buf = readFileSync(mergedTxt())
    expect(buf[0]).not.toBe(0xef) // 无 BOM
    expect(buf.includes(0x0d)).toBe(false) // LF 规范形
    const text = buf.toString('utf-8')
    expect(text).toBe('甲\n\n正文一\n\n\n乙\n\n正文二')
    expect(text).not.toContain('#')
    expect(text).not.toContain('---')
  })
})

describe('txt 导出 · 净化口径', () => {
  it('剥行首标题/引用与行内成对标记；列表标记、场景分隔线、算式星号原样保留', () => {
    addChapter(
      root,
      1,
      '甲',
      [
        '## 小节标题',
        '> 引用一句',
        '他说：**重点**、*轻点*、~~删掉~~、`代码`、[链接](https://example.com)。',
        '---',
        '- 列表项',
        '3*4*5 与 a * b * c 不变',
      ].join('\n'),
    )
    const r = exportBook({ bookRoot: root, format: 'merged', output: 'txt' })
    expect(r.ok).toBe(true)
    const text = readFileSync(mergedTxt(), 'utf-8')
    expect(text).toContain('小节标题')
    expect(text).not.toContain('#')
    expect(text).not.toContain('> ')
    expect(text).toContain('他说：重点、轻点、删掉、代码、链接。')
    expect(text).toContain('\n---\n') // 场景分隔线不剥（纯文本面仍有分段语义）
    expect(text).toContain('\n- 列表项\n') // 列表标记不剥
    expect(text).toContain('3*4*5 与 a * b * c 不变')
  })
})

describe('txt 导出 · 分章与 md 面隔离', () => {
  it('分章落 导出/纯文本/分章/0001-标题.txt，正文净化同口径', () => {
    addChapter(root, 1, '甲', '## 小节\n\n正文一')
    const r = exportBook({ bookRoot: root, format: 'split', output: 'txt' })
    expect(r.ok).toBe(true)
    expect(readdirSync(join(txtDir(), '分章'))).toEqual(['0001-甲.txt'])
    const text = readFileSync(join(txtDir(), '分章', '0001-甲.txt'), 'utf-8')
    expect(text).toBe('甲\n\n小节\n\n正文一')
  })

  it('md 面零漂移：默认输出仍为 `# 标题` Markdown，且不产 纯文本/ 目录', () => {
    addChapter(root, 1, '甲', '正文一')
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(true)
    expect(r.files).toEqual(['工作区/导出/全本-纯文本书.md'])
    expect(readFileSync(join(root, '工作区', '导出', '全本-纯文本书.md'), 'utf-8')).toBe('# 甲\n\n正文一')
    expect(existsSync(txtDir())).toBe(false)
  })

  it('目录作用域隔断：md 产物不被 txt 清旧归档；旧 txt 归档进 纯文本/.旧版/', () => {
    addChapter(root, 1, '甲', '正文一')
    expect(exportBook({ bookRoot: root, format: 'merged' }).ok).toBe(true)
    // 预置改书名残留的旧 txt（txt 面清旧目标）
    mkdirSync(txtDir(), { recursive: true })
    writeFileSync(join(txtDir(), '全本-旧名.txt'), '旧稿')
    const r = exportBook({ bookRoot: root, format: 'merged', output: 'txt' })
    expect(r.ok).toBe(true)
    // md 产物原位未动、导出/ 根无 .旧版（txt 的清旧不越目录作用域）
    expect(existsSync(join(root, '工作区', '导出', '全本-纯文本书.md'))).toBe(true)
    expect(existsSync(join(root, '工作区', '导出', '.旧版'))).toBe(false)
    expect(existsSync(join(txtDir(), '.旧版', '全本-旧名.txt'))).toBe(true)
  })

  it('短篇：txt 面不出投稿视图（md 面照旧出）', () => {
    const shortRoot = scaffoldBook({
      name: '短篇集',
      dirs: ['写作/正文'],
      config: 'spec_version: 1\nkind: short\nbook:\n  title: 短篇集\n',
    }).root
    addChapter(shortRoot, 1, '一篇', '正文')
    const txtRun = exportBook({ bookRoot: shortRoot, format: 'merged', output: 'txt' })
    expect(txtRun.ok).toBe(true)
    expect(txtRun.files.some((f) => f.includes('投稿视图'))).toBe(false)
    expect(readdirSync(join(shortRoot, '工作区', '导出', '纯文本')).some((n) => n.startsWith('投稿视图'))).toBe(false)
    const mdRun = exportBook({ bookRoot: shortRoot, format: 'merged' })
    expect(mdRun.ok).toBe(true)
    expect(mdRun.files.some((f) => f.startsWith('工作区/导出/投稿视图-'))).toBe(true)
    rmSync(shortRoot, { recursive: true, force: true })
  })
})

describe('txt 导出 · 入口校验', () => {
  it('非法 output → 参数错误返回（不静默按 md 处理），零产物', () => {
    addChapter(root, 1, '甲', '正文一')
    const r = exportBook({ bookRoot: root, format: 'merged', output: 'rtf' as unknown as ExportOutput })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('参数错误')
    expect(r.error).toContain('output')
    expect(r.files).toEqual([])
    expect(existsSync(join(root, '工作区', '导出'))).toBe(false)
  })
})
