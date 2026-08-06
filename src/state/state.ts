/**
 * 状态机单入口 —— 依据 #15 状态机单入口 spec（M3 子 spec·#15）+ 母本第 6.4 节。
 *
 * 每次进书按序判定、命中即路由（#15 第 2 节）：
 * 1 健康检查 → 2 源文件解析失败 → 3 未入账手改 → 4 工作区未完成
 * → 8 待批量审稿 → 5 卷末 → 7 起草新章
 * （CLI 退场：体检周期态 6 已移除，不再拦写章。）
 *
 * 去 git 自管版本系统（Dev/Main/Plans/gitless-version-system.md）：
 * - 态 1 健康检查：journal 崩溃恢复 + 网盘副本扫描（不再依赖 git 半提交/冲突/锁）
 * - 态 3 未入账手改：manifest.finalizedRevision vs 文件实时指纹比对（不再依赖 git modified）
 * - 态 4 工作区未完成：工作区信号 + manifest 定稿检测（不再依赖 git log 反查 commit）
 *
 * 设计（#15 第 1 节原则）：
 * - 单入口、按序判定：前一个命中就路由，不再判后面的（体检优先于续跑、续跑优先于周期）。
 * - 进门先体检、自愈不门禁：态 1-3 异常先提议修复，不报错拒绝、不崩整个系统。
 * - 脚本面为主、AI 介入点用桩：判定/路由全确定性脚本；语义判断（顺势圆/修复确认）M3 桩、M4 真。
 * - 文件即真相：判定读 md 真源 + manifest 账本，不维护额外状态机状态文件。
 *
 * 回滚「回到第 N 章」是横切命令（#16 第 5 节），不在顺序判定里——由 version 恢复单独触发。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { scanCloudCopies } from '../git/exec.js'
import { findUnsettled } from '../document/journal.js'
import { rebuild } from '../cache/rebuild.js'
import { readBookConfig } from '../format/yaml.js'
import { assembleStatus } from '../process/assemble.js'
import { countPieces } from '../format/pieces.js'
import { readManifest } from '../document/manifest.js'
import { computeRevision } from '../document/revision.js'
import type { BookConfig, ParseError } from '../format/types.js'

/** 默认每卷章数；book.yaml 可用 book.volume_size 覆盖。 */
const DEFAULT_VOLUME_SIZE = 50

function volumeSizeOf(config: BookConfig): number {
  const size = config.book.volume_size
  return typeof size === 'number' && Number.isSafeInteger(size) && size > 0 ? size : DEFAULT_VOLUME_SIZE
}

/** 状态枚举（#15 第 2 节顺序）+ 态 5 卷末；CLI 退场无态 6/8（M6 #34 未接入主流程） */
export type BookState = 1 | 2 | 3 | 4 | 5 | 7

/** 态名（人话，#15 第 2 节表） */
export const STATE_NAMES: Record<BookState, string> = {
  1: '健康检查',
  2: '源文件解析失败',
  3: '未入账手改',
  4: '工作区未完成',
  5: '卷末',
  7: '起草新章',
}

/**
 * 判定结果（判别联合，自带 state 字段供 switch 收窄）。
 * 各态细节人话 + 结构化，路由据此决定动作。
 */
export type DetectedState =
  | { state: 1; issues: HealthIssue[] }
  | { state: 2; parseErrors: import('../format/types.js').ParseError[] }
  | { state: 3; handEdits: string[] } // 定稿基线后有改动但未重新定稿的文件
  | { state: 4; chapterNum: number; resumePoint: 'pre-finalize' | 'post-finalize-residue' } // 中断点
  | { state: 5; volume: number } // 第几卷写完了
  | { state: 7; nextChapter: number }

/** 路由动作（#15 第 2 节，各态路由去向；AI 执行处出桩标记） */
export interface RouterAction {
  state: BookState
  /** 人话（对作者：现在该干什么，零机器味） */
  humanMsg: string
  /** 动作类型（机器侧：状态机/#16#17#18/M2 流程谁来接） */
  action?: RouterActionKind
  /** 是否需要 AI 介入（M3 桩、M4 真） */
  needsAI: boolean
}

