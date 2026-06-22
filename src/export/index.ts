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
import { readPieceDir } from '../format/pieces.js'
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
  /** 导出的章/篇数量 */
  chapterCount: number
  /** 导出对象单位 */
  unit: '章' | '篇'
  /** 错误信息 */
  error?: string
}

interface ExportUnit {
  num: number
  title: string
  path: string
}

/**
 * 导出定稿正文（多形态 + 净化）。
 */
export function exportBook(options: ExportOptions): ExportResult {
  const { bookRoot, format = 'both' } = options
  const cfg = readBookConfig(join(bookRoot, 'book.yaml'))
  const kind = cfg.ok && cfg.config.kind === 'short' ? 'short' : 'long'
  const unitLabel = kind === 'short' ? '篇' : '章'
  const bodyDir = kind === 'short' ? join(bookRoot, '篇') : join(bookRoot, '定稿', '正文')

  // 1. 扫描定稿正文（长篇复用 readChapterDir；短篇复用 readPieceDir）
  if (!existsSync(bodyDir)) {
    return { ok: false, files: [], chapterCount: 0, unit: unitLabel, error: `没有定稿${unitLabel === '篇' ? '短篇' : '正文'}可导出。` }
  }
  const { units, errors } = kind === 'short'
    ? readShortExportUnits(bodyDir)
    : readLongExportUnits(bodyDir)
  if (errors.length > 0) {
    const msgs = errors.map((e) => `${e.file}: ${e.message}`).join('; ')
    return { ok: false, files: [], chapterCount: 0, unit: unitLabel, error: `${unitLabel}解析失败：${msgs}` }
  }
  if (units.length === 0) {
    return { ok: false, files: [], chapterCount: 0, unit: unitLabel, error: `没有定稿${unitLabel === '篇' ? '短篇' : '正文'}可导出。` }
  }

  // 2. 按章/篇号数值排序（不依赖文件名字符串序）
  units.sort((a, b) => a.num - b.num)

  // 3. 读正文并净化（复用 readFile 取 body；readChapter 只返 meta 不够）
  const purified: Array<{ num: number; title: string; body: string }> = []
  for (const unit of units) {
    const r = readFile(unit.path)
    if (!r.ok) {
      return { ok: false, files: [], chapterCount: 0, unit: unitLabel, error: `读取 ${unit.path} 失败：${r.error.message}` }
    }
    purified.push({ num: unit.num, title: unit.title, body: r.body.trim() })
  }

  // 4. 准备导出目录（母本 6.2 工作区/导出/）
  const exportDir = join(bookRoot, '工作区', '导出')
  mkdirSync(exportDir, { recursive: true })

  // 5. 读书名（用于合并文件名；book.yaml #9 格式）
  let bookTitle = '未命名'
  if (cfg.ok && cfg.config.book.title) {
    bookTitle = cfg.config.book.title
  }

  const files: string[] = []
  const doMerged = format === 'merged' || format === 'both'
  const doSplit = format === 'split' || format === 'both'

  // 6. 单文件合并：长篇 全本-<书名>.md；短篇 全篇集-<集名>.md
  if (doMerged) {
    const mergedContent = purified
      .map((unit) => `# ${unit.title}\n\n${unit.body}`)
      .join('\n\n---\n\n')
    const fileName = `${kind === 'short' ? '全篇集' : '全本'}-${bookTitle}.md`
    writeFileSync(join(exportDir, fileName), mergedContent, 'utf-8')
    files.push(`工作区/导出/${fileName}`)
  }

  // 7. 分章/分篇导出：工作区/导出/分章|分篇/<序号>-<标题>.md
  if (doSplit) {
    const splitName = kind === 'short' ? '分篇' : '分章'
    const splitDir = join(exportDir, splitName)
    mkdirSync(splitDir, { recursive: true })
    for (const unit of purified) {
      const width = kind === 'short' ? 3 : 4
      const fileName = `${String(unit.num).padStart(width, '0')}-${unit.title}.md`
      writeFileSync(join(splitDir, fileName), `# ${unit.title}\n\n${unit.body}`, 'utf-8')
      files.push(`工作区/导出/${splitName}/${fileName}`)
    }
  }

  return { ok: true, files, chapterCount: units.length, unit: unitLabel }
}

function readLongExportUnits(bodyDir: string): { units: ExportUnit[]; errors: ReturnType<typeof readChapterDir>['errors'] } {
  const { chapters, errors } = readChapterDir(bodyDir)
  return {
    units: chapters.flatMap((ch) => ch._path ? [{ num: ch.章号, title: ch.标题, path: ch._path }] : []),
    errors,
  }
}

function readShortExportUnits(bodyDir: string): { units: ExportUnit[]; errors: ReturnType<typeof readPieceDir>['errors'] } {
  const { pieces, errors } = readPieceDir(bodyDir)
  return {
    units: pieces.flatMap((piece) => piece._path ? [{ num: piece.篇号, title: piece.标题, path: piece._path }] : []),
    errors,
  }
}
