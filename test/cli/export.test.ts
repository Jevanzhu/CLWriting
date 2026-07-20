/**
 * export 命令测试 —— M7 #36。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exportCommand } from '../../src/cli/export.js'
import { exportBook } from '../../src/export/index.js'
import { writeChapter } from '../../src/format/chapters.js'
import { writePiece } from '../../src/format/pieces.js'
import type { ChapterMeta } from '../../src/format/types.js'

describe('exportBook', () => {
  let bookRoot: string

  beforeEach(() => {
    bookRoot = join(tmpdir(), `clwriting-export-test-${Date.now()}`)
    mkdirSync(bookRoot, { recursive: true })

    // 创建定稿正文目录
    const bodyDir = join(bookRoot, '定稿', '正文')
    mkdirSync(bodyDir, { recursive: true })

    // 写入测试章节（故意乱序，验证按章号数值排序）
    const chapters: Array<{ 章号: number; 标题: string; body: string }> = [
      { 章号: 10, 标题: '第十章', body: '第十章正文内容' },
      { 章号: 1, 标题: '第一章', body: '第一章正文内容' },
      { 章号: 2, 标题: '第二章', body: '第二章正文内容' },
    ]
    for (const ch of chapters) {
      const meta: ChapterMeta = {
        章号: ch.章号,
        标题: ch.标题,
        钩子类型: '悬念钩',
        钩子强弱: '中',
        情绪定位: '铺垫',
        _path: '',
        _wordCount: ch.body.length,
      }
      writeChapter(join(bodyDir, `${ch.章号}-${ch.标题}.md`), meta, ch.body)
    }

    // 创建 book.yaml（#9 spec 格式：嵌套 book 段）
    writeFileSync(
      join(bookRoot, 'book.yaml'),
      'spec_version: 1\n\nbook:\n  title: 测试书名\n  genre: 玄幻\n\nleads:\n  enabled: [主线]\n',
      'utf-8',
    )
  })

  afterEach(() => {
    rmSync(bookRoot, { recursive: true, force: true })
  })

  it('单文件合并：按章号排序 + 无 front matter + 章间分隔', () => {
    const result = exportBook({ bookRoot, format: 'merged' })

    expect(result.ok).toBe(true)
    expect(result.chapterCount).toBe(3)
    expect(result.files).toHaveLength(1)
    expect(result.files[0]).toBe('工作区/导出/全本-测试书名.md')

    const content = readFileSync(join(bookRoot, result.files[0]!), 'utf-8')
    // 按章号数值排序（1 → 2 → 10，非字符串序 1,10,2）
    expect(content).toMatch(/# 第一章\n\n第一章正文内容/)
    expect(content).toMatch(/# 第二章\n\n第二章正文内容/)
    expect(content).toMatch(/# 第十章\n\n第十章正文内容/)
    // 章间有分隔符
    expect(content).toContain('\n\n---\n\n')
    // 净化：不含 front matter 机器字段
    expect(content).not.toContain('钩子类型')
    expect(content).not.toContain('情绪定位')
  })

  it('分章导出：文件名 4 位补零 + 净化内容', () => {
    const result = exportBook({ bookRoot, format: 'split' })

    expect(result.ok).toBe(true)
    expect(result.chapterCount).toBe(3)
    expect(result.files).toHaveLength(3)
    expect(result.files).toContain('工作区/导出/分章/0001-第一章.md')
    expect(result.files).toContain('工作区/导出/分章/0002-第二章.md')
    expect(result.files).toContain('工作区/导出/分章/0010-第十章.md')

    const ch1 = readFileSync(join(bookRoot, '工作区/导出/分章/0001-第一章.md'), 'utf-8')
    expect(ch1).toBe('# 第一章\n\n第一章正文内容')
  })

  it('both：同时导出两种形态', () => {
    const result = exportBook({ bookRoot, format: 'both' })

    expect(result.ok).toBe(true)
    expect(result.chapterCount).toBe(3)
    expect(result.files).toHaveLength(4) // 1 合并 + 3 分章
  })

  it('净化：过滤 #% 开头的作者批注行（W2B B6）', () => {
    // 覆盖第一章正文，含 #% 批注行
    const bodyDir = join(bookRoot, '定稿', '正文')
    const meta: ChapterMeta = {
      章号: 1,
      标题: '第一章',
      钩子类型: '悬念钩',
      钩子强弱: '中',
      情绪定位: '铺垫',
      _path: '',
      _wordCount: 0,
    }
    writeChapter(join(bodyDir, '1-第一章.md'), meta, '正文行一\n#% 这是一条作者批注\n正文行二')

    const result = exportBook({ bookRoot, format: 'merged' })
    expect(result.ok).toBe(true)
    const content = readFileSync(join(bookRoot, result.files[0]!), 'utf-8')
    expect(content).toContain('正文行一')
    expect(content).toContain('正文行二')
    expect(content).not.toContain('#%')
    expect(content).not.toContain('批注')
  })

  it('CLI: --format 在书目录前也能正确解析书仓库', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      exportCommand(['--format', 'split', bookRoot])
    } finally {
      logSpy.mockRestore()
    }

    expect(existsSync(join(bookRoot, '工作区', '导出', '分章', '0001-第一章.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '工作区', '导出', '全本-测试书名.md'))).toBe(false)
  })

  it('短篇集导出：按篇号排序 + 全篇集/分篇 + 无 front matter', () => {
    const shortRoot = join(tmpdir(), `clwriting-export-short-${Date.now()}`)
    mkdirSync(shortRoot, { recursive: true })
    mkdirSync(join(shortRoot, '篇'), { recursive: true })
    writeFileSync(
      join(shortRoot, 'book.yaml'),
      'spec_version: 1\nkind: short\n\nbook:\n  title: 夜语集\n  genre: 悬疑\n',
      'utf-8',
    )
    const pieces = [
      { 篇号: 3, 标题: '第三夜', body: '第三夜正文' },
      { 篇号: 1, 标题: '第一夜', body: '第一夜正文' },
      { 篇号: 2, 标题: '第二夜', body: '第二夜正文' },
    ]
    for (const piece of pieces) {
      const dir = join(shortRoot, '篇', `${String(piece.篇号).padStart(3, '0')}-${piece.标题}`)
      mkdirSync(dir, { recursive: true })
      writePiece(join(dir, '正文.md'), {
        篇号: piece.篇号,
        标题: piece.标题,
        目标情绪: '惊悚',
        核心反转: '来客就是死者',
      }, piece.body)
    }

    try {
      const result = exportBook({ bookRoot: shortRoot, format: 'both' })

      expect(result.ok).toBe(true)
      expect(result.unit).toBe('篇')
      expect(result.chapterCount).toBe(3)
      expect(result.files).toContain('工作区/导出/全篇集-夜语集.md')
      expect(result.files).toContain('工作区/导出/分篇/001-第一夜.md')
      expect(result.files).toContain('工作区/导出/分篇/002-第二夜.md')
      expect(result.files).toContain('工作区/导出/分篇/003-第三夜.md')
      expect(result.files).toContain('工作区/导出/投稿视图-夜语集.md')

      const merged = readFileSync(join(shortRoot, '工作区/导出/全篇集-夜语集.md'), 'utf-8')
      expect(merged).toMatch(/# 第一夜\n\n第一夜正文/)
      expect(merged).toMatch(/# 第二夜\n\n第二夜正文/)
      expect(merged).toMatch(/# 第三夜\n\n第三夜正文/)
      expect(merged).not.toContain('目标情绪')
      expect(merged).not.toContain('核心反转')

      const first = readFileSync(join(shortRoot, '工作区/导出/分篇/001-第一夜.md'), 'utf-8')
      expect(first).toBe('# 第一夜\n\n第一夜正文')

      const submission = readFileSync(join(shortRoot, '工作区/导出/投稿视图-夜语集.md'), 'utf-8')
      expect(submission).toContain('# 投稿视图-夜语集')
      expect(submission).toContain('| 001 | 第一夜 |')
      expect(submission).toContain('核心反转：来客就是死者')
      expect(submission).toContain('## 策划分布')
    } finally {
      rmSync(shortRoot, { recursive: true, force: true })
    }
  })

  it('CLI short: 输出篇数文案', () => {
    const shortRoot = join(tmpdir(), `clwriting-export-short-cli-${Date.now()}`)
    mkdirSync(join(shortRoot, '篇', '001-第一夜'), { recursive: true })
    writeFileSync(
      join(shortRoot, 'book.yaml'),
      'spec_version: 1\nkind: short\n\nbook:\n  title: 夜语集\n  genre: 悬疑\n',
      'utf-8',
    )
    writePiece(join(shortRoot, '篇', '001-第一夜', '正文.md'), {
      篇号: 1,
      标题: '第一夜',
    }, '第一夜正文')

    const lines: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    })
    try {
      exportCommand(['--format', 'merged', shortRoot])
      expect(lines.join('\n')).toContain('已导出 1 篇')
    } finally {
      logSpy.mockRestore()
      rmSync(shortRoot, { recursive: true, force: true })
    }
  })

  it('CLI short: --platform 生成平台化投稿视图', () => {
    const shortRoot = join(tmpdir(), `clwriting-export-short-platform-${Date.now()}`)
    mkdirSync(join(shortRoot, '篇', '001-第一夜'), { recursive: true })
    writeFileSync(
      join(shortRoot, 'book.yaml'),
      'spec_version: 1\nkind: short\n\nbook:\n  title: 夜语集\n  genre: 悬疑\n',
      'utf-8',
    )
    writePiece(join(shortRoot, '篇', '001-第一夜', '正文.md'), {
      篇号: 1,
      标题: '第一夜',
      目标情绪: '惊悚',
      核心反转: '来客就是死者',
    }, '第一夜正文')

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      exportCommand(['--platform', 'zhihu-salt', shortRoot])
      const submission = readFileSync(join(shortRoot, '工作区', '导出', '投稿视图-夜语集.md'), 'utf-8')
      expect(submission).toContain('# 投稿视图-夜语集-知乎盐选')
      expect(submission).toContain('平台模板：知乎盐选')
      expect(submission).toContain('付费后反转')
    } finally {
      logSpy.mockRestore()
      rmSync(shortRoot, { recursive: true, force: true })
    }
  })

  it('空书（无定稿正文目录）应报错', () => {
    const empty = join(tmpdir(), `clwriting-export-empty-${Date.now()}`)
    mkdirSync(empty, { recursive: true })
    const result = exportBook({ bookRoot: empty })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('没有定稿正文可导出')
    rmSync(empty, { recursive: true, force: true })
  })
})