export type RouterActionKind =
  | 'repair' // 态 2 → #18 修复确认
  | 'resume' // 态 4 → 中断恢复续跑
  | 'volume-review' // 态 5 → 卷复盘（M3 概要）
  | 'write-new-chapter' // 态 7 → M2 AI 写章流程

/**
 * 进门状态判定（#15 第 2 节，按序命中即返回）。
 * 全程零 AI：健康检查 / 全量重建收错 / 指纹比对 / 工作区文件 / 章号推算，全是确定性脚本。
 */
export function detectState(bookRoot: string, config: BookConfig): DetectedState {
  // #1 健康检查（journal 崩溃恢复 + 网盘副本扫描）
  const issues = healthCheck(bookRoot)
  if (issues.length > 0) {
    return { state: 1, issues }
  }

  // 全量重建一次（#2#3 都要用它的结果；幂等，删了能建回）
  // 短篇跳过 rebuild：短篇不依赖 index.db（态7 分支 + readRecapSnapshot 短篇分支都直扫 写作/正文/ 目录），
  // rebuild 扫的是长篇结构（布线/账本 + 写作/正文），对短篇是纯浪费；态2 解析错误检测对短篇无意义（真相源是 写作/正文/）。
  const cachePath = join(bookRoot, '.cache', 'index.db')
  let rebuildResult: { leadCount: number; chapterCount: number; summaryCount: number; errors: ParseError[] }
  if (config.kind === 'short') {
    rebuildResult = { leadCount: 0, chapterCount: 0, summaryCount: 0, errors: [] }
  } else {
    // rebuild 仅在 db 层故障(磁盘满/权限/损坏)抛异常;catch 后降级态2,不崩整个 enter
    try {
      rebuildResult = rebuild(bookRoot, cachePath)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        state: 2,
        parseErrors: [{ file: cachePath, line: 0, message: `缓存重建失败：${msg}（可删 .cache/index.db 重试）` }],
      }
    }
  }

  // #2 源文件解析失败（#18 第 2 节）
  if (rebuildResult.errors.length > 0) {
    return { state: 2, parseErrors: rebuildResult.errors }
  }

  // #3 未入账手改：定稿基线存在但当前指纹不同（manifest 指纹比对，不依赖 git）
  const handEdits = detectHandEdits(bookRoot, config)
  if (handEdits.length > 0) {
    return { state: 3, handEdits }
  }

  // #4 工作区未完成（中断恢复）：有细纲/未定稿草稿 但对应章节已定稿 → post-finalize-residue
  const incomplete = detectIncompleteWorkdir(bookRoot)
  if (incomplete) {
    const alreadyFinalized = isChapterFinalized(bookRoot, incomplete)
    return {
      state: 4,
      chapterNum: incomplete,
      resumePoint: alreadyFinalized ? 'post-finalize-residue' : 'pre-finalize',
    }
  }

  // ── 态 4 之后按 kind 分叉（M8 #25/#26，H2 合并设计）──
  // 短篇分支：无态 5（无卷）/6（无体检）；直接落态 7 写作主态，篇号扫 写作/正文/ 目录
  if (config.kind === 'short') {
    const excludeNames = unfinishedPieceNames(bookRoot)
    return { state: 7, nextChapter: countPieces(join(bookRoot, '写作', '正文'), excludeNames) + 1 }
  }

  // 读缓存算 currentChapter（5/6/7 都要）
  const volumeSize = volumeSizeOf(config)
  const db = new DatabaseSync(cachePath)
  let snapshot
  try {
    snapshot = assembleStatus(db, config, volumeSize)
  } finally {
    db.close()
  }
  const currentChapter = snapshot.currentChapter

  // #5 卷末（currentChapter > 0 且整除卷大小）
  if (currentChapter > 0 && currentChapter % volumeSize === 0) {
    return { state: 5, volume: currentChapter / volumeSize }
  }

  // #6 体检周期：CLI 退场后移除（态 6 不再拦截写章），直接落态 7。

  // #7 起草新章（兜底）
  return { state: 7, nextChapter: currentChapter + 1 }
}

