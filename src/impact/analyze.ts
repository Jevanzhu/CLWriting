/**
 * 影响分析 —— 依据 #17 影响分析 spec 第 3-4 节。
 *
 * 改设定/大纲时，扫描该设定的引用足迹，按发布状态分桶（零 token 脚本）：
 * - 已发布影响清单：引用旧设定的已 commit 章（定稿/正文/，只读 → 顺势圆）
 * - 未发布影响清单：引用旧设定的大纲/草稿/未定稿（可改 → 随设定同步）
 *
 * 吃书检测（#17 第 4 节）：新设定值 vs 已发布章引用的旧值 → 直接冲突（数值/名称）脚本判。
 *
 * 原则（#17 第 1 节）：
 * - 已发布只读、向后兼容——已 commit 正文永不改，错误后续圆。
 * - 影响可见——改设定前先看影响哪些章，不让作者盲改吃书。
 * - 脚本产清单、AI 出建议——引用扫描/分桶/直接冲突是零 token 脚本；顺势圆怎么圆 M4。
 * - 决策归作者——清单给作者，圆不圆、怎么圆作者拍。
 */

import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { join, extname } from 'node:path'

/** 一处引用足迹（#17 第 3 节） */
export interface Reference {
  /** 引用所在的文件路径（相对 bookRoot） */
  file: string
  /** 引用所在的行号（1-based） */
  line: number
  /** 引用行的文本（供作者定位） */
  snippet: string
}

/** 影响清单（#17 第 3 节，按发布状态分桶） */
export interface ImpactReport {
  /** 被分析的设定名或编号 */
  target: string
  /** 已发布影响清单：引用旧设定的已 commit 章（定稿/正文/，只读） */
  published: Reference[]
  /** 未发布影响清单：引用旧设定的大纲/草稿/未定稿（可改） */
  unpublished: Reference[]
  /** 吃书检测：直接冲突标记（#17 第 4 节） */
  conflicts: Conflict[]
}

/** 吃书冲突（#17 第 4 节，直接冲突——数值/名称硬性不符） */
export interface Conflict {
  /** 冲突所在文件 */
  file: string
  /** 冲突行 */
  line: number
  /** 旧值（已发布章引用的） */
  oldValue: string
  /** 新值（设定改成的） */
  newValue: string
  /** 人话 */
  humanMsg: string
}

/**
 * 扫描某设定的引用足迹，按发布状态分桶（#17 第 3 节）。
 *
 * @param bookRoot 书仓库根
 * @param target 设定名或账本编号（如「伏笔-031」「林晚」「筑基」），grep 命中
 * @param newValue 可选：设定改成的新值（用于吃书检测，#17 第 4 节）；不传则只扫描引用
 *
 * 精确匹配优先：显式编号（伏笔-031）/专名优先；模糊指代（代词/化名）留 M4。
 */
export function scanReferences(bookRoot: string, target: string, newValue?: string): ImpactReport {
  const published = scanDir(join(bookRoot, '定稿', '正文'), target)
  const unpublished = [
    ...scanDir(join(bookRoot, '大纲'), target),
    ...scanDir(join(bookRoot, '工作区'), target),
  ]

  // 吃书检测（#17 第 4 节）：新值 vs 已发布引用的旧值
  const conflicts: Conflict[] = []
  if (newValue !== undefined && published.length > 0) {
    for (const ref of published) {
      const c = detectConflict(ref, target, newValue)
      if (c) conflicts.push(c)
    }
  }

  return { target, published, unpublished, conflicts }
}

/**
 * 扫描目录下含 target 的行（#17 第 3 节，零 token grep）。
 * 返回每处引用的 file（相对 bookRoot 不便，这里用相对 dir 的路径 + 前缀拼接）。
 */
function scanDir(dir: string, target: string, prefix = ''): Reference[] {
  const refs: Reference[] = []
  if (!existsSync(dir)) return refs

  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return refs
  }

  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name.startsWith('._')) continue
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      refs.push(...scanDir(full, target, rel))
    } else if (e.isFile() && extname(e.name) === '.md') {
      refs.push(...scanFile(full, rel, target))
    }
  }
  return refs
}

/** 扫描单个 md 文件，找含 target 的行 */
function scanFile(filePath: string, relPath: string, target: string): Reference[] {
  let text: string
  try {
    text = readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }
  const refs: Reference[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(target)) {
      refs.push({
        file: relPath,
        line: i + 1,
        snippet: lines[i]!.trim().slice(0, 80), // 截断长行
      })
    }
  }
  return refs
}

/**
 * 吃书检测（#17 第 4 节，M3 落地直接冲突）。
 * 直接冲突 = 数值/名称硬性不符（脚本可判）；复杂语义矛盾（情节逻辑/因果）M4。
 *
 * M3 实现：target 在已发布章出现 = 该处用了旧值 target（target 既是设定名又是其当前值）。
 * 设定要改成 newValue，若 newValue ≠ target → 每处引用都是直接冲突（旧值 target ≠ 新值 newValue）。
 * 例：设定「筑基」（当前境界）要改「金丹」，已发布章里写「境界：筑基」→ 旧值筑基 ≠ 新值金丹 → 吃书。
 */
function detectConflict(ref: Reference, target: string, newValue: string): Conflict | null {
  // 旧值 = target 本身（已发布章引用的就是当前设定值 target）
  const oldValue = target
  // 新值与旧值不同 → 直接冲突
  if (newValue !== oldValue) {
    return {
      file: ref.file,
      line: ref.line,
      oldValue,
      newValue,
      humanMsg: `「${target}」在 ${ref.file}:${ref.line} 用的是旧值「${oldValue}」，设定改成「${newValue}」将与此处吃书。`,
    }
  }
  return null
}

/** 影响清单 → 人话（#17 第 3-4 节，对作者零机器味 + 决策归作者） */
export function formatImpactReport(report: ImpactReport): string {
  const lines: string[] = []
  lines.push(`【影响分析：${report.target}】\n`)

  lines.push(`已发布影响（已 commit 正文，只读 → 顺势圆 / 接受 / 回滚）：${report.published.length} 处`)
  for (const r of report.published.slice(0, 10)) {
    lines.push(`  · ${r.file}:${r.line} ${r.snippet}`)
  }
  if (report.published.length > 10) lines.push(`  …还有 ${report.published.length - 10} 处`)

  lines.push('')
  lines.push(`未发布影响（大纲/草稿/未定稿，可改 → 随设定同步）：${report.unpublished.length} 处`)
  for (const r of report.unpublished.slice(0, 10)) {
    lines.push(`  · ${r.file}:${r.line} ${r.snippet}`)
  }
  if (report.unpublished.length > 10) lines.push(`  …还有 ${report.unpublished.length - 10} 处`)

  if (report.conflicts.length > 0) {
    lines.push('')
    lines.push(`⚠ 吃书预警（直接冲突，${report.conflicts.length} 处）：`)
    for (const c of report.conflicts) {
      lines.push(`  · ${c.humanMsg}`)
    }
    lines.push('  复杂语义矛盾（情节/因果）留 AI 判（M4）。')
  }

  lines.push('')
  lines.push('决策归你：已发布的只能顺势圆（后续章圆回来）或接受小瑕疵或「回到第 N 章」重写；未发布的随手改。')
  return lines.join('\n')
}
