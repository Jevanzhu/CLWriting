/**
 * 状态机单入口 —— 依据 #15 状态机单入口 spec（M3 子 spec·#15）+ 母本第 6.4 节。
 *
 * 每次进书按序判定、命中即路由（#15 第 2 节）：
 * 1 git 健康检查 → 2 源文件解析失败 → 3 未入账手改 → 4 工作区未完成
 * → 8 待批量审稿 → 5 卷末 → 7 起草新章
 * （CLI 退场：体检周期态 6 已移除，不再拦写章。）
 *
 * 设计（#15 第 1 节原则）：
 * - 单入口、按序判定：前一个命中就路由，不再判后面的（体检优先于续跑、续跑优先于周期）。
 * - 进门先体检、自愈不门禁：态 1-3 异常先提议修复，不报错拒绝、不崩整个系统。
 * - 脚本面为主、AI 介入点用桩：判定/路由/git 全确定性脚本；语义判断（顺势圆/修复确认）M3 桩、M4 真。
 * - 文件即真相：判定读 md 真源 + git 状态，不维护额外状态机状态文件（.cache 是可重建派生）。
 *
 * 回滚「回到第 N 章」是横切命令（#16 第 5 节），不在顺序判定里——由 cli revert 单独触发。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gitHealthCheck, statusPorcelain, lastCommitMsg, findChapterCommit } from '../git/exec.js'
import { rebuild } from '../cache/rebuild.js'
import { readBookConfig } from '../format/yaml.js'
import { hashFile } from '../fs/hash.js'
import { assembleStatus } from '../process/assemble.js'
import { countPieces } from '../format/pieces.js'
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
  1: 'git 健康检查',
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
  | { state: 1; issues: import('../git/exec.js').HealthIssue[] }
  | { state: 2; parseErrors: import('../format/types.js').ParseError[] }
  | { state: 3; handEdits: string[] } // 未 commit 的脏文件清单
  | { state: 4; chapterNum: number; resumePoint: 'pre-commit' | 'post-commit-residue' } // #13 中断点
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
  | 'resume' // 态 4 → #13 中断恢复续跑
  | 'volume-review' // 态 5 → 卷复盘（M3 概要）
  | 'write-new-chapter' // 态 7 → M2 AI 写章流程

/**
 * 进门状态判定（#15 第 2 节，按序命中即返回）。
 * 全程零 AI：git 检查 / 全量重建收错 / git status / 工作区文件 / 章号推算，全是确定性脚本。
 */