/** 健康检查异常项（去 git：journal 崩溃恢复 + 网盘副本扫描）。 */
export interface HealthIssue {
  kind: 'crashedWrite' | 'cloudCopy'
  humanMsg: string
  fix: string
  files?: string[]
}

/** 态 1：journal 崩溃恢复 + 网盘副本扫描（不再依赖 git 半提交/冲突/锁——无 git 即无此类异常）。 */
function healthCheck(bookRoot: string): HealthIssue[] {
  const issues: HealthIssue[] = []

  // ① journal 崩溃恢复：扫 工作区/.journal/*.jsonl，找 pending 未 settled 的写操作
  const journalDir = join(bookRoot, '工作区', '.journal')
  if (existsSync(journalDir)) {
    try {
      for (const name of readdirSync(journalDir)) {
        if (name.startsWith('._') || !name.endsWith('.jsonl')) continue
        const docId = name.slice(0, -'.jsonl'.length)
        const pending = findUnsettled(join(journalDir, name))
        if (pending.length > 0) {
          issues.push({
            kind: 'crashedWrite',
            humanMsg: `上次写作时「${docId}」的保存没完成，可能丢字。`,
            fix: '确认内容是否完整，可从版本历史恢复，或忽略继续写作。',
            files: pending.map((p) => p.opId),
          })
        }
      }
    } catch {
      // journal 扫描异常不阻断进门（降级为无 journal 检查）
    }
  }

  // ② 网盘副本扫描（纯 fs，不依赖 git）
  const cloudCopies = scanCloudCopies(bookRoot)
  if (cloudCopies.length > 0) {
    issues.push({
      kind: 'cloudCopy',
      humanMsg: '检测到同步盘副本残留，可能有双写冲突。',
      fix: '对比副本和原文件，确认哪份是真内容后删掉多余的；警示同步盘风险（建议关掉书仓库的同步盘）。',
      files: cloudCopies,
    })
  }

  return issues
}

/** 态 3：已定稿文件有未重新定稿的改动（manifest.finalizedRevision vs 当前指纹）。 */
function detectHandEdits(bookRoot: string, config: BookConfig): string[] {
  const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  const handEditPrefixes = config.kind === 'short' ? ['写作/正文/'] : ['写作/正文/', '设定/', '大纲/', '布线/']
  const out: string[] = []
  for (const entry of manifest.entries.values()) {
    if (entry.nodeType !== 'document') continue
    if (!entry.finalizedRevision) continue // 从未定稿 → 不是手改（是正常草稿流程）
    if (!handEditPrefixes.some((p) => entry.path.startsWith(p))) continue
    const abs = join(bookRoot, entry.path)
    if (!existsSync(abs)) continue
    const rev = computeRevision(abs)
    if (rev !== entry.finalizedRevision) out.push(entry.path)
  }
  return out
}

/** 态 4：工作区/正文区是否有未完成章节（中断判定）。
 *  信号：工作区细纲.md / .confirm.json，或正文区存在未定稿（无 finalizedRevision）的草稿文件。 */
function detectIncompleteWorkdir(bookRoot: string): number | null {
  const workDir = join(bookRoot, '工作区')
  const hasOutline = existsSync(join(workDir, '细纲.md'))
  const hasConfirm = existsSync(join(workDir, '.confirm.json'))
  const unfinishedChapter = findUnfinishedChapter(bookRoot)
  if (!hasOutline && !hasConfirm && !unfinishedChapter) return null

  let chapterNum = 0
  // 章号源优先：.confirm.json.chapter（写作中断时确认过细纲）> 正文区未定稿草稿
  if (hasConfirm) {
    try {
      const rec = JSON.parse(readFileSync(join(workDir, '.confirm.json'), 'utf-8')) as { chapter?: number }
      chapterNum = rec.chapter ?? 0
    } catch {
      // 坏的 .confirm.json 不影响判定（当无章号）
    }
  }
  if (chapterNum === 0 && unfinishedChapter) {
    chapterNum = unfinishedChapter
  }
  return chapterNum > 0 ? chapterNum : null
}

