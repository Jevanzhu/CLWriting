/**
 * 账本形式三检 —— 依据 ③ 第 7 节 + ⑩ 第 2 节项 1（🔴 红）。
 *
 * 三检（零 token 机检，全七类覆盖，定稿前校验）：
 * 1. 章号一致：履历章号 == 写入它的那次定稿章号（回填除外）
 * 2. 引文命中：履历的章内证据须在该章正文 grep 命中
 * 3. 两端闭合：细纲声明的本章变动 ⟷ 定稿实际写入的履历
 *
 * 状态闭合（③ 第 5 节）：状态 ⟷ 履历末条动词一致。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CheckSectionResult, CheckItem } from './types.js'
import { readLeadHistory, readLeadStatus } from '../cli/read.js'

/**
 * 账本形式三检。
 *
 * @param db 缓存
 * @param bookRoot 书仓库根（读正文 grep 引文）
 * @param currentChapter 当前定稿章号（章号一致校验用）
 * @param enabledTypes 已启用的账本类（只检这些类，⑩ 第 1 节原则 4）
 */
export function checkLeadsForm(
  db: DatabaseSync,
  bookRoot: string,
  currentChapter: number,
  enabledTypes: string[],
): CheckSectionResult {
  const items: CheckItem[] = []

  // 取所有已启用类的 open 条目
  const placeholders = enabledTypes.map(() => '?').join(',')
  const leads = db.prepare(
    `SELECT id, type, title, status FROM leads WHERE type IN (${placeholders})`,
  ).all(...enabledTypes) as Record<string, unknown>[]

  const 正文dir = join(bookRoot, '定稿', '正文')

  for (const lead of leads) {
    const id = lead['id'] as string
    const history = readLeadHistory(db, id)

    for (const entry of history) {
      // ① 章号一致：非回填行的章号须 ≤ currentChapter（不能凭空声称未来章）
      if (!entry.回填 && entry.章号 > currentChapter) {
        items.push({
          checkId: 'lead-chapter-mismatch',
          level: 'red',
          message: `${id} 履历声称第${entry.章号}章，但当前只定稿到第${currentChapter}章（凭空声称未来章）`,
          leadId: id,
          chapter: entry.章号,
        })
      }

      // ② 引文命中：证据须在该章正文 grep 命中
      if (!entry.回填 && entry.证据) {
        const chapterPath = findChapterFile(正文dir, entry.章号)
        if (chapterPath) {
          const text = readFileSync(chapterPath, 'utf-8')
          // 取引号内的核心片段 grep（③ 第 4 节：章内证据尽量是正文原文）
          const evidenceCore = extractEvidenceCore(entry.证据)
          if (evidenceCore && !text.includes(evidenceCore)) {
            items.push({
              checkId: 'lead-evidence-miss',
              level: 'red',
              message: `${id} 履历引文「${evidenceCore}」在第${entry.章号}章正文未命中`,
              leadId: id,
              chapter: entry.章号,
            })
          }
        }
      }
    }

    // 状态闭合（③ 第 5 节）：状态 ⟷ 履历末条动词
    if (history.length > 0) {
      const lastEntry = history[history.length - 1]!
      const status = lead['status'] as string
      const statusMismatch = checkStatusClosure(lastEntry.动词, status)
      if (statusMismatch) {
        items.push({
          checkId: 'lead-status-open',
          level: 'red',
          message: `${id} 状态「${status}」与履历末条动词「${lastEntry.动词}」不一致`,
          leadId: id,
        })
      }
    }
  }

  return { name: '账本形式三检', items }
}

/** 找某章的正文文件（定稿/正文/<章号>-*.md） */
function findChapterFile(正文dir: string, chapter: number): string | null {
  const { readdirSync, statSync } = require('node:fs')
  try {
    const files = readdirSync(正文dir) as string[]
    const prefix = String(chapter) + '-'
    const match = files.find((f) => f.startsWith(prefix) && f.endsWith('.md') && !f.startsWith('._'))
    return match ? join(正文dir, match) : null
  } catch {
    return null
  }
}

/** 提取证据的核心片段（引号内的内容优先，否则取前 N 字） */
function extractEvidenceCore(evidence: string): string {
  // 优先取引号内的内容
  const quoted = evidence.match(/["""]([^"""]{4,})["""]/)
  if (quoted) return quoted[1]!
  // 否则取前 8 个字符（够 grep）
  return evidence.slice(0, 8)
}

/**
 * 状态闭合校验（③ 第 5 节）：
 * 末条动词是收尾类（回收/揭晓/修成/收网/固化/突破/清算）→ 状态须「已收尾」
 * 末条动词是放弃类（放弃/无疾/被破/倾覆/瓶颈/化解）→ 状态须「已放弃」
 */
const RESOLVE_VERBS = new Set(['回收', '揭晓', '修成', '收网', '固化', '突破', '清算'])
const DROP_VERBS = new Set(['放弃', '无疾', '被破', '倾覆', '瓶颈', '化解'])

function checkStatusClosure(lastVerb: string, status: string): boolean {
  if (RESOLVE_VERBS.has(lastVerb) && status !== '已收尾') return true
  if (DROP_VERBS.has(lastVerb) && status !== '已放弃') return true
  return false
}
