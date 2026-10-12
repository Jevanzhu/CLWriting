/**
 * 分析端点编排体（analysis.ts 的 handler 落地档）。
 *
 * 内容 = analysis.ts 六个端点的 handler 全量业务：读存量信封 + stale 判定、单章重新分析
 * （analyze）、AI 章节标签识别（autotag）、目标情绪/核心反转推断（infer-meta）、全书聚合趋势
 * （analysis-overview）、全书文风分析（analyze-style）。method/path 声明与 handler 接线留
 * analysis.ts，本档只承载被接线体；四个 runGatedGeneration 站点（analyze/autotag/infer-meta/
 * analyze-style）的 opts（book/workDir/action/busyText）仍在各站原位（闸调用点保持真实位置，
 * known-actions-audit 按调用点对账）。
 *
 * 行为不变量（纯下沉，逐字等价）：
 * - 中断收口：runAnalyst 的非 ok 一律经 replyGenerationFailure 单源映射（ABORTED → 499；
 *   其余维持 GEN_FAIL 坍缩，错误码面零扩散）。
 * - 模型档位在 AI 调用前快照（mock 时恒 'mock'，否则 resolveTier('assistant').model）——
 *   完成后二次 resolve 会在分钟级分析期间切档导致信封溯源失真。
 * - 信封落盘走异步孪生（writeAnalysisAsync / writeBookAnalysisAsync，锁等待不阻塞事件循环），
 *   落盘后 forgetAnalysisOverviewCache 写侧失效；analyze-style 另有源3 候选接线（口癖/建议 →
 *   候选，日键取本地日）。
 * - 三 kind 合一次读盘与形状守卫（坏信封跳过该章，不让 NaN 进趋势）沿用 computeAnalysisOverviewAsync。
 *
 * 依赖方向单向（无环）：本文件 → http / book-context / document（清单、分析信封、候选）/
 * metrics / format / fs / log / ai（spec 运行 + ProviderRuntime 端口 + AnalysisKind 契约类型）/
 * 同目录 rhythm + ttl-cache + cache-registry + task-gate + progress + style-scan-async；
 * analysis.ts 单向 import 本文件（本文件对 analysis.ts 只有 type 面回引 AnalysisCtx）。
 */
import { join, relative } from 'node:path'
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJson, reply, replyError } from '../http.js'
import { resolveBookOrReply, resolveDocEntry, resolveDraftByDocId } from '../book-context.js' // docId→正文解析链单源
import { readDraft } from '../../../format/draft.js'
import { readChapterDir } from '../../../format/chapters.js'
import type { ChapterMeta } from '../../../format/types.js'
import { readIronRules, computeFullStats } from '../../../metrics/style.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { analysisSpec } from '../../../ai/tasks/specs.js'
import type { AnalysisKind as ContractKind } from '../../../ai/contract/index.js'
import {
  readAnalysis,
  writeAnalysisAsync,
  writeBookAnalysisAsync,
  sourceHashOf,
  type AnalysisKind,
} from '../../../document/analysis.js'
import { mapAnalysisToCandidates, persistCandidates } from '../../../format/style-candidate.js'
import { log, localDayKey, errMsg } from '../../../log/index.js' // 候选日键本地日（同 overview/日记口径）；worker 回落 warn 留痕；errMsg 三目收编
import { safeManifestPath } from '../../../fs/safe-path.js'
import { readMdTextCachedAsync } from '../../../fs/md-text-cache.js' // GET stale 判定走异步指纹缓存读
import { replyGenerationFailure } from './task-gate.js' // 生成失败状态映射单源（走 ctx.gate 实例）
import { yieldToEventLoop, SCAN_YIELD_EVERY } from './progress.js' // MISS 读循环逐块让出（范式；起主路径下沉 worker，此为回落面）
import { runStyleScanAsync, type StyleScanJob } from './style-scan-async.js' // 全书扫描 worker 卸载
import { forgetAnalysisOverviewCache, getAnalysisOverviewCached, styleCorpusCache } from './analysis-cache.js'
import type { StyleCorpusResult } from './analysis-cache.js'
import type { AnalysisCtx } from './analysis.js'

