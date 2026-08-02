/**
 * rewrite 改写端点(2.5 + M12 B2.1):局部改写 + 整章返修 + diff,docId 直读。
 *
 * POST /api/books/:name/documents/:docId/rewrite  body {instruction, selection?, append?}
 *   → 读正文(strip fm body)→ 组 prompt → generateTool(submit_text)→ produced
 *   → local:replace(selection, produced);whole:produced 即整稿;append:原文+续写
 *   → lineDiff(原, 改)→ {ok, mode, original, rewritten, diff}
 *
 * POST /api/books/:name/documents/:docId/ai-version  body {content}
 *   → 作者接受改写时上报 AI 版全文 → 旁路 ref(文风S2 轨迹,不碰正文)
 *
 * 改写走 generateTool(submit_text);apply 不走后端,前端拿 rewritten 进编辑器由作者 ⌘S 保存。
 * diff 行级 LCS 自写(YAGNI,~50 行)。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readKind } from '../book-context.js'
import { runTask } from '../../../ai/runner.js'
import { generateTool } from '../../../ai/gen.js'
import { resolveTier } from '../../../ai/provider/index.js'
import { submitText } from '../../../ai/contract/index.js'
import { REWRITER_SYSTEM } from '../../../ai/prompts/index.js'
import { readManifest } from '../../../document/manifest.js'
import { readDraft } from '../../../format/draft.js'
import { recordAiVersion } from '../../../git/ai-track.js'

interface RewriteCtx {
  workDir: string | null
  userDataPath: string | null
}

/** 跑一次 writer 改写（经 runTask 统一编排：mock/provider/中断/错误文案；mock 与真实同走 decode）。 */
async function runRewriter(
  userDataPath: string | null,
  prompt: string,
): Promise<{ ok: true; produced: string } | { ok: false; code: string; error: string }> {
  const tier = resolveTier(userDataPath, 'creative')
  const out = await runTask<{ input: unknown; text: string }>({
    userDataPath,
    tierKind: 'creative',
    mockTool: 'submit_text',
    run: (provider, signal) =>
      generateTool(
        provider,
        {
          systemPrompt: REWRITER_SYSTEM,
          messages: [{ role: 'user', content: prompt }],
          maxTokens: tier.maxTokens,
          effort: tier.effort,
          tools: [submitText()],
          toolChoice: 'tool',
          toolName: 'submit_text',
        },
        signal,
      ),
  })
  if (!out.ok) return { ok: false, code: 'GEN_FAIL', error: out.error }
  const { input, text } = out.data
  // tool_use 产出 → input.正文
  if (input && typeof input === 'object') {
    const produced = String((input as Record<string, unknown>)['正文'] ?? '').trim()
    if (produced) return { ok: true, produced }
  }
  // 降级：tool_use 未命中 → 直接用 text
  if (text.trim()) return { ok: true, produced: text.trim() }
  return { ok: false, code: 'EMPTY_OUTPUT', error: 'writer 产出为空' }
}

export interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
}

export function registerRewriteRoutes(ctx: RewriteCtx): void {
  // 改写直读（M12 B2.1，O-a）：docId → 正文（strip fm 的 body）→ generateTool(submit_text) → lineDiff
  // apply 不走后端：前端拿 rewritten 进编辑器 buffer 由作者 ⌘S 保存（最纯提案模型，AI 永不直接落盘正文）
  // M2 续写解选区：body {instruction, append:true}（无 selection）→ 全文作语境只产续写部分 → 原文 + 续写
  route('POST', '/api/books/:name/documents/:docId/rewrite', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { ok: false, code: 'NO_WORKDIR', error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `没有这本书：${params['name']}` })
    const reqBody = await readJson(req)
    const instruction = String(reqBody['instruction'] ?? '').trim()
    if (!instruction) return reply(res, 400, { ok: false, code: 'BAD_INPUT', error: 'instruction(改写指令)必填' })
    const selectionRaw = String(reqBody['selection'] ?? '').trim()
    const append = reqBody['append'] === true

    const bookRoot = join(ctx.workDir, entry.path)
    const docId = params['docId'] ?? ''
    const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.get(docId)
    if (!m) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档ID未登记：${docId}` })
    const absPath = join(bookRoot, m.path)
    if (!existsSync(absPath)) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档不存在：${m.path}` })

    const isShort = readKind(bookRoot) === 'short'
    const draft = readDraft(absPath, isShort)
    if (!draft.ok) return reply(res, 400, { ok: false, code: 'NOT_CHAPTER', error: draft.reason })
    const original = draft.body
    // append(M2)：无靶点纯追加；否则 选区空 → 整 body 改写（whole）；非空 → 选段改写（local）。改写统一走 local prompt（body 语境，不涉 fm）
    const selection = selectionRaw || original
    const mode: 'local' | 'whole' | 'append' = append ? 'append' : selectionRaw ? 'local' : 'whole'
    if (mode === 'local' && !original.includes(selection)) {
      return reply(res, 400, { ok: false, code: 'BAD_INPUT', error: 'selection 不在正文内' })
    }

    const prompt = append
      ? buildAppendPrompt(original, instruction)
      : buildRewritePrompt('local', original, selection, instruction, [], draft.chapter.章号, isShort ? 'short' : 'long')
    const result = await runRewriter(ctx.userDataPath, prompt)
    if (!result.ok) return reply(res, 500, { ok: false, code: result.code, error: result.error })
    const produced = result.produced
    const rewritten =
      mode === 'append' ? appendRewritten(original, produced)
      : mode === 'local' ? original.replace(selection, produced)
      : produced
    if (rewritten === original) {
      return reply(res, 500, { ok: false, code: 'NO_CHANGE', error: '改写产出与原文相同（未发生变化）' })
    }
    reply(res, 200, { ok: true, mode, original, rewritten, diff: lineDiff(original, rewritten) })
  })

  // 改稿轨迹采集（文风S2）：作者接受改写时前端上报 AI 版全文 → 旁路 ref。
  // 只写 ref 不碰正文（「AI 永不落盘正文」红线不破）；失败静默——轨迹是旁路证据，不阻断接受。
  route('POST', '/api/books/:name/documents/:docId/ai-version', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { ok: false, code: 'NO_WORKDIR', error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `没有这本书：${params['name']}` })
    const reqBody = await readJson(req)
    const content = typeof reqBody['content'] === 'string' ? (reqBody['content'] as string) : ''
    if (!content.trim()) return reply(res, 400, { ok: false, code: 'BAD_INPUT', error: 'content 为空' })
    const ref = recordAiVersion(join(ctx.workDir, entry.path), params['docId'] ?? '', content)
    reply(res, 200, { ok: true, recorded: ref !== null })
  })

  }

