/**
 * import 命令测试 —— M7 #36。
 *
 * 验证复用 scaffold 建书的完整性（对照 init.test.ts 的 6.2 目录断言）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { importV02Book } from '../../src/import/index.js'
import { readChapter } from '../../src/format/chapters.js'
import { readBookConfig } from '../../src/format/yaml.js'
import { readBooks, readActive } from '../../src/install/books.js'

describe('importV02Book', () => {
  let workDir: string

  beforeEach(() => {
    workDir = join(tmpdir(), `clwriting-import-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(workDir, { recursive: true })
    mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  /** 造一份 v0.2 长篇正文（5 章，触发 length-routing 长篇） */
  function writeV02LongBook(path: string): void {
    const content = Array.from({ length: 5 }, (_, i) =>
      `第${i + 1}章：第${i + 1}章标题\n\n这是第${i + 1}章的正文内容，主角展开了新的冒险。\n`,
    ).join('\n')
    writeFileSync(path, content, 'utf-8')
  }

  it('长篇导入：复用 scaffold，6.2 目录完整 + 正文落定稿 + 登记', () => {
    const sourcePath = join(workDir, 'v02-book.md')
    writeV02LongBook(sourcePath)

    const result = importV02Book({ sourcePath, workDir, name: '导入书' })

    expect(result.ok).toBe(true)
    expect(result.kind).toBe('long')
    expect(result.chapterCount).toBe(5)
    expect(result.bookName).toBe('导入书')

    const bookRoot = result.bookRoot!

    // ── 6.2 目录完整性（对照 init.test.ts，验证复用 scaffold 而非自造）──
    expect(existsSync(join(bookRoot, '.git'))).toBe(true)
    expect(existsSync(join(bookRoot, 'book.yaml'))).toBe(true)
    expect(existsSync(join(bookRoot, 'AGENTS.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '.gitignore'))).toBe(true)
    // 基础三类恒建
    expect(existsSync(join(bookRoot, '大纲', '伏笔'))).toBe(true)
    expect(existsSync(join(bookRoot, '大纲', '悬念'))).toBe(true)
    expect(existsSync(join(bookRoot, '大纲', '感情线'))).toBe(true)
    expect(existsSync(join(bookRoot, '大纲', '总纲.md'))).toBe(true)
    // 文风冷启动（修复 S1：上一轮文风铁律是空壳，现在应是 scaffold 完整模板）
    expect(existsSync(join(bookRoot, '文风', '样章库', '战斗'))).toBe(true)
    const iron = require('node:fs').readFileSync(join(bookRoot, '文风', '文风铁律.md'), 'utf-8')
    expect(iron).toContain('反和解段')
    expect(iron).toContain('可量化约束')
    // 定稿区完整（scaffoldDirectories 建的，非简化版）
    expect(existsSync(join(bookRoot, '定稿', '摘要', '章摘要'))).toBe(true)
    expect(existsSync(join(bookRoot, '定稿', '设定', '角色'))).toBe(true)

    // ── 正文落定稿（5 章）──
    const bodyFiles = readdirSync(join(bookRoot, '定稿', '正文')).filter((f) => f.endsWith('.md'))
    expect(bodyFiles).toHaveLength(5)

    // ── 元数据占位诚实标注（不伪装真标注）──
    const ch1 = readChapter(join(bookRoot, '定稿', '正文', bodyFiles.find((f) => f.startsWith('1-'))!))
    expect(ch1.ok).toBe(true)
    if (ch1.ok) {
      expect(ch1.chapter._raw?.导入).toBe('待标注')
    }

    // ── book.yaml 书名正确 ──
    const cfg = readBookConfig(join(bookRoot, 'book.yaml')).config
    expect(cfg.book.title).toBe('导入书')

    // ── git 有两个 commit（init + import）──
    const log = execSync('git log --oneline', { cwd: bookRoot, stdio: 'pipe' }).toString().trim()
    expect(log).toContain('import: 导入 5 章')
    expect(log).toContain('init')

    // ── 登记 + 活动书 ──
    const books = readBooks(workDir)
    expect(books).toHaveLength(1)
    expect(books[0]!.name).toBe('导入书')
    expect(readActive(workDir)).toBe('导入书')
  })

  it('短篇（<5 章 <30000 字）建短篇集 + 落篇', () => {
    const sourcePath = join(workDir, 'short.md')
    writeFileSync(sourcePath, '第1章：短篇\n\n短内容。\n\n第2章：续\n\n继续。\n', 'utf-8')

    const result = importV02Book({ sourcePath, workDir, name: '夜语集' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.kind).toBe('short')
    expect(result.chapterCount).toBe(2)
    const bookRoot = result.bookRoot!
    // 短篇集布局：篇/ 子目录，无 定稿/正文/
    expect(existsSync(join(bookRoot, '篇', '001-短篇', '正文.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '篇', '002-续', '正文.md'))).toBe(true)
    // 清单.md 占位（不臆造反转线索）
    expect(existsSync(join(bookRoot, '篇', '001-短篇', '清单.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '定稿', '正文'))).toBe(false)
    // book.yaml kind: short
    const cfg = readBookConfig(join(bookRoot, 'book.yaml')).config
    expect(cfg.kind).toBe('short')
  })

  it('显式 --kind short 强制短篇（即使章节数≥5）', () => {
    const sourcePath = join(workDir, 'forced-short.md')
    writeV02LongBook(sourcePath)

    const result = importV02Book({ sourcePath, workDir, kind: 'short' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.kind).toBe('short')
    // 5 篇落 篇/
    expect(result.chapterCount).toBe(5)
    expect(existsSync(join(result.bookRoot!, '篇', '005-第5章标题', '正文.md'))).toBe(true)
  })

  it('长短信号冲突（<5 章但 ≥30000 字）→ 请 --kind 拍板', () => {
    const sourcePath = join(workDir, 'conflict.md')
    // 4 章但每章 8000 字（总 32000 ≥30000）→ 章节信号短、字数信号长
    const longPara = '字'.repeat(8000)
    const content = Array.from({ length: 4 }, (_, i) =>
      `第${i + 1}章：章${i + 1}\n\n${longPara}\n`,
    ).join('\n')
    writeFileSync(sourcePath, content, 'utf-8')

    const result = importV02Book({ sourcePath, workDir })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('冲突')
    expect(result.error).toContain('--kind')
  })

  it('文件不存在报错', () => {
    const result = importV02Book({ sourcePath: '/nonexistent/file.md', workDir })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('文件不存在')
  })

  it('同名书已登记报冲突', () => {
    // 先导入一本
    const s1 = join(workDir, 'book-a.md')
    writeV02LongBook(s1)
    importV02Book({ sourcePath: s1, workDir, name: '同名书' })

    // 再用同名导入第二本
    const s2 = join(workDir, 'book-b.md')
    writeV02LongBook(s2)
    const result = importV02Book({ sourcePath: s2, workDir, name: '同名书' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('已有一本叫「同名书」')
  })
})