/** analyze 端点支持的 kind（review 走独立三审端点，不在此）。 */
export const ANALYSIS_KINDS: ReadonlySet<AnalysisKind> = new Set(['score', 'emotion', 'hooks', 'style'])

export const ANALYSIS_LABEL: Record<AnalysisKind, string> = {
  review: '三审汇总',
  score: '体验分',
  emotion: '情绪曲线',
  hooks: '钩子密度',
  style: '文风总结',
}

/** 组 analyst prompt（`[kind:x]` 标记供 mock 分发；附正文 + 该 kind JSON 契约 + 章纲/stats 为底）。 */
export function buildAnalystPrompt(
  kind: AnalysisKind,
  body: string,
  chapter: ChapterMeta,
  bookRoot: string,
): string {
  const parts: string[] = [
    `[kind:${kind}]`,
    '',
    `## 任务\n对第 ${chapter.章号} 章正文做${ANALYSIS_LABEL[kind]}分析，只读不改稿。`,
  ]
  // 各 kind 附「规则版为底」（章纲 fm 声明 / 本地 stats），AI 据此补识别/评价
  if (kind === 'emotion') {
    parts.push('', `## 章纲声明目标情绪\n${chapter.情绪定位}`)
  } else if (kind === 'hooks') {
    parts.push('', `## 章纲声明钩子\n类型：${chapter.钩子类型}；强弱：${chapter.钩子强弱}`)
  } else if (kind === 'style') {
    // 附本地文风 stats（句长/重复率/口癖命中）+ IronRules（作者基线铁律）为底
    const rules = readIronRules(bookRoot)
    const stats = computeFullStats(body, rules)
    parts.push(
      '',
      `## 本地文风 stats\n${JSON.stringify(stats)}`,
      '',
      `## IronRules（作者基线铁律）\n${JSON.stringify(rules)}`,
    )
  }
  parts.push('', `## 正文\n${body}`)
  return parts.join('\n')
}

/** 信封过期判定（sourceHash 与当前正文不符）。内联别名，避免循环依赖 document/analysis 全量引入。 */
function isStaleEnv(envelope: { sourceHash: string }, fullContent: string): boolean {
  return envelope.sourceHash !== sourceHashOf(fullContent)
}

/** 跑一次 analyst 生成（runSpec 统一编排；mock 与真实同走 decode）。
 * ctrl 透传 runSpec——外部中断（/interrupt 经 driver abort）同步中止生成；
 * 中断码透传（ABORTED），其余失败维持既有 GEN_FAIL 坍缩不变（错误码面零扩散）。 */
async function runAnalyst(
  userDataPath: string | null,
  kind: ContractKind,
  prompt: string,
  bookRoot?: string,
  /** 正文/采样注入源（相对书根）——铁律①登记通道 */
  promptFiles?: string[],
  ctrl?: AbortController,
): Promise<{ ok: true; payload: unknown } | { ok: false; code: string; error: string }> {
  const out = await runSpec(analysisSpec(kind), { userDataPath, bookRoot, userPrompt: prompt, promptFiles, ctrl })
  if (!out.ok) return { ok: false, code: out.code === 'ABORTED' ? 'ABORTED' : 'GEN_FAIL', error: out.error }
  if (out.data.input) return { ok: true, payload: out.data.input }
  return { ok: false, code: 'PARSE_FAIL', error: 'AI 未通过工具提交结构化结果' }
}