/** 组改写 prompt(方案 6.7:原文 + 指令 + 要求)*/
export function buildRewritePrompt(
  mode: 'local' | 'whole',
  original: string,
  selection: string,
  instruction: string,
  reviewIssues: string[],
  chapter: number,
  kind: 'long' | 'short',
): string {
  if (mode === 'local') {
    return [
      '## 原文(选中段落)',
      selection,
      '',
      '## 改写指令',
      instruction,
      '',
      '## 要求',
      '只改写选中段落,不动其他;保持正文纯文本(段落+空行,禁 MD 标题/格式)。',
    ].join('\n')
  }
  const unit = kind === 'short' ? '篇' : '章'
  const parts = [
    '## 任务',
    `按指令${reviewIssues.length ? ' / 审稿意见' : ''}重写第 ${chapter} ${unit}正文。`,
    '',
    `## 原${unit}正文`,
    original,
    '',
    '## 改写指令',
    instruction,
  ]
  if (reviewIssues.length) {
    parts.push('', '## 审稿意见(逐条采纳)', ...reviewIssues.map((s, i) => `${i + 1}. ${s}`))
  }
  parts.push(
    '',
    '## 要求',
    kind === 'short'
      ? '按指令重写整篇正文(8000-20000 字,单篇完整开合:铺垫→反转→收尾)。'
      : '按指令重写整章正文(2000-4000 字,单章一主场景,章尾留钩)。',
  )
  return parts.join('\n')
}

/** 组续写 prompt(M2 续写解选区:全文作语境,只输出续写部分,不复述原文)*/
export function buildAppendPrompt(original: string, instruction: string): string {
  return [
    '## 正文全文(语境)',
    original.trim() || '(本章尚无正文,从头开写)',
    '',
    '## 续写指令',
    instruction,
    '',
    '## 要求',
    '在正文之后继续写。只输出续写部分,不要复述或改动原文任何内容;保持正文纯文本(段落+空行,禁 MD 标题/格式),延续当前文风与情节。',
  ].join('\n')
}

/** append 续写拼稿:原文(去尾换行)+ 空行 + 续写;空白页直接用续写 */
export function appendRewritten(original: string, produced: string): string {
  const base = original.replace(/\n+$/, '')
  return base ? `${base}\n\n${produced}` : produced
}

/** 草稿文件名:长篇 草稿-<章号>.md;短篇 草稿-1.md(候选) */
export function draftFileName(chapter: number, kind: 'long' | 'short'): string {
  return kind === 'short' ? '草稿-1.md' : `草稿-${chapter}.md`
}

/** 行级 LCS diff → DiffLine[](export 供测试)*/
export function lineDiff(a: string, b: string): DiffLine[] {
  const la = a.split('\n')
  const lb = b.split('\n')
  const n = la.length
  const m = lb.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const ai = la[i] ?? ''
      const bj = lb[j] ?? ''
      dp[i]![j] = ai === bj ? (dp[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const ai = la[i] ?? ''
    const bj = lb[j] ?? ''
    if (ai === bj) {
      out.push({ type: 'same', text: ai })
      i++
      j++
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push({ type: 'del', text: ai })
      i++
    } else {
      out.push({ type: 'add', text: bj })
      j++
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: la[i] ?? '' })
    i++
  }
  while (j < m) {
    out.push({ type: 'add', text: lb[j] ?? '' })
    j++
  }
  return out
}