/** 正文区未定稿（无 finalizedRevision）的草稿文件章号；从 frontmatter 或文件名提取。 */
function findUnfinishedChapter(bookRoot: string): number | null {
  const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  const finalizedStems = new Set<string>()
  for (const e of manifest.entries.values()) {
    if (e.nodeType !== 'document' || !e.finalizedRevision) continue
    finalizedStems.add(e.path)
  }
  const bodyDir = join(bookRoot, '写作', '正文')
  if (!existsSync(bodyDir)) return null
  const walk = (dir: string): number | null => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return null
    }
    for (const name of entries) {
      if (name.startsWith('._')) continue
      const fp = join(dir, name)
      const st = statSyncSafe(fp)
      if (st === null) continue
      if (st.isDirectory()) {
        const hit = walk(fp)
        if (hit) return hit
      } else if (name.endsWith('.md')) {
        const rel = relativePath(bookRoot, fp)
        if (finalizedStems.has(rel)) continue // 已定稿，不算未完成
        const no = chapterFromFile(fp, name)
        if (no > 0) return no
      }
    }
    return null
  }
  return walk(bodyDir)
}

/** 从文件 frontmatter 章号 或 文件名数字提取章号。 */
function chapterFromFile(absPath: string, name: string): number {
  try {
    const raw = readFileSync(absPath, 'utf-8')
    const m = raw.match(/章号:\s*(\d+)/)
    if (m) return Number(m[1])
  } catch {
    // 读失败忽略
  }
  const m = name.match(/(\d+)/)
  return m ? Number(m[1]) : 0
}

function statSyncSafe(fp: string): import('node:fs').Stats | null {
  try {
    return statSync(fp)
  } catch {
    return null
  }
}

function relativePath(bookRoot: string, absPath: string): string {
  return absPath.slice(bookRoot.length + 1).replace(/\\/g, '/')
}

/** 章节是否已定稿：manifest 中该章 entry 有 finalizedRevision。 */
function isChapterFinalized(bookRoot: string, chapterNum: number): boolean {
  const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  for (const e of manifest.entries.values()) {
    if (e.nodeType !== 'document' || !e.finalizedRevision) continue
    if (!e.path.startsWith('写作/正文/')) continue
    const no = chapterFromRelPath(e.path)
    if (no === chapterNum) return true
  }
  return false
}

/** 从正文区相对路径提取章号（0001-标题.md → 1；嵌套卷同）。 */
function chapterFromRelPath(relPath: string): number {
  const base = relPath.split('/').pop() ?? ''
  const m = base.match(/^(\d+)-/)
  return m ? Number(m[1]) : 0
}

/** 正文区未定稿文件名集合（用于 countPieces 排除草稿——未定稿不计入"已写"）。 */
function unfinishedPieceNames(bookRoot: string): Set<string> {
  const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  const finalized = new Set<string>()
  for (const e of manifest.entries.values()) {
    if (e.nodeType === 'document' && e.finalizedRevision) finalized.add(e.path)
  }
  const out = new Set<string>()
  const bodyDir = join(bookRoot, '写作', '正文')
  if (!existsSync(bodyDir)) return out
  const walk = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith('._')) continue
      const fp = join(dir, name)
      const st = statSyncSafe(fp)
      if (st === null) continue
      if (st.isDirectory()) walk(fp)
      else if (name.endsWith('.md')) {
        const rel = relativePath(bookRoot, fp)
        if (!finalized.has(rel)) out.add(rel.slice('写作/正文/'.length))
      }
    }
  }
  walk(bodyDir)
  return out
}

