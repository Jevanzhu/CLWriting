/**
 * `clwriting auto` —— M6 自动模式连写门面（#33/#34）。
 *
 * 对活动书连写 N 章（阶段 1–6 自动），产出攒进 待定稿/。
 * 停止四件套（预算/质量/需人/系统）任一触发即暂停问人。
 *
 * AI 步接缝：真模型产出由宿主（Claude Code/Codex）在编排点填入。
 * CLI 层无 TTY/无模型时，auto 输出编排骨架 + 提示「这是宿主驱动流程」。
 */

import process from 'node:process'
import { join } from 'node:path'
import { resolveBookRoot } from '../install/books.js'
import { readBookConfig } from '../format/yaml.js'
import { doAutoBatch, readBatchProgress, type ChapterProduction, type ProduceChapter } from '../auto/batch.js'

/** `clwriting auto [N] [--resume]` */
export async function autoCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printAutoHelp()
    return
  }

  const resume = args.includes('--resume')
  const positional = args.filter((a) => !a.startsWith('--'))
  // 第一个位置参可能是章数 N（数字）
  const n = positional.length > 0 && /^\d+$/.test(positional[0]!) ? Number(positional[0]) : undefined

  // 定位活动书
  const resolved = resolveBookRoot(args.filter((a) => !/^\d+$/.test(a)))
  if (!resolved.ok) {
    console.error(`✗ ${resolved.reason}`)
    process.exit(1)
  }
  const bookRoot = resolved.bookRoot
  const config = readBookConfig(join(bookRoot, 'book.yaml')).config
  const unit = config.kind === 'short' ? '篇' : '章'

  // 章/篇数：参数 > book.yaml batch_size > 默认 8
  const targetCount = n ?? config.auto.batch_size ?? 8

  // resume 模式：读既有批次进度
  if (resume) {
    const existing = readBatchProgress(bookRoot)
    if (!existing) {
      console.error('✗ 没有未完批次可恢复（工作区/待定稿/.auto-batch.json 不存在或损坏）。')
      process.exit(1)
    }
    console.log(`续跑批次：起始第 ${existing.start_chapter} ${unit}，已完成 ${existing.completed.length}/${existing.target_count}，下一${unit} ${existing.next_chapter}。`)
    if (existing.paused) {
      console.log(`上次暂停在第 ${existing.paused.at_chapter} ${unit}（${existing.paused.reason}：${existing.paused.detail}）。`)
      console.log(`确认触发原因已处理后，继续续写剩余${unit}。`)
    }
  } else {
    console.log(`连写 ${targetCount} ${unit}（活动书：${config.book.title || bookRoot}）。`)
  }

  // AI 步接缝：CLI 层无内置模型，produce 用占位实现提示宿主驱动
  // 真模型宿主（Claude Code/Codex）会在编排点接管 produce，产出细纲+正文（可 await tools.prepareMaterials 拿含 RAG 召回的备料）
  const produce: ProduceChapter = async ({ chapter, tools }) => {
    console.log(`\n▶ 第 ${chapter} ${unit}：宿主在此产出细纲 + 正文（AI 步接缝）。`)
    console.log('  连写编排已串联脚本步（确认/机检/三审）；真模型调用由宿主填入。')
    console.log('  备料含 RAG 召回：宿主在 produce 内 `await tools.prepareMaterials(leadIds)` 拿写作材料。')
    console.log('  CLI 直跑（无宿主）→ 返回需人停止。')
    // 证实 tools 已注入（CLI 无模型，仅展示备料降级能力：未配 RAG 时 prepareMaterials 也正常）
    const m = await tools.prepareMaterials([], `第${chapter}${unit}`)
    console.log(`  （备料预览：${m.ragUsed ? `含 RAG 召回 ${m.ragHitCount} 命中` : '无 RAG 召回（未配/降级）'}，材料 ${m.text.length} 字符）`)
    return { reason: 'human', detail: 'CLI 无内置模型，需宿主（Claude Code/Codex）驱动 AI 步产出' }
  }

  const result = await doAutoBatch({ bookRoot, targetCount, produce, resume })

  // 输出结果
  if (!result.ok) {
    console.error(`✗ ${result.reason}`)
    process.exit(1)
  }

  const { progress, produced } = result
  if (produced.length > 0) {
    console.log(`\n✓ 本轮连写产出 ${produced.length} ${unit}：第 ${produced.join('、')} ${unit}（已入待定稿）。`)
  }
  console.log(`批次进度：已完成 ${progress.completed.length}/${progress.target_count}，下一${unit} ${progress.next_chapter}。`)

  if (progress.paused) {
    console.log(`\n⚠ 连写暂停在第 ${progress.paused.at_chapter} ${unit}（${progress.paused.reason}：${progress.paused.detail}）。`)
    console.log('处理后用 `clwriting auto --resume` 续跑。')
  }

  if (progress.isolated.length > 0) {
    console.log(`\n⚠ 隔离 ${progress.isolated.length} ${unit}坏${unit}（不出批次）：`)
    for (const i of progress.isolated) {
      console.log(`  · 第 ${i.chapter} ${unit}（${i.reason}：${i.detail}）`)
    }
  }

  if (progress.completed.length >= progress.target_count && !progress.paused) {
    console.log('\n本批攒满，待审稿。敲 `clwriting enter` 看「待批量审稿」态。')
  }
}

function printAutoHelp(): void {
  console.log('用法：clwriting auto [N] [--resume]')
  console.log('')
  console.log('对活动书连写 N 章/篇（阶段 1–6 自动），产出攒进待定稿。')
  console.log('· auto       连写 batch_size 章/篇（默认 8）')
  console.log('· auto 3     连写 3 章/篇')
  console.log('· auto --resume   续跑未完批次（进度/计数继承不重置）')
  console.log('')
  console.log('停止四件套（预算/质量/需人/系统）任一触发即暂停问人。')
  console.log('AI 步（起草细纲/写稿/三审调模型）由宿主在编排点产出。')
}
