/**
 * 知识层装配单点——三面（写稿 / 三审 / 对话）共用的注入段组装。
 *
 * 此前三面各持一份平行实现（解析 → 单篇帽 → 计量 → 标题提取 → 拼段 → 收 sources），
 * 标题提取与超帽判据各抄一遍，语义已现分叉（写稿 `continue` / 对话 `break` / 三审无）。
 * 收敛到这里后，各面只声明**策略**（选哪些篇、帽值多少、为何入选），装配语义单源：
 *
 * - 解析：`resolveCorpusFile`（书级 > 随包，两级皆缺 / 不可读 / 超 256KB → `null`）；
 * - 单篇超帽：保头截断 + 标注（`clipWithNotice`），登记名照记（注入确有其实）；
 * - 合计超帽：该篇记 `cap-total` 并**即止**（候选表本身即优先级序，低优先级篇不得
 *   挤掉高优先级篇的位置）；
 * - 开关关停：`enabled === false` 不读盘，逐 rel 记 `switch-off`，段与登记一并空；
 * - 标题：`<类目>/<篇>.md` → `<篇>`（单点，消三处 `lastIndexOf('/')+1` 复制）；
 * - 拼段：`heading` 是**整块段头前缀（含其后换行）**，其后接各篇块，块间空行。
 *   三面段文本是测试锚定面（含段头与首篇间的换行数），故换行形态由调用方在
 *   `heading` 里给全，本模块不代它统一——统一会改段文本字节。
 *
 * 段为空（无任何篇入选）时 `text: ''`，调用方按「空段不入 prompt 不登记」契约处置。
 */
import type { ResolvedCorpus } from './corpus.js'
import { ensureBundledCorpusChecked, resolveCorpusFile } from './corpus.js'
import { clipWithNotice, codePointLength } from '../shared/text.js'
import { log } from '../log/index.js'

/** 单篇入选登记：为何入选、注入了多少、是否被截断（报告面/接口面消费） */
export interface PieceRecord {
  /** 子集相对路径（如 `长篇/章节钩子速查.md`） */
  rel: string
  /** 取件层：书级 `知识层/<rel>` or 随包 `知识层(内置)/<rel>` */
  layer: 'book' | 'bundled'
  /** 注入登记名（`知识层/<rel>` / `知识层(内置)/<rel>`） */
  source: string
  /** 为何入选（人话） */
  reason: string
  /** 实际注入的码点数（截断后） */
  codePoints: number
  truncated: boolean
}

/** 未入选登记：缺口结构化回报（取代静默丢弃） */
export interface DroppedPiece {
  rel: string
  reason: 'missing' | 'cap-total' | 'switch-off'
}

export interface KnowledgeAssembly {
  /** 注入段全文；无篇入选为空串 */
  text: string
  /** 注入源登记名（注入序，仅含实际入选篇） */
  sources: string[]
  /** 入选篇逐条留痕（注入序） */
  records: PieceRecord[]
  /** 未入选篇留痕（声明序） */
  dropped: DroppedPiece[]
}

/** 报告面形状（接口返回与 log 共用）——「一篇为何入选 / 哪些篇未入选」两问的答案。 */
export interface KnowledgeReport {
  records: PieceRecord[]
  dropped: DroppedPiece[]
}

/** 取报告面（装配结果 → 报告）：只挑两列，避免接口面把段文本/sources 一并带出去。 */
export function knowledgeReportOf(a: KnowledgeAssembly): KnowledgeReport {
  return { records: a.records, dropped: a.dropped }
}

/**
 * 同面多段注入合流（写稿面 = 按章技法选材段 + 按书题材参考段）。
 *
 * 段文本按序以空行相接、登记名与非入选留痕并流：报告面仍是「一面一报告」，
 * 哪个来源取到/漏了料由 `records[].reason` 分辨（与三审按 lens 标注同族）。
 * 段为空者不参与相接（空段不入 prompt 的既有契约在合流层再保一次）。
 */