// countPieces 复用 format/pieces.ts 单源(避免两份计数逻辑漂移);签名接收 写作/正文/ 目录路径

/** 读 .auto-batch.json 的 paused 字段（M6 #34 暂停元状态）。 */
function readBatchPause(bookRoot: string): { atChapter: number; reason: string; detail: string } | undefined {
  const fp = join(bookRoot, '工作区', '待定稿', '.auto-batch.json')
  if (!existsSync(fp)) return undefined
  try {
    const obj = JSON.parse(readFileSync(fp, 'utf-8')) as { paused?: { at_chapter?: number; reason?: string; detail?: string } | null }
    const p = obj.paused
    if (!p || typeof p.at_chapter !== 'number' || typeof p.reason !== 'string') return undefined
    return { atChapter: p.at_chapter, reason: p.reason, detail: String(p.detail ?? '') }
  } catch {
    return undefined
  }
}

/**
 * 路由（#15 第 2 节，各态路由去向 + 人话）。
 * AI 介入处（修复确认语义、顺势圆）标 needsAI=true，M3 出人话不真执行。
 */
export function routeState(detected: DetectedState, kind: 'long' | 'short' = 'long'): RouterAction {
  switch (detected.state) {
    case 1: {
      const list = detected.issues.map((i) => `· ${i.humanMsg}（${i.fix}）`).join('\n')
      return {
        state: 1,
        humanMsg: `进门体检发现问题，先处理再开写：\n${list}`,
        needsAI: false,
      }
    }
    case 2: {
      const list = detected.parseErrors
        .map((e) => `· ${e.file}${e.line > 0 ? ` 第${e.line}行` : ''}：${e.message}`)
        .join('\n')
      return {
        state: 2,
        humanMsg: `有源文件坏了，需要修复确认：\n${list}`,
        action: 'repair',
        needsAI: true, // 语义修复 M4
      }
    }
    case 3: {
      const list = detected.handEdits.map((f) => `· ${f}`).join('\n')
      return {
        state: 3,
        humanMsg: `你直接改了下面这些文件，需要同步一下：\n${list}`,
        needsAI: true, // 补登内容判断 M4
      }
    }
    case 4: {
      // 中断点：pre-finalize = 续写（草稿还在没定稿）；post-finalize-residue = 定稿了但工作区没收尾（幂等清理）
      const unit = kind === 'short' ? '篇' : '章'
      const msg =
        detected.resumePoint === 'pre-finalize'
          ? `第 ${detected.chapterNum} ${unit}写到一半（工作区有草稿/细纲没定稿），接着干——从断点续写到定稿。`
          : `第 ${detected.chapterNum} ${unit}其实已定稿，但草稿区没收尾（草稿/细纲残留），清理一下就好。`
      return {
        state: 4,
        humanMsg: msg,
        action: 'resume',
        needsAI: false, // 续跑判定脚本，真编排 M4
      }
    }
    case 5:
      return {
        state: 5,
        humanMsg: `第 ${detected.volume} 卷写完了，建议做卷复盘（节奏/线收束/伏笔回收）再开下一卷。`,
        action: 'volume-review',
        needsAI: true, // 卷复盘深度 M4
      }
    case 7: {
      const unit = kind === 'short' ? '篇' : '章'
      // CLI 退场后写章收敛为单一入口（全自动/编辑器），不再分「手写起草」动作
      return {
        state: 7,
        humanMsg: `一切就绪，开始写第 ${detected.nextChapter} ${unit}。`,
        action: 'write-new-chapter',
        needsAI: false, // M2 AI 写稿由 M4 壳调
      }
    }
  }
  throw new Error(`未知状态：${JSON.stringify(detected)}`)
}

// ── 近况复述（#15 第 4 节）──────────────────────────────

