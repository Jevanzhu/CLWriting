/**
 * 文风样章 learn 收割 —— 依据 M7 #38 spec。
 *
 * 从定稿正文产文风样章/金句候选，作者审核才入库（候选制，品味归人）。
 *
 * 红线（工单）：
 * 1. 独立命令、不挂 finalize（定稿仍零 token 原子）
 * 2. 候选制、作者审核才入库
 * 3. 纯脚本、不耗写稿大模型
 *
 * 复用边界（#38 第 3 节）：
 * - 打分复用 #10 机检（checkStyleMetrics + checkRepeat + parseIronRules）
 * - 遍历复用 readChapterDir
 * - 入库格式复用 #5 writeSample（见 commit.ts）
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { readChapterDir } from '../format/chapters.js'
import { splitSentences } from '../format/sentences.js'
import { atomicWriteFile } from '../fs/atomic.js'
import { acquireCrossProcessLockAsync } from '../fs/cross-process-lock.js'
import { readFile } from '../format/frontmatter.js'
import { readBookConfig } from '../format/yaml.js'
import { finalizedPathSet } from '../document/manifest.js'
import { checkStyleMetrics, checkRepeat } from '../check/count.js'
import { readIronRules } from '../metrics/style.js'
import type { IronRules } from '../format/iron-rules.js'

/** 样章候选 */
export interface SampleCandidate {
  /** 拟定场景（作者审核时确认/改归） */
  场景: string
  /** 正文片段 */
  正文: string
  /** 出处：《书名》第 N 章 */
  出处: string
  /** 章号 */
  章号: number
  /** 打分（0-100，借 #10 机检） */
  打分: number
  /** 技法指令（作者审核时一句话标注「这段学什么」，可空；G5 闭合样章配技法指令） */
  技法指令?: string
}

/** 金句候选 */
export interface QuoteCandidate {
  场景: string
  正文: string
  出处: string
  章号: number
}

export interface LearnResult {
  ok: boolean
  /** 样章候选数 */
  sampleCount: number
  /** 金句候选数 */
  quoteCount: number
  /** 候选目录（相对书仓库） */
  candidateDir: string
  /** 候选明细（供 CLI 交互挑选用） */
  samples?: SampleCandidate[]
  quotes?: QuoteCandidate[]
  /** H-1（二轮复审）：因未定稿被跳过的章数（草稿不进候选池的可见性口径） */
  skippedDrafts?: number
  error?: string
}

/** 候选落盘的临时区（工作区/，gitignore） */
const CANDIDATE_DIR = '工作区/learn候选'

/**
 * 候选打分（借 #10 机检，#38 第 3.2 节）。
 *
 * 基础 100 分，扣分项来自 #10：
 * - checkStyleMetrics 的 yellow 项每条 -5（对话标签/形容词堆叠/排比/总结体等 AI 味）
 * - checkRepeat 复读率超阈值 -10 * rate
 * 无加分项（避免硬编码关键词，口径归 #10 机检，作者调铁律阈值能直接影响打分）。
 */
function scoreByChecks(body: string, rules: IronRules): number {
  let score = 100

  const styleResult = checkStyleMetrics(body, rules)
  for (const item of styleResult.items) {
    score -= item.level === 'red' ? 15 : 5
  }

  const repeatResult = checkRepeat(body)
  for (const item of repeatResult.items) {
    if (item.level === 'yellow') score -= 10
  }

  return Math.max(0, Math.min(100, score))
}

/**
 * learn 收割主流程（产候选，不自动入库）。
 * 场景不做启发式预归（词表伪精度已删，S8）——候选一律「通用」，标注权在作者。
 *
 * R72-2（二十轮 A-1）：async 化——全书收割是「逐章同步 IO + 逐段正则打分」的秒级
 * CPU/IO 段，原先在 chat agent 循环（harvest_style 工具）与 HTTP 请求线程（/learn
 * 端点）内同步执行，长书收割期间 utility 进程事件循环整体停摆（同进程全部 SSE 广播、
 * steer 队列、其他书会话卡顿，abort 信号也无法及时处理）。现逐章处理间 await 让出
 * 事件循环（setImmediate 级，每章一次），单章内的段级打分仍同步（毫秒级，无需更碎）。
 * ToolExecutor 契约本就支持 Promise（turns.ts executor 调用全带 await），调用方无感。
 */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** learn 收割跨进程锁等待上限（R30-18 口径：const 导出 + 内部可变生效值 + 测试注入钩子）。 */
