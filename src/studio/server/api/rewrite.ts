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
import { existsSync } from 'node:fs'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { safeManifestPath } from '../../../fs/safe-path.js'
import { readBooks } from '../../../install/books.js'
import { readKind } from '../../../format/kind.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { REWRITE_SPEC } from '../../../ai/tasks/specs.js'
import { readManifest } from '../../../document/manifest.js'
import { readDraft } from '../../../format/draft.js'
import { recordAiVersion } from '../../../git/ai-track.js'
import {
  buildRewritePrompt,
  buildAppendPrompt,
  appendRewritten,
  lineDiff,
} from '../../../process/rewrite-prompt.js'

// re-export（P1-8 下沉兼容：既有 import 方零感知）
export { buildRewritePrompt, buildAppendPrompt, appendRewritten, lineDiff, type DiffLine } from '../../../process/rewrite-prompt.js'

interface RewriteCtx {
  workDir: string | null
  userDataPath: string | null
}

/** 跑一次 writer 改写（runSpec 统一编排；mock 与真实同走 decode）。 */
async function runRewriter(
  userDataPath: string | null,
  prompt: string,
  bookRoot?: string,
): Promise<{ ok: true; produced: string } | { ok: false; code: string; error: string }> {
  const out = await runSpec(REWRITE_SPEC, { userDataPath, bookRoot, userPrompt: prompt })
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
    const absPath = safeManifestPath(bookRoot, m.path)
    if (!absPath) return reply(res, 400, { ok: false, code: 'BAD_PATH', error: '文档路径非法' })
    if (!existsSync(absPath)) return reply(res, 404, { ok: false, code: 'NOT_FOUND', error: `文档不存在：${m.path}` })

    const draft = readDraft(absPath)
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
      : buildRewritePrompt('local', original, selection, instruction, [], draft.chapter.章号, readKind(bookRoot))
    const result = await runRewriter(ctx.userDataPath, prompt, bookRoot)
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
