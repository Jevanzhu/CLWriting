/**
 * `clwriting review` —— M4 #20/#22 三审门面。
 *
 * 三个子命令（脚本编排与宿主执行分离）：
 * - plan    输出本章审查档位与三审任务（只读，不调模型）
 * - run     打包执行包（档位 + 各视角任务书 + 正文 + 账本清单 + 输出契约），
 *           供宿主按视角调模型；预算闸在此校验并预留
 * - collect 宿主把各视角 issues JSON 回写到 工作区/三审/ 后，归一化生成审稿单
 *           （工作区/审稿.md），记账调用预算
 *
 * 真模型调用由宿主执行，脚本不内联；档位降级、证据硬闸、ledger 阻断全在脚本层。
 */

import process from 'node:process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getAiCallBudgetState, recordAiCall, type AiCallStep } from '../ai/calls.js'
import { readBookConfig } from '../format/yaml.js'
import { readFile, parseFlat } from '../format/frontmatter.js'
import { runAllChecks } from '../check/runner.js'
import { rebuild } from '../cache/rebuild.js'
import { buildReviewTasks, selectReviewTier, type ReviewHostCapabilities } from '../review/contract.js'
import {
  buildReviewPacket,
  collectReviewIssues,
  formatReviewPacket,
  writeReviewVerdict,
} from '../review/run.js'
import type { ChapterMeta, BookConfig } from '../format/types.js'

export function reviewCommand(args: string[]): void {
  const subcommand = args[0]
  if (subcommand === 'plan') return planCommand(args.slice(1))
  if (subcommand === 'run') return runCommand(args.slice(1))
  if (subcommand === 'collect') return collectCommand(args.slice(1))
  printReviewHelp()
  process.exit(1)
}

// ── review plan：输出档位与任务（只读）────────────────

function planCommand(args: string[]): void {
  const parsed = parseCommonArgs(args)
  if (!parsed.ok) {
    console.error(parsed.reason)
    printReviewHelp()
    process.exit(1)
  }
  const { config, workDir, remaining } = readReviewContext(parsed)
  const decision = selectReviewTier({
    capabilities: parsed.capabilities,
    remaining_calls: remaining.remaining,
    high_risk: parsed.highRisk,
  })
  if (!decision.ok) {
    console.error(`✗ ${decision.reason}`)
    process.exit(1)
  }
  const emptyReport = { sections: [] }
  const tasks = buildReviewTasks(emptyReport)
  console.log(`✓ 第 ${parsed.chapter} 章三审计划：${tierLabel(decision.tier)}（预计 ${decision.calls} 次 AI 调用）`)
  console.log(`· 请求档：${tierLabel(decision.requested_tier)}；实际档：${tierLabel(decision.tier)}；fallback：${decision.fallback}`)
  if (decision.downgrade_reason) console.log(`· 降级说明：${decision.downgrade_reason}`)
  console.log(`· 剩余调用预算：${remaining.remaining}`)
  console.log(`· 实跑视角：${decision.lenses_run.map(lensLabel).join(' / ')}；账本核对：${decision.ledger_check}`)
  console.log('· 三审任务：')
  for (const task of tasks) {
    console.log(`  - ${task.title}：${task.focus.join(' / ')}`)
  }
  console.log('· 账本核对：由机检 byproducts.leadChanges 接入设定校对；空清单不跳过设定校对。')
  void config
  void workDir
}

// ── review run：打包执行包（宿主据此调模型）──────────

function runCommand(args: string[]): void {
  const parsed = parseCommonArgs(args)
  if (!parsed.ok) {
    console.error(parsed.reason)
    printReviewHelp()
    process.exit(1)
  }
  const { config, workDir, remaining, bookRoot } = readReviewContext(parsed)

  // 预算闸：执行前校验本章余量是否够本次三审调用
  const decision = selectReviewTier({
    capabilities: parsed.capabilities,
    remaining_calls: remaining.remaining,
    high_risk: parsed.highRisk,
  })
  if (!decision.ok) {
    console.error(`✗ ${decision.reason}`)
    process.exit(1)
  }

  // 读草稿正文 + 跑机检（取 byproducts.leadChanges → 设定校对账本清单）
  const draft = readDraftForReview(bookRoot, parsed.draftPath)
  if (!draft.ok) {
    console.error(`✗ ${draft.reason}`)
    process.exit(1)
  }
  const cachePath = join(bookRoot, '.cache', 'index.db')
  const rebuilt = rebuild(bookRoot, cachePath)
  if (rebuilt.errors.length > 0) {
    console.error('✗ 源文件解析失败，先修这些文件：')
    for (const e of rebuilt.errors) console.error(`· ${e.file}${e.line > 0 ? ` 第${e.line}行` : ''}：${e.message}`)
    process.exit(1)
  }
  let checkReport
  const db = new DatabaseSync(cachePath)
  try {
    checkReport = runAllChecks({
      db, bookRoot, config,
      chapter: draft.chapter, body: draft.body,
      fileName: `${draft.chapter.章号}-${draft.chapter.标题}.md`,
    })
  } finally {
    db.close()
  }

  const built = buildReviewPacket({
    checkReport,
    body: draft.body,
    chapter: parsed.chapter,
    workDir,
    capabilities: parsed.capabilities,
    remaining_calls: remaining.remaining,
    high_risk: parsed.highRisk,
  })
  if (!built.ok) {
    console.error(`✗ ${built.reason}`)
    process.exit(1)
  }

  // 建 issues 回写目录
  mkdirSync(built.packet.out_dir, { recursive: true })

  console.log(formatReviewPacket(built.packet))
  console.log('')
  console.log(`预算校验通过：第 ${parsed.chapter} 章已用 ${remaining.used}/${remaining.limit}，本次三审预计 ${built.packet.planned_calls} 次调用。`)
  console.log('宿主按执行包各调一次模型，把 issues JSON 回写到上述目录后，运行：')
  console.log(`  clwriting review collect [书目录] --chapter=${parsed.chapter}`)
}

