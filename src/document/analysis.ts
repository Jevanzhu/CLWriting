/**
 * AI 分析信封（M12 块0 B0.1）—— 随书存储的 AI 生成辅助数据。
 *
 * 生成与展示解耦：AI 不可达时存量数据照常展示，仅「重新分析」置灰
 * （与三审意见落 审稿.md 同模式，符合「无开关、置灰不隐藏」）。
 *
 * 存储：项目/分析/<docId>.json，单文件按 kind 分 key（多载荷共一文档）。
 * Envelope = { 生成时间, 模型, 正文 hash, 载荷 }；正文变更（strip fm 后）
 * hash 不匹配 → 面板标「已过期」，提示可重新分析。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { createHash } from 'node:crypto'
import { splitFrontMatter } from '../format/frontmatter.js'

/** 分析载荷种类（review=三审汇总 / score=体验分 / emotion=情绪曲线 / hooks=钩子密度 / style=文风总结）。 */
export type AnalysisKind = 'review' | 'score' | 'emotion' | 'hooks' | 'style'

/** 单条分析信封（payload 按 kind 各异；B0.1 统一 unknown，B4 各载荷细化类型）。 */
export interface Envelope {
  /** 生成时刻（ISO）。 */
  generatedAt: string
  /** 生成模型标识（如 driver:model）。 */
  model: string
  /** 源正文 sha256（strip fm 后；fm 改动不触发过期）。 */
  sourceHash: string
  /** 载荷（按 kind 结构不同）。 */
  payload: unknown
}

/** 分析文件路径：项目/分析/<docId>.json。 */
export function analysisPath(bookRoot: string, docId: string): string {
  return join(bookRoot, '项目', '分析', `${docId}.json`)
}

/** 全书级分析路径：项目/分析/__book__.json（按书存，不绑 docId；style 全书文风用）。 */
export function analysisBookPath(bookRoot: string): string {
  return join(bookRoot, '项目', '分析', '__book__.json')
}

/** 读某文档某 kind 的信封；无文件/无 kind/损坏 → null。 */
export function readAnalysis(bookRoot: string, docId: string, kind: AnalysisKind): Envelope | null {
  const fp = analysisPath(bookRoot, docId)
  if (!existsSync(fp)) return null
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, unknown>
    const env = raw[kind]
    return isEnvelope(env) ? env : null
  } catch {
    return null
  }
}

/** 写某文档某 kind 的信封（合并写：其他 kind 保留；损坏文件重建）。 */
export function writeAnalysis(
  bookRoot: string,
  docId: string,
  kind: AnalysisKind,
  envelope: Envelope,
): void {
  const fp = analysisPath(bookRoot, docId)
  let raw: Record<string, unknown> = {}
  if (existsSync(fp)) {
    try {
      raw = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, unknown>
    } catch {
      // 损坏则重建（丢弃旧载荷）
    }
  }
  raw[kind] = envelope
  atomicWriteFile(fp, JSON.stringify(raw, null, 2))
}

/** 读全书级某 kind 信封（项目/分析/__book__.json；无文件/无 kind/损坏 → null）。 */
export function readBookAnalysis(bookRoot: string, kind: AnalysisKind): Envelope | null {
  const fp = analysisBookPath(bookRoot)
  if (!existsSync(fp)) return null
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, unknown>
    const env = raw[kind]
    return isEnvelope(env) ? env : null
  } catch {
    return null
  }
}

/** 写全书级某 kind 信封（合并写：其他 kind 保留）。 */
export function writeBookAnalysis(
  bookRoot: string,
  kind: AnalysisKind,
  envelope: Envelope,
): void {
  const fp = analysisBookPath(bookRoot)
  let raw: Record<string, unknown> = {}
  if (existsSync(fp)) {
    try {
      raw = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, unknown>
    } catch {
      /* 损坏则重建 */
    }
  }
  raw[kind] = envelope
  atomicWriteFile(fp, JSON.stringify(raw, null, 2))
}

/** 算源正文 hash（strip fm 后 sha256）。调用方组装信封时用。 */
export function sourceHashOf(fullContent: string): string {
  return createHash('sha256').update(bodyOf(fullContent)).digest('hex')
}

/** 信封是否过期（源正文 hash 与当前不符）。fullContent = 文档全文（含 fm）。 */
export function isStale(envelope: Envelope, fullContent: string): boolean {
  return envelope.sourceHash !== sourceHashOf(fullContent)
}

/** 剥 frontmatter 取正文（与 service.bodyOf 同口径；裸 md 无 fm 原样返回）。 */
function bodyOf(raw: string): string {
  const s = splitFrontMatter(raw)
  return s ? s.body : raw
}

/** 信封结构守卫（generatedAt/model/sourceHash 必为字符串；payload 任意）。 */
function isEnvelope(v: unknown): v is Envelope {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return (
    typeof e.generatedAt === 'string' &&
    typeof e.model === 'string' &&
    typeof e.sourceHash === 'string'
  )
}
