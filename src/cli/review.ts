/**
 * `clwriting review plan` —— M4 #20/#22 三审任务书与审查档位薄门面。
 *
 * 只做确定性计划：读取 book.yaml + 调用预算状态，给出本章应跑的审查档位和三审任务。
 * 真模型调用与审稿单写入后续接入。
 */

import process from 'node:process'
import { join, resolve } from 'node:path'
import { getAiCallBudgetState } from '../ai/calls.js'
import { readBookConfig } from '../format/yaml.js'
import { buildReviewTasks, selectReviewTier, type ReviewHostCapabilities } from '../review/contract.js'
import type { CheckReport } from '../check/types.js'

/** `clwriting review plan [书目录] --chapter=N [--parallel|--multi|--single] [--remaining=N] [--high-risk]` */
export function reviewCommand(args: string[]): void {
  const subcommand = args[0]
  if (subcommand !== 'plan') {
    printReviewHelp()
    process.exit(1)
  }

  const parsed = parsePlanArgs(args.slice(1))
  if (!parsed.ok) {
    console.error(parsed.reason)
    printReviewHelp()
    process.exit(1)
  }

  const config = readBookConfig(join(parsed.bookRoot, 'book.yaml')).config
  const workDir = join(parsed.bookRoot, '工作区')
  const remainingResult = parsed.remainingCalls === undefined
    ? readRemainingCalls(workDir, parsed.chapter, config)
    : { ok: true as const, remaining: parsed.remainingCalls }
  if (!remainingResult.ok) {
    console.error(`✗ ${remainingResult.reason}`)
    process.exit(1)
  }

  const decision = selectReviewTier({
    capabilities: parsed.capabilities,
    remaining_calls: remainingResult.remaining,
    high_risk: parsed.highRisk,
  })
  if (!decision.ok) {
    console.error(`✗ ${decision.reason}`)
    process.exit(1)
  }

  const emptyCheckReport: CheckReport = { sections: [] }
  const tasks = buildReviewTasks(emptyCheckReport)

  console.log(`✓ 第 ${parsed.chapter} 章三审计划：${tierLabel(decision.tier)}（预计 ${decision.calls} 次 AI 调用）`)
  console.log(`· 请求档：${tierLabel(decision.requested_tier)}；实际档：${tierLabel(decision.tier)}；fallback：${decision.fallback}`)
  if (decision.downgrade_reason) console.log(`· 降级说明：${decision.downgrade_reason}`)
  console.log(`· 剩余调用预算：${remainingResult.remaining}`)
  console.log(`· 实跑视角：${decision.lenses_run.map(lensLabel).join(' / ')}；账本核对：${decision.ledger_check}`)
  console.log('· 三审任务：')
  for (const task of tasks) {
    console.log(`  - ${task.title}：${task.focus.join(' / ')}`)
  }
  console.log('· 账本核对：由机检 byproducts.leadChanges 接入设定校对；空清单不跳过设定校对。')
}

type ParsedPlanArgs =
  | {
      ok: true
      bookRoot: string
      chapter: number
      remainingCalls?: number
      highRisk: boolean
      capabilities: ReviewHostCapabilities
    }
  | { ok: false; reason: string }

function parsePlanArgs(args: string[]): ParsedPlanArgs {
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

  return {
    ok: true,
    bookRoot,
    chapter,
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

function readRemainingCalls(
  workDir: string,
  chapter: number,
  config: Parameters<typeof getAiCallBudgetState>[2],
): { ok: true; remaining: number } | { ok: false; reason: string } {
  const state = getAiCallBudgetState(workDir, chapter, config)
  if (!state.ok) return { ok: false, reason: state.reason }
  return { ok: true, remaining: state.remaining }
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
  console.error('用法：clwriting review plan [书目录] --chapter=N [--parallel|--multi|--single] [--remaining=N] [--high-risk]')
}
