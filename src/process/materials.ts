/**
 * 备料编排 —— RAG 召回与 prepare 的接缝（#37 第 6 节真正接入）。
 *
 * 留点：prepare 虽有 ragRecallText 入参，但「调用方在 prepare 外异步 await 召回完成后传入」
 * 一直没有人接——本模块把这条链补齐：
 *
 *   prepareMaterials(db, config, bookRoot, workDir, chapterLeadIds, query?)
 *     ├─ 未配 RAG（或未启用）→ 直接 prepare，无召回段（行为逐字节不变）
 *     └─ 已配 RAG → await recall(query) → 取回命中正文片段 → prepare(..., ragRecallText)
 *
 * 降级诚实（#37 第 6.2 节）：端点挂/未配 key/召回失败 → 召回空 → prepare 无 RAG 段，不崩主路径。
 * 账本永走精准读取不走 RAG（红线，#37 第 6.1 节）——召回只补正文片段，绝不当账本源。
 */

import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { readFile as fsReadFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readFile } from '../format/frontmatter.js'
import { chapterPathByNumber } from '../format/chapter-lookup.js'
import { readChapterScenes, readDeclaredChapterScenes } from './draft-pipeline.js'
import { prepare, type PrepareResult } from './prepare.js'
import { selfHealRecentChapterSummaries, selfHealVolumeSummary } from './summary.js'
import { readRagConfig } from '../rag/config.js'
import { resolveRag } from '../rag/resolve.js'
import { loadProviders, resolveTier } from '../ai/provider/index.js'
import { recallDetailed, RAG_CHUNK_WARN_THRESHOLD, type RecallHit, type RecallResult } from '../rag/index.js'
import { log, errMsg } from '../log/index.js'
import { embed } from '../rag/embed.js'
import { findWorkDir } from '../install/books.js'
import type { BookConfig } from '../format/types.js'

/**
 * 取召回命中对应的原文片段（精准读取定稿正文，按偏移切片）。
 * 账本不走这里——召回只补正文（#37 红线）。
 * 先收集去重章号，交 readChapterBodiesByNumbersAsync 按章号解析正文（定位口径 =
 * chapterPathByNumber 公共原语单源；同章号取首个命中文件，正文切片口径不变）。
 * 正文读取全链异步（fs.promises）——本函数在 studio 服务进程事件循环内被 await，
 * 逐文件整读同步执行会冻结同进程全部书的 SSE/保存；扫描期间事件循环可响应其他请求。
 */
async function renderRecallHits(bookRoot: string, hits: RecallHit[]): Promise<string> {
  if (hits.length === 0) return ''
  const bodies = await readChapterBodiesByNumbersAsync(bookRoot, [...new Set(hits.map((h) => h.章号))])
  const lines: string[] = []
  for (const hit of hits) {
    // 命中位置：第 X 章 offset[a,b]
    // 原文精准读取：从 写作/正文/<章号>-<标题>.md 取正文后按偏移切片
    const body = bodies.get(hit.章号)
    if (body === undefined) continue
    const frag = body.slice(hit.start_offset, hit.end_offset)
    if (frag.trim().length === 0) continue
    lines.push(`【第${hit.章号}章 · 相关度 ${hit.score.toFixed(2)}】\n${frag.trim()}`)
  }
  return lines.join('\n\n')
}

/**
 * 正文整读的异步孪生：fs/promises 读全文后经 readFile 的
 * content 传参（入参）复用同一解析与错误塑形单源——读失败时回落 readFile(fp)
 * 自读（readFileSync 兜底读同样失败 → 同构错误对象），调用方只看 .ok/.body 面不变。
 */
async function readFileBodyAsync(fp: string): Promise<ReturnType<typeof readFile>> {
  let text: string
  try {
    text = await fsReadFile(fp, 'utf-8')
  } catch {
    return readFile(fp) // 读失败 → readFile 自读同路径失败，错误塑形单源
  }
  return readFile(fp, text)
}

