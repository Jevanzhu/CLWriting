/**
 * `clwriting learn` —— 文风样章/金句收割（M7 #38）。
 *
 * - `clwriting learn`：从定稿正文产候选（落 工作区/learn候选/）
 * - `clwriting learn commit`：交互式挑选候选入库（writeSample 到 #5 样章库）
 *
 * 独立命令、不挂 finalize。候选制、作者审核才入库。
 */

import process from 'node:process'
import readline from 'node:readline'
import { resolveBookRoot } from '../install/books.js'
import { learnFromBook, type SampleCandidate, type QuoteCandidate } from '../learn/index.js'
import { commitSamples, commitQuotes } from '../learn/commit.js'

/** `clwriting learn` / `clwriting learn commit` */
export function learnCommand(args: string[]): void {
  const sub = args[0]

  if (sub === '--help' || sub === '-h' || (sub === undefined && args.includes('--help'))) {
    printHelp()
    return
  }

  if (sub === 'commit') {
    learnCommit(args.slice(1))
    return
  }

  // 默认：产候选
  learnProduce(args)
}

function printHelp(): void {
  console.log('用法：clwriting learn [commit] [书目录]')
  console.log()
  console.log('  clwriting learn            从定稿正文产文风样章/金句候选（落 工作区/learn候选/）')
  console.log('  clwriting learn commit     交互式挑选候选入库到 #5 样章库/金句库')
  console.log()
  console.log('打分借 #10 机检（checkStyleMetrics + checkRepeat），低分过滤。')
  console.log('独立命令，不挂 finalize。候选制，作者审核才入库。')
}

/** 产候选 */
function learnProduce(args: string[]): void {
  const r = resolveBookRoot(args)
  if (!r.ok) {
    console.error(`✗ ${r.reason}`)
    process.exit(1)
  }
  const result = learnFromBook(r.bookRoot)
  if (!result.ok) {
    console.error(`✗ ${result.error}`)
    process.exit(1)
  }
  console.log(`✓ 已产 ${result.sampleCount} 个样章候选、${result.quoteCount} 个金句候选`)
  console.log(`  产物在 ${result.candidateDir}/`)
  console.log()
  console.log('下一步：')
  console.log('  clwriting learn commit  交互式挑选入库')
}

/** 交互式挑选入库 */
async function learnCommit(args: string[]): Promise<void> {
  const r = resolveBookRoot(args)
  if (!r.ok) {
    console.error(`✗ ${r.reason}`)
    process.exit(1)
  }

  // 重新跑 learn 产候选（候选在 工作区/learn候选/，但直接用内存结果更可靠）
  const result = learnFromBook(r.bookRoot)
  if (!result.ok) {
    console.error(`✗ ${result.error}`)
    process.exit(1)
  }
  if (!result.samples || result.samples.length === 0) {
    console.log('没有样章候选可入库。')
    return
  }

  // 非 TTY 报错（交互式需要 stdin，参考 init.ts:48-51）
  if (!process.stdin.isTTY) {
    console.error('✗ 非交互环境（无 TTY），learn commit 需要交互挑选。')
    process.exit(1)
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, (a) => res(a.trim())))

  const pickedSamples: SampleCandidate[] = []
  const pickedQuotes: QuoteCandidate[] = []
  let allMode = false

  try {
    console.log(`\n=== 样章候选（${result.samples.length} 个）===\n`)
    for (let i = 0; i < result.samples.length; i++) {
      const c = result.samples[i]!
      if (allMode) {
        pickedSamples.push(c)
        continue
      }
      console.log(`[${i + 1}/${result.samples.length}] 场景：${c.场景} | 打分：${c.打分} | ${c.出处}`)
      console.log(`  ${c.正文.slice(0, 80)}${c.正文.length > 80 ? '…' : ''}`)
      console.log()
      const ans = await ask('入库？[y=是 n=否 a=剩下全选 q=放弃] ')
      const lower = ans.toLowerCase()
      if (lower === 'y' || lower === '是') {
        pickedSamples.push(c)
      } else if (lower === 'a' || lower === '全选') {
        pickedSamples.push(c)
        allMode = true
      } else if (lower === 'q' || lower === '放弃' || lower === 'exit') {
        break
      }
      // n / 空 → 跳过
    }

    // 金句候选同样处理
    if (result.quotes && result.quotes.length > 0) {
      console.log(`\n=== 金句候选（${result.quotes.length} 个）===\n`)
      allMode = false
      for (let i = 0; i < result.quotes.length; i++) {
        const q = result.quotes[i]!
        if (allMode) {
          pickedQuotes.push(q)
          continue
        }
        console.log(`[${i + 1}] ${q.场景} | ${q.正文}`)
        const ans = await ask('入库？[y/n/a/q] ')
        const lower = ans.toLowerCase()
        if (lower === 'y' || lower === '是') {
          pickedQuotes.push(q)
        } else if (lower === 'a' || lower === '全选') {
          pickedQuotes.push(q)
          allMode = true
        } else if (lower === 'q' || lower === '放弃') {
          break
        }
      }
    }
  } finally {
    rl.close()
  }

  // 入库
  if (pickedSamples.length === 0 && pickedQuotes.length === 0) {
    console.log('未挑选任何候选，不入库。')
    return
  }

  console.log()
  if (pickedSamples.length > 0) {
    const files = commitSamples(r.bookRoot, pickedSamples)
    console.log(`✓ 入库 ${pickedSamples.length} 个样章：`)
    for (const f of files) console.log(`  ${f}`)
  }
  if (pickedQuotes.length > 0) {
    const files = commitQuotes(r.bookRoot, pickedQuotes)
    console.log(`✓ 入库 ${pickedQuotes.length} 条金句：`)
    for (const f of files) console.log(`  ${f}`)
  }
}
