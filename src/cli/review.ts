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
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getAiCallBudgetState, recordAiCall, type AiCallStep } from '../ai/calls.js'
import { hashFile } from '../gate/confirm.js'
import { readBookConfig } from '../format/yaml.js'
import { readFile, parseFlat } from '../format/frontmatter.js'
import { readPiece } from '../format/pieces.js'
import { runAllChecks } from '../check/runner.js'
import { rebuild } from '../cache/rebuild.js'
import { buildReviewTasks, selectReviewTier, type ReviewHostCapabilities } from '../review/contract.js'
import {
  buildReviewPacket,
  collectReviewIssues,
  formatReviewPacket,
  readReviewPacket,
  writeReviewPacket,
  writeReviewVerdict,
} from '../review/run.js'
import type { ChapterMeta, BookConfig } from '../format/types.js'
import { resolveBookRoot } from '../install/books.js'
import { readOutlineLeads } from '../process/materials.js'
import { aggregateLeadUpdates, readChapterLeadUpdates } from '../process/lead-updates.js'
import {
  finalizePendingChapters,
  listPendingChapters,
  rejectPendingChapter,
  rollbackPendingBatch,
} from '../auto/review-batch.js'

export function reviewCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    printReviewHelp(true)
    return
  }

  const subcommand = args[0]
  if (subcommand === 'plan') return planCommand(args.slice(1))
  if (subcommand === 'run') return runCommand(args.slice(1))
  if (subcommand === 'collect') return collectCommand(args.slice(1))
  if (subcommand === 'batch') return batchCommand(args.slice(1))
  printReviewHelp(false)
  process.exit(1)
}

// ── review plan：输出档位与任务（只读）────────────────

function planCommand(args: string[]): void {
  const parsed = parseCommonArgs(args)
  if (!parsed.ok) {
    console.error(parsed.reason)
    printReviewHelp(false)
    process.exit(1)
  }
  const { config, workDir, remaining } = readReviewContext(parsed)
  const kind = config.kind ?? 'long'
  const isShort = kind === 'short'
  const unit = isShort ? '篇' : '章'
  const decision = selectReviewTier({
    capabilities: parsed.capabilities,
    remaining_calls: remaining.remaining,
    high_risk: parsed.highRisk,
    kind,
  })
  if (!decision.ok) {
    console.error(`✗ ${decision.reason}`)
    process.exit(1)
  }
  const emptyReport = { sections: [] }
  const tasks = buildReviewTasks(emptyReport, kind)
  console.log(`✓ 第 ${parsed.chapter} ${unit}三审计划：${tierLabel(decision.tier)}（预计 ${decision.calls} 次 AI 调用）`)
  console.log(`· 请求档：${tierLabel(decision.requested_tier)}；实际档：${tierLabel(decision.tier)}；fallback：${decision.fallback}`)
  if (decision.downgrade_reason) console.log(`· 降级说明：${decision.downgrade_reason}`)
  console.log(`· 剩余调用预算：${remaining.remaining}`)
  const checkLabel = isShort ? '清单核对' : '账本核对'
  console.log(`· 实跑视角：${decision.lenses_run.map(lensLabel).join(' / ')}；${checkLabel}：${decision.ledger_check}`)
  console.log('· 三审任务：')
  for (const task of tasks) {
    console.log(`  - ${task.title}：${task.focus.join(' / ')}`)
  }
  if (isShort) {
    console.log('· 清单核对：设定收尾审对 清单.md（反转线索表 + 伏笔回收）逐条核对；机检形式检挡在前。')
  } else {
    console.log('· 账本核对：由机检 byproducts.leadChanges 接入设定校对；空清单不跳过设定校对。')
  }
  void workDir
}

// ── review run：打包执行包（宿主据此调模型）──────────

