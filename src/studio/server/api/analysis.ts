/**
 * 分析端点（M12 B0.2/B4，editor 组）：
 *
 * GET  /api/books/:name/documents/:docId/analysis/:kind
 *   → 读 项目/分析/<docId>.json 中该 kind 的信封 + stale 标志（无 AI 依赖）。
 *
 * POST /api/books/:name/documents/:docId/analyze  body {kind}
 *   → docId → 正文（strip fm）→ 组 prompt → generateTool(submit_<kind>) → 信封落盘
 *   → 信封落盘；kind ∈ {score/emotion/hooks/style}（review 走独立三审端点）。
 *
 * 信封落盘与展示解耦：AI 不可达时存量照常展示，仅「重新分析」置灰（无开关、置灰不隐藏）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { readManifest } from '../../../document/manifest.js'
import { readDraft } from '../../../format/draft.js'
import { readChapterDir } from '../../../format/chapters.js'
import type { ChapterMeta } from '../../../format/types.js'
import { readIronRules, computeFullStats } from '../../../metrics/style.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { analysisSpec } from '../../../ai/tasks/specs.js'
import { resolveTier } from '../../../ai/provider/index.js'
import type { AnalysisKind as ContractKind } from '../../../ai/contract/index.js'
import { readAnalysis, writeAnalysis, readBookAnalysis, writeBookAnalysis, sourceHashOf, type AnalysisKind } from '../../../document/analysis.js'
import { mapAnalysisToCandidates, persistCandidates } from '../../../format/style-candidate.js'

interface AnalysisCtx {
  workDir: string | null
  userDataPath: string | null
}

/** 跑一次 analyst 生成（runSpec 统一编排；mock 与真实同走 decode）。 */
async function runAnalyst(
  userDataPath: string | null,
  kind: ContractKind,
  prompt: string,
  bookRoot?: string,
): Promise<{ ok: true; payload: unknown } | { ok: false; code: string; error: string }> {
  const out = await runSpec(analysisSpec(kind), { userDataPath, bookRoot, userPrompt: prompt })
  if (!out.ok) return { ok: false, code: 'GEN_FAIL', error: out.error }
  if (out.data.input) return { ok: true, payload: out.data.input }
  return { ok: false, code: 'PARSE_FAIL', error: 'AI 未通过工具提交结构化结果' }
}

/** analyze 端点支持的 kind（review 走独立三审端点，不在此）。 */
const ANALYSIS_KINDS: ReadonlySet<AnalysisKind> = new Set(['score', 'emotion', 'hooks', 'style'])

const ANALYSIS_LABEL: Record<AnalysisKind, string> = {
  review: '三审汇总',
  score: '体验分',
  emotion: '情绪曲线',
  hooks: '钩子密度',
  style: '文风总结',
}

