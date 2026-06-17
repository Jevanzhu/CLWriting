/**
 * 状态机单入口 —— 依据 ⑮ 状态机单入口 spec（M3 子 spec·⑮）+ 母本第 6.4 节。
 *
 * 每次进书按序判定 7 态、命中即路由（⑮ 第 2 节）：
 * 1 git 健康检查 → 2 源文件解析失败 → 3 未入账手改 → 4 工作区未完成
 * → 5 卷末 → 6 体检周期 → 7 起草新章
 *
 * 设计（⑮ 第 1 节原则）：
 * - 单入口、按序判定：前一个命中就路由，不再判后面的（体检优先于续跑、续跑优先于周期）。
 * - 进门先体检、自愈不门禁：态 1-3 异常先提议修复，不报错拒绝、不崩整个系统。
 * - 脚本面为主、AI 介入点用桩：判定/路由/git 全确定性脚本；语义判断（顺势圆/修复确认）M3 桩、M4 真。
 * - 文件即真相：判定读 md 真源 + git 状态，不维护额外状态机状态文件（.cache 是可重建派生）。
 *
 * 回滚「回到第 N 章」是横切命令（⑯ 第 5 节），不在顺序判定里——由 cli revert 单独触发。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gitHealthCheck, statusPorcelain, lastCommitMsg, findChapterCommit } from '../git/exec.js'
import { rebuild } from '../cache/rebuild.js'
import { readBookConfig } from '../format/yaml.js'
import { assembleStatus } from '../process/assemble.js'
import type { BookConfig } from '../format/types.js'

/** 默认每卷章数（book.yaml 无 growth/卷大小覆盖时用，⑮ 第 2 节） */
const DEFAULT_VOLUME_SIZE = 50

/** 7 态枚举（⑮ 第 2 节顺序） */
export type BookState = 1 | 2 | 3 | 4 | 5 | 6 | 7