/** GET 存量信封 handler——kind 白名单（GET 面含 review，POST 面不含）+ stale 判定。 */
export async function handleAnalysisGet(
  ctx: AnalysisCtx,
  routeCtx: { params: Record<string, string> },
  res: ServerResponse,
): Promise<void> {
  const { params } = routeCtx
  const r = resolveBookOrReply(ctx.workDir, params['name'], res)
  if (!r) return
  const bookRoot = r.bookRoot
  const docId = params['docId'] ?? ''
  // kind 显式白名单（原 as 断言直通；垃圾 kind 同款 404 NO_ENVELOPE，
  // 行为等价、校验显式化）
  const kindRaw = params['kind'] ?? ''
  if (!GET_ANALYSIS_KINDS.has(kindRaw)) {
    return replyError(res, 404, 'NO_ENVELOPE', '无存量分析')
  }
  const kind = kindRaw as AnalysisKind
  const m = resolveDocEntry(bookRoot, docId)
  if (!m) return replyError(res, 404, 'NOT_FOUND', `文档ID未登记：${docId}`)

  const env = readAnalysis(bookRoot, docId, kind)
  if (!env) return replyError(res, 404, 'NO_ENVELOPE', '无存量分析')

  // stale：当前正文 hash 与信封 sourceHash 不符 → 过期
  const absPath = safeManifestPath(bookRoot, m.path)
  if (!absPath) return replyError(res, 400, 'BAD_PATH', '文档路径不合法')
  let stale = false
  if (existsSync(absPath)) {
    // 裸 readFileSync 整章同步读是范式一致性
    // 残留——改走 readMdTextCachedAsync（HTTP 端点不回退同步 IO 口径；stat 指纹
    // 缓存命中零读盘）。降级语义同原 try/catch：读失败/TOCTOU 消失 → null → stale=true。
    const text = await readMdTextCachedAsync(absPath)
    stale = text === null ? true : isStaleEnv(env, text)
  }
  reply(res, 200, { ok: true, envelope: env, stale })
}

/** GET 存量信封的 kind 白名单——原 handler 对 params.kind 直接 as 断言，
 * 垃圾 kind 靠 readAnalysis 空手而归间接落 404（行为对但校验隐式）。显式化对齐
 * POST /analyze 的白名单口径；注意须含 review——review 由三审端点写入同一信封目录，
 * 读存量同样经本 GET 端点（前端 api/review.ts getReviewEnvelope），不能用 ANALYSIS_KINDS
 * 原集（那里不含 review）。垃圾 kind 显式 404 NO_ENVELOPE（与原行为等价：读不到 → 同信封）。 */
const GET_ANALYSIS_KINDS: ReadonlySet<string> = new Set<AnalysisKind>(['review', ...ANALYSIS_KINDS])

/** analyze 站点的编排体（闸已由 handler 的 runGatedGeneration 占好，ctrl 透传生成链）。 */
export async function runAnalyzeGated(
  ctx: AnalysisCtx,
  routeCtx: { params: Record<string, string>; bookRoot: string },
  req: IncomingMessage,
  res: ServerResponse,
  ctrl: AbortController,
): Promise<void> {
  const { params, bookRoot } = routeCtx
  const reqBody = await readJson(req)
  const kind = String(reqBody['kind'] ?? '').trim() as AnalysisKind
  if (!ANALYSIS_KINDS.has(kind)) {
    return replyError(res, 400, 'BAD_KIND', 'kind 需为 score/emotion/hooks/style 之一')
  }

  const docId = params['docId'] ?? ''
  // sourceHash 与进 prompt 的正文单次读取同拍（两读间作者保存
  // 会让 body 与 sourceHash 对应不同稿）——解析链
  // 收编 resolveDraftByDocId 单源（existsSync 后 µs 级竞态删除的 ENOENT 由守卫
  // 转人话 500 IO_ERROR，不再裸穿 dispatch；单读快照口径随链）。
  const d = await resolveDraftByDocId(bookRoot, docId)
  if (!d.ok) return replyError(res, d.status, d.code, d.message)
  const { entry: m, content: draftText, draft } = d
  const { body, chapter } = draft
  const sourceHash = sourceHashOf(draftText)

  // 模型档位在 AI 调用前快照——信封 model 原在完成后二次
  // resolve，分钟级分析期间切档则溯源失真（stream 侧已确立请求时刻
  // 快照口径，此处对齐）
  const modelAtRequest =
    ctx.driver.kind === 'mock' ? 'mock' : ctx.providers.resolveTier(ctx.userDataPath, 'assistant').model
  const prompt = buildAnalystPrompt(kind, body, chapter, bookRoot)
  const result = await runAnalyst(ctx.userDataPath, kind as ContractKind, prompt, bookRoot, [m.path], ctrl)
  if (!result.ok) {
    // 中断收口——ABORTED → 499 人话信封；
    // 状态映射收编 replyGenerationFailure 单源（本端点无 NO_* 码面，行为不变）
    return replyGenerationFailure(res, result)
  }
  const payload = result.payload

  const envelope = {
    generatedAt: new Date().toISOString(),
    model: modelAtRequest,
    sourceHash, // 进 prompt 时的稿（见上）——与 payload 同源，不重读
    payload,
  }
  // 写信封走异步孪生（锁等待不阻塞服务事件循环）
  await writeAnalysisAsync(bookRoot, docId, kind, envelope)
  // 全书信封落盘 → overview 缓存失效（探针/TTL 兜底）
  forgetAnalysisOverviewCache(bookRoot)
  reply(res, 200, { ok: true, envelope })
}

