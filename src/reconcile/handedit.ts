/**
 * 未入账手改对账 —— 依据 #18 手改对账 spec 第 3-4 节（原则 1「文件即真相」核心）。
 *
 * 检测定稿区/账本/大纲的未 commit 手改（作者绕过 finalize 直接编辑），分类、提议补登。
 * 与 finalize（#13 写时入账）殊途同归——都让「md 真相」与「缓存/账本」一致。
 *
 * 原则（#18 第 1 节）：
 * - 文件即真相、手改是权利——作者可手改任意 md；系统是「发现→提议」，不是「禁止」。
 * - 检测→提议→永不拒绝——发现手改提议补登，不报错阻断。
 * - 已发布正文对 AI 是硬约束、对作者是提醒——作者改已发布正文只警示+提议，不强制拒（作者是上帝）。
 * - 语义分类 M3 脚本（哪个文件+改动类型）、M4 语义（这手改意味什么）。
 */

import { statusPorcelain } from '../git/exec.js'

/** 手改类型（#18 第 3 节分类，脚本按文件位置判） */
export type HandEditKind = 'ledger' | 'setting' | 'outline' | 'published-text' | 'other'

/** 检测到的手改（#18 第 3 节） */
export interface HandEdit {
  /** 改动文件路径（相对 bookRoot） */
  path: string
  /** git 状态码（XY，porcelain 前 2 字符） */
  status: string
  /** 手改类型（脚本按路径分类） */
  kind: HandEditKind
  /** 是否已发布正文（#18 第 4 节特殊处理） */
  isPublished: boolean
}

/** 手改类型人话（#18 第 3 节，零机器味） */
const KIND_NAMES: Record<HandEditKind, string> = {
  ledger: '账本履历',
  setting: '设定',
  outline: '大纲',
  'published-text': '已发布正文',
  other: '其他',
}

/** 手改报告（#18 第 3 节） */
export interface HandEditReport {
  /** 检测到的手改 */
  edits: HandEdit[]
  /** 其中有已发布正文手改（#18 第 4 节需特殊警示） */
  hasPublishedText: boolean
}

/**
 * 检测未入账手改（#18 第 3 节）。
 * git status 见 定稿/、大纲/ 有未 commit 改动；按文件位置分类。
 */
export function detectHandEdits(bookRoot: string): HandEditReport {
  const dirty = statusPorcelain(bookRoot)
  const edits: HandEdit[] = []

  if (dirty) {
    for (const line of dirty.split('\n')) {
      if (line.length <= 3) continue
      const status = line.slice(0, 2)
      const path = line.slice(3)
      // 只关心定稿区、大纲区的改动（工作区改动属正常写作，不算手改）
      if (!path.startsWith('定稿/') && !path.startsWith('大纲/')) continue

      const kind = classifyByPath(path)
      edits.push({
        path,
        status,
        kind,
        isPublished: kind === 'published-text',
      })
    }
  }

  return {
    edits,
    hasPublishedText: edits.some((e) => e.isPublished),
  }
}

/** 按文件路径选手改类型（#18 第 3 节脚本分类） */
function classifyByPath(path: string): HandEditKind {
  // 已发布正文：定稿/正文/*.md（#18 第 4 节，已 commit 的正文只读）
  if (path.startsWith('定稿/正文/')) return 'published-text'
  // 账本：大纲/{已启用类}/*.md
  if (path.startsWith('大纲/伏笔/') || path.startsWith('大纲/悬念/') || path.startsWith('大纲/感情线/') ||
      path.startsWith('大纲/局线/') || path.startsWith('大纲/设定线/') || path.startsWith('大纲/成长线/') || path.startsWith('大纲/关系债/')) {
    return 'ledger'
  }
  // 设定：定稿/设定/
  if (path.startsWith('定稿/设定/')) return 'setting'
  // 大纲其他（总纲/卷纲）
  if (path.startsWith('大纲/')) return 'outline'
  return 'other'
}

/** 补登提议（#18 第 3 节「提议入账」） */
export interface RebookProposal {
  /** 对应的手改 */
  edit: HandEdit
  /** 人话提议（怎么补登） */
  proposal: string
  /** 是否需触发影响分析（改设定被引用 → #17） */
  needsImpactAnalysis: boolean
}

/**
 * 对手改提议补登（#18 第 3 节）。
 * - 账本/大纲 → 提议同步进缓存（重建相关项）
 * - 设定 → 提议同步 + 若被引用触发影响分析（#17）
 * - 已发布正文 → 警示 + 提议（撤销/回滚/坚持），不强制拒（#18 第 4 节）
 */
export function proposeRebook(edit: HandEdit): RebookProposal {
  switch (edit.kind) {
    case 'ledger':
      return {
        edit,
        proposal: '改了账本履历，建议同步进缓存（重建相关账本项），让履历与正文一致。',
        needsImpactAnalysis: false,
      }
    case 'outline':
      return {
        edit,
        proposal: '改了大纲（总纲/卷纲），建议同步进缓存。后续章节细纲会基于新大纲起草。',
        needsImpactAnalysis: false,
      }
    case 'setting':
      return {
        edit,
        proposal: '改了设定。设定是创作辅助可改，但已发布章对旧设定的引用可能需要顺势圆。建议先看影响清单（已发布 N 处 / 未发布 M 处）。',
        needsImpactAnalysis: true, // #17 触发
      }
    case 'published-text':
      // #18 第 4 节：已发布正文手改特殊处理（对作者是提醒不是禁止）
      return {
        edit,
        proposal: '⚠ 这章已发布，按铁律是只读的——读者已经看过，改它会和已读内容不一致。建议：#1撤销手改（git 恢复）；#2或走「回到第 N 章」正式重发；#3或坚持保留（你是作者，你说了算，系统会记一笔供后续对账）。',
        needsImpactAnalysis: false,
      }
    case 'other':
      return {
        edit,
        proposal: '检测到改动，建议确认后同步。',
        needsImpactAnalysis: false,
      }
  }
}

/** 手改报告 → 人话（#18 第 3-4 节，对作者零机器味 + 永不拒绝） */
export function formatHandEditReport(report: HandEditReport): string {
  if (report.edits.length === 0) {
    return '✓ 没有未入账的手改。'
  }
  const lines: string[] = []
  lines.push(`检测到 ${report.edits.length} 处手改（你是作者，手改是权利，系统只是帮你对账）：\n`)
  for (const edit of report.edits) {
    const p = proposeRebook(edit)
    lines.push(`· [${KIND_NAMES[edit.kind]}] ${edit.path}`)
    lines.push(`  ${p.proposal}`)
    lines.push('')
  }
  if (report.hasPublishedText) {
    lines.push('⚠ 其中有已发布正文被手改，请特别注意（见上）。')
  }
  return lines.join('\n')
}

/** 便利：检测 + 提议一步（状态机态 3 路由用） */
export function handeditReport(bookRoot: string): { report: HandEditReport; proposals: RebookProposal[] } {
  const report = detectHandEdits(bookRoot)
  const proposals = report.edits.map(proposeRebook)
  return { report, proposals }
}
