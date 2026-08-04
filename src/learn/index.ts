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

import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readChapterDir } from '../format/chapters.js'
import { readFile } from '../format/frontmatter.js'
import { readBookConfig } from '../format/yaml.js'
import { checkStyleMetrics, checkRepeat } from '../check/count.js'
import { readIronRules } from '../metrics/style.js'
import type { IronRules } from '../check/count.js'

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
 */
export function learnFromBook(bookRoot: string): LearnResult {
  // 1. 扫描定稿正文
  const bodyDir = join(bookRoot, '定稿', '正文')
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

  // 3. 读正文
  const chapterBodies: Array<{ 章号: number; 标题: string; body: string }> = []
  for (const ch of chapters) {
    const path = ch._path
    if (!path) continue
    const r = readFile(path)
    if (!r.ok) continue
    chapterBodies.push({ 章号: ch.章号, 标题: ch.标题, body: r.body.trim() })
  }

  // 4. 提取样章候选（按段落分块 + #10 打分 + 低分过滤）
  const sampleCandidates: SampleCandidate[] = []
  for (const ch of chapterBodies) {
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
    const sentences = ch.body.split(/[。！？]/).map((s) => s.trim()).filter((s) => {
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
  const topQuotes: QuoteCandidate[] = quoteCandidates.slice(0, 5)

  // 6. 落候选到 工作区/learn候选/
  const candidateRoot = join(bookRoot, CANDIDATE_DIR)
  // 清旧候选（重跑覆盖）
  try { rmSync(candidateRoot, { recursive: true, force: true }) } catch { /* 不存在无所谓 */ }
  mkdirSync(candidateRoot, { recursive: true })

  // 样章候选：样章/<场景>-候选-NN.md（拟入 front matter）
  const sampleDir = join(candidateRoot, '样章')
  mkdirSync(sampleDir, { recursive: true })
  topSamples.forEach((c, i) => {
    const fileName = `${c.场景}-候选-${String(i + 1).padStart(2, '0')}.md`
    const fm = [`场景: ${c.场景}`, `来源: 作者原作`, `出处: ${c.出处}`, `打分: ${c.打分}`].join('\n')
    writeFileSync(join(sampleDir, fileName), `---\n${fm}\n---\n\n${c.正文}`, 'utf-8')
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
    writeFileSync(join(quoteDir, `${scene}.md`), content, 'utf-8')
  }

  return {
    ok: true,
    sampleCount: topSamples.length,
    quoteCount: topQuotes.length,
    candidateDir: CANDIDATE_DIR,
    samples: topSamples,
    quotes: topQuotes,
  }
}