/** autotag 站点的编排体——AI 识别章节标签，只保留合法选项内的字段（防 AI 产出越界值）。 */
export async function runAutotagGated(
  ctx: AnalysisCtx,
  routeCtx: { params: Record<string, string>; bookRoot: string },
  res: ServerResponse,
  ctrl: AbortController,
): Promise<void> {
  const { params, bookRoot } = routeCtx
  const docId = params['docId'] ?? ''
  // existsSync→readDraft 之间的 TOCTOU（文件恰被移动/删除时
  // 裸抛 → dispatch 兜底 500 泛化「内部错误」丢现场语义）——
  // 解析链收编 resolveDraftByDocId 单源（IO 失败落 500 IO_ERROR 人话
  // 文案模式随链；单读快照口径不变）。
  const d = await resolveDraftByDocId(bookRoot, docId)
  if (!d.ok) return replyError(res, d.status, d.code, d.message)
  const { entry: m, draft } = d
  const { body, chapter } = draft

  const prompt = [
    '[kind:tags]',
    '',
    `## 任务\n对第 ${chapter.章号} 章正文做章节标签识别（钩子/情绪/场景），只读不改稿。`,
    '',
    `## 正文\n${body}`,
  ].join('\n')

  const result = await runAnalyst(ctx.userDataPath, 'tags', prompt, bookRoot, [m.path], ctrl)
  if (!result.ok) {
    // 中断收口——ABORTED → 499 人话信封；
    // 状态映射收编 replyGenerationFailure 单源（本端点无 NO_* 码面，行为不变）
    return replyGenerationFailure(res, result)
  }
  const payload = result.payload as Record<string, unknown>

  // 校验：只保留合法选项内的字段（防 AI 产出越界值）
  const ALLOWED_TAGS: Record<string, ReadonlySet<string>> = {
    钩子类型: new Set(['危机钩', '悬念钩', '渴望钩', '情绪钩', '选择钩']),
    钩子强弱: new Set(['强', '中', '弱']),
    情绪定位: new Set(['压抑', '铺垫', '小爽', '大爽', '转折']),
    场景: new Set(['战斗', '对话', '抒情', '叙事铺陈', '爽点高潮']),
  }
  const tags: Record<string, string> = {}
  for (const key of Object.keys(ALLOWED_TAGS)) {
    const allowed = ALLOWED_TAGS[key]
    const v = String(payload[key] ?? '').trim()
    if (allowed && allowed.has(v)) tags[key] = v
  }
  reply(res, 200, { ok: true, tags })
}

