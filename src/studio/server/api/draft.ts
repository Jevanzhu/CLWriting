/**
 * draft 落盘端点：driver writer 产出 → 正文区（resolveDraftPath 按章号定位文件）。
 *
 * POST /api/books/:name/draft-save  body {chapter, content}
 *   → 写作/正文/[<卷>/]<章号>-<标题>.md（已有同章号则覆盖）→ {ok, path, words}
 * GET  /api/books/:name/draft-prompt?chapter=N
 *   → 组 prompt(长篇:细纲+备料+章 front matter;短篇:细纲+篇 front matter)→ {prompt}
 *
 * 草稿落盘 + prompt 组装逻辑已下沉 src/process/draft-pipeline.ts（P1-8 架构治理），
 * 此处 re-export 兼容既有调用方（self-heal 已从内核直接 import）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readKind } from '../../../format/kind.js'
import { saveDraft, buildDraftPrompt } from '../../../process/draft-pipeline.js'
import { recordAuthorSignal } from '../../../ai/author-signal.js'
import { recordAiVersion } from '../../../git/ai-track.js'

// re-export（P1-8 下沉兼容：既有 import 方零感知）
export { saveDraft, buildDraftPrompt, snapshotBeforeOverwrite } from '../../../process/draft-pipeline.js'

interface DraftCtx {
  workDir: string | null
}

export function registerDraftRoutes(ctx: DraftCtx): void {
  route('POST', '/api/books/:name/draft-save', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })

    const body = await readJson(req)
    const chapter = Number(body['chapter'])
    if (!Number.isInteger(chapter) || chapter < 1) {
      return reply(res, 400, { error: 'chapter 需为正整数' })
    }
    const content = typeof body['content'] === 'string' ? (body['content'] as string) : ''
    if (!content.trim()) return reply(res, 400, { error: 'content 为空' })

    const bookRoot = join(ctx.workDir, entry.path)
    let saved: ReturnType<typeof saveDraft>
    try {
      saved = saveDraft(bookRoot, chapter, content)
      // 文风改稿轨迹（P1-ARCH-1：从 saveDraft 内部提取到调用方，消除 process→ai 向上依赖）
      recordAuthorSignal(bookRoot, saved.docId, content, 'draft-save')
      recordAiVersion(bookRoot, saved.docId, content)
    } catch (e) {
      console.error('[api] 落盘失败:', e)
      return reply(res, 500, { error: '落盘失败' })
    }
    reply(res, 200, {
      ok: true,
      path: saved.relPath,
      words: saved.words,
      docId: saved.docId,
      snapshotted: saved.snapshotted,
    })
  })

  // 组 draft prompt(读细纲+备料,长短篇分支,方案 6.6)——前端 draftWrite 拉取后 POST /spawn
  route('GET', '/api/books/:name/draft-prompt', (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const chapter = Number(url.searchParams.get('chapter') ?? '1')
    if (!Number.isInteger(chapter) || chapter < 1) return reply(res, 400, { error: 'chapter 需为正整数' })
    const bookRoot = join(ctx.workDir, entry.path)
    reply(res, 200, { prompt: buildDraftPrompt(bookRoot, chapter, readKind(bookRoot)) })
  })
}