/**
 * 按章号集合解析定稿正文（RAG 召回片段水源）。
 * 定位走 format/chapter-lookup.ts 的 chapterPathByNumber 公共原语单源——「两层优先
 * （正文根 + 直接卷目录，常态零全树 walk）+ 全树 walk 兜底 + 并入回退」：
 * - 较原实现（每次整树异步 walk + chapterNamePrefixes 前缀表匹配）IO 更省，且命中
 *   口径由前缀表改为 chapterNoFromName 逐名解析单源（`5—标题.md`/裸数字名等宽容
 *   形态与 prepare/summary/失配对账等全库消费方同判——新命名形态不再需三处同改）；
 * - 并入源章回退（合并窗口内召回仍可能带源章号）由原语内建，无需本函数另建 Map。
 * 正文读取保持异步（fs/promises 读全文后经 frontmatter.readFile content 传参复用
 * 解析单源；读失败回落 readFile(fp) 自读同路径失败，错误塑形单源）——原语定位段
 * 为名字级 readdir（不读文件），两层命中时同步段有界；walk 兜底仅在全 miss 的
 * 合并窗口触发，与 mergedIntoMap 同属「miss 路径一次性同步段」口径（原函同款）。
 * 目录缺失/章不在盘 → 空 Map（不抛，调用方容错）。
 */
export async function readChapterBodiesByNumbersAsync(
  bookRoot: string,
  chapterNumbers: number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (chapterNumbers.length === 0) return out
  for (const n of chapterNumbers) {
    if (out.has(n)) continue
    const path = chapterPathByNumber(bookRoot, n)
    if (path === null) continue
    const r = await readFileBodyAsync(path)
    if (r.ok) out.set(n, r.body)
  }
  return out
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
  /** 本章章号：文风样章场景据此走 readChapterScenes 三级回退（与 draft 链同源） */
  chapter?: number
  /** RAG 召回的 query（默认用本章细纲/标题；调用方可显式传） */
  query?: string
  /** 文风样章场景显式覆盖；缺省且传了 chapter 时按三级回退推导（全空→['通用']） */
  sampleScene?: string | string[]
  /** 召回 topK（默认 5） */
  topK?: number
  /** 召回池告警/硬截断阈值（测试注入用；缺省 RAG_CHUNK_WARN_THRESHOLD）——
   *  与 recallDetailed 同参，截断事实经 ragTruncated/ragNote 透出 */
  warnThreshold?: number
  /** 编排级中断信号（同款）——内部补漏 LLM 调用
   *  （selfHealRecentChapterSummaries/selfHealVolumeSummary）透传收口，中断即时生效。 */
  signal?: AbortSignal
  /** 可选：注入 embed 函数（测试用桩，默认调真实 embed）—— 与 buildIndex/recall 对齐 */
  embedFn?: typeof embed
}

interface PrepareMaterialsResult extends PrepareResult {
  /** 本次是否触发了 RAG 召回（未配/降级 → false） */
  ragUsed: boolean
  /** 召回命中数（ragUsed=false 时 0） */
  ragHitCount: number
  /** 降级原因（召回失败/未配 key 等留痕；无降级则空） */
  ragNote?: string
  /** 本轮召回池超上限被硬截断（recall 兼容包装此前丢弃 truncated
   *  信号，消费面无感——接线后透出，供上层留痕/决策；truncated=false 时缺省） */
  ragTruncated?: boolean
  /** 文风留痕：声明了场景却查无样章时提示去 learn 补；无声明/有样章则空 */
  styleNote?: string
  /** 自愈补漏实际生成/重生成的章摘要（相对书根路径；空 = 无补漏） */
  summaryGenerated: string[]
}

/**
 * 文风留痕：声明了场景（三级水源/显式入参）却查无样章 → 提示去 learn 收割补。
 * 范文回落待知识层补数据（OQ2）。空声明（冷启动无场景）不留痕，保逐字节红线。
 */
function styleNoteOf(scenes: string[], base: PrepareResult): { styleNote?: string } {
  if (scenes.length === 0) return {}
  if (base.sections.some((s) => s.title === '文风样章')) return {}
  return {
    styleNote: `场景「${scenes.join('、')}」无样章，文风未对齐，可运行 learn 收割补（范文回落待知识层补数据）。`,
  }
}

/**
 * 备料链场景水源（kk- 归一）：与 draft 链共用 readChapterScenes 三级回退
 * （① 章纲 fm「场景」→ ② 正文 fm「场景」→ ③ 细纲「## 场景声明」段+章号门），全空回落 ['通用']。
 * 此前备料链读细纲 fm「场景」字段——全仓无生产写入方（outline 端点只写 章号/推进），
 * 恒空 → prepare 回落硬编码「战斗」，文风样章场景与本章实际场景脱节；G1/G3 特性未生效。
 */