/** 近况复述结果（#15 第 4 节） */
export interface StatusRecap {
  /** 已定稿到第几章 */
  currentChapter: number
  /** 当前卷 */
  currentVolume: number
  /** 下一章号 */
  nextChapter: number
  /** 健康是否干净（态 1 为 false） */
  gitClean: boolean
  /** 有无解析错误 */
  parseErrors: boolean
  /** 有无未入账手改 */
  handEdits: boolean
  /** 当前态 */
  state: BookState
  /** 连写暂停元状态（M6 #34，叠加在态 4/8 之上的批次暂停提示） */
  batchPause?: { atChapter: number; reason: string; detail: string }
}

/**
 * 组装近况复述（#15 第 4 节）。
 * 去 git：确认复述（lastConfirm）原依赖 commit trailer，已随 git 移除——定稿留痕改由版本档案（.版本）承载。
 */
export function buildRecap(bookRoot: string, config: BookConfig, detected: DetectedState): StatusRecap {
  const snapshot = readRecapSnapshot(bookRoot, config, detected)

  // 连写暂停元状态（M6 #34）：读 .auto-batch.json paused（叠加在态 4/8 之上）
  const batchPause = readBatchPause(bookRoot)

  return {
    currentChapter: snapshot.currentChapter,
    currentVolume: snapshot.currentVolume,
    nextChapter: snapshot.currentChapter + 1,
    gitClean: detected.state !== 1,
    parseErrors: detected.state === 2,
    handEdits: detected.state === 3,
    state: detected.state,
    ...(batchPause ? { batchPause } : {}),
  }
}

function readRecapSnapshot(
  bookRoot: string,
  config: BookConfig,
  detected: DetectedState,
): Pick<StatusRecap, 'currentChapter' | 'currentVolume'> {
  // 短篇不读缓存章统计（无长程账本缓存，M8 #26）；直接扫 写作/正文/ 作为已定稿篇数。
  // 排除未定稿草稿（未定稿不计入"已写"篇数）
  if (config.kind === 'short') {
    return { currentChapter: countPieces(join(bookRoot, '写作', '正文'), unfinishedPieceNames(bookRoot)), currentVolume: 1 }
  }
  const cachePath = join(bookRoot, '.cache', 'index.db')
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(cachePath)
    return assembleStatus(db, config, volumeSizeOf(config))
  } catch {
    return fallbackRecapSnapshot(detected, volumeSizeOf(config))
  } finally {
    db?.close()
  }
}

function fallbackRecapSnapshot(
  detected: DetectedState,
  volumeSize = DEFAULT_VOLUME_SIZE,
): Pick<StatusRecap, 'currentChapter' | 'currentVolume'> {
  if (detected.state === 5) {
    return { currentChapter: detected.volume * volumeSize, currentVolume: detected.volume }
  }
  const nextChapter = detected.state === 7 ? detected.nextChapter : 1
  return { currentChapter: Math.max(0, nextChapter - 1), currentVolume: 1 }
}

// ── 单入口：enter（#15 第 3 节，CLI + 库双形态）────────

/** enter 结果（库形态：结构化数据，前端自行渲染） */
export interface EnterResult {
  recap: StatusRecap
  detected: DetectedState
  route: RouterAction
  /** 长短篇（M8，CLI 文案按 kind 出「章/篇」） */
  kind: 'long' | 'short'
}

/**
 * 进门入口（#15 第 3 节）。
 * 串：判态 → 路由 → 近况复述。无 hook 等价入口（SessionStart 真 hook M4 接同一结构化结果）。
 */
export function enter(bookRoot: string): EnterResult {
  const cfgPath = join(bookRoot, 'book.yaml')
  const cfgResult = readBookConfig(cfgPath)
  // P3-2：book.yaml 损坏时静默降级到默认配置——至少留下诊断痕迹
  if (!cfgResult.ok) {
    console.warn(`[state] book.yaml 解析降级: ${cfgResult.error.message}`)
  }
  const { config } = cfgResult
  const detected = detectState(bookRoot, config)
  const route = routeState(detected, config.kind ?? 'long')
  const recap = buildRecap(bookRoot, config, detected)
  return { recap, detected, route, kind: config.kind ?? 'long' }
}