/**
 * 定稿原子 commit —— 依据 ⑬ 定稿 commit spec。
 *
 * finalize 是写定稿区的唯一入口（⑬ 第 1 节）。
 * 一次 git commit = 原子点：commit 成功则定稿成立，失败/中断则定稿区无变化。
 *
 * 执行顺序（⑬ 第 4 节）：
 * 1. 前置闸（审稿裁决 / 形式三检 / 确认哈希）
 * 2. 写定稿区变更到工作树
 * 3. git add + 一次 git commit（原子点）
 * 4. 清空工作区
 * 5. 重建缓存
 *
 * 中断恢复（⑬ 第 5 节）：commit 前崩 = 工作区原样保留；commit 后崩 = 已定稿。
 */

import { existsSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { addCommit } from '../git/exec.js'
import type { DatabaseSync } from 'node:sqlite'
import type { ChapterMeta, BookConfig } from '../format/types.js'
import { writeChapter } from '../format/chapters.js'
import { writeLead, readLead } from '../format/leads.js'
import { checkConfirmGate, readConfirm, clearConfirm } from '../gate/confirm.js'
import { checkLeadsForm } from '../check/leads.js'
import { runAllChecks, hasRed } from '../check/runner.js'
import { rebuild } from '../cache/rebuild.js'
import type { ParseError } from '../format/types.js'

/** finalize 前置闸检查结果（⑬ 第 2 节） */
export type FinalizeGateResult =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * finalize 前置闸（⑬ 第 2 节）。
 * - 审稿有作者裁决
 * - 账本形式三检通过
 * - 确认记录哈希一致
 */
export function checkFinalizeGate(
  workDir: string,
  outlinePath: string,
  hasReviewVerdict: boolean,
  db: DatabaseSync,
  bookRoot: string,
  currentChapter: number,
  enabledTypes: string[],
): FinalizeGateResult {
  // ① 审稿裁决
  if (!hasReviewVerdict) {
    return { ok: false, reason: '你还没拍板（审稿无作者裁决）' }
  }

  // ② 账本形式三检（定稿前再跑一次，⑬ 第 2 节）
  const formCheck = checkLeadsForm(db, bookRoot, currentChapter, enabledTypes)
  const redForm = formCheck.items.filter((i) => i.level === 'red')
  if (redForm.length > 0) {
    return { ok: false, reason: `账本对不上：${redForm.map((r) => r.message).join('；')}` }
  }

  // ③ 确认记录哈希
  const confirmGate = checkConfirmGate(workDir, outlinePath)
  if (!confirmGate.ok) {
    return { ok: false, reason: confirmGate.reason }
  }

  return { ok: true }
}

/** finalize 输入 */
export interface FinalizeInput {
  bookRoot: string
  workDir: string
  outlinePath: string
  db: DatabaseSync
  config: BookConfig
  chapter: ChapterMeta
  body: string // 正文
  fileName: string // 正文文件名
  hasReviewVerdict: boolean
  /** 本章需更新的账本履历（leadId → 新增的履历行） */
  leadUpdates?: { leadId: string; entries: { 章号: number; 动词: string; 证据: string }[] }[]
  /** 章摘要文本 */
  chapterSummary?: string
}

/** finalize 结果 */
export type FinalizeResult =
  | { ok: true; commitHash: string }
  | { ok: false; reason: string }

/**
 * 执行定稿（原子 commit）。
 * 全程在书仓库根（bookRoot）执行 git 操作。
 */
export function doFinalize(input: FinalizeInput): FinalizeResult {
  const { bookRoot, workDir, outlinePath, db, config, chapter, body, fileName, hasReviewVerdict } = input
  const enabledTypes = ['伏笔', '悬念', '感情线', ...config.leads.enabled]

  // ① 前置闸
  const gate = checkFinalizeGate(workDir, outlinePath, hasReviewVerdict, db, bookRoot, chapter.章号, enabledTypes)
  if (!gate.ok) return gate

  // ② 写定稿区变更
  // 正文
  const 正文dir = join(bookRoot, '定稿', '正文')
  const chapterPath = join(正文dir, fileName)
  writeChapter(chapterPath, chapter, body)

  // 账本履历更新（幂等 + 本章校验）
  if (input.leadUpdates) {
    for (const update of input.leadUpdates) {
      const leadDir = join(bookRoot, '大纲')
      // 找到该 lead 的文件
      const leadFile = findLeadFile(leadDir, update.leadId)
      if (leadFile) {
        const r = readLead(leadFile)
        if (r.ok) {
          for (const e of update.entries) {
            // 定稿只写本章（chapter.章号）的履历，章号不符跳过（防写错章）
            if (e.章号 !== chapter.章号) continue
            // 幂等：同章号 + 动词已存在则跳过（防二次 finalize / 重试重复追加）
            if (r.lead.履历.some((h) => h.章号 === e.章号 && h.动词 === e.动词)) continue
            r.lead.履历.push({ 章号: e.章号, 动词: e.动词, 证据: e.证据 })
          }
          writeLead(leadFile, r.lead)
        }
      }
    }
  }

  // 章摘要
  if (input.chapterSummary) {
    const summaryDir = join(bookRoot, '定稿', '摘要', '章摘要')
    writeFileSync(join(summaryDir, `${chapter.章号}.md`), input.chapterSummary, 'utf-8')
  }

  // ③ git add + commit（原子点）
  const confirm = readConfirm(workDir)
  const trailer = confirm
    ? `\n\nConfirmed: ${confirm.confirmed_at} mode=${confirm.mode} hash=${confirm.outline_hash}`
    : ''
  // commit msg 前缀贴 ⑯ 第 4 节：ch:<4 位补零章号>（对齐 定稿/正文/0152-标题.md 补零约定，供 M3 回滚按 ch:<章号> grep 定位）
  const commitMsg = `ch:${String(chapter.章号).padStart(4, '0')} ${chapter.标题}${trailer}`

  // ③ git add + commit（原子点）—— 经 ⑯ git 隐身层 addCommit（集中收口 + 人话）
  const commit = addCommit(bookRoot, commitMsg)
  if (!commit.ok) {
    return { ok: false, reason: commit.humanMsg }
  }
  const commitHash = commit.hash

  // ④ 清空工作区
  clearWorkDir(workDir)

  // ⑤ 重建缓存
  const cachePath = join(bookRoot, '.cache', 'index.db')
  rebuild(bookRoot, cachePath)

  return { ok: true, commitHash }
}

/** 清空工作区（删草稿/细纲/材料/确认记录） */
function clearWorkDir(workDir: string): void {
  const toDelete = ['草稿-1.md', '细纲.md', '本章写作材料.md', '审稿.md']
  for (const f of toDelete) {
    const fp = join(workDir, f)
    if (existsSync(fp)) unlinkSync(fp)
  }
  // 删所有草稿-*
  try {
    for (const f of readdirSync(workDir)) {
      if (f.startsWith('草稿-') || f.startsWith('._草稿-')) {
        unlinkSync(join(workDir, f))
      }
    }
  } catch {
    // 目录不存在无妨
  }
  clearConfirm(workDir)
}

/** 在大纲/ 下找某编号的账本文件 */
function findLeadFile(outlineDir: string, leadId: string): string | null {
  for (const typeDir of readdirSync(outlineDir)) {
    const dir = join(outlineDir, typeDir)
    if (!existsSync(dir)) continue
    try {
      for (const f of readdirSync(dir)) {
        if (f.startsWith(leadId + '-') && f.endsWith('.md') && !f.startsWith('._')) {
          return join(dir, f)
        }
      }
    } catch {
      // 非目录，跳过
    }
  }
  return null
}