export function detectState(bookRoot: string, config: BookConfig): DetectedState {
  // #1 git 健康检查（#16 第 2 节）
  const health = gitHealthCheck(bookRoot)
  if (!health.clean) {
    return { state: 1, issues: health.issues }
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

  // #3 未入账手改（#18 第 3 节）：定稿区/账本区有未 commit 改动
  // porcelain 格式：XY<空格>path，XY 是 2 字符状态码（" M"=worktree改、"M?"=staged等），path 从第 3 字符起。
  // 手改目录按 kind 适配（M8 #25）：short 看 写作/正文/，long 看 写作/正文/ + 设定/ + 大纲/ + 布线/
  const dirty = statusPorcelain(bookRoot)
  if (dirty) {
    const handEditPrefixes = config.kind === 'short' ? ['写作/正文/'] : ['写作/正文/', '设定/', '大纲/', '布线/']
    const handEdits = dirty
      .split('\n')
      .filter((l) => l.length > 3) // 有效行（XY + 至少 1 字符 path）
      .map((l) => l.slice(3)) // 去 XY+空格，剩 path
      .filter((path) => handEditPrefixes.some((p) => path.startsWith(p)))
    if (handEdits.length > 0) {
      return { state: 3, handEdits }
    }
  }

  // #4 工作区未完成（#13 第 5 节中断恢复）：有草稿/细纲/.confirm 但无对应定稿 commit
  // 按 #13 第 5 节判中断点：无对应 commit = pre-commit（续写）；有对应 commit = post-commit-residue（幂等清理）
  // 前缀按 kind（M8 #26）：long → ch:，short → pc:
  const incomplete = detectIncompleteWorkdir(bookRoot)
  if (incomplete) {
    const alreadyCommitted = findChapterCommit(bookRoot, incomplete, config.kind ?? 'long') !== null
    return {
      state: 4,
      chapterNum: incomplete,
      resumePoint: alreadyCommitted ? 'post-commit-residue' : 'pre-commit',
    }
  }

  // ── 态 4 之后按 kind 分叉（M8 #25/#26，H2 合并设计）──
  // 短篇分支：无态 5（无卷）/6（无体检）；直接落态 7 写作主态，篇号扫 写作/正文/ 目录
  if (config.kind === 'short') {
    return { state: 7, nextChapter: countPieces(join(bookRoot, '写作', '正文')) + 1 }
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

/** 检测草稿区/工作区是否有未完成章节（态 4，#13 第 5 节中断判定） */
function detectIncompleteWorkdir(bookRoot: string): number | null {
  const workDir = join(bookRoot, '工作区')
  const draftDir = join(bookRoot, '写作', '草稿')
  // .confirm.json 仍在 工作区/（运行时资产）
  const hasConfirm = existsSync(join(workDir, '.confirm.json'))
  // 草稿/细纲迁到 写作/草稿/
  const hasDraft = existsSync(join(draftDir, '细纲.md')) || existsDraft(draftDir)
  if (!hasConfirm && !hasDraft) return null

  // 从 .confirm.json 取章号；没确认记录则从草稿文件名取
  let chapterNum = 0
  if (hasConfirm) {
    try {
      const rec = JSON.parse(readFileSync(join(workDir, '.confirm.json'), 'utf-8')) as { chapter?: number }
      chapterNum = rec.chapter ?? 0
    } catch {
      // 坏的 .confirm.json 不影响判定（当无章号）
    }
  }
  if (chapterNum === 0) {
    // 草稿-N.md 取 N（在 写作/草稿/ 下）
    if (existsSync(draftDir)) {
      const draft = readdirSync(draftDir).find((f) => /^草稿-\d+\.md$/.test(f))
      if (draft) {
        const m = draft.match(/草稿-(\d+)/)
        chapterNum = m ? Number(m[1]) : 0
      }
    }
  }
  return chapterNum > 0 ? chapterNum : null
}

// countPieces 复用 format/pieces.ts 单源(避免两份计数逻辑漂移);签名接收 写作/正文/ 目录路径

/**
 * 读 .auto-batch.json 的 paused 字段（M6 #34 暂停元状态）。
 * 连写暂停叠加在态 4/8 之上，buildRecap 读它填充 recap.batchPause。
 */
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

/** 工作区是否有任何草稿文件 */
function existsDraft(workDir: string): boolean {
  try {
    return readdirSync(workDir).some((f) => /^草稿-\d+\.md$/.test(f))
  } catch {
    return false
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
        humanMsg: `进门体检发现 git 有问题，先处理再开写：\n${list}`,
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
      // #13 第 5 节中断点：pre-commit = 续写（草稿还在没定稿）；post-commit-residue = 定稿了但草稿区没收尾（幂等清理）
      const unit = kind === 'short' ? '篇' : '章'
      const msg =
        detected.resumePoint === 'pre-commit'
          ? `第 ${detected.chapterNum} ${unit}写到一半（草稿区有草稿/细纲没定稿），接着干——从断点续写到定稿。`
          : `第 ${detected.chapterNum} ${unit}其实已定稿，但草稿区没收尾（草稿/细纲残留），幂等清理一下就好。`
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

// ── 近况复述（#15 第 4 节，含确认复述）──────────────

/** 近况复述结果（#15 第 4 节） */
export interface StatusRecap {
  /** 已定稿到第几章 */
  currentChapter: number
  /** 当前卷 */
  currentVolume: number
  /** 下一章号 */
  nextChapter: number
  /** git 是否干净 */
  gitClean: boolean
  /** 有无解析错误 */
  parseErrors: boolean
  /** 有无未入账手改 */
  handEdits: boolean
  /** 当前态 */
  state: BookState
  /** 连写暂停元状态（M6 #34，叠加在态 4/8 之上的批次暂停提示） */
  batchPause?: { atChapter: number; reason: string; detail: string }
  /** 上一章确认复述（哈希/mode/时间，从 commit trailer 取；细纲仍在时可复核） */
  lastConfirm?: { chapter: number; hash: string; mode: string; at: string; verified: boolean | null }
}

/**
 * 组装近况复述（#15 第 4 节）。
 * 确认复述的哈希从最近 ch: commit 的 Confirmed: trailer 取。
 * 若工作区还保留细纲，则与当前细纲比对；若 finalize 已清理细纲，则只复述留痕，
 * 不把「无法复核」伪装成「哈希一致」。
 */
export function buildRecap(bookRoot: string, config: BookConfig, detected: DetectedState): StatusRecap {
  const snapshot = readRecapSnapshot(bookRoot, config, detected)

  // 确认复述：从最近 ch: commit trailer 取
  const lastConfirm = parseLastConfirm(bookRoot)

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
    lastConfirm,
  }
}

function readRecapSnapshot(
  bookRoot: string,
  config: BookConfig,
  detected: DetectedState,
): Pick<StatusRecap, 'currentChapter' | 'currentVolume'> {
  // 短篇不读缓存章统计（无长程账本缓存，M8 #26）；直接扫 写作/正文/ 作为已定稿篇数。
  if (config.kind === 'short') {
    return { currentChapter: countPieces(join(bookRoot, '写作', '正文')), currentVolume: 1 }
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

/** 从最近 ch: commit 的 Confirmed: trailer 解析确认复述（#15 第 4 节 + #16 第 4 节） */
function parseLastConfirm(bookRoot: string): StatusRecap['lastConfirm'] {
  const msg = lastCommitMsg(bookRoot)
  if (!msg) return undefined
  // trailer 格式（#16 第 4 节）：Confirmed: <ISO> mode=<mode> hash=<sha256:...>
  const m = msg.match(/^Confirmed:\s*(\S+)\s+mode=(\S+)\s+hash=(\S+)/m)
  if (!m || !m[1] || !m[2] || !m[3]) return undefined
  const at = m[1]
  const mode = m[2]
  const hash = m[3]
  // 章号/篇号从 commit 标题取（long → ch:NNNN；short → pc:NNN，M8 #26）
  const chMatch = msg.match(/^(?:ch|pc):(\d+)/)
  const chapter = chMatch && chMatch[1] ? Number(chMatch[1]) : 0
  // verified：当前工作区细纲哈希是否与 trailer 一致；无细纲文件则无法复核。
  // 复用 gate/confirm.ts 的 hashFile（原始字节哈希），与 doConfirm 写入算法保持单源一致
  let verified: boolean | null = null
  const outline = join(bookRoot, '写作', '草稿', '细纲.md')
  if (chapter > 0 && existsSync(outline)) {
    verified = hashFile(outline) === hash
  }
  return { chapter, hash, mode, at, verified }
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
  const { config } = readBookConfig(cfgPath)
  const detected = detectState(bookRoot, config)
  const route = routeState(detected, config.kind ?? 'long')
  const recap = buildRecap(bookRoot, config, detected)
  return { recap, detected, route, kind: config.kind ?? 'long' }
}

