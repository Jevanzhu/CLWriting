/**
 * 备料编排 —— RAG 召回与 prepare 的接缝（M7 #37 第 6 节 R1 真正接入）。
 *
 * M7 留点：prepare 虽有 ragRecallText 入参，但「调用方在 prepare 外异步 await 召回完成后传入」
 * 一直没有人接——本模块把这条链补齐：
 *
 *   prepareMaterials(db, config, bookRoot, workDir, chapterLeadIds, query?)
 *     ├─ 未配 RAG（或未启用）→ 直接 prepare()，无召回段（行为逐字节不变）
 *     └─ 已配 RAG → await recall(query) → 取回命中正文片段 → prepare(..., ragRecallText)
 *
 * 降级诚实（#37 第 6.2 节）：端点挂/未配 key/召回失败 → 召回空 → prepare 无 RAG 段，不崩主路径。
 * 账本永走精准读取不走 RAG（红线，#37 第 6.1 节）——召回只补正文片段，绝不当账本源。
 */

import type { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readFile, parseFlat } from '../format/frontmatter.js'
import { prepare, type PrepareResult } from './prepare.js'
import { readRagConfig, readApiKey } from '../rag/config.js'
import { recall, type RecallHit } from '../rag/index.js'
import { embed } from '../rag/embed.js'
import { findWorkDir } from '../install/books.js'
import type { BookConfig } from '../format/types.js'

/**
 * 取召回命中对应的原文片段（精准读取定稿正文，按偏移切片）。
 * 账本不走这里——召回只补正文（#37 红线）。
 */
function renderRecallHits(bookRoot: string, hits: RecallHit[]): string {
  if (hits.length === 0) return ''
  const lines: string[] = []
  for (const hit of hits) {
    // 命中位置：第 X 章 offset[a,b]
    // 原文精准读取：从 定稿/正文/<章号>-<标题>.md 取正文后按偏移切片
    const body = readChapterBodyByNumber(bookRoot, hit.章号)
    if (body === null) continue
    const frag = body.slice(hit.start_offset, hit.end_offset)
    if (frag.trim().length === 0) continue
    lines.push(`【第${hit.章号}章 · 相关度 ${hit.score.toFixed(2)}】\n${frag.trim()}`)
  }
  return lines.join('\n\n')
}

/**
 * 按章号精准读取定稿正文（复用 frontmatter.readFile 取 body）。
 * 兼容两种命名：<章号>-<标题>.md（原始章号）与 <章号4位补零>-<标题>.md（commit msg 口径）。
 */
function readChapterBodyByNumber(bookRoot: string, chapter: number): string | null {
  const bodyDir = join(bookRoot, '定稿', '正文')
  if (!existsSync(bodyDir)) return null
  const padded = String(chapter).padStart(4, '0')
  const candidates = [`${chapter}-`, `${padded}-`]
  for (const f of readdirSync(bodyDir)) {
    if (!f.endsWith('.md') || f.startsWith('._')) continue
    if (candidates.some((p) => f.startsWith(p))) {
      const r = readFile(join(bodyDir, f))
      if (r.ok) return r.body
    }
  }
  return null
}

export interface PrepareMaterialsOptions {
  /** 书仓库根（定稿正文在这读） */
  bookRoot: string
  /** 工作目录（RAG api_key 落在 .clwriting/，由 workDir 定位） */
  workDir: string
  /** 本章细纲声明推进的账本条目 id（源头限流） */
  chapterLeadIds: string[]
  /** RAG 召回的 query（默认用本章细纲/标题；调用方可显式传） */
  query?: string
  /** 文风样章场景；可单值或多值（G2 跨场景）。缺省由 prepare 回落「战斗」 */
  sampleScene?: string | string[]
  /** 召回 topK（默认 5） */
  topK?: number
  /** 可选：注入 embed 函数（测试用桩，默认调真实 embed）—— 与 buildIndex/recall 对齐 */
  embedFn?: typeof embed
}

export interface PrepareMaterialsResult extends PrepareResult {
  /** 本次是否触发了 RAG 召回（未配/降级 → false） */
  ragUsed: boolean
  /** 召回命中数（ragUsed=false 时 0） */
  ragHitCount: number
  /** 降级原因（召回失败/未配 key 等留痕；无降级则空） */
  ragNote?: string
  /** 文风留痕（G3）：声明了场景却查无样章时提示去 learn 补；无声明/有样章则空 */
  styleNote?: string
}

/**
 * G3 文风留痕：声明了场景（细纲/显式入参）却查无样章 → 提示去 learn 收割补。
 * 范文回落待知识层补数据（OQ2）。空声明（冷启动无场景）不留痕，保逐字节红线。
 */
function styleNoteOf(scenes: string[], base: PrepareResult): { styleNote?: string } {
  if (scenes.length === 0) return {}
  if (base.sections.some((s) => s.title === '文风样章')) return {}
  return { styleNote: `场景「${scenes.join('、')}」无样章，文风未对齐，可运行 learn 收割补（范文回落待知识层补数据）。` }
}

/**
 * 从工作区细纲 front matter 读「场景」声明（G1 场景水源 + G2 多场景，OQ1 已定）。
 *
 * 细纲正文是 freeform，但 front matter 的「场景」是结构化声明——读它是「数」不是「判」。
 * 单值 `场景: 对话` → ['对话']；多值 `场景: [战斗, 对话]` → ['战斗','对话']（首为主场景）。
 * 缺省/无细纲/无 front matter → [] → prepare 回落默认「战斗」（逐字节不变红线）。
 */