// ── review collect：回收 issues + 归一化 + 写审稿单 ──────

function collectCommand(args: string[]): void {
  const parsed = parseCommonArgs(args)
  if (!parsed.ok) {
    console.error(parsed.reason)
    printReviewHelp()
    process.exit(1)
  }
  const { config, workDir, remaining, bookRoot } = readReviewContext(parsed)

  // 重算执行包（与 run 同构，collect 据此知道期望哪些 issues 文件 + tier）
  const draft = readDraftForReview(bookRoot, parsed.draftPath)
  if (!draft.ok) {
    console.error(`✗ ${draft.reason}`)
    process.exit(1)
  }
  const cachePath = join(bookRoot, '.cache', 'index.db')
  const rebuilt = rebuild(bookRoot, cachePath)
  if (rebuilt.errors.length > 0) {
    console.error('✗ 源文件解析失败，先修这些文件后再 collect。')
    process.exit(1)
  }
  let checkReport
  const db = new DatabaseSync(cachePath)
  try {
    checkReport = runAllChecks({
      db, bookRoot, config,
      chapter: draft.chapter, body: draft.body,
      fileName: `${draft.chapter.章号}-${draft.chapter.标题}.md`,
    })
  } finally {
    db.close()
  }

  const built = buildReviewPacket({
    checkReport,
    body: draft.body,
    chapter: parsed.chapter,
    workDir,
    capabilities: parsed.capabilities,
    remaining_calls: remaining.remaining,
    high_risk: parsed.highRisk,
  })
  if (!built.ok) {
    console.error(`✗ ${built.reason}`)
    process.exit(1)
  }

  const collected = collectReviewIssues({ packet: built.packet })
  const path = writeReviewVerdict(workDir, collected)

  // 记账调用预算（三审消耗 planned_calls 次）
  const step: AiCallStep = built.packet.tier === 'combined' ? 'review-combined' : 'review'
  const recorded = recordAiCall({
    workDir, chapter: parsed.chapter, config,
    step, calls: built.packet.planned_calls,
    note: `${built.packet.tier} 三审`,
  })

  console.log(`✓ 三审回收完成，审稿单已写入 ${path}`)
  console.log(`· 档位：${tierLabel(collected.tier)}；视角：${collected.collected_lenses.map(lensLabel).join(' / ')}`)
  if (collected.missing_lenses.length > 0) {
    console.log(`· ⚠ 缺失视角：${collected.missing_lenses.map(lensLabel).join(' / ')}（审稿单不成立，需补跑）`)
  }
  if (collected.bad_entries.length > 0) {
    console.log(`· ⚠ 损坏回收：${collected.bad_entries.map((b) => `${b.path}（${b.reason}）`).join('；')}`)
  }
  console.log(`· 阻断项：${collected.normalized.blockers.length}；警告项：${collected.normalized.warnings.length}；无效 issue：${collected.normalized.invalid_issues.length}`)
  const ledgerBlockers = collected.normalized.blockers.filter((i) => i.category === 'ledger').length
  if (ledgerBlockers > 0) {
    console.log(`· ⚠ 其中账本核对阻断 ${ledgerBlockers} 项（设定校对逮到账本问题）`)
  }
  console.log(`· 审稿单成立：${collected.normalized.passed && collected.ok ? '是' : '否'}`)
  if (!recorded.ok) {
    console.log(`· ⚠ 预算记账失败：${recorded.reason}（审稿单已写，但调用计数未更新）`)
  } else {
    console.log(`· 调用记账：${step} +${built.packet.planned_calls}（第 ${parsed.chapter} 章已用 ${recorded.record.used}/${recorded.record.limit_override ?? config.budget.calls_per_chapter}）`)
  }
  console.log('作者拍板后在审稿单写「verdict: 通过」，即可 finalize。')
}