/** infer-meta 站点的编排体——AI 反推目标情绪/核心反转，空值不落字段。 */
export async function runInferMetaGated(
  ctx: AnalysisCtx,
  routeCtx: { params: Record<string, string>; bookRoot: string },
  res: ServerResponse,
  ctrl: AbortController,
): Promise<void> {
  const { params, bookRoot } = routeCtx
  const docId = params['docId'] ?? ''
  // 同 autotag——existsSync→readDraft TOCTOU 兜底（模式）；
  // 解析链收编 resolveDraftByDocId 单源（IO 失败落 500 IO_ERROR 人话
  const d = await resolveDraftByDocId(bookRoot, docId)
  if (!d.ok) return replyError(res, d.status, d.code, d.message)
  const { entry: m, draft } = d
  const { body, chapter } = draft

  const prompt = [
    '[kind:infer_meta]',
    '',
    `## 任务\n对第 ${chapter.章号} 章正文做目标情绪与核心反转识别，只读不改稿。`,
    '- 目标情绪：本章正文最终在读者心中落地的核心情绪（一句话，如「从压抑到释然的救赎」）',
    '- 核心反转：本章核心反转点（铺垫→反转→收尾一句话概述；无明显反转的章留空字符串）',
    '',
    `## 正文\n${body}`,
  ].join('\n')

  const result = await runAnalyst(ctx.userDataPath, 'infer_meta', prompt, bookRoot, [m.path], ctrl)
  if (!result.ok) {
    // 中断收口——ABORTED → 499 人话信封；
    // 状态映射收编 replyGenerationFailure 单源（本端点无 NO_* 码面，行为不变）
    return replyGenerationFailure(res, result)
  }
  const payload = result.payload as { 目标情绪?: string; 核心反转?: string }

  const meta: Record<string, string> = {}
  const emotion = String(payload.目标情绪 ?? '').trim()
  const reversal = String(payload.核心反转 ?? '').trim()
  if (emotion) meta.目标情绪 = emotion
  if (reversal) meta.核心反转 = reversal
  reply(res, 200, { ok: true, meta })
}

/** 全书聚合趋势 handler——mtime 探针 + TTL 缓存壳命中即跳过 manifest 整读 + 信封全读
 *  （计算体见 computeAnalysisOverviewAsync）；TTL 覆盖档经 ctx 逐调用传入。 */
export async function handleAnalysisOverview(
  ctx: AnalysisCtx,
  routeCtx: { params: Record<string, string> },
  res: ServerResponse,
): Promise<void> {
  const { params } = routeCtx
  const r = resolveBookOrReply(ctx.workDir, params['name'], res)
  if (!r) return
  // mtime 探针 + 5s TTL 缓存壳（命中即跳过 manifest 整读 + 信封全读；
  // 计算体见 computeAnalysisOverviewAsync，行为与改前逐位一致）
  // MISS 计算体异步分批让出，handler 相应 async（同文件 analyze 等
  // async handler 同款，dispatch try/catch 兜底 → 500）
  // 收尾：TTL 覆盖档经 ctx（组装根 RouteOverrides）逐调用传入
  const ov = await getAnalysisOverviewCached(r.bookRoot, ctx.analysisOverviewTtlMs ?? undefined)
  reply(res, 200, {
    ok: true,
    scoreTrend: ov.scoreTrend,
    emotionTrend: ov.emotionTrend,
    hooksTrend: ov.hooksTrend,
    style: ov.style,
    allChapters: ov.allChapters,
  })
}

/** analyze-style 站点的编排体——全文 stats + 最近 10 章采样 → AI → __book__.json；
 *  落盘后另做源3 候选接线（口癖→禁词候选、建议→手法候选，查重闸防重复骚扰）。 */