function readOutlineScenes(workDir: string): string[] {
  const outlinePath = join(workDir, '细纲.md')
  if (!existsSync(outlinePath)) return []
  const r = readFile(outlinePath)
  if (!r.ok) return [] // 无 front matter → 安全回落
  const scene = parseFlat(r.fmRaw).get('场景')
  if (typeof scene === 'string' && scene.trim()) return [scene.trim()]
  if (Array.isArray(scene)) {
    return scene.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim())
  }
  return []
}

/**
 * 从工作区细纲 front matter 读「推进」声明（账本 CLI 接缝修复：declaredLeadIds + chapterLeadIds 源）。
 *
 * 与「场景」同范式——front matter 的「推进」是结构化声明（本章计划推进的账本编号），读它是「数」不是「判」。
 * 单值 `推进: 成长线-001` → ['成长线-001']；多值 `推进: [成长线-001, 设定线-001]` → [...]。
 * 缺省/无细纲/无 front matter → []（无声明，两端闭合左侧空）。
 */
export function readOutlineLeads(workDir: string): string[] {
  const outlinePath = join(workDir, '细纲.md')
  if (!existsSync(outlinePath)) return []
  const r = readFile(outlinePath)
  if (!r.ok) return []
  const v = parseFlat(r.fmRaw).get('推进')
  if (typeof v === 'string' && v.trim()) return [v.trim()]
  if (Array.isArray(v)) {
    return v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim())
  }
  return []
}

/**
 * 备料 + RAG 召回编排（M7 #37 R1 接缝真正接入）。
 *
 * @param db 缓存
 * @param config book.yaml
 * @returns 备料结果（含召回状态）
 */
export async function prepareMaterials(
  db: DatabaseSync,
  config: BookConfig,
  opts: PrepareMaterialsOptions,
): Promise<PrepareMaterialsResult> {
  const { bookRoot, workDir, chapterLeadIds } = opts
  // 文风样章场景（G1/G2）：显式入参优先，否则从细纲 front matter 推导（OQ1）；空 → undefined → prepare 回落「战斗」
  const outlineScenes = readOutlineScenes(workDir)
  const sampleScene = opts.sampleScene ?? (outlineScenes.length > 0 ? outlineScenes : undefined)
  // G3 留痕判定用：实际生效的场景（空 = 无声明，不留痕）
  const effectiveScenes = sampleScene === undefined ? [] : Array.isArray(sampleScene) ? sampleScene : [sampleScene]
  const ragConfig = readRagConfig(bookRoot)

  // 未配 RAG → 直接 prepare，行为逐字节不变（验收红线）
  if (!ragConfig.enabled || !ragConfig.endpoint || !ragConfig.model) {
    const base = prepare(db, config, bookRoot, chapterLeadIds, undefined, sampleScene)
    return { ...base, ragUsed: false, ragHitCount: 0, ...styleNoteOf(effectiveScenes, base) }
  }

  // 已配 RAG → 读 key（环境变量 > .clwriting/rag.secret）
  // workDir 定位：传入的 workDir 可能是「书仓库内写章工作区」，真正放 .clwriting/rag.secret
  // 的是工作目录（bookRoot 的祖先含 .clwriting/）。先用传入 workDir，找不到则上溯 findWorkDir。
  const realWorkDir = existsSync(join(workDir, '.clwriting')) ? workDir : (findWorkDir(bookRoot) ?? workDir)
  const apiKey = readApiKey(realWorkDir)
  if (!apiKey) {
    const base = prepare(db, config, bookRoot, chapterLeadIds, undefined, sampleScene)
    return { ...base, ragUsed: false, ragHitCount: 0, ragNote: '未配 RAG api_key（召回降级，主路径不受影响）', ...styleNoteOf(effectiveScenes, base) }
  }

  // 召回 query：显式 > 默认「本章推进条目编号 + 近况章节」
  const query = opts.query || chapterLeadIds.join(' ') || `第${config.book.title}章`

  // 召回（失败/空命中 → 降级，不崩）。embedFn 可注入桩（测试），默认调真实 embed
  let hits: RecallHit[] = []
  let ragNote: string | undefined
  try {
    hits = await recall(bookRoot, ragConfig, apiKey, query, opts.topK ?? 5, opts.embedFn ?? embed)
  } catch {
    hits = []
    ragNote = 'RAG 召回异常（降级回落精准读取）'
  }

  if (hits.length === 0) {
    const base = prepare(db, config, bookRoot, chapterLeadIds, undefined, sampleScene)
    return {
      ...base,
      ragUsed: false,
      ragHitCount: 0,
      ragNote: ragNote ?? 'RAG 召回无命中（降级回落精准读取）',
      ...styleNoteOf(effectiveScenes, base),
    }
  }

  // 命中 → 取原文片段 → 喂给 prepare 的 ragRecallText
  const ragRecallText = renderRecallHits(bookRoot, hits)
  const base = prepare(db, config, bookRoot, chapterLeadIds, ragRecallText, sampleScene)
  return {
    ...base,
    ragUsed: true,
    ragHitCount: hits.length,
    ...styleNoteOf(effectiveScenes, base),
  }
}