export const LEARN_HARVEST_LOCK_TIMEOUT_MS = 5_000

/** 生效值（模块内可变）：初值 = 常量；仅注入钩子可改。 */
let learnHarvestLockTimeoutMs = LEARN_HARVEST_LOCK_TIMEOUT_MS

/** 测试注入钩子（生产零调用）。 */
export function __setLearnHarvestLockTimeoutForTest(ms: number): void {
  learnHarvestLockTimeoutMs = ms
}

export async function learnFromBook(bookRoot: string): Promise<LearnResult> {
  // 1. 扫描定稿正文
  const bodyDir = join(bookRoot, '写作', '正文')
  if (!existsSync(bodyDir)) {
    return { ok: false, sampleCount: 0, quoteCount: 0, candidateDir: '', error: '没有定稿正文可收割。' }
  }
  const { chapters, errors } = readChapterDir(bodyDir)
  if (errors.length > 0) {
    return { ok: false, sampleCount: 0, quoteCount: 0, candidateDir: '', error: `章节解析失败：${errors[0]!.message}` }
  }
  if (chapters.length === 0) {
    return { ok: false, sampleCount: 0, quoteCount: 0, candidateDir: '', error: '没有定稿正文可收割。' }
  }
  chapters.sort((a, b) => a.章号 - b.章号)

  // 2. 读书名 + 文风铁律阈值（打分用）
  let bookTitle = '未命名'
  const cfg = readBookConfig(join(bookRoot, 'book.yaml'))
  if (cfg.ok && cfg.config.book.title) bookTitle = cfg.config.book.title

  // 铁律阈值 + 条目库禁词（S5 收口：统一走 readIronRules）
  const ironRules: IronRules = readIronRules(bookRoot)

  // 3. 读正文。H-1（二轮复审）：只收定稿正文（模块契约「从定稿正文产候选」）——
  // 未定稿草稿/在写章不进候选池（流水线刚写出的段会被勾选入库污染文风基准与注入
  // 素材）。判定与导出 V-P2-2 同一函数（manifest.finalizedPathSet，曾定稿=过）；
  // 旧书无清单 → null 无法判定，保持全量（与导出降级一致）
  const finalized = finalizedPathSet(bookRoot)
  let skippedDrafts = 0
  const chapterBodies: Array<{ 章号: number; 标题: string; body: string }> = []
  for (const ch of chapters) {
    await yieldToEventLoop() // R72-2：每章让出事件循环，长书收割不再阻塞同进程其他会话
    const path = ch._path
    if (!path) continue
    if (finalized && !finalized.has(relative(bookRoot, path).replace(/\\/g, '/'))) {
      skippedDrafts++
      continue
    }
    const r = readFile(path)
    if (!r.ok) continue
    chapterBodies.push({ 章号: ch.章号, 标题: ch.标题, body: r.body.trim() })
  }
  if (chapterBodies.length === 0) {
    return {
      ok: false,
      sampleCount: 0,
      quoteCount: 0,
      candidateDir: '',
      skippedDrafts,
      error: '没有定稿正文可收割。',
    }
  }

  // 4. 提取样章候选（按段落分块 + #10 打分 + 低分过滤）
  const sampleCandidates: SampleCandidate[] = []
  for (const ch of chapterBodies) {
    await yieldToEventLoop() // R72-2：打分循环同为章级热点段
    const blocks = ch.body.split(/\n\n+/).filter((b) => {
      const len = b.trim().length
      return len >= 50 && len <= 500
    })
    for (const block of blocks) {
      const trimmed = block.trim()
      const score = scoreByChecks(trimmed, ironRules)
      if (score < 60) continue // 低分过滤（避免收割平庸段）
      sampleCandidates.push({
        场景: '通用',
        正文: trimmed,
        出处: `《${bookTitle}》第 ${ch.章号} 章`,
        章号: ch.章号,
        打分: score,
      })
    }
  }

  // 按打分降序取 top 10（场景不再分桶配额）
  sampleCandidates.sort((a, b) => b.打分 - a.打分)
  const topSamples: SampleCandidate[] = sampleCandidates.slice(0, 10)

  // 5. 提取金句候选（短句 + 钩子/情绪/对比特征）
  const quoteCandidates: QuoteCandidate[] = []
  for (const ch of chapterBodies) {
    await yieldToEventLoop() // R72-2
    // 统一分句口径（原先少 \n，可能漏检跨行——P2-BE-6）
    const sentences = splitSentences(ch.body).filter((s) => {
      return s.length >= 10 && s.length <= 50 && !s.startsWith('#')
    })
    for (const s of sentences) {
      const hasHook = /[忽然竟然居然可是但是]/.test(s)
      const hasEmotion = /[痛爱恨死生泪笑]/.test(s)
      const hasContrast = /[却而]/.test(s)
      if (hasHook && hasEmotion || (hasContrast && hasEmotion)) {
        quoteCandidates.push({
          场景: '通用',
          正文: s,
          出处: `《${bookTitle}》第 ${ch.章号} 章`,
          章号: ch.章号,
        })
      }
    }
  }
  // 取 top 5（场景不再分桶配额）
  // A5（五十九轮）：候选按章号倒序再取 top5——章节按章号升序遍历，直接 slice 取的是
  // 章节序最前 5 条，金句候选系统性偏旧；倒序取最新章节的候选（同章内保遍历序，稳定排序）
  quoteCandidates.sort((a, b) => b.章号 - a.章号)
  const topQuotes: QuoteCandidate[] = quoteCandidates.slice(0, 5)

  // 6. 落候选到 工作区/learn候选/
  // R69-15（十七轮）：候选目录 rm+重建整段跨进程互斥——chat 工具（harvest_style 不经
  // 端点 'learn' 闸）与 CLI/他进程并发收割时对同一目录互相 rm 半删/覆盖；5s 超时
  // fail-closed 报「在途」交调用方提示重试（桌面+CLI 双进程形态 J7 已认可）。
  // R32-13（三十二轮）：锁等待异步化（acquireCrossProcessLockAsync，rule-hits 同口径）——
  // 同步 Atomics.wait 微睡会在双进程争用时冻结 utility 进程事件循环（SSE/HTTP 最坏停 5s）。
  const candidateRoot = join(bookRoot, CANDIDATE_DIR)
  const releaseHarvest = await acquireCrossProcessLockAsync(join(bookRoot, '工作区', '.learn-harvest.lock'), learnHarvestLockTimeoutMs)
  if (!releaseHarvest) {
    return {
      ok: false,
      sampleCount: 0,
      quoteCount: 0,
      candidateDir: CANDIDATE_DIR,
      error: 'learn 收割在途（另一进程正在收割本书），请稍后重试。',
    }
  }
  try {
    // 清旧候选（重跑覆盖）
    try { rmSync(candidateRoot, { recursive: true, force: true }) } catch { /* 不存在无所谓 */ }
    mkdirSync(candidateRoot, { recursive: true })

    // 样章候选：样章/<场景>-候选-NN.md（拟入 front matter）
    const sampleDir = join(candidateRoot, '样章')
    mkdirSync(sampleDir, { recursive: true })
    topSamples.forEach((c, i) => {
      const fileName = `${c.场景}-候选-${String(i + 1).padStart(2, '0')}.md`
      const fm = [`场景: ${c.场景}`, `来源: 作者原作`, `出处: ${c.出处}`, `打分: ${c.打分}`].join('\n')
      atomicWriteFile(join(sampleDir, fileName), `---\n${fm}\n---\n\n${c.正文}`)
    })

    // 金句候选：金句/<场景>.md（逐条列表）
    const quoteDir = join(candidateRoot, '金句')
    mkdirSync(quoteDir, { recursive: true })
    const quotesByScene = new Map<string, QuoteCandidate[]>()
    for (const q of topQuotes) {
      const list = quotesByScene.get(q.场景) ?? []
      list.push(q)
      quotesByScene.set(q.场景, list)
    }
    for (const [scene, quotes] of quotesByScene) {
      const content = quotes.map((q) => `- ${q.正文}  \n  ——${q.出处}`).join('\n\n')
      atomicWriteFile(join(quoteDir, `${scene}.md`), content)
    }
  } finally {
    releaseHarvest()
  }

  return {
    ok: true,
    sampleCount: topSamples.length,
    quoteCount: topQuotes.length,
    candidateDir: CANDIDATE_DIR,
    samples: topSamples,
    quotes: topQuotes,
    skippedDrafts,
  }
}
