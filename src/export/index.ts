/**
 * 干净导出 —— 依据 M7 #36 spec。
 *
 * 把定稿正文导出成多形态（单文件合并 / 分章），剥所有 front matter，
 * 产物落 `工作区/导出/`。
 *
 * 复用边界（#36 第 2.1/5 节）：
 * - 遍历复用 M1 readChapterDir（不新写）
 * - 正文取法复用 frontmatter.readFile().body（readChapter 只返 meta）
 * - 排序按章号数值（不依赖文件名字符串序——定稿文件名不补零）
 * - 净化：每章 `# {标题}\n\n{body}`，完全不输出 front matter
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readChapterDir } from '../format/chapters.js'
import { readFile } from '../format/frontmatter.js'
import { readBookConfig } from '../format/yaml.js'

export type ExportFormat = 'merged' | 'split' | 'both'

export interface ExportOptions {
  /** 书仓库根 */
  bookRoot: string
  /** 导出形态（默认 both） */
  format?: ExportFormat
}

export interface ExportResult {
  ok: boolean
  /** 导出的文件列表（相对书仓库的路径） */
  files: string[]
  /** 章数 */
  chapterCount: number
  /** 错误信息 */
  error?: string
}

/**
 * 导出定稿正文（多形态 + 净化）。
 */
export function exportBook(options: ExportOptions): ExportResult {
  const { bookRoot, format = 'both' } = options

  // 1. 扫描定稿正文（复用 readChapterDir，不新写遍历）
  const bodyDir = join(bookRoot, '定稿', '正文')
  if (!existsSync(bodyDir)) {
    return { ok: false, files: [], chapterCount: 0, error: '没有定稿正文可导出。' }
  }
  const { chapters, errors } = readChapterDir(bodyDir)
  if (errors.length > 0) {
    const msgs = errors.map((e) => `${e.file}: ${e.message}`).join('; ')
    return { ok: false, files: [], chapterCount: 0, error: `章节解析失败：${msgs}` }
  }
  if (chapters.length === 0) {
    return { ok: false, files: [], chapterCount: 0, error: '没有定稿正文可导出。' }
  }

  // 2. 按章号数值排序（不依赖文件名字符串序）
  chapters.sort((a, b) => a.章号 - b.章号)

  // 3. 读正文并净化（复用 readFile 取 body；readChapter 只返 meta 不够）
  const purified: Array<{ 章号: number; 标题: string; body: string }> = []
  for (const ch of chapters) {
    const path = ch._path
    if (!path) continue
    const r = readFile(path)
    if (!r.ok) {
      return { ok: false, files: [], chapterCount: 0, error: `读取 ${path} 失败：${r.error.message}` }
    }
    purified.push({ 章号: ch.章号, 标题: ch.标题, body: r.body.trim() })
  }

  // 4. 准备导出目录（母本 6.2 工作区/导出/）
  const exportDir = join(bookRoot, '工作区', '导出')
  mkdirSync(exportDir, { recursive: true })

  // 5. 读书名（用于合并文件名；book.yaml #9 格式）
  let bookTitle = '未命名'
  const cfg = readBookConfig(join(bookRoot, 'book.yaml'))
  if (cfg.ok && cfg.config.book.title) {
    bookTitle = cfg.config.book.title
  }

  const files: string[] = []
  const doMerged = format === 'merged' || format === 'both'
  const doSplit = format === 'split' || format === 'both'

  // 6. 单文件合并：工作区/导出/全本-<书名>.md
  if (doMerged) {
    const mergedContent = purified
      .map((ch) => `# ${ch.标题}\n\n${ch.body}`)
      .join('\n\n---\n\n')
    const fileName = `全本-${bookTitle}.md`
    writeFileSync(join(exportDir, fileName), mergedContent, 'utf-8')
    files.push(`工作区/导出/${fileName}`)
  }

  // 7. 分章导出：工作区/导出/分章/<章号 4 位补零>-<标题>.md
  if (doSplit) {
    const splitDir = join(exportDir, '分章')
    mkdirSync(splitDir, { recursive: true })
    for (const ch of purified) {
      const fileName = `${String(ch.章号).padStart(4, '0')}-${ch.标题}.md`
      writeFileSync(join(splitDir, fileName), `# ${ch.标题}\n\n${ch.body}`, 'utf-8')
      files.push(`工作区/导出/分章/${fileName}`)
    }
  }

  return { ok: true, files, chapterCount: chapters.length }
}
