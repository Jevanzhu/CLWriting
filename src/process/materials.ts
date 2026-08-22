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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { walkMdFind } from '../fs/walk-md.js'
import { readFile } from '../format/frontmatter.js'
import { chapterNamePrefixes } from '../format/chapters.js'
import { readChapterScenes, readDeclaredChapterScenes } from './draft-pipeline.js'
import { prepare, type PrepareResult } from './prepare.js'
import { selfHealRecentChapterSummaries, selfHealVolumeSummary } from './summary.js'
import { readRagConfig } from '../rag/config.js'
import { resolveRag } from '../rag/resolve.js'
import { loadProviders, resolveTier } from '../ai/provider/index.js'
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
    // 原文精准读取：从 写作/正文/<章号>-<标题>.md 取正文后按偏移切片
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
 * 前缀口径走 chapterNamePrefixes 单一真相源（CC-P2-21）：无补零 / 3 位 / 4 位补零全试——
 * 草稿新建是 3 位补零，此前只试「无补零 + 4 位」导致这些章 RAG 召回静默返回 null。
 */
function readChapterBodyByNumber(bookRoot: string, chapter: number): string | null {
  const bodyDir = join(bookRoot, '写作', '正文')
  if (!existsSync(bodyDir)) return null
  return findChapterBodyRecursive(bodyDir, chapterNamePrefixes(chapter))
}

/** 递归扫描正文目录（含卷子目录），按文件名前缀匹配章号取正文。
 *  v2 后章节可在 写作/正文/<卷>/ 子目录，非递归会漏（D1）。 */
/** L-P1（第八轮）：走共享 walkMdFind（环剪枝 + 起遍目录根界），替换手写递归 */
function findChapterBodyRecursive(dir: string, candidates: string[]): string | null {
  return (
    walkMdFind(dir, (abs, name) => {
      if (!candidates.some((p) => name.startsWith(p))) return undefined
      const r = readFile(abs)
      return r.ok ? r.body : undefined
    }) ?? null
  )
}

export interface PrepareMaterialsOptions {
  /** 书仓库根（定稿正文在这读） */
  bookRoot: string
  /** 工作目录（旧版内联 RAG 的 key 落 .clwriting/，由 workDir 定位） */
  workDir: string
  /** 应用数据目录（RAG 服务商存 providers.json；缺省只走旧版内联回落） */
  userDataPath?: string
  /** 本章细纲声明推进的账本条目 id（源头限流） */
  chapterLeadIds: string[]
  /** 本章章号（kk-P1-2）：文风样章场景据此走 readChapterScenes 三级回退（与 draft 链同源） */
  chapter?: number
  /** RAG 召回的 query（默认用本章细纲/标题；调用方可显式传） */
  query?: string
  /** 文风样章场景显式覆盖；缺省且传了 chapter 时按三级回退推导（全空→['通用']） */
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
  /** C1（批 2）：自愈补漏实际生成/重生成的章摘要（相对书根路径；空 = 无补漏） */
  summaryGenerated: string[]
}

/**
 * G3 文风留痕：声明了场景（三级水源/显式入参）却查无样章 → 提示去 learn 收割补。
 * 范文回落待知识层补数据（OQ2）。空声明（冷启动无场景）不留痕，保逐字节红线。
 */
function styleNoteOf(scenes: string[], base: PrepareResult): { styleNote?: string } {
  if (scenes.length === 0) return {}
  if (base.sections.some((s) => s.title === '文风样章')) return {}
  return { styleNote: `场景「${scenes.join('、')}」无样章，文风未对齐，可运行 learn 收割补（范文回落待知识层补数据）。` }
}

/**
 * 备料链场景水源（kk-P1-2 归一）：与 draft 链共用 readChapterScenes 三级回退
 * （① 章纲 fm「场景」→ ② 正文 fm「场景」→ ③ 细纲「## 场景声明」段+章号门），全空回落 ['通用']。
 * 此前备料链读细纲 fm「场景」字段——全仓无生产写入方（outline 端点只写 章号/推进），
 * 恒空 → prepare 回落硬编码「战斗」，文风样章场景与本章实际场景脱节；G1/G3 特性未生效。
 */
