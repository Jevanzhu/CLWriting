/**
 * 分析端点（M12 B0.2/B4，editor 组）：
 *
 * GET  /api/books/:name/documents/:docId/analysis/:kind
 *   → 读 项目/分析/<docId>.json 中该 kind 的信封 + stale 标志（无 AI 依赖）。
 *
 * POST /api/books/:name/documents/:docId/analyze  body {kind}
 *   → docId → 正文（strip fm）→ 组 prompt → spawnRole('analyst') → extractJson
 *   → 信封落盘；kind ∈ {score/emotion/hooks/style}（review 走独立三审端点）。
 *
 * 信封落盘与展示解耦：AI 不可达时存量照常展示，仅「重新分析」置灰（无开关、置灰不隐藏）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { readManifest } from '../../../document/manifest.js'
import { readDraft } from '../../../format/draft.js'
import type { ChapterMeta } from '../../../format/types.js'
import { readIronRules, computeFullStats } from '../../../metrics/style.js'
import { getDriver } from '../../../driver/index.js'
import type { DriverEvent } from '../../../driver/types.js'
import { readAnalysis, writeAnalysis, sourceHashOf, type AnalysisKind } from '../../../document/analysis.js'
import { extractJson } from '../../../format/json-extract.js'

interface AnalysisCtx {
  workDir: string | null
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

/** 各 kind JSON 输出契约（prompt 末尾约束；review 不走此端点，空串占位）。 */
const ANALYSIS_CONTRACTS: Record<AnalysisKind, string> = {
  review: '',
  score:
    '格式：{"score": <1-10 整数>, "verdict": "<一句总评>", "dims": {"爽点": <1-10>, "节奏感": <1-10>, "拖沓": <1-10>}}（拖沓分越高越拖沓）',
  emotion:
    '格式：[{"seg": "<段落标识>", "emotion": <-2..2 整数>, "label": "<情绪标签>"}]（-2 谷底 / 0 平 / +2 高潮，按正文顺序分段）',
  hooks:
    '格式：{"hooks": [{"pos": "<位置>", "type": "<危机钩/悬念钩/渴望钩/情绪钩/选择钩>", "strength": <1-5>, "note": "<一句话>"}], "density": "<疏/中/密>"}',
  style:
    '格式：{"drift": "<与基线偏离方向>", "口癖": ["<高频词/句式>"], "重复度评价": "<一句话>", "建议": ["<改进建议>"]}',
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

  // 重新分析（B4.0）：kind → spawnRole(analyst) → extractJson → 落信封
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
      const driver = getDriver('cc')
      const session = await driver.startSession(ctx.workDir)
      driver.spawnRole(session, 'analyst', prompt)
      let text = ''
      try {
        for await (const ev of driver.stream(session) as AsyncGenerator<DriverEvent>) {
          if (ev.type === 'text') text += String(ev.text ?? '')
          else if (ev.type === 'done') break
          else if (ev.type === 'error') {
            driver.dispose(session)
            return reply(res, 500, { ok: false, code: 'DRIVER_FAIL', error: `driver:${ev.message}` })
          }
        }
      } catch (e) {
        driver.dispose(session)
        return reply(res, 500, { ok: false, code: 'STREAM_FAIL', error: `stream:${e instanceof Error ? e.message : String(e)}` })
      }
      driver.dispose(session)

      let payload: unknown
      try {
        payload = JSON.parse(extractJson(text))
      } catch {
        return reply(res, 500, { ok: false, code: 'PARSE_FAIL', error: `产出非合法 JSON：${text.slice(0, 120)}` })
      }

      const fullContent = readFileSync(absPath, 'utf-8')
      const envelope = {
        generatedAt: new Date().toISOString(),
        model: process.env['CLWRITING_DRIVER'] === 'mock' ? 'mock' : 'cc',
        sourceHash: sourceHashOf(fullContent),
        payload,
      }
      writeAnalysis(bookRoot, docId, kind, envelope)
      reply(res, 200, { ok: true, envelope })
    },
  )

  // AI 章节标签识别：spawnRole analyst [kind:tags] → JSON 返回（不落信封；前端拿结果写 fm）。
  route(
    'POST',
    '/api/books/:name/documents/:docId/autotag',
    async (req: IncomingMessage, res: ServerResponse, params) => {
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
        '',
        '## 输出契约\n直接输出 JSON，不要多余文字、不要 markdown 代码块、不要读文件、不要用任何工具。',
        '{"钩子类型": "<危机钩/悬念钩/渴望钩/情绪钩/选择钩>", "钩子强弱": "<强/中/弱>", "情绪定位": "<压抑/铺垫/小爽/大爽/转折>", "场景": "<战斗/对话/抒情/叙事铺陈/爽点高潮>"}',
      ].join('\n')

      const driver = getDriver('cc')
      const session = await driver.startSession(ctx.workDir)
      driver.spawnRole(session, 'analyst', prompt)
      let text = ''
      try {
        for await (const ev of driver.stream(session) as AsyncGenerator<DriverEvent>) {
          if (ev.type === 'text') text += String(ev.text ?? '')
          else if (ev.type === 'done') break
          else if (ev.type === 'error') {
            driver.dispose(session)
            return reply(res, 500, { ok: false, code: 'DRIVER_FAIL', error: `driver:${ev.message}` })
          }
        }
      } catch (e) {
        driver.dispose(session)
        return reply(res, 500, { ok: false, code: 'STREAM_FAIL', error: `stream:${e instanceof Error ? e.message : String(e)}` })
      }
      driver.dispose(session)

      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(extractJson(text))
      } catch {
        return reply(res, 500, { ok: false, code: 'PARSE_FAIL', error: `产出非合法 JSON：${text.slice(0, 120)}` })
      }

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
  parts.push(
    '',
    `## 正文\n${body}`,
    '',
    '## 输出契约\n直接输出 JSON，不要多余文字、不要 markdown 代码块、不要读文件、不要用任何工具。',
    ANALYSIS_CONTRACTS[kind],
  )
  return parts.join('\n')
}

/** 信封过期判定（sourceHash 与当前正文不符）。内联别名，避免循环依赖 document/analysis 全量引入。 */
function isStaleEnv(envelope: { sourceHash: string }, fullContent: string): boolean {
  return envelope.sourceHash !== sourceHashOf(fullContent)
}