function runCommand(args: string[]): void {
  const parsed = parseCommonArgs(args)
  if (!parsed.ok) {
    console.error(parsed.reason)
      printReviewHelp(false)
    process.exit(1)
  }
  const { config, workDir, remaining, bookRoot } = readReviewContext(parsed)

  // 预算闸：执行前校验本章余量是否够本次三审调用
  const isShort = (config.kind ?? 'long') === 'short'
  const decision = selectReviewTier({
    capabilities: parsed.capabilities,
    remaining_calls: remaining.remaining,
    high_risk: parsed.highRisk,
    kind: config.kind ?? 'long',
  })
  if (!decision.ok) {
    console.error(`✗ ${decision.reason}`)
    process.exit(1)
  }

  // 读草稿正文 + 跑机检（长篇取 byproducts.leadChanges；短篇无账本，机检走短篇分支）
  const draft = readDraftForReview(bookRoot, parsed.draftPath, isShort)
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
    const leadUpdates = isShort ? [] : aggregateLeadUpdates(readChapterLeadUpdates(workDir), draft.body, draft.chapter.章号)
    const fileName = isShort
      ? `${String(draft.chapter.章号).padStart(3, '0')}-${draft.chapter.标题}/正文.md`
      : `${draft.chapter.章号}-${draft.chapter.标题}.md`
    checkReport = runAllChecks({
      db: isShort ? undefined : db,
      bookRoot, config,
      chapter: draft.chapter, body: draft.body,
      fileName,
      declaredLeadIds: isShort ? undefined : readOutlineLeads(workDir),
      actualLeadIds: isShort ? undefined : leadUpdates.map((u) => u.leadId),
    })
    if (!isShort && leadUpdates.length > 0) {
      checkReport.byproducts = {
        ...checkReport.byproducts,
        leadChanges: [
          ...(checkReport.byproducts?.leadChanges ?? []),
          ...leadUpdates.flatMap((update) => update.entries.map((entry) => ({
            leadId: update.leadId,
            chapter: entry.章号,
            verb: entry.动词,
            evidence: entry.证据,
          }))),
        ],
      }
    }
  } finally {
    db.close()
  }

  const built = buildReviewPacket({
    checkReport,
    body: draft.body,
    chapter: parsed.chapter,
    draft_path: parsed.draftPath,
    draft_hash: hashFile(parsed.draftPath),
    workDir,
    capabilities: parsed.capabilities,
    remaining_calls: remaining.remaining,
    high_risk: parsed.highRisk,
    kind: config.kind ?? 'long',
  })
  if (!built.ok) {
    console.error(`✗ ${built.reason}`)
    process.exit(1)
  }

  // 建 issues 回写目录
  mkdirSync(built.packet.out_dir, { recursive: true })
  const packetPath = writeReviewPacket(built.packet)

  console.log(formatReviewPacket(built.packet))
  console.log('')
  console.log(`执行包已写入：${packetPath}`)
  console.log(`预算校验通过：第 ${parsed.chapter} ${isShort ? '篇' : '章'}已用 ${remaining.used}/${remaining.limit}，本次三审预计 ${built.packet.planned_calls} 次调用。`)
  console.log('宿主按执行包各调一次模型，把 issues JSON 回写到上述目录后，运行：')
  const defaultWorkDir = join(bookRoot, '工作区')
  const collectHint = workDir === defaultWorkDir
    ? `clwriting review collect [书目录] --chapter=${parsed.chapter}`
    : `clwriting review collect [书目录] --chapter=${parsed.chapter} ${parsed.draftPath}`
  console.log(`  ${collectHint}`)
}

// ── review collect：回收 issues + 归一化 + 写审稿单 ──────

function collectCommand(args: string[]): void {
  const parsed = parseCommonArgs(args)
  if (!parsed.ok) {
    console.error(parsed.reason)
      printReviewHelp(false)
    process.exit(1)
  }
  const { config, workDir } = readReviewContext(parsed)
  const isShort = (config.kind ?? 'long') === 'short'
  const unit = isShort ? '篇' : '章'
  const loaded = readReviewPacket(workDir)
  if (!loaded.ok) {
    console.error(`✗ ${loaded.reason}`)
    process.exit(1)
  }
  const packet = loaded.packet
  if (packet.chapter !== parsed.chapter) {
    console.error(`✗ 三审执行包是第 ${packet.chapter} ${unit}，但当前 collect 指定第 ${parsed.chapter} ${unit}。请重新 review run。`)
    process.exit(1)
  }
  const draftPath = packet.draft_path ?? parsed.draftPath
  if (packet.draft_hash) {
    if (!existsSync(draftPath)) {
      console.error(`✗ 三审执行包对应的草稿不存在：${draftPath}`)
      process.exit(1)
    }
    const currentHash = hashFile(draftPath)
    if (currentHash !== packet.draft_hash) {
      console.error('✗ 草稿在 review run 之后发生变化。请重新运行 clwriting review run。')
      process.exit(1)
    }
  }

  const collected = collectReviewIssues({ packet })
  const path = writeReviewVerdict(workDir, collected)

  // 记账调用预算（三审消耗 planned_calls 次）
  const step: AiCallStep = packet.tier === 'combined' ? 'review-combined' : 'review'
  const recorded = recordAiCall({
    workDir, chapter: parsed.chapter, config,
    step, calls: packet.planned_calls,
    note: `${packet.tier} 三审`,
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
    console.log(`· 调用记账：${step} +${packet.planned_calls}（第 ${parsed.chapter} ${unit}已用 ${recorded.record.used}/${recorded.record.limit_override ?? config.budget.calls_per_chapter}）`)
  }
  console.log('作者拍板后在审稿单写「verdict: 通过」，即可 finalize。')
}

// ── review batch：批量审稿入口（M6 #35）────────────

function batchCommand(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    printReviewHelp(true)
    return
  }
  const knownActions = new Set(['list', 'finalize', 'reject', 'rollback'])
  const first = args[0]
  const action = first && knownActions.has(first) ? first : 'list'
  const rest = action === 'list' && first !== 'list' ? args : args.slice(1)

  if (action === 'list') return batchListCommand(rest)
  if (action === 'finalize') return batchFinalizeCommand(rest)
  if (action === 'reject') return batchRejectCommand(rest)
  return batchRollbackCommand(rest)
}