function resolveScenes(bookRoot: string, opts: PrepareMaterialsOptions): { sampleScene: string[] | undefined; declaredScenes: string[] } {
  // 显式入参优先（测试/调用方覆盖）；未传 chapter 的旧调用维持「不推导」→ prepare 自行回落
  if (opts.sampleScene !== undefined) {
    const arr = Array.isArray(opts.sampleScene) ? opts.sampleScene : [opts.sampleScene]
    return { sampleScene: arr, declaredScenes: arr }
  }
  if (opts.chapter === undefined) return { sampleScene: undefined, declaredScenes: [] }
  return {
    sampleScene: readChapterScenes(bookRoot, opts.chapter),
    declaredScenes: readDeclaredChapterScenes(bookRoot, opts.chapter),
  }
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
  // 文风样章场景（kk-P1-2 归一）：显式入参优先，否则按 chapter 走 readChapterScenes 三级
  // 回退（与 draft 链同一水源，全空→['通用']）；G3 留痕只看「已声明」场景（兜底不算声明）
  const { sampleScene, declaredScenes } = resolveScenes(bookRoot, opts)
  // C4（批 3）：写稿模型（creative 档）——prepare 的 token 系数按模型查表
  const writeModel = resolveTier(opts.userDataPath ?? null, 'creative').model || undefined
  // C1（批 2）自愈补漏：备料前发现近章（N-2/N-1）摘要缺失或过期 → 现场补生成
  // （计入本章 calls_per_chapter 预算，既有预算闸口径）；失败不阻断备料（无近章结尾段降级）
  let summaryGenerated: string[] = []
  if (opts.chapter !== undefined) {
    try {
      summaryGenerated = await selfHealRecentChapterSummaries(bookRoot, opts.userDataPath ?? null, config, opts.chapter)
    } catch { /* 补漏失败静默降级——prepare 无该段照常组装 */ }
    // C2（批 3）：上一卷摘要缺失且章摘要链完整 → 按需生成（链不全不强行，留痕降级）。
    // 卷摘要手写优先（文件存在即跳过）；prepare 直接读文件，无需 rebuild
    try {
      const vol = await selfHealVolumeSummary(bookRoot, opts.userDataPath ?? null, config, opts.chapter)
      if (vol) summaryGenerated.push(vol)
    } catch { /* 同上：备料降级 */ }
  }
  // RAG 解析：书级引用 → 应用级服务商（providers.json ragProviders）；无引用走旧版内联回落。
  // workDir 定位：传入的 workDir 可能是「书仓库内写章工作区」，真正放 .clwriting/rag.secret
  // 的是工作目录（bookRoot 的祖先含 .clwriting/）。先用传入 workDir，找不到则上溯 findWorkDir。
  // 全局托底：enabled/provider 书级未设回落 global.json（userDataPath 由调用方注入）
  const ragConfig = readRagConfig(bookRoot, opts.userDataPath ?? null)
  const ragProviders = opts.userDataPath ? loadProviders(opts.userDataPath).ragProviders : []
  const realWorkDir = existsSync(join(workDir, '.clwriting')) ? workDir : (findWorkDir(bookRoot) ?? workDir)
  const resolved = resolveRag(ragConfig, ragProviders, realWorkDir)

  // 未配 RAG → 直接 prepare，行为逐字节不变（验收红线）
  if (!resolved) {
    const base = prepare(db, config, bookRoot, chapterLeadIds, undefined, sampleScene, writeModel, opts.chapter)
    return { ...base, ragUsed: false, ragHitCount: 0, summaryGenerated, ...styleNoteOf(declaredScenes, base) }
  }

  if (!resolved.apiKey) {
    const base = prepare(db, config, bookRoot, chapterLeadIds, undefined, sampleScene, writeModel, opts.chapter)
    return { ...base, ragUsed: false, ragHitCount: 0, summaryGenerated, ragNote: '未配 RAG api_key（召回降级，主路径不受影响）', ...styleNoteOf(declaredScenes, base) }
  }

  // 召回 query：显式 > 默认「本章推进条目编号 + 近况章节」> 书名（兜底召回与本书相关的片段）
  const query = opts.query || chapterLeadIds.join(' ') || config.book.title

  // 召回（失败/空命中 → 降级，不崩）。embedFn 可注入桩（测试），默认调真实 embed。
  // candidate_depth 从书级 ragConfig 显式透传（此前召回点重造字面量漏带该键，
  // book.yaml 配了 rag.candidate_depth 恒不生效——缺省 20 静默兜底）
  let hits: RecallHit[] = []
  let ragNote: string | undefined
  try {
    hits = await recall(bookRoot, { enabled: true, endpoint: resolved.endpoint, model: resolved.model, candidate_depth: ragConfig.candidate_depth }, resolved.apiKey, query, opts.topK ?? 5, opts.embedFn ?? embed)
  } catch {
    hits = []
    ragNote = 'RAG 召回异常（降级回落精准读取）'
  }

  if (hits.length === 0) {
    // 低-1（第十轮）：writingChapter 与另两处调用点对齐——无命中降级也走 L-P3
    // 「卷号按写作章推」口径，否则降级分支卷首章的上卷摘要晚一章注入
    const base = prepare(db, config, bookRoot, chapterLeadIds, undefined, sampleScene, writeModel, opts.chapter)
    return {
      ...base,
      ragUsed: false,
      ragHitCount: 0,
      summaryGenerated,
      ragNote: ragNote ?? 'RAG 召回无命中（降级回落精准读取）',
      ...styleNoteOf(declaredScenes, base),
    }
  }

  // 命中 → 取原文片段 → 喂给 prepare 的 ragRecallText
  const ragRecallText = renderRecallHits(bookRoot, hits)
  const base = prepare(db, config, bookRoot, chapterLeadIds, ragRecallText, sampleScene, writeModel, opts.chapter)
  return {
    ...base,
    ragUsed: true,
    ragHitCount: hits.length,
    summaryGenerated,
    ...styleNoteOf(declaredScenes, base),
  }
}
