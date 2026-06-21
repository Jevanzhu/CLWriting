/**
 * `clwriting record-call <章号> --step <outline|draft> [书目录] [--calls N] [--tokens N]`
 * `clwriting record-call <章号> --step <outline|draft> [书目录] --set-tokens N`
 *
 * outline/draft 调用记账的薄门面（成本采集闭环方案 §1）。
 * 把宿主侧（outline/writer 角色）的模型调用接回已有的 recordAiCall（含预算闸 + entries 留痕），
 * 零改预算逻辑。review 仍由 `review collect` 内部自动记（review.ts），故此处拒绝 review*，
 * 避免重复记账。
 */

import process from 'node:process'
import { join } from 'node:path'
import { recordAiCall, setAiCallTokens, type AiCallStep } from '../ai/calls.js'
import { readBookConfig } from '../format/yaml.js'
import { resolveBookRoot } from '../install/books.js'

/** `record-call` 接受的 step（不含 review*，后者由 review collect 自动记） */
const ALLOWED_STEPS = new Set<AiCallStep>(['outline', 'draft'])

interface ParsedArgs {
  chapter: number
  step: string
  calls: number | undefined
  tokens: number | undefined
  setTokens: number | undefined
  positional: string[]
}

type ParseResult = ParsedArgs | { error: string }

/** `clwriting record-call <章号> --step <outline|draft> [--calls N] [--tokens N] [书目录]` 命令处理器 */
export function recordCallCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    printRecordCallHelp()
    return
  }

  const parsed = parseArgs(args)
  if (parsed === null) {
    printRecordCallHelp(console.error)
    process.exit(1)
  }
  if ('error' in parsed) {
    console.error(`✗ ${parsed.error}`)
    process.exit(1)
  }

  if (!Number.isSafeInteger(parsed.chapter) || parsed.chapter < 1) {
    console.error(`章号得是正整数，你给的是「${parsed.positional[0]}」。`)
    process.exit(1)
  }

  if (!ALLOWED_STEPS.has(parsed.step as AiCallStep)) {
    console.error(
      `✗ --step 只接受 outline / draft（review 由「review collect」自动记，无需手动 record-call）。你给的是「${parsed.step}」。`,
    )
    process.exit(1)
  }

  // positional[0]=章号，positional[1]=可选书目录
  const resolved = resolveBookRoot(parsed.positional.slice(1))
  if (!resolved.ok) {
    console.error(`✗ ${resolved.reason}`)
    process.exit(1)
  }
  const bookRoot = resolved.bookRoot
  const workDir = join(bookRoot, '工作区')
  const config = readBookConfig(join(bookRoot, 'book.yaml')).config
  const step = parsed.step as AiCallStep

  const recorded = parsed.setTokens !== undefined
    ? setAiCallTokens({
        workDir,
        chapter: parsed.chapter,
        config,
        step,
        tokens: parsed.setTokens,
      })
    : recordAiCall({
        workDir,
        chapter: parsed.chapter,
        config,
        step,
        ...(parsed.calls !== undefined ? { calls: parsed.calls } : {}),
        ...(parsed.tokens !== undefined ? { tokens: parsed.tokens } : {}),
      })
  if (!recorded.ok) {
    console.error(`✗ ${recorded.reason}`)
    process.exit(1)
  }

  const unit = (config.kind ?? 'long') === 'short' ? '篇' : '章'
  const limit = config.budget.calls_per_chapter
  const callsPart = parsed.calls !== undefined ? ` ×${parsed.calls}` : ''
  const tokensPart = parsed.tokens !== undefined ? `、tokens ${parsed.tokens}` : ''
  if (parsed.setTokens !== undefined) {
    console.log(`✓ 第 ${parsed.chapter} ${unit} ${step} 调用已回填 tokens ${parsed.setTokens}`)
  } else {
    console.log(`✓ 第 ${parsed.chapter} ${unit}已记一次 ${step} 调用${callsPart}${tokensPart}`)
  }
  console.log(`· 本章累计 ${recorded.record.used}/${limit} 次调用`)
}

/** 解析 `<章号> --step S [--calls N] [--tokens N] [书目录]`；缺必填返回 null，坏参数返回 error */
function parseArgs(args: string[]): ParseResult | null {
  let step: string | undefined
  let calls: number | undefined
  let tokens: number | undefined
  let setTokens: number | undefined
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--step') {
      step = args[++i]
    } else if (a === '--calls') {
      const parsed = parseIntegerOption('--calls', args[++i], { min: 1 })
      if (!parsed.ok) return { error: parsed.reason }
      calls = parsed.value
    } else if (a === '--tokens') {
      const parsed = parseIntegerOption('--tokens', args[++i], { min: 0 })
      if (!parsed.ok) return { error: parsed.reason }
      tokens = parsed.value
    } else if (a === '--set-tokens') {
      const parsed = parseIntegerOption('--set-tokens', args[++i], { min: 0 })
      if (!parsed.ok) return { error: parsed.reason }
      setTokens = parsed.value
    } else if (a.startsWith('--step=')) {
      step = a.slice('--step='.length)
    } else if (a.startsWith('--calls=')) {
      const parsed = parseIntegerOption('--calls', a.slice('--calls='.length), { min: 1 })
      if (!parsed.ok) return { error: parsed.reason }
      calls = parsed.value
    } else if (a.startsWith('--tokens=')) {
      const parsed = parseIntegerOption('--tokens', a.slice('--tokens='.length), { min: 0 })
      if (!parsed.ok) return { error: parsed.reason }
      tokens = parsed.value
    } else if (a.startsWith('--set-tokens=')) {
      const parsed = parseIntegerOption('--set-tokens', a.slice('--set-tokens='.length), { min: 0 })
      if (!parsed.ok) return { error: parsed.reason }
      setTokens = parsed.value
    } else {
      positional.push(a)
    }
  }

  if (!positional[0] || step === undefined) return null
  if (setTokens !== undefined && (calls !== undefined || tokens !== undefined)) {
    return { error: '--set-tokens 是回填模式，不能和 --calls / --tokens 混用。' }
  }
  const chapter = Number(positional[0])
  return { chapter, step, calls, tokens, setTokens, positional }
}

function parseIntegerOption(
  name: '--calls' | '--tokens' | '--set-tokens',
  raw: string | undefined,
  opts: { min: number },
): { ok: true; value: number } | { ok: false; reason: string } {
  if (raw === undefined || raw.startsWith('--')) {
    return { ok: false, reason: `${name} 需要一个数字参数。` }
  }
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < opts.min) {
    const requirement = opts.min === 1 ? '正整数' : '非负整数'
    return { ok: false, reason: `${name} 需要${requirement}，你给的是「${raw}」。` }
  }
  return { ok: true, value: n }
}

function printRecordCallHelp(write: (message: string) => void = console.log): void {
  write('用法：clwriting record-call <章号> --step <outline|draft> [书目录] [--calls N] [--tokens N]')
  write('回填：clwriting record-call <章号> --step <outline|draft> [书目录] --set-tokens N')
  write('记一次 outline/draft 的 AI 调用到预算闸（review 由 review collect 自动记）。')
  write('--calls N：本次调用次数（best-of-N 草稿传 N，默认 1）。')
  write('--tokens N：本次 token 消耗（宿主拿得到 usage 才填，可选）。')
  write('--set-tokens N：事后回填该 step 最近一次调用的 token 真值，不增加 calls。')
}
