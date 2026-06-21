/**
 * 定稿原子 commit —— 依据 #13 定稿 commit spec。
 *
 * finalize 是写定稿区的唯一入口（#13 第 1 节）。
 * 一次 git commit = 原子点：commit 成功则定稿成立，失败/中断则定稿区无变化。
 *
 * 执行顺序（#13 第 4 节）：
 * 1. 前置闸（审稿裁决 / 形式三检 / 确认哈希）
 * 2. 写定稿区变更到工作树
 * 3. git add + 一次 git commit（原子点）
 * 4. 清空工作区
 * 5. 重建缓存
 *
 * 中断恢复（#13 第 5 节）：commit 前崩 = 工作区原样保留；commit 后崩 = 已定稿。
 */

import { copyFileSync, existsSync, writeFileSync, unlinkSync, readdirSync, mkdirSync, rmSync, rmdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { git, addCommit } from '../git/exec.js'
import type { DatabaseSync } from 'node:sqlite'
import type { ChapterMeta, BookConfig, PieceMeta } from '../format/types.js'
import { writeChapter } from '../format/chapters.js'
import { writePiece } from '../format/pieces.js'
import { writeLead, readLead } from '../format/leads.js'
import { checkConfirmGate, readConfirm, clearConfirm } from '../gate/confirm.js'
import { runAllChecks, hasRed } from '../check/runner.js'
import { formatRedForRewrite } from '../check/report.js'
import { rebuild } from '../cache/rebuild.js'
import type { ParseError } from '../format/types.js'
import { clearAiCallBudget } from '../ai/calls.js'
import { collectAndAppend } from '../metrics/collect.js'
import { readOutlineLeads } from '../process/materials.js'
import { aggregateLeadUpdates, readChapterLeadUpdates } from '../process/lead-updates.js'

/** finalize 前置闸检查结果（#13 第 2 节） */
export type FinalizeGateResult =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * finalize 前置闸（#13 第 2 节）。
 * - 审稿有作者裁决
 * - 确认记录哈希一致
 *
 * 账本形式三检不在此闸重复跑——已被随后的 checkFinalizeFullReport 通过
 * runAllChecks 覆盖（两者口径一致，幂等），避免双倍开销与文案分叉。
 */
export function checkFinalizeGate(
  workDir: string,
  outlinePath: string,
  hasReviewVerdict: boolean,
): FinalizeGateResult {
  // #1 审稿裁决
  if (!hasReviewVerdict) {
    return { ok: false, reason: '你还没拍板（审稿无作者裁决）' }
  }

  // #2 确认记录哈希
  const confirmGate = checkConfirmGate(workDir, outlinePath)
  if (!confirmGate.ok) {
    return { ok: false, reason: confirmGate.reason }
  }

  return { ok: true }
}

/**
 * 短篇前置闸（M8 #26）：只跑审稿裁决 + 确认哈希两道刚需闸，跳形式三检。
 * 短篇无七类长程账本（账本降级单篇清单 #27），形式三检对清单的适配归 #27；本期短篇 finalize 不跑形式三检。
 */
function checkFinalizeGateShort(
  workDir: string,
  outlinePath: string,
  hasReviewVerdict: boolean,
): FinalizeGateResult {
  // #1 审稿裁决（刚需）
  if (!hasReviewVerdict) {
    return { ok: false, reason: '你还没拍板（审稿无作者裁决）' }
  }
  // #2 确认记录哈希（刚需）
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
  /** 双轨标识（M8 #26）：long（缺省）→ ch: 前缀 + 定稿/正文/ + 账本摘要；short → pc: 前缀 + 篇/ + 跳账本摘要 */
  kind?: 'long' | 'short'
  /** 本章需更新的账本履历（leadId → 新增的履历行）；短篇无账本，不传 */
  leadUpdates?: { leadId: string; entries: { 章号: number; 动词: string; 证据: string }[] }[]
  /** 章摘要文本；短篇无分层摘要，不传 */
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
  const kind = input.kind ?? 'long'
  const isShort = kind === 'short'

  // #1 前置闸：长篇跑形式三检（账本对账）；短篇无七类账本，跳形式三检（清单核对归 #27），只留审稿裁决 + 确认哈希
  const gate = isShort
    ? checkFinalizeGateShort(workDir, outlinePath, hasReviewVerdict)
    : checkFinalizeGate(workDir, outlinePath, hasReviewVerdict)
  if (!gate.ok) return gate

  const effectiveLeadUpdates = isShort
    ? undefined
    : (input.leadUpdates ?? aggregateLeadUpdates(readChapterLeadUpdates(workDir), body, chapter.章号))
  const checkGate = checkFinalizeFullReport({ ...input, kind, leadUpdates: effectiveLeadUpdates })
  if (!checkGate.ok) return checkGate

  const occupied = findFinalizedUnit(bookRoot, chapter.章号, kind)
  if (occupied) {
    const unit = isShort ? '篇' : '章'
    return { ok: false, reason: `第 ${chapter.章号} ${unit}已定稿（${occupied}），拒绝覆盖已有正文。请改用下一${unit}号或先回滚。` }
  }

  if (!isShort) {
    const leadTargetCheck = validateLeadUpdateTargets(bookRoot, chapter.章号, effectiveLeadUpdates)
    if (!leadTargetCheck.ok) return { ok: false, reason: leadTargetCheck.reason }
  }

  // #2 写定稿区变更（记录改动路径，供 commit 失败时原子回滚，#13 第 4 节）
  const changedPaths: string[] = [] // 相对 bookRoot 的路径（commit 用 + 失败回滚用）

  if (isShort) {
    // 短篇落点：篇/<篇号>-<标题>/正文.md（M8 #26）；fileName 约定 = `<篇号>-<标题>/正文.md`，落 篇/ 下
    const pieceDirName = fileName.split('/')[0]!
    const chapterPath = join(bookRoot, '篇', fileName)
    // 篇目录可能不存在（新篇），写正文前建（fileName 含子路径，需 mkdir 父目录）
    mkdirSync(join(bookRoot, '篇', pieceDirName), { recursive: true })
    const chapterRel = `篇/${fileName}`
    // 短篇正文用 PieceMeta（篇号/标题/目标情绪/核心反转），从 ChapterMeta（章号承载篇号）映射；
    // 目标情绪/核心反转藏在 _raw（readDraft 短篇分支保留），无则按篇号/标题最小字段写
    const piece: PieceMeta = {
      篇号: chapter.章号,
      标题: chapter.标题,
      ...(chapter._raw ? { _raw: chapter._raw } : {}),
    }
    writePiece(chapterPath, piece, body)
    changedPaths.push(chapterRel)
    const sourceManifest = join(workDir, '清单.md')
    if (existsSync(sourceManifest)) {
      const manifestRel = `篇/${pieceDirName}/清单.md`
      copyFileSync(sourceManifest, join(bookRoot, manifestRel))
      changedPaths.push(manifestRel)
    }
  } else {
    // 长篇落点：定稿/正文/<章号>-<标题>.md（行为逐字节不变）
    const 正文dir = join(bookRoot, '定稿', '正文')
    const chapterPath = join(正文dir, fileName)
    const chapterRel = `定稿/正文/${fileName}`
    writeChapter(chapterPath, chapter, body)
    changedPaths.push(chapterRel)
  }

  // 账本履历更新（幂等 + 本章校验）。短篇无长程账本（降级单篇清单 #27），强制跳过
  if (!isShort && effectiveLeadUpdates) {
    for (const update of effectiveLeadUpdates) {
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
          // 记录账本路径（相对 bookRoot）供 commit + 回滚
          const leadRel = r.lead._path ? r.lead._path.slice(bookRoot.length + 1) : ''
          if (leadRel) changedPaths.push(leadRel.replace(/\\/g, '/'))
        }
      }
    }
  }

  // 章摘要（短篇无分层摘要 #27，强制跳过）
  let summaryRel: string | null = null
  if (!isShort && input.chapterSummary) {
    const summaryDir = join(bookRoot, '定稿', '摘要', '章摘要')
    summaryRel = `定稿/摘要/章摘要/${chapter.章号}.md`
    writeFileSync(join(summaryDir, `${chapter.章号}.md`), input.chapterSummary, 'utf-8')
    changedPaths.push(summaryRel)
  }

  // commit msg 前缀按 kind（M8 #26）：long → ch:<4 位补零章号>；short → pc:<3 位补零篇号>
  const confirm = readConfirm(workDir)
  const trailer = confirm
    ? `\n\nConfirmed: ${confirm.confirmed_at} mode=${confirm.mode} hash=${confirm.outline_hash}`
    : ''
  const prefix = isShort
    ? `pc:${String(chapter.章号).padStart(3, '0')}`
    : `ch:${String(chapter.章号).padStart(4, '0')}`
  const commitMsg = `${prefix} ${chapter.标题}${trailer}`

  // #3 git add + commit（原子点）—— 经 #16 git 隐身层 addCommit（集中收口 + 人话）
  const commit = addCommit(bookRoot, commitMsg, changedPaths)
  if (!commit.ok) {
    // 原子回滚（#13 第 4 节「commit 失败则定稿区无变化」）：撤销 #2 写入的定稿区改动，
    // 避免下次进门被状态机判为「态 3 未入账手改」。工作区原样保留（可续跑/可回滚）。
    rollbackWorktreeChanges(bookRoot, changedPaths)
    return { ok: false, reason: commit.humanMsg }
  }
  const commitHash = commit.hash

  // 落账成本/审查指标（指标方案 §3.1）：commit 成功后、clearWorkDir 前采集。
  // .ai-calls.json 和 三审/ 在 clearWorkDir 才删，必须在此之前读。
  // try/catch 不阻断定稿（指标是附带功能，同 markHealthCheckDone 容错风格）。
  try {
    collectAndAppend(bookRoot, workDir, {
      kind,
      num: chapter.章号,
      title: chapter.标题,
      body,
      config,
    })
  } catch {
    // 采集失败绝不阻断定稿
  }

  // #4 清空工作区
  clearWorkDir(workDir)

  // #5 重建缓存
  const cachePath = join(bookRoot, '.cache', 'index.db')
  rebuild(bookRoot, cachePath)

  return { ok: true, commitHash }
}

