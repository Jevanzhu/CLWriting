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
import { readBookConfig } from '../format/yaml.js'
import { finalizedPathSet } from '../document/manifest.js'
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
  /** X-P2-4：单章级问题（解析失败/正文为空被跳过）——个别坏章不再拖垮整本导出 */
  warnings?: string[]
  /** 错误信息 */
  error?: string
}

interface ExportUnit {
  num: number
  title: string
  path: string
  /** W-P2-4：readChapterDir(includeBody) 一次读带出，替代二次 readFile */
  body?: string
}

/**
 * 导出定稿正文（多形态 + 净化）。
 */

/** 净化正文：去首尾空白 + 过滤 #% 作者批注（W0 §6 过渡期，导出不泄漏定稿批注）。
 *  P3-14：行首整行批注与**行中**批注尾巴（`正文#%批注`）一并截掉——此前只滤
 *  行首 `#%`，行中批注会泄漏进导出；截断后行尾空白收敛，整行批注变空行则剔除，
 *  原空行保留（markdown 分段）。 */
function purifyBody(body: string): string {
  return body
    .split('\n')
    .map((line) => {
      if (line.trim() === '') return { keep: true, out: line } // 原空行保留（分段）
      const i = line.indexOf('#%')
      const out = i === -1 ? line : line.slice(0, i).replace(/\s+$/, '')
      return { keep: out.trim() !== '', out }
    })
    .filter((r) => r.keep)
    .map((r) => r.out)
    .join('\n')
    .trim()
}

/** 净化文件名：替换路径分隔符为 _，杜绝 ../ 越出导出目录；超长截断（X-P2-4 码位 + FF-F3 字节双封顶）。
 *  书名/章标题来自 book.yaml 与 frontmatter（不可信），拼文件名前须净化——
 *  AI 产出标题可任意长，超 255 字节文件名在 macOS/NTFS 直接写失败，整本导出被一章拖垮。
 *  FF-F3：ext4/NTFS 单段上限按 255 **字节**判（APFS 按码位判，本地恒绿会掩盖 CI 红）——
 *  码位封顶挡不住 4 字节字符（emoji 类 AI 标题 × 80 码位 = 320 字节），须再按字节截断；
 *  字节预算按各拼接点实际前后缀计算（分章序号 / 全本- / 投稿视图-平台后缀 长度不一），截断不切多字节字符。
 *  预算还须为原子写临时名让路：src/fs/atomic.ts 在同目录写 `.{名}.{pid}.{uuid}.tmp`
 *  （42B 固定 + pid 位数，Linux 上限 7 位 = 49B）——最终名贴着 255B 截断则临时名必超限，
 *  ext4 直接 ENAMETOOLONG（APFS 按码位判，本地恒绿会再次掩盖 CI 红），故预留 52B。 */
const FILENAME_MAX_CP = 80
const FILENAME_MAX_BYTES = 255 - 52

function sanitizeFileName(name: string, maxBytes: number): string {
  const cleaned = name.replace(/[\\/]/g, '_').trim()
  const cps = Array.from(cleaned)
  let out = ''
  let used = 0
  for (let i = 0; i < cps.length; i++) {
    if (i >= FILENAME_MAX_CP) break
    const b = Buffer.byteLength(cps[i]!, 'utf8')
    if (used + b > maxBytes) break
    out += cps[i]!
    used += b
  }
  return out
}