function resolveScenes(
  bookRoot: string,
  opts: PrepareMaterialsOptions,
): { sampleScene: string[] | undefined; declaredScenes: string[] } {
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
 * 备料 + RAG 召回编排（#37 接缝真正接入）。
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
  // 文风样章场景（kk- 归一）：显式入参优先，否则按 chapter 走 readChapterScenes 三级
  // 回退（与 draft 链同一水源，全空→['通用']）；留痕只看「已声明」场景（兜底不算声明）
  const { sampleScene, declaredScenes } = resolveScenes(bookRoot, opts)
  // 写稿模型（creative 档）——prepare 的 token 系数按模型查表。
  // 解析失败降级 undefined（= 全局 token 系数兜底）而非上抛：resolveTier 内部
  // loadProviders 会因 providers.json 损坏/权限抛错，此前裸调在备料链最外层
  // ——抛错即整条备料链中断（材料段全丢），调用方 catch 又零留痕，故障不可观测。
  let writeModel: string | undefined
  try {
    writeModel = resolveTier(opts.userDataPath ?? null, 'creative').model || undefined
  } catch (e) {
    log.warn('materials', `写稿档位解析失败，token 系数回落全局默认：${errMsg(e)}`)
  }
  // 自愈补漏：备料前发现近章摘要缺失或过期 → 现场补生成
  // （计入本章 calls_per_chapter 预算，既有预算闸口径）；失败不阻断备料（无近章结尾段降级）
  let summaryGenerated: string[] = []
  if (opts.chapter !== undefined) {
    try {
      summaryGenerated = await selfHealRecentChapterSummaries(
        bookRoot,
        opts.userDataPath ?? null,
        config,
        opts.chapter,
        opts.signal,
      )
    } catch (e) {
      // 静默降级改 warn 留痕——此前「补漏失败静默」把 ENOENT/权限类
      // 持续性故障埋进零痕迹（自愈循环断链无观测），备料降级语义不变
      log.warn('materials', `近章摘要补漏失败（prepare 无该段照常组装）：${errMsg(e)}`)
    }
    // 上一卷摘要缺失且章摘要链完整 → 按需生成（链不全不强行，留痕降级）。
    // 卷摘要手写优先（文件存在即跳过）；prepare 直接读文件，无需 rebuild
    try {
      const vol = await selfHealVolumeSummary(bookRoot, opts.userDataPath ?? null, config, opts.chapter, opts.signal)
      if (vol) summaryGenerated.push(vol)
    } catch (e) {
      // 同款 warn 留痕（备料降级语义不变）
      log.warn('materials', `上一卷摘要按需生成失败（备料降级）：${errMsg(e)}`)
    }
  }
  // RAG 解析：书级引用 → 应用级服务商（providers.json ragProviders）；无引用走旧版内联回落。
  // workDir 定位：传入的 workDir 可能是「书仓库内写章工作区」，真正放 .clwriting/rag.secret
  // 的是工作目录（bookRoot 的祖先含 .clwriting/）。先用传入 workDir，找不到则上溯 findWorkDir。
  // 全局托底：enabled/provider 书级未设回落 global.json（userDataPath 由调用方注入）
  const ragConfig = readRagConfig(bookRoot, opts.userDataPath ?? null)
  // loadProviders 同款降级（与上方 writeModel 解析同因——providers.json 损坏/权限
  // 时整链中断）：解析失败按「无应用级服务商」继续，resolveRag 走旧版内联回落/未配降级
  let ragProviders: ReturnType<typeof loadProviders>['ragProviders'] = []
  if (opts.userDataPath) {
    try {
      ragProviders = loadProviders(opts.userDataPath).ragProviders
    } catch (e) {
      log.warn('materials', `应用级服务商解析失败，RAG 回落书级内联配置：${errMsg(e)}`)
    }
  }
  const realWorkDir = existsSync(join(workDir, '.clwriting')) ? workDir : (findWorkDir(bookRoot) ?? workDir)
  const resolved = resolveRag(ragConfig, ragProviders, realWorkDir)

  // 未配 RAG → 直接 prepare，行为与配 RAG 前逐字节相同
  if (!resolved) {
    const base = prepare(db, config, bookRoot, chapterLeadIds, undefined, sampleScene, writeModel, opts.chapter)
    return { ...base, ragUsed: false, ragHitCount: 0, summaryGenerated, ...styleNoteOf(declaredScenes, base) }
  }

  if (!resolved.apiKey) {
    const base = prepare(db, config, bookRoot, chapterLeadIds, undefined, sampleScene, writeModel, opts.chapter)
    return {
      ...base,
      ragUsed: false,
      ragHitCount: 0,
      summaryGenerated,
      ragNote: '未配 RAG api_key（召回降级，主路径不受影响）',
      ...styleNoteOf(declaredScenes, base),
    }
  }

  // 召回 query：显式 > 默认「本章推进条目编号 + 近况章节」> 书名（兜底召回与本书相关的片段）
  const query = opts.query || chapterLeadIds.join(' ') || config.book.title

  // 召回（失败/空命中 → 降级，不崩）。embedFn 可注入桩（测试），默认调真实 embed。
  // candidate_depth 从书级 ragConfig 显式透传（此前召回点重造字面量漏带该键，
  // book.yaml 配了 rag.candidate_depth 恒不生效——缺省 20 静默兜底）；
  // embed_timeout_ms 同款透传（缺省回落 embed.ts 内置 30s）。
  // 消费面从兼容包装 recall() 切到结构化出口 recallDetailed——
  // 原包装把 truncated/totalBlocks 丢弃（截断仅 log.warn 留痕，消费面无感），
  // 接线后截断事实经 ragTruncated + ragNote 透出（目标场景 ~3.5 万块未触界，
  // warnThreshold 仅测试注入压低触发）
  const ragWarnThreshold = opts.warnThreshold ?? RAG_CHUNK_WARN_THRESHOLD
  let rec: RecallResult | null = null
  let ragNote: string | undefined
  try {
    rec = await recallDetailed(
      bookRoot,
      {
        enabled: true,
        endpoint: resolved.endpoint,
        model: resolved.model,
        candidate_depth: ragConfig.candidate_depth,
        embed_timeout_ms: ragConfig.embed_timeout_ms,
      },
      resolved.apiKey,
      query,
      opts.topK ?? 5,
      opts.embedFn ?? embed,
      ragWarnThreshold,
      // 编排级中断透传——embed 网络往返与流式打分
      // 此前不随编排 signal 收口（分钟级白烧），现入口/网络前后/打分行级检查点齐备
      opts.signal !== undefined ? { signal: opts.signal } : undefined,
    )
  } catch (e) {
    // -源码 -⑱：降级文案附病因（对齐同文件 selfHeal 卷摘要 catch 的
    // message 透出口径）——此前 ragNote 只说「异常」，网络/中断/解析错无从归因
    rec = null
    ragNote = `RAG 召回异常（降级回落精准读取）：${errMsg(e)}`
  }
  const hits: RecallHit[] = rec?.hits ?? []
  // 截断信号透出——recallDetailed 硬截断（池超上限保读出序前缀）时留痕
  const ragTruncated = rec?.truncated ?? false
  const truncNote = ragTruncated
    ? `RAG 召回池超上限被硬截断（${rec!.totalBlocks} 块仅取前 ${ragWarnThreshold} 块参与召回，topK 可能不满额）`
    : undefined

  if (hits.length === 0) {
    // 低-1：writingChapter 与另两处调用点对齐——无命中降级也走
    // 「卷号按写作章推」口径，否则降级分支卷首章的上卷摘要晚一章注入
    const base = prepare(db, config, bookRoot, chapterLeadIds, undefined, sampleScene, writeModel, opts.chapter)
    return {
      ...base,
      ragUsed: false,
      ragHitCount: 0,
      summaryGenerated,
      ...(ragTruncated ? { ragTruncated } : {}),
      ragNote: ragNote ?? truncNote ?? 'RAG 召回无命中（降级回落精准读取）',
      ...styleNoteOf(declaredScenes, base),
    }
  }

  // 命中 → 取原文片段 → 喂给 prepare 的 ragRecallText（正文读取已异步化）
  const ragRecallText = await renderRecallHits(bookRoot, hits)
  const base = prepare(db, config, bookRoot, chapterLeadIds, ragRecallText, sampleScene, writeModel, opts.chapter)
  return {
    ...base,
    ragUsed: true,
    ragHitCount: hits.length,
    summaryGenerated,
    ...(ragTruncated ? { ragTruncated } : {}),
    ...(truncNote ? { ragNote: truncNote } : {}),
    ...styleNoteOf(declaredScenes, base),
  }
}