/** 态名（人话，⑮ 第 2 节表） */
export const STATE_NAMES: Record<BookState, string> = {
  1: 'git 健康检查',
  2: '源文件解析失败',
  3: '未入账手改',
  4: '工作区未完成',
  5: '卷末',
  6: '体检周期',
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
  | { state: 4; chapterNum: number; resumePoint: 'pre-commit' | 'post-commit-residue' } // ⑬ 中断点
  | { state: 5; volume: number } // 第几卷写完了
  | { state: 6; chaptersSince: number } // 距上次体检多少章
  | { state: 7; nextChapter: number }

/** 路由动作（⑮ 第 2 节，各态路由去向；AI 执行处出桩标记） */
export interface RouterAction {
  state: BookState
  /** 人话（对作者：现在该干什么，零机器味） */
  humanMsg: string
  /** 动作类型（机器侧：状态机/⑯⑰⑱/M2 流程谁来接） */
  action: RouterActionKind
  /** 是否需要 AI 介入（M3 桩、M4 真） */
  needsAI: boolean
}

export type RouterActionKind =
  | 'git-health' // 态 1 → ⑯ 健康检查修复
  | 'repair' // 态 2 → ⑱ 修复确认
  | 'rebook' // 态 3 → ⑱ 提议补登
  | 'resume' // 态 4 → ⑬ 中断恢复续跑
  | 'volume-review' // 态 5 → 卷复盘（M3 概要）
  | 'health-check-periodic' // 态 6 → 体检（M3 概要）
  | 'write-new-chapter' // 态 7 → M2 写章流程
  | 'pending-ai' // AI 介入点（M3 桩，M4 真执行）

/**
 * 进门状态判定（⑮ 第 2 节，按序命中即返回）。
 * 全程零 AI：git 检查 / 全量重建收错 / git status / 工作区文件 / 章号推算，全是确定性脚本。
 */
export function detectState(bookRoot: string, config: BookConfig): DetectedState {
  // ① git 健康检查（⑯ 第 2 节）
  const health = gitHealthCheck(bookRoot)
  if (!health.clean) {
    return { state: 1, issues: health.issues }
  }

  // 全量重建一次（②③ 都要用它的结果；幂等，删了能建回）
  const cachePath = join(bookRoot, '.cache', 'index.db')
  const rebuildResult = rebuild(bookRoot, cachePath)

  // ② 源文件解析失败（⑱ 第 2 节）
  if (rebuildResult.errors.length > 0) {
    return { state: 2, parseErrors: rebuildResult.errors }
  }

  // ③ 未入账手改（⑱ 第 3 节）：定稿/、大纲/ 有未 commit 改动
  // porcelain 格式：XY<空格>path，XY 是 2 字符状态码（" M"=worktree改、"M?"=staged等），path 从第 3 字符起。
  const dirty = statusPorcelain(bookRoot)
  if (dirty) {
    const handEdits = dirty
      .split('\n')
      .filter((l) => l.length > 3) // 有效行（XY + 至少 1 字符 path）
      .map((l) => l.slice(3)) // 去 XY+空格，剩 path
      .filter((path) => path.startsWith('定稿/') || path.startsWith('大纲/'))
    if (handEdits.length > 0) {
      return { state: 3, handEdits }
    }
  }

  // ④ 工作区未完成（⑬ 第 5 节中断恢复）：有草稿/细纲/.confirm 但无对应 ch: commit
  // 按 ⑬ 第 5 节判中断点：无对应 commit = pre-commit（续写）；有对应 commit = post-commit-residue（幂等清理）
  const incomplete = detectIncompleteWorkdir(bookRoot)
  if (incomplete) {
    const alreadyCommitted = findChapterCommit(bookRoot, incomplete) !== null
    return {
      state: 4,
      chapterNum: incomplete,
      resumePoint: alreadyCommitted ? 'post-commit-residue' : 'pre-commit',
    }
  }

  // 读缓存算 currentChapter（5/6/7 都要）
  const volumeSize = DEFAULT_VOLUME_SIZE
  const db = new DatabaseSync(cachePath)
  let snapshot
  try {
    snapshot = assembleStatus(db, config, volumeSize)
  } finally {
    db.close()
  }
  const currentChapter = snapshot.currentChapter

  // ⑤ 卷末（currentChapter > 0 且整除卷大小）
  if (currentChapter > 0 && currentChapter % volumeSize === 0) {
    return { state: 5, volume: currentChapter / volumeSize }
  }

  // ⑥ 体检周期（M3 桩：先判未到期；⑮ 第 6 节，深度 M4）
  // TODO M4: 读 .cache meta「上次体检章号」，距 currentChapter ≥ 阈值则到期
  // M3 先不触发（返回不到期），避免误拦正常写章

  // ⑦ 起草新章（兜底）
  return { state: 7, nextChapter: currentChapter + 1 }
}

/** 检测工作区是否有未完成章节（态 4，⑬ 第 5 节中断判定） */
function detectIncompleteWorkdir(bookRoot: string): number | null {
  const workDir = join(bookRoot, '工作区')
  if (!existsSync(workDir)) return null
  const hasConfirm = existsSync(join(workDir, '.confirm.json'))
  const hasDraft = existsSync(join(workDir, '细纲.md')) || existsDraft(workDir)
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
    // 草稿-N.md 取 N
    const draft = readdirSync(workDir).find((f) => /^草稿-\d+\.md$/.test(f))
    if (draft) {
      const m = draft.match(/草稿-(\d+)/)
      chapterNum = m ? Number(m[1]) : 0
    }
  }
  return chapterNum > 0 ? chapterNum : null
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
 * 路由（⑮ 第 2 节，各态路由去向 + 人话）。
 * AI 介入处（修复确认语义、顺势圆）标 needsAI=true，M3 出人话不真执行。
 */
export function routeState(detected: DetectedState): RouterAction {
  switch (detected.state) {
    case 1: {
      const list = detected.issues.map((i) => `· ${i.humanMsg}（${i.fix}）`).join('\n')
      return {
        state: 1,
        humanMsg: `进门体检发现 git 有问题，先处理再开写：\n${list}`,
        action: 'git-health',
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
        humanMsg: `检测到未入账的手改，要不要补登：\n${list}`,
        action: 'rebook',
        needsAI: true, // 补登内容判断 M4
      }
    }
    case 4: {
      // ⑬ 第 5 节中断点：pre-commit = 续写（草稿还在没定稿）；post-commit-residue = 定稿了但工作区没收尾（幂等清理）
      const msg =
        detected.resumePoint === 'pre-commit'
          ? `第 ${detected.chapterNum} 章写到一半（工作区有草稿/细纲没定稿），接着干——从断点续写到定稿。`
          : `第 ${detected.chapterNum} 章其实已定稿，但工作区没收尾（草稿/细纲残留），幂等清理一下就好。`
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
    case 6:
      return {
        state: 6,
        humanMsg: `该体检了（距上次体检 ${detected.chaptersSince} 章），建议做账本对账。`,
        action: 'health-check-periodic',
        needsAI: true, // 体检抽查 M4
      }
    case 7:
      return {
        state: 7,
        humanMsg: `一切就绪，开始写第 ${detected.nextChapter} 章。`,
        action: 'write-new-chapter',
        needsAI: false, // M2 流程接，AI 写稿由 M4 壳调
      }
  }
}

// ── 近况复述（⑮ 第 4 节，含确认复述）──────────────

/** 近况复述结果（⑮ 第 4 节） */
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
  /** 上一章确认复述（哈希/mode/时间，从 commit trailer 取；伪造确认靠它暴露） */
  lastConfirm?: { chapter: number; hash: string; mode: string; at: string; verified: boolean }
}

/**
 * 组装近况复述（⑮ 第 4 节）。
 * 确认复述的哈希从最近 ch: commit 的 Confirmed: trailer 取，与当前细纲比对（verified）。
 * 伪造确认（先盖章再偷改细纲）→ verified=false → 复述暴露 → 作者可「回到第 N 章」推翻（兜底闭环）。
 */
export function buildRecap(bookRoot: string, config: BookConfig, detected: DetectedState): StatusRecap {
  const cachePath = join(bookRoot, '.cache', 'index.db')
  const db = new DatabaseSync(cachePath)
  let snapshot
  try {
    snapshot = assembleStatus(db, config)
  } finally {
    db.close()
  }

  // 确认复述：从最近 ch: commit trailer 取
  const lastConfirm = parseLastConfirm(bookRoot)

  return {
    currentChapter: snapshot.currentChapter,
    currentVolume: snapshot.currentVolume,
    nextChapter: snapshot.currentChapter + 1,
    gitClean: detected.state !== 1,
    parseErrors: detected.state === 2,
    handEdits: detected.state === 3,
    state: detected.state,
    lastConfirm,
  }
}

/** 从最近 ch: commit 的 Confirmed: trailer 解析确认复述（⑮ 第 4 节 + ⑯ 第 4 节） */
function parseLastConfirm(bookRoot: string): StatusRecap['lastConfirm'] {
  const msg = lastCommitMsg(bookRoot)
  if (!msg) return undefined
  // trailer 格式（⑯ 第 4 节）：Confirmed: <ISO> mode=<mode> hash=<sha256:...>
  const m = msg.match(/^Confirmed:\s*(\S+)\s+mode=(\S+)\s+hash=(\S+)/m)
  if (!m || !m[1] || !m[2] || !m[3]) return undefined
  const at = m[1]
  const mode = m[2]
  const hash = m[3]
  // 章号从 commit 标题 ch:NNNN 取
  const chMatch = msg.match(/^ch:(\d+)/)
  const chapter = chMatch && chMatch[1] ? Number(chMatch[1]) : 0
  // verified：当前工作区细纲哈希是否与 trailer 一致（无细纲文件则不验）
  let verified = true
  const outline = join(bookRoot, '工作区', '细纲.md')
  if (chapter > 0 && existsSync(outline)) {
    const currentHash = 'sha256:' + createHash('sha256').update(readFileSync(outline, 'utf-8')).digest('hex')
    verified = currentHash === hash
  }
  return { chapter, hash, mode, at, verified }
}

/** 近况复述 → 人话文本（⑮ 第 4 节，对作者零机器味） */
export function formatRecap(recap: StatusRecap): string {
  const lines: string[] = []
  lines.push(`【近况】已定稿到第 ${recap.currentChapter} 章（第 ${recap.currentVolume} 卷），下一章 ${recap.nextChapter}。`)
  lines.push(
    `【体检】git ${recap.gitClean ? '干净 ✓' : '有问题 ✗'}；` +
      `${recap.parseErrors ? '有源文件坏 ✗' : '账本无解析错误 ✓'}；` +
      `${recap.handEdits ? '有未入账手改 ✗' : '无未入账手改 ✓'}。`,
  )
  if (recap.lastConfirm && recap.lastConfirm.chapter > 0) {
    const c = recap.lastConfirm
    const flag = c.verified ? '一致 ✓' : '⚠ 不一致（确认后又改过细纲）'
    lines.push(`【确认复述】第 ${c.chapter} 章细纲确认哈希 ${c.hash.slice(0, 16)}…（${c.mode}，${c.at}）${flag}。`)
  }
  return lines.join('\n')
}

// ── 单入口：enter（⑮ 第 3 节，CLI + 库双形态）────────

/** enter 结果（库形态：结构化；CLI 再 formatRecap/formatRoute 出人话） */
export interface EnterResult {
  recap: StatusRecap
  detected: DetectedState
  route: RouterAction
}

/**
 * 进门入口（⑮ 第 3 节）。
 * 串：判态 → 路由 → 近况复述。无 hook 等价入口（SessionStart 真 hook M4 接同一近况文件）。
 */
export function enter(bookRoot: string): EnterResult {
  const cfgPath = join(bookRoot, 'book.yaml')
  const { config } = readBookConfig(cfgPath)
  const detected = detectState(bookRoot, config)
  const route = routeState(detected)
  const recap = buildRecap(bookRoot, config, detected)
  return { recap, detected, route }
}

/** 路由 → 人话（对作者：现在该干什么） */
export function formatRoute(route: RouterAction): string {
  const prefix = `【${STATE_NAMES[route.state]}】`
  return `${prefix} ${route.humanMsg}`
}