export function mergeKnowledgeAssemblies(parts: readonly KnowledgeAssembly[]): KnowledgeAssembly {
  const texts = parts.map((p) => p.text).filter((t) => t !== '')
  return {
    text: texts.join('\n\n'),
    sources: parts.flatMap((p) => p.sources),
    records: parts.flatMap((p) => p.records),
    dropped: parts.flatMap((p) => p.dropped),
  }
}

/**
 * 缺口摘要（计数式，人话）：`missing×1 cap-total×1 switch-off×2`。
 * 只计**不列 rel**——日志要能直接进诊断包（rel 属书库侧取值，带它就得走内容门登记）；
 * 缺口计数已足够回答「这一面是不是少给了料、少在哪一类」。
 */
export function summarizeDropped(dropped: readonly DroppedPiece[]): string {
  if (dropped.length === 0) return '无'
  const byReason = new Map<string, number>()
  for (const d of dropped) byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1)
  return [...byReason].map(([reason, n]) => `${reason}×${n}`).join(' ')
}

/** `<类目>/<篇>.md` → `<篇>`（标题提取单点） */
export function titleOf(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, '')
}

/**
 * 组装知识层注入段。
 *
 * @param rels 候选篇目（**即优先级序**；由各面策略给出）
 * @param heading 段头整块前缀（含其后换行——三面换行形态各不相同，逐字保持）
 * @param fileCap 单篇码点帽（超帽保头截断 + 标注）
 * @param totalCap 合计码点帽（超帽即止；`Infinity` = 本面无合计帽）
 * @param enabled `false` = 开关关停（不读盘，逐 rel 记 `switch-off`）；缺省/`true` 照常
 * @param reasonOf 逐篇入选理由（人话文案，报告面用）
 */
export function assembleKnowledge(args: {
  bookRoot?: string
  rels: readonly string[]
  heading: string
  fileCap: number
  totalCap: number
  enabled?: boolean
  reasonOf: (rel: string, i: number) => string
}): KnowledgeAssembly {
  const { bookRoot, rels, heading, fileCap, totalCap, enabled, reasonOf } = args
  if (enabled === false) {
    return {
      text: '',
      sources: [],
      records: [],
      dropped: rels.map((rel) => ({ rel, reason: 'switch-off' as const })),
    }
  }

  // 首次注入前抽查随包语料(一次性;缺口只留痕不阻断——见 corpus.ensureBundledCorpusChecked)
  ensureBundledCorpusChecked()

  const blocks: string[] = []
  const sources: string[] = []
  const records: PieceRecord[] = []
  const dropped: DroppedPiece[] = []
  let total = 0

  for (let i = 0; i < rels.length; i++) {
    const rel = rels[i]!
    const resolved: ResolvedCorpus | null = resolveCorpusFile(bookRoot, rel)
    if (resolved === null) {
      // 两级皆缺 / 读失败 / 超限——增强面不阻断,留痕后跳过该篇
      log.warn('knowledge-inject', `语料两级皆缺,跳过该篇:${rel}(书级 知识层/${rel} 与随包均不可读)`)
      dropped.push({ rel, reason: 'missing' })
      continue
    }
    const rawLen = codePointLength(resolved.body)
    const body = clipWithNotice(resolved.body, fileCap)
    const len = codePointLength(body)
    if (total + len > totalCap) {
      log.warn('knowledge-inject', `注入合计超帽(${totalCap} 码点),此后篇目不入段:${rel}`)
      dropped.push({ rel, reason: 'cap-total' })
      break
    }
    total += len
    blocks.push(`### ${titleOf(rel)}\n${body}`)
    sources.push(resolved.source)
    records.push({
      rel,
      layer: resolved.layer,
      source: resolved.source,
      reason: reasonOf(rel, i),
      codePoints: len,
      truncated: rawLen > fileCap,
    })
  }

  if (blocks.length === 0) return { text: '', sources: [], records, dropped }
  return { text: `${heading}${blocks.join('\n\n')}`, sources, records, dropped }
}