// ── 共用解析 ─────────────────────────────────────

type ParsedArgs =
  | {
      ok: true
      bookRoot: string
      chapter: number
      draftPath: string
      remainingCalls?: number
      highRisk: boolean
      capabilities: ReviewHostCapabilities
    }
  | { ok: false; reason: string }

function parseCommonArgs(args: string[]): ParsedArgs {
  const chapterArg = args.find((arg) => arg.startsWith('--chapter='))
  const chapter = chapterArg ? Number(chapterArg.slice('--chapter='.length)) : NaN
  if (!Number.isSafeInteger(chapter) || chapter < 1) {
    return { ok: false, reason: '章号得用 --chapter=N 指定正整数。' }
  }

  const remainingArg = args.find((arg) => arg.startsWith('--remaining='))
  const remainingCalls = remainingArg === undefined ? undefined : Number(remainingArg.slice('--remaining='.length))
  if (remainingCalls !== undefined && (!Number.isSafeInteger(remainingCalls) || remainingCalls < 0)) {
    return { ok: false, reason: '剩余调用次数得是非负整数。' }
  }

  const positional = args.filter((arg) => !arg.startsWith('--'))
  const bookRoot = positional[0] ? resolve(positional[0]) : process.cwd()
  const highRisk = args.includes('--high-risk')
  const capabilities = parseCapabilities(args)
  const draftPath = positional[1]?.endsWith('.md')
    ? resolve(positional[1])
    : join(bookRoot, '工作区', '草稿-1.md')

  return {
    ok: true,
    bookRoot,
    chapter,
    draftPath,
    ...(remainingCalls !== undefined ? { remainingCalls } : {}),
    highRisk,
    capabilities,
  }
}

function parseCapabilities(args: string[]): ReviewHostCapabilities {
  if (args.includes('--parallel')) return { parallel_subagents: true, multiple_calls: true }
  if (args.includes('--single')) return { parallel_subagents: false, multiple_calls: false }
  return { parallel_subagents: false, multiple_calls: true }
}

/** 读预算余量（--remaining 覆盖；否则读工作区 .ai-calls.json）。 */
function readReviewContext(parsed: Extract<ParsedArgs, { ok: true }>): {
  config: BookConfig
  workDir: string
  remaining: { remaining: number; used: number; limit: number }
  bookRoot: string
} {
  const config = readBookConfig(join(parsed.bookRoot, 'book.yaml')).config
  const workDir = join(parsed.bookRoot, '工作区')
  const remaining = parsed.remainingCalls === undefined
    ? readRemainingFromBudget(workDir, parsed.chapter, config)
    : { remaining: parsed.remainingCalls, used: 0, limit: config.budget.calls_per_chapter }
  return { config, workDir, remaining, bookRoot: parsed.bookRoot }
}

function readRemainingFromBudget(
  workDir: string,
  chapter: number,
  config: BookConfig,
): { remaining: number; used: number; limit: number } {
  const state = getAiCallBudgetState(workDir, chapter, config)
  if (!state.ok) {
    console.error(`✗ ${state.reason}`)
    process.exit(1)
  }
  return { remaining: state.remaining, used: state.used, limit: state.limit }
}

function readDraftForReview(
  bookRoot: string,
  draftPath: string,
): { ok: true; chapter: ChapterMeta; body: string } | { ok: false; reason: string } {
  if (!existsSync(draftPath)) return { ok: false, reason: `草稿不存在：${draftPath}` }
  const file = readFile(draftPath)
  if (!file.ok) return { ok: false, reason: file.error.message }
  const fm = parseFlat(file.fmRaw)
  const chapterNum = Number(fm.get('章号'))
  const title = String(fm.get('标题') ?? '')
  const meta: ChapterMeta = {
    章号: chapterNum,
    标题: title,
    钩子类型: '悬念钩',
    钩子强弱: '强',
    情绪定位: '铺垫',
  }
  void bookRoot
  return { ok: true, chapter: meta, body: file.body }
}

function tierLabel(tier: 'full' | 'sequential' | 'combined'): string {
  if (tier === 'full') return '满审'
  if (tier === 'sequential') return '顺序审'
  return '合审'
}

function lensLabel(lens: 'reader' | 'editor' | 'continuity'): string {
  if (lens === 'reader') return '读者审'
  if (lens === 'editor') return '编辑审'
  return '设定校对'
}

function printReviewHelp(): void {
  console.error('用法：')
  console.error('  clwriting review plan [书目录] --chapter=N [--parallel|--multi|--single] [--remaining=N] [--high-risk]')
  console.error('  clwriting review run  [书目录] --chapter=N [--parallel|--multi|--single] [--high-risk] [草稿文件]')
  console.error('  clwriting review collect [书目录] --chapter=N [--high-risk] [草稿文件]')
}