export function exportBook(options: ExportOptions): ExportResult {
  const { bookRoot, format = 'both', platform = 'generic' } = options
  const cfg = readBookConfig(join(bookRoot, 'book.yaml'))
  const kind = cfg.ok && cfg.config.kind === 'short' ? 'short' : 'long'
  const bodyDir = join(bookRoot, '写作', '正文')

  // 1. 扫描定稿正文（统一 readChapterDir，递归卷结构；W-P2-4：includeBody 一次读带出正文，不再二次 readFile）
  if (!existsSync(bodyDir)) {
    return { ok: false, files: [], chapterCount: 0, unit: '章', error: '没有定稿正文可导出。' }
  }
  // X-P2-4：单个坏章（解析失败）不再拖垮整本导出——记入 warnings 跳过，仍有可导章则继续
  const warnings: string[] = []
  const { chapters, errors } = readChapterDir(bodyDir, true)
  for (const e of errors) warnings.push(`${relative(bookRoot, e.file)}: ${e.message}`)
  const units: ExportUnit[] = chapters.flatMap((ch) =>
    ch._path ? [{ num: ch.章号, title: ch.标题, path: ch._path, body: ch._body }] : [],
  )
  if (units.length === 0 && warnings.length > 0) {
    return { ok: false, files: [], chapterCount: 0, unit: '章', error: `章解析失败：${warnings.join('; ')}` }
  }
  if (units.length === 0) {
    return { ok: false, files: [], chapterCount: 0, unit: '章', error: '没有定稿正文可导出。' }
  }

  // V-P2-2：「导出定稿正文」名要符实——滤掉从未定稿的章（manifest 无 finalizedRevision；
  // 态7 流水线刚写出的在写章/坏 fm 草稿不再混进全本/分章/投稿视图）。
  // 判定收敛到 manifest.finalizedPathSet 单一真相（learn 收割 H-1 同款，防两处漂移）
  const finalizedPaths = finalizedPathSet(bookRoot)
  let skippedDrafts = 0
  const filtered: ExportUnit[] =
    finalizedPaths !== null
      ? units.filter((u) => {
          // RB-KN-P2-3：relative() 在 Windows 产反斜杠而 manifest path 是正斜杠——
          // 不归一会把全部章误判未定稿、导出为空（对齐 state.ts 既有 slash 归一口径）
          if (finalizedPaths.has(relative(bookRoot, u.path).replace(/\\/g, '/'))) return true
          skippedDrafts++
          return false
        })
      : units
  // X-P2-4：正文为空的单章跳过（记警告），不再整本失败
  const exportable: ExportUnit[] = filtered.filter((u) => {
    if (u.body) return true
    warnings.push(`${relative(bookRoot, u.path)}: 正文为空，已跳过`)
    return false
  })
  if (exportable.length === 0) {
    return {
      ok: false,
      files: [],
      chapterCount: 0,
      unit: '章',
      skippedDrafts,
      ...(warnings.length > 0 ? { warnings } : {}),
      error: `正文区共 ${units.length} 章均未定稿，没有可导出的定稿正文；请先在文档树中定稿。`,
    }
  }

  // 2. 按章号数值排序（不依赖文件名字符串序）
  exportable.sort((a, b) => a.num - b.num)

  // 3. 净化正文（W-P2-4：body 已随 readChapterDir(includeBody=true) 一次带出，不再二次 readFile）
  const purified: Array<{ num: number; title: string; body: string }> = exportable.map((unit) => ({
    num: unit.num,
    title: unit.title,
    body: purifyBody(unit.body!),
  }))

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
    const fileName = `全本-${sanitizeFileName(bookTitle, FILENAME_MAX_BYTES - Buffer.byteLength('全本-') - Buffer.byteLength('.md'))}.md`
    atomicWriteFile(join(exportDir, fileName), mergedContent)
    files.push(`工作区/导出/${fileName}`)
  }

  // 7. 分章导出：工作区/导出/分章/<序号>-<标题>.md
  if (doSplit) {
    const splitName = '分章'
    const splitDir = join(exportDir, splitName)
    mkdirSync(splitDir, { recursive: true })
    for (const unit of purified) {
      const prefix = `${String(unit.num).padStart(3, '0')}-`
      const fileName = `${prefix}${sanitizeFileName(unit.title, FILENAME_MAX_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength('.md'))}.md`
      atomicWriteFile(join(splitDir, fileName), `# ${unit.title}\n\n${unit.body}`)
      files.push(`工作区/导出/${splitName}/${fileName}`)
    }
  }

  if (kind === 'short') {
    // 文件名与内容标题一致：非 generic 平台带模板 label（多平台产物不互相覆盖）
    const template = SUBMISSION_TEMPLATES[platform]
    const platformSuffix = template && platform !== 'generic' ? `-${template.label}` : ''
    const submissionName = `投稿视图-${sanitizeFileName(bookTitle, FILENAME_MAX_BYTES - Buffer.byteLength(`投稿视图-${platformSuffix}.md`))}${platformSuffix}.md`
    // V-P2-2：投稿视图同口径滤未定稿（entries 按 exportable 章号对齐）
    const exportableNums = new Set(exportable.map((u) => u.num))
    const entries = scanShortCollection(bookRoot).filter((e) => exportableNums.has(e.num))
    atomicWriteFile(
      join(exportDir, submissionName),
      formatShortSubmissionView(entries, cfg.ok ? cfg.config.short : undefined, bookTitle, platform),
    )
    files.push(`工作区/导出/${submissionName}`)
  }

  return {
    ok: true,
    files,
    chapterCount: exportable.length,
    unit: '章',
    skippedDrafts,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