function checkFinalizeFullReport(input: FinalizeInput & { kind: 'long' | 'short' }): FinalizeGateResult {
  const isShort = input.kind === 'short'
  const report = runAllChecks({
    db: isShort ? undefined : input.db,
    bookRoot: input.bookRoot,
    config: input.config,
    chapter: input.chapter,
    body: input.body,
    fileName: input.fileName,
    declaredLeadIds: isShort ? undefined : readOutlineLeads(input.workDir),
    actualLeadIds: isShort ? undefined : (input.leadUpdates ?? []).map((u) => u.leadId),
  })
  if (!hasRed(report)) return { ok: true }
  return { ok: false, reason: `机检红项未过：\n${formatRedForRewrite(report)}` }
}

function validateLeadUpdateTargets(
  bookRoot: string,
  chapter: number,
  leadUpdates?: FinalizeInput['leadUpdates'],
): { ok: true } | { ok: false; reason: string } {
  if (!leadUpdates || leadUpdates.length === 0) return { ok: true }
  const outlineDir = join(bookRoot, '大纲')
  for (const update of leadUpdates) {
    const currentEntries = update.entries.filter((e) => e.章号 === chapter)
    if (currentEntries.length === 0) continue
    const leadFile = findLeadFile(outlineDir, update.leadId)
    if (!leadFile) {
      return {
        ok: false,
        reason: `账本推进声明了「${update.leadId}」，但大纲里找不到对应账本文件。请先建立「大纲/<类>/${update.leadId}-<标题>.md」。`,
      }
    }
    const r = readLead(leadFile)
    if (!r.ok) {
      return { ok: false, reason: `账本文件读不了：${r.error.file} ${r.error.message}` }
    }
  }
  return { ok: true }
}