function batchListCommand(args: string[]): void {
  const bookRoot = resolveBatchBookRoot(args)
  const unit = readBatchUnit(bookRoot)
  const chapters = listPendingChapters(bookRoot)
  if (chapters.length === 0) {
    console.log(`没有待审${unit}。`)
    return
  }
  console.log(`待审${unit} ${chapters.length} ${unit}：`)
  for (const ch of chapters) {
    const verdict = ch.verdict === 'approved' ? '已通过' : ch.verdict === 'rejected' ? '已打回' : '未裁决'
    console.log(`· 第 ${ch.chapter} ${unit} ${ch.title}：${verdict}`)
  }
  console.log('通过后运行：clwriting review batch finalize [书目录]')
}

function batchFinalizeCommand(args: string[]): void {
  const bookRoot = resolveBatchBookRoot(args)
  const unit = readBatchUnit(bookRoot)
  const chapter = readOptionalChapter(args)
  const targets = chapter === undefined
    ? listPendingChapters(bookRoot).filter((ch) => ch.verdict === 'approved').map((ch) => ch.chapter)
    : [chapter]
  if (targets.length === 0) {
    console.log(`没有已通过裁决的待定稿${unit}可定稿。`)
    return
  }

  const results = finalizePendingChapters(bookRoot, targets)
  let failed = false
  for (const r of results) {
    if (r.ok) {
      console.log(`✓ 第 ${r.chapter} ${unit}已定稿（commit ${r.commitHash}）`)
    } else {
      failed = true
      console.error(`✗ 第 ${r.chapter} ${unit}定稿失败：${r.reason}`)
    }
  }
  if (failed) process.exit(1)
}

function batchRejectCommand(args: string[]): void {
  const bookRoot = resolveBatchBookRoot(args)
  const unit = readBatchUnit(bookRoot)
  const chapter = readRequiredChapter(args)
  const reason = readStringFlag(args, '--reason') ?? '作者打回'
  const result = rejectPendingChapter(bookRoot, chapter, reason)
  if (!result.ok) {
    console.error(`✗ ${result.reason}`)
    process.exit(1)
  }
  console.log(`✓ 第 ${chapter} ${unit}已打回，移入 .isolated。`)
}

function batchRollbackCommand(args: string[]): void {
  const bookRoot = resolveBatchBookRoot(args)
  const unit = readBatchUnit(bookRoot)
  if (!args.includes('--yes')) {
    console.error('✗ 整批回滚会删除未定稿待定稿目录；确认执行请加 --yes。')
    process.exit(1)
  }
  const result = rollbackPendingBatch(bookRoot)
  if (!result.ok) {
    console.error(`✗ ${result.reason}`)
    process.exit(1)
  }
  console.log(`✓ 已清理待定稿，共 ${result.cleared} 个${unit}目录。`)
}

function resolveBatchBookRoot(args: string[]): string {
  const positional = args.filter((arg) => !arg.startsWith('--'))
  const bookResolved = resolveBookRoot(undefined, positional[0])
  if (!bookResolved.ok) {
    console.error(`✗ ${bookResolved.reason}`)
    process.exit(1)
  }
  return bookResolved.bookRoot
}

