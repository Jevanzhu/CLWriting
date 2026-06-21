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

  it('空书（无定稿正文目录）应报错', () => {
    const empty = join(tmpdir(), `clwriting-export-empty-${Date.now()}`)
    mkdirSync(empty, { recursive: true })
    const result = exportBook({ bookRoot: empty })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('没有定稿正文可导出')
    rmSync(empty, { recursive: true, force: true })
  })
})