function findFinalizedUnit(bookRoot: string, unitNum: number, kind: 'long' | 'short'): string | null {
  const dir = kind === 'short' ? join(bookRoot, '篇') : join(bookRoot, '定稿', '正文')
  if (!existsSync(dir)) return null
  const prefix = kind === 'short' ? String(unitNum).padStart(3, '0') : String(unitNum)
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('._')) continue
      const m = name.match(/^(\d+)-/)
      if (!m) continue
      const n = Number(m[1])
      if (n === unitNum || name.startsWith(`${prefix}-`)) {
        const rel = kind === 'short' ? `篇/${name}/正文.md` : `定稿/正文/${name}`
        if (kind === 'short' && !existsSync(join(bookRoot, rel))) continue
        return rel
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * 撤销 finalize #2 写入定稿区的改动（commit 失败时调用，#13 第 4 节原子性）。
 * - 先 git reset 清掉 index 中被 add 的暂存（addCommit 已 git add，但 commit 失败了）
 * - 再判 HEAD 里有没有该文件（git ls-tree）：
 *   - 有 = 改了已有正文/账本 → git checkout 恢复到 HEAD 版本
 *   - 无 = 本章新建的正文/摘要 → unlink 删除
 * 失败静默（best-effort：git 已坏时无法 checkout，至少删掉能删的新文件）。
 */
function rollbackWorktreeChanges(bookRoot: string, relPaths: string[]): void {
  for (const rel of relPaths) {
    const full = join(bookRoot, rel)
    // 先清 index 暂存（addCommit 执行了 git add，commit 失败后该路径在 index 里）
    git(['reset', 'HEAD', '--', rel], bookRoot)
    // 判该路径在 HEAD（上次 commit）里是否存在
    const inHead = git(['ls-tree', 'HEAD', '--', rel], bookRoot)
    if (inHead.ok && inHead.stdout.trim().length > 0) {
      // HEAD 里有：恢复工作树到 HEAD 版本（丢弃本次改动）
      git(['checkout', 'HEAD', '--', rel], bookRoot)
    } else if (existsSync(full)) {
      // HEAD 里没有（本章新建）：删除
      try {
        unlinkSync(full)
        rmdirSync(dirname(full))
      } catch {
        // best-effort
      }
    }
  }
}

/** 清空工作区（删草稿/细纲/材料/审稿/三审/确认记录）。
 *  草稿-N.md 全部交给下面的 readdir 循环兜底（覆盖 草稿-1 / 草稿-N / ._草稿-*）。 */
function clearWorkDir(workDir: string): void {
  const toDelete = ['细纲.md', '本章写作材料.md', '审稿.md', '清单.md', '账本推进.md', '三审']
  for (const f of toDelete) {
    const fp = join(workDir, f)
    if (existsSync(fp)) rmSync(fp, { recursive: true, force: true })
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
  clearAiCallBudget(workDir)
}

/** 在大纲/ 下找某编号的账本文件 */
function findLeadFile(outlineDir: string, leadId: string): string | null {
  let typeDirs: string[]
  try {
    typeDirs = readdirSync(outlineDir)
  } catch {
    return null
  }
  for (const typeDir of typeDirs) {
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
