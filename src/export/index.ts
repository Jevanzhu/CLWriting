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

import { existsSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { readChapterDir } from '../format/chapters.js'
import { readFile } from '../format/frontmatter.js'
import { readBookConfig } from '../format/yaml.js'
import { readManifest } from '../document/manifest.js'
import {
  formatShortSubmissionView,
  scanShortCollection,
  SUBMISSION_TEMPLATES,
  type ShortSubmissionPlatform,
} from '../metrics/short-index.js'

export type ExportFormat = 'merged' | 'split' | 'both'
/** 平台标识（配置化：查 SUBMISSION_TEMPLATES，未知平台 fallback generic）。 */
export type ExportPlatform = ShortSubmissionPlatform

export interface ExportOptions {
  /** 书仓库根 */
  bookRoot: string
  /** 导出形态（默认 both） */
  format?: ExportFormat
  /** 短篇投稿视图模板（长篇忽略） */
  platform?: ExportPlatform
}

export interface ExportResult {
  ok: boolean
  /** 导出的文件列表（相对书仓库的路径） */
  files: string[]
  /** 导出的章数 */
  chapterCount: number
  /** 导出对象单位 */
  unit: '章'
  /** 因未定稿被滤掉的章数（V-P2-2，前端可提示） */
  skippedDrafts?: number
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

/** 净化正文：去首尾空白 + 过滤 #% 开头的作者批注行（W0 §6 过渡期，导出不泄漏定稿批注） */
function purifyBody(body: string): string {
  return body
    .split('\n')
    .filter((line) => !line.startsWith('#%'))
    .join('\n')
    .trim()
}

/** 净化文件名：替换路径分隔符为 _，杜绝 ../ 越出导出目录。
 *  书名/章标题来自 book.yaml 与 frontmatter（不可信），拼文件名前须净化。 */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/]/g, '_')
}

export function exportBook(options: ExportOptions): ExportResult {
  const { bookRoot, format = 'both', platform = 'generic' } = options
  const cfg = readBookConfig(join(bookRoot, 'book.yaml'))
  const kind = cfg.ok && cfg.config.kind === 'short' ? 'short' : 'long'
  const bodyDir = join(bookRoot, '写作', '正文')

  // 1. 扫描定稿正文（统一 readChapterDir，递归卷结构）
  if (!existsSync(bodyDir)) {
    return { ok: false, files: [], chapterCount: 0, unit: '章', error: '没有定稿正文可导出。' }
  }
  const { chapters, errors } = readChapterDir(bodyDir)
  if (errors.length > 0) {
    const msgs = errors.map((e) => `${e.file}: ${e.message}`).join('; ')
    return { ok: false, files: [], chapterCount: 0, unit: '章', error: `章解析失败：${msgs}` }
  }
  const units: ExportUnit[] = chapters.flatMap((ch) =>
    ch._path ? [{ num: ch.章号, title: ch.标题, path: ch._path }] : [],
  )
  if (units.length === 0) {
    return { ok: false, files: [], chapterCount: 0, unit: '章', error: '没有定稿正文可导出。' }
  }

  // V-P2-2：「导出定稿正文」名要符实——滤掉从未定稿的章（manifest 无 finalizedRevision；
  // 态7 流水线刚写出的在写章/坏 fm 草稿不再混进全本/分章/投稿视图）。
  // 旧书无清单 / 清单无任何文档条目（损坏降级）→ 无法判定，保持全量（与历史行为一致）。
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const manifestEntries = existsSync(manifestPath)
    ? [...readManifest(manifestPath).entries.values()]
    : null
  let skippedDrafts = 0
  const exportable: ExportUnit[] =
    manifestEntries && manifestEntries.some((e) => e.nodeType === 'document')
      ? units.filter((u) => {
          const rel = relative(bookRoot, u.path)
          if (manifestEntries.some((e) => e.nodeType === 'document' && e.finalizedRevision && e.path === rel)) return true
          skippedDrafts++
          return false
        })
      : units
  if (exportable.length === 0) {
    return {
      ok: false,
      files: [],
      chapterCount: 0,
      unit: '章',
      skippedDrafts,
      error: `正文区共 ${units.length} 章均未定稿，没有可导出的定稿正文；请先在文档树中定稿。`,
    }
  }

  // 2. 按章号数值排序（不依赖文件名字符串序）
  exportable.sort((a, b) => a.num - b.num)

  // 3. 读正文并净化（复用 readFile 取 body；readChapter 只返 meta 不够）
  const purified: Array<{ num: number; title: string; body: string }> = []
  for (const unit of exportable) {
    const r = readFile(unit.path)
    if (!r.ok) {
      return { ok: false, files: [], chapterCount: 0, unit: '章', error: `读取 ${unit.path} 失败：${r.error.message}` }
    }
    purified.push({ num: unit.num, title: unit.title, body: purifyBody(r.body) })
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

  // 6. 单文件合并：全本-<书名>.md
  if (doMerged) {
    const mergedContent = purified
      .map((unit) => `# ${unit.title}\n\n${unit.body}`)
      .join('\n\n---\n\n')
    const fileName = `全本-${sanitizeFileName(bookTitle)}.md`
    atomicWriteFile(join(exportDir, fileName), mergedContent)
    files.push(`工作区/导出/${fileName}`)
  }

  // 7. 分章导出：工作区/导出/分章/<序号>-<标题>.md
  if (doSplit) {
    const splitName = '分章'
    const splitDir = join(exportDir, splitName)
    mkdirSync(splitDir, { recursive: true })
    for (const unit of purified) {
      const fileName = `${String(unit.num).padStart(3, '0')}-${sanitizeFileName(unit.title)}.md`
      atomicWriteFile(join(splitDir, fileName), `# ${unit.title}\n\n${unit.body}`)
      files.push(`工作区/导出/${splitName}/${fileName}`)
    }
  }

  if (kind === 'short') {
    // 文件名与内容标题一致：非 generic 平台带模板 label（多平台产物不互相覆盖）
    const template = SUBMISSION_TEMPLATES[platform]
    const platformSuffix = template && platform !== 'generic' ? `-${template.label}` : ''
    const submissionName = `投稿视图-${sanitizeFileName(bookTitle)}${platformSuffix}.md`
    // V-P2-2：投稿视图同口径滤未定稿（entries 按 exportable 章号对齐）
    const exportableNums = new Set(exportable.map((u) => u.num))
    const entries = scanShortCollection(bookRoot).filter((e) => exportableNums.has(e.num))
    atomicWriteFile(
      join(exportDir, submissionName),
      formatShortSubmissionView(entries, cfg.ok ? cfg.config.short : undefined, bookTitle, platform),
    )
    files.push(`工作区/导出/${submissionName}`)
  }

  return { ok: true, files, chapterCount: exportable.length, unit: '章', skippedDrafts }
}