function readBatchUnit(bookRoot: string): '章' | '篇' {
  const config = readBookConfig(join(bookRoot, 'book.yaml')).config
  return config.kind === 'short' ? '篇' : '章'
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
  // bookRoot 走 resolveBookRoot（支持活动书/cwd 兜底）；positional[0] 是显式书目录
  const bookResolved = resolveBookRoot(undefined, positional[0])
  if (!bookResolved.ok) {
    return { ok: false, reason: bookResolved.reason }
  }
  const bookRoot = bookResolved.bookRoot
  const highRisk = args.includes('--high-risk')
  const capabilities = parseCapabilities(args)
  // 草稿路径：显式参数 > 按 --chapter=N 推导「草稿-N.md」> 回落草稿-1.md
  // （smoke 实测发现原硬编码草稿-1.md 导致第 N≠1 章必须显式传路径，DX 差）
  const explicitDraft = positional[1]?.endsWith('.md') ? resolve(positional[1]) : undefined
  const draftByChapter = join(bookRoot, '工作区', `草稿-${chapter}.md`)
  const draftPath = explicitDraft
    ?? (existsSync(draftByChapter) ? draftByChapter : join(bookRoot, '工作区', '草稿-1.md'))

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

function readOptionalChapter(args: string[]): number | undefined {
  const value = readStringFlag(args, '--chapter')
  if (value === undefined) return undefined
  const chapter = Number(value)
  if (!Number.isSafeInteger(chapter) || chapter < 1) {
    console.error('✗ 章号得用 --chapter=N 指定正整数。')
    process.exit(1)
  }
  return chapter
}

function readRequiredChapter(args: string[]): number {
  const chapter = readOptionalChapter(args)
  if (chapter === undefined) {
    console.error('✗ 章号得用 --chapter=N 指定正整数。')
    process.exit(1)
  }
  return chapter
}

function readStringFlag(args: string[], flag: string): string | undefined {
  const eq = args.find((arg) => arg.startsWith(`${flag}=`))
  if (eq) return eq.slice(flag.length + 1)
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  const value = args[idx + 1]
  return value && !value.startsWith('--') ? value : undefined
}

/** 读预算余量（--remaining 覆盖；否则读工作区 .ai-calls.json）。 */
function readReviewContext(parsed: Extract<ParsedArgs, { ok: true }>): {
  config: BookConfig
  workDir: string
  remaining: { remaining: number; used: number; limit: number }
  bookRoot: string
} {
  const config = readBookConfig(join(parsed.bookRoot, 'book.yaml')).config
  const workDir = dirname(parsed.draftPath)
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
  isShort: boolean,
): { ok: true; chapter: ChapterMeta; body: string } | { ok: false; reason: string } {
  if (!existsSync(draftPath)) return { ok: false, reason: `草稿不存在：${draftPath}` }
  const file = readFile(draftPath)
  if (!file.ok) return { ok: false, reason: file.error.message }
  if (isShort) {
    const piece = readPiece(draftPath)
    if (!piece.ok) return { ok: false, reason: piece.error.message }
    const raw: Record<string, string> = { ...(piece.piece._raw ?? {}) }
    if (piece.piece.目标情绪) raw['目标情绪'] = piece.piece.目标情绪
    if (piece.piece.核心反转) raw['核心反转'] = piece.piece.核心反转
    return {
      ok: true,
      chapter: {
        章号: piece.piece.篇号,
        标题: piece.piece.标题,
        钩子类型: '悬念钩',
        钩子强弱: '中',
        情绪定位: '铺垫',
        ...(Object.keys(raw).length > 0 ? { _raw: raw } : {}),
        _path: piece.piece._path,
      },
      body: file.body,
    }
  }
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

function lensLabel(lens: string): string {
  if (lens === 'reader') return '读者审'
  if (lens === 'editor') return '编辑审'
  if (lens === 'continuity') return '设定校对'
  if (lens === 'hook') return '钩子审'
  if (lens === 'emotion_peak') return '情绪反转审'
  return '设定收尾审'
}

function printReviewHelp(toStdout: boolean): void {
  const write = toStdout ? console.log : console.error
  write('用法：')
  write('  clwriting review plan [书目录] --chapter=N [--parallel|--multi|--single] [--remaining=N] [--high-risk]')
  write('  clwriting review run  [书目录] --chapter=N [--parallel|--multi|--single] [--high-risk] [草稿文件]')
  write('  clwriting review collect [书目录] --chapter=N [--high-risk] [草稿文件]')
  write('  clwriting review batch [list] [书目录]')
  write('  clwriting review batch finalize [书目录] [--chapter=N]')
  write('  clwriting review batch reject [书目录] --chapter=N [--reason=原因]')
  write('  clwriting review batch rollback [书目录] --yes')
  write('')
  write('说明：草稿文件可指向 工作区/草稿-1.md 或 工作区/待定稿/<章或篇>/草稿-1.md；review run/collect 会使用草稿所在目录读写三审产物。')
}