export function registerAnalysisRoutes(ctx: AnalysisCtx): void {
  // 读信封 + stale（无 AI 依赖；打开文档时读存量展示）
  route(
    'GET',
    '/api/books/:name/documents/:docId/analysis/:kind',
    (_req: IncomingMessage, res: ServerResponse, params) => {
      if (!ctx.workDir) return reply(res, 400, { ok: false, code: 'NO_WORKDIR', error: '未定位到工作目录' })
      const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
      if (!entry) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `没有这本书：${params['name']}` })
      const bookRoot = join(ctx.workDir, entry.path)
      const docId = params['docId'] ?? ''
      const kind = (params['kind'] ?? '') as AnalysisKind
      const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.get(docId)
      if (!m) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档ID未登记：${docId}` })

      const env = readAnalysis(bookRoot, docId, kind)
      if (!env) return reply(res, 404, { ok: false, code: 'NO_ENVELOPE', error: '无存量分析' })

      // stale：当前正文 hash 与信封 sourceHash 不符 → 过期
      const absPath = join(bookRoot, m.path)
      let stale = false
      if (existsSync(absPath)) {
        try {
          stale = isStaleEnv(env, readFileSync(absPath, 'utf-8'))
        } catch {
          stale = true
        }
      }
      reply(res, 200, { ok: true, envelope: env, stale })
    },
  )

  // 重新分析（B4.0）：kind → generateTool(submit_<kind>) → 落信封
  route(
    'POST',
    '/api/books/:name/documents/:docId/analyze',
    async (req: IncomingMessage, res: ServerResponse, params) => {
      if (!ctx.workDir) return reply(res, 400, { ok: false, code: 'NO_WORKDIR', error: '未定位到工作目录' })
      const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
      if (!entry) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `没有这本书：${params['name']}` })
      const reqBody = await readJson(req)
      const kind = String(reqBody['kind'] ?? '').trim() as AnalysisKind
      if (!ANALYSIS_KINDS.has(kind)) {
        return reply(res, 400, { ok: false, code: 'BAD_KIND', error: 'kind 需为 score/emotion/hooks/style 之一' })
      }

      const bookRoot = join(ctx.workDir, entry.path)
      const docId = params['docId'] ?? ''
      const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.get(docId)
      if (!m) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档ID未登记：${docId}` })
      const absPath = join(bookRoot, m.path)
      if (!existsSync(absPath)) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档不存在：${m.path}` })

      const config = readBookConfig(join(bookRoot, 'book.yaml')).config
      const isShort = (config.kind ?? 'long') === 'short'
      const draft = readDraft(absPath, isShort)
      if (!draft.ok) return reply(res, 400, { ok: false, code: 'NOT_CHAPTER', error: draft.reason })
      const { body, chapter } = draft

      const prompt = buildAnalystPrompt(kind, body, chapter, isShort ? 'short' : 'long', bookRoot)
      const result = await runAnalyst(ctx.userDataPath, kind as ContractKind, prompt, bookRoot)
      if (!result.ok) return reply(res, 500, { ok: false, code: result.code, error: result.error })
      const payload = result.payload

      const fullContent = readFileSync(absPath, 'utf-8')
      const envelope = {
        generatedAt: new Date().toISOString(),
        model: process.env['CLWRITING_DRIVER'] === 'mock' ? 'mock' : resolveTier(ctx.userDataPath, 'assistant').model,
        sourceHash: sourceHashOf(fullContent),
        payload,
      }
      writeAnalysis(bookRoot, docId, kind, envelope)
      reply(res, 200, { ok: true, envelope })
    },
  )

  // AI 章节标签识别：generateTool(submit_tags) → 结构化返回（不落信封；前端拿结果写 fm）。
  route(
    'POST',
    '/api/books/:name/documents/:docId/autotag',
    async (_req: IncomingMessage, res: ServerResponse, params) => {
      if (!ctx.workDir) return reply(res, 400, { ok: false, code: 'NO_WORKDIR', error: '未定位到工作目录' })
      const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
      if (!entry) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `没有这本书：${params['name']}` })

      const bookRoot = join(ctx.workDir, entry.path)
      const docId = params['docId'] ?? ''
      const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.get(docId)
      if (!m) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档ID未登记：${docId}` })
      const absPath = join(bookRoot, m.path)
      if (!existsSync(absPath)) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档不存在：${m.path}` })

      const config = readBookConfig(join(bookRoot, 'book.yaml')).config
      const isShort = (config.kind ?? 'long') === 'short'
      const draft = readDraft(absPath, isShort)
      if (!draft.ok) return reply(res, 400, { ok: false, code: 'NOT_CHAPTER', error: draft.reason })
      const { body, chapter } = draft

      const unit = isShort ? '篇' : '章'
      const prompt = [
        '[kind:tags]',
        '',
        `## 任务\n对第 ${chapter.章号} ${unit}正文做章节标签识别（钩子/情绪/场景），只读不改稿。`,
        '',
        `## 正文\n${body}`,
      ].join('\n')

      const result = await runAnalyst(ctx.userDataPath, 'tags', prompt, bookRoot)
      if (!result.ok) return reply(res, 500, { ok: false, code: result.code, error: result.error })
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
    },
  )

  // ── 全书聚合趋势：遍历 分析/<docId>.json 拼趋势序列（无 AI 依赖）──
  route(
    'GET',
    '/api/books/:name/analysis-overview',
    (_req: IncomingMessage, res: ServerResponse, params) => {
      if (!ctx.workDir) return reply(res, 400, { ok: false, code: 'NO_WORKDIR', error: '未定位到工作目录' })
      const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
      if (!entry) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `没有这本书：${params['name']}` })
      const bookRoot = join(ctx.workDir, entry.path)
      const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
      const analysisDir = join(bookRoot, '项目', '分析')

      const scoreTrend: { 章号: number; 标题: string; score: number; dims: Record<string, number> }[] = []
      const emotionTrend: { 章号: number; 标题: string; emotion: number; label: string }[] = []
      const hooksTrend: { 章号: number; 标题: string; density: string; hookCount: number }[] = []
      // 所有正文章节章号→docId 映射（供前端逐章/批量分析）
      const allChapters: { 章号: number; docId: string }[] = []

      // 先收集 allChapters（遍历 manifest 正文档档）
      for (const [id, me] of manifest.entries) {
        if (me.nodeType !== 'document' || !me.path.startsWith('写作/正文/')) continue
        const filename = me.path.split('/').pop() ?? ''
        const numMatch = filename.match(/^(\d+)-/)
        if (!numMatch) continue
        allChapters.push({ 章号: parseInt(numMatch[1]!, 10), docId: id })
      }
      allChapters.sort((a, b) => a.章号 - b.章号)

      if (existsSync(analysisDir)) {
        const files = readdirSync(analysisDir).filter((f) => f.endsWith('.json') && f !== '__book__.json')
        for (const file of files) {
          const docId = file.replace(/\.json$/, '')
          const me = manifest.entries.get(docId)
          if (!me || !me.path.startsWith('写作/正文/')) continue
          // 从文件名 NN-标题.md 提取章号/标题
          const filename = me.path.split('/').pop() ?? ''
          const numMatch = filename.match(/^(\d+)-/)
          if (!numMatch) continue
          const 章号 = parseInt(numMatch[1]!, 10)
          const 标题 = filename.replace(/^\d+-/, '').replace(/\.md$/, '')

          const scoreEnv = readAnalysis(bookRoot, docId, 'score')
          if (scoreEnv?.payload) {
            const p = scoreEnv.payload as { score: number; dims: Record<string, number> }
            scoreTrend.push({ 章号, 标题, score: p.score, dims: p.dims })
          }
          const emotionEnv = readAnalysis(bookRoot, docId, 'emotion')
          if (emotionEnv?.payload) {
            // tool_use 后 payload 为 { segments: [...] }；兼容旧版裸数组
            const raw = emotionEnv.payload
            const arr = Array.isArray(raw)
              ? (raw as { emotion: number; label: string }[])
              : ((raw as { segments?: { emotion: number; label: string }[] }).segments ?? [])
            if (arr.length > 0) {
              const last = arr[arr.length - 1]! // 末段值（章末情绪 = 下章起点）
              emotionTrend.push({ 章号, 标题, emotion: last.emotion, label: last.label })
            }
          }
          const hooksEnv = readAnalysis(bookRoot, docId, 'hooks')
          if (hooksEnv?.payload) {
            const p = hooksEnv.payload as { hooks: unknown[]; density: string }
            hooksTrend.push({ 章号, 标题, density: p.density, hookCount: p.hooks.length })
          }
        }
      }

      scoreTrend.sort((a, b) => a.章号 - b.章号)
      emotionTrend.sort((a, b) => a.章号 - b.章号)
      hooksTrend.sort((a, b) => a.章号 - b.章号)

      const styleEnv = readBookAnalysis(bookRoot, 'style')
      reply(res, 200, { ok: true, scoreTrend, emotionTrend, hooksTrend, style: styleEnv?.payload ?? null, allChapters })
    },
  )

  // ── 全书文风分析：全文 stats + 最近 10 章采样 → AI → __book__.json ──
  route(
    'POST',
    '/api/books/:name/analyze-style',
    async (_req: IncomingMessage, res: ServerResponse, params) => {
      if (!ctx.workDir) return reply(res, 400, { ok: false, code: 'NO_WORKDIR', error: '未定位到工作目录' })
      const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
      if (!entry) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `没有这本书：${params['name']}` })
      const bookRoot = join(ctx.workDir, entry.path)

      // 读所有定稿正文章节（按章号排序）
      const { chapters } = readChapterDir(join(bookRoot, '写作', '正文'))
      const sorted = chapters.slice().sort((a, b) => a.章号 - b.章号)
      if (!sorted.length) return reply(res, 400, { ok: false, code: 'NO_CHAPTERS', error: '无定稿正文章节' })

      const config = readBookConfig(join(bookRoot, 'book.yaml')).config
      const isShort = (config.kind ?? 'long') === 'short'

      // 全文 stats（所有正文字符合并扫描）+ 最近 10 章采样正文
      const rules = readIronRules(bookRoot)
      const allBodies: string[] = []
      const recent = sorted.slice(-10)
      const recentBodies: string[] = []
      for (const ch of sorted) {
        if (!ch._path) continue
        const draft = readDraft(ch._path, isShort)
        if (!draft.ok) continue
        allBodies.push(draft.body)
        if (recent.includes(ch)) {
          recentBodies.push(`### 第${ch.章号}章 ${ch.标题}\n\n${draft.body}`)
        }
      }

      const fullStats = computeFullStats(allBodies.join('\n\n'), rules)
      const sampleText = recentBodies.join('\n\n---\n\n')

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

      const result = await runAnalyst(ctx.userDataPath, 'style', prompt, bookRoot)
      if (!result.ok) return reply(res, 500, { ok: false, code: result.code, error: result.error })
      const payload = result.payload

      const envelope = {
        generatedAt: new Date().toISOString(),
        model: process.env['CLWRITING_DRIVER'] === 'mock' ? 'mock' : resolveTier(ctx.userDataPath, 'assistant').model,
        sourceHash: sourceHashOf(sampleText),
        payload,
      }
      writeBookAnalysis(bookRoot, 'style', envelope)

      // 源3 接线（文风系统重整）：口癖→禁词候选、建议→手法候选；查重闸防重复骚扰
      let styleCandidates = 0
      if (typeof payload === 'object' && payload !== null) {
        const mapped = mapAnalysisToCandidates(
          payload as { 口癖?: string[]; 建议?: string[] },
          new Date().toISOString().slice(0, 10),
        )
        styleCandidates = persistCandidates(bookRoot, mapped).created.length
      }
      reply(res, 200, { ok: true, envelope, styleCandidates })
    },
  )
}

/** 组 analyst prompt（`[kind:x]` 标记供 mock 分发；附正文 + 该 kind JSON 契约 + 章纲/stats 为底）。 */
function buildAnalystPrompt(
  kind: AnalysisKind,
  body: string,
  chapter: ChapterMeta,
  bookKind: 'long' | 'short',
  bookRoot: string,
): string {
  const unit = bookKind === 'short' ? '篇' : '章'
  const parts: string[] = [
    `[kind:${kind}]`,
    '',
    `## 任务\n对第 ${chapter.章号} ${unit}正文做${ANALYSIS_LABEL[kind]}分析，只读不改稿。`,
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
    parts.push('', `## 本地文风 stats\n${JSON.stringify(stats)}`, '', `## IronRules（作者基线铁律）\n${JSON.stringify(rules)}`)
  }
  parts.push('', `## 正文\n${body}`)
  return parts.join('\n')
}

/** 信封过期判定（sourceHash 与当前正文不符）。内联别名，避免循环依赖 document/analysis 全量引入。 */
function isStaleEnv(envelope: { sourceHash: string }, fullContent: string): boolean {
  return envelope.sourceHash !== sourceHashOf(fullContent)
}