export async function runAnalyzeStyleGated(
  ctx: AnalysisCtx,
  routeCtx: { params: Record<string, string>; bookRoot: string },
  res: ServerResponse,
  ctrl: AbortController,
): Promise<void> {
  const { bookRoot } = routeCtx
  // 读所有定稿正文章节（按章号排序）
  const { chapters } = readChapterDir(join(bookRoot, '写作', '正文'))
  const sorted = chapters.slice().sort((a, b) => a.章号 - b.章号)
  if (!sorted.length) return replyError(res, 400, 'NO_CHAPTERS', '无定稿正文章节')

  // 全文 stats（所有正文字符合并扫描）+ 最近 10 章采样正文
  const rules = readIronRules(bookRoot)
  const recent = sorted.slice(-10)
  // 命中短时缓存则跳过全书重读（allBodies+join 的重扫）；章集/正文变化最迟 5s 可见
  // 壳体收编 ttl-cache.ts 通用件——原过期
  // 逐出写侧清扫/FIFO 段移入通用件 store（时序逐位不变）
  // 收尾：TTL 覆盖档经 ctx（组装根 RouteOverrides）逐调用传入
  const { fullStats, sampleText } = await styleCorpusCache.get(
    bookRoot,
    async (): Promise<StyleCorpusResult> => {
      // 扫描+统计下沉 worker 线程（export 同款先例）——
      // computeFullStats 对全书大串（join 又是一次同步大分配）的单段同步 CPU 正是
      // 0.1-1s 级事件循环停摆面。worker 失败/超时回落进程内同步
      // （保可用性——退化形态即旧行为，不产生新的失败面）
      const scanJob: StyleScanJob = {
        chapters: sorted
          .filter((ch) => ch._path)
          .map((ch) => ({ path: ch._path!, 章号: ch.章号, 标题: ch.标题, recent: recent.includes(ch) })),
        rules,
      }
      try {
        return await runStyleScanAsync(scanJob)
      } catch (e) {
        log.warn('api', `文风全书扫描 worker 失败，回落进程内同步路径：${errMsg(e)}`)
        const allBodies: string[] = []
        const recentBodies: string[] = []
        // 回落面的读循环逐块让出（范式）
        let scanned = 0
        for (const ch of sorted) {
          if (!ch._path) continue
          const draft = readDraft(ch._path)
          if (!draft.ok) continue
          allBodies.push(draft.body)
          if (recent.includes(ch)) {
            recentBodies.push(`### 第${ch.章号}章 ${ch.标题}\n\n${draft.body}`)
          }
          if (++scanned % SCAN_YIELD_EVERY === 0) await yieldToEventLoop()
        }
        return {
          fullStats: computeFullStats(allBodies.join('\n\n'), rules),
          sampleText: recentBodies.join('\n\n---\n\n'),
        }
      }
    },
    ctx.styleCorpusTtlMs ?? undefined,
  )

  // 同 analyze——模型档位调用前快照（完成后二次 resolve 在
  // 分钟级分析期间切档则信封溯源失真请求时刻口径）
  const modelAtRequest =
    ctx.driver.kind === 'mock' ? 'mock' : ctx.providers.resolveTier(ctx.userDataPath, 'assistant').model
  const prompt = [
    '[kind:style]',
    '',
    `## 任务\n对全书最近 ${recent.length} 章做文风总结分析（口癖/重复度/漂移），只读不改稿。`,
    '',
    `## 全文本地 stats（全文 ${sorted.length} 章扫描）\n${JSON.stringify(fullStats)}`,
    '',
    `## IronRules（作者基线铁律）\n${JSON.stringify(rules)}`,
    '',
    `## 最近 ${recent.length} 章采样正文\n${sampleText}`,
  ].join('\n')

  // 全书采样注入源登记（相对书根；readChapterDir 的 _path 为绝对路径）
  const styleSources = recent
    .filter((ch) => ch._path)
    .map((ch) => relative(bookRoot, ch._path!).replace(/\\/g, '/'))
  const result = await runAnalyst(ctx.userDataPath, 'style', prompt, bookRoot, styleSources, ctrl)
  if (!result.ok) {
    // 中断收口——ABORTED → 499 人话信封；
    // 状态映射收编 replyGenerationFailure 单源（本端点无 NO_* 码面，行为不变）
    return replyGenerationFailure(res, result)
  }
  const payload = result.payload

  const envelope = {
    generatedAt: new Date().toISOString(),
    model: modelAtRequest,
    sourceHash: sourceHashOf(sampleText),
    payload,
  }
  // 全书信封落盘走异步孪生——锁等待 setTimeout 轮询不阻塞事件
  // 循环（原同步版 Atomics.wait ≤5s 冻结整进程，见 document/analysis.ts 头注）
  await writeBookAnalysisAsync(bookRoot, 'style', envelope)
  // 全书信封落盘 → overview 缓存失效（探针/TTL 兜底）
  forgetAnalysisOverviewCache(bookRoot)

  // 源3 接线（文风系统重整）：口癖→禁词候选、建议→手法候选；查重闸防重复骚扰
  let styleCandidates = 0
  if (typeof payload === 'object' && payload !== null) {
    const mapped = mapAnalysisToCandidates(
      payload as { 口癖?: string[]; 建议?: string[] },
      // 候选日键本地日——与 style.ts today()/overview 热力图同口径（此前
      // UTC 切日，东八区 0-8 点生成的候选记前一日，查重闸跨日误放行）
      localDayKey(new Date()),
    )
    styleCandidates = persistCandidates(bookRoot, mapped).created.length
  }
  reply(res, 200, { ok: true, envelope, styleCandidates })
}
