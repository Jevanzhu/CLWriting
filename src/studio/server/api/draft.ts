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
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { readKind } from '../../../format/kind.js'
import { readBookConfig } from '../../../format/yaml.js'
import { applyGlobalDefaults } from '../../../format/global-defaults.js'
import { saveDraft, buildDraftPrompt } from '../../../process/draft-pipeline.js'
import { recordAuthorSignal } from '../../../ai/author-signal.js'
import { recordAiVersion } from '../../../git/ai-track.js'
import { log } from '../../../log/index.js'

// re-export（P1-8 下沉兼容：既有 import 方零感知）
export { saveDraft, buildDraftPrompt, snapshotBeforeOverwrite } from '../../../process/draft-pipeline.js'

interface DraftCtx {
  workDir: string | null
  userDataPath?: string | null
}

export function registerDraftRoutes(ctx: DraftCtx): void {
  defineRoute('books.draft-save', {
    method: 'POST',
    path: '/api/books/:name/draft-save',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)

    const body = await readJson(req)
    const chapter = Number(body['chapter'])
    if (!Number.isInteger(chapter) || chapter < 1) {
      return replyError(res, 400, 'BAD_INPUT', 'chapter 需为正整数')
    }
    const content = typeof body['content'] === 'string' ? (body['content'] as string) : ''
    if (!content.trim()) return replyError(res, 400, 'BAD_INPUT', 'content 为空')

    const bookRoot = r.bookRoot
    let saved: ReturnType<typeof saveDraft>
    try {
      saved = saveDraft(bookRoot, chapter, content)
      // 文风改稿轨迹（P1-ARCH-1：从 saveDraft 内部提取到调用方，消除 process→ai 向上依赖）
      recordAuthorSignal(bookRoot, saved.docId, content, 'draft-save', ctx.userDataPath ?? undefined)
      recordAiVersion(bookRoot, saved.docId, content)
    } catch (e) {
      log.error('api', `落盘失败（章 ${chapter}）`, e)
      return replyError(res, 500, 'IO', '落盘失败')
    }
    reply(res, 200, {
      ok: true,
      path: saved.relPath,
      words: saved.words,
      docId: saved.docId,
      snapshotted: saved.snapshotted,
    })
  },
  })

  // 组 draft prompt(读细纲+备料,长短篇分支,方案 6.6)——前端 draftWrite 拉取后 POST /spawn
  defineRoute('books.draft-prompt', {
    method: 'GET',
    path: '/api/books/:name/draft-prompt',
    handler: ({ params }, req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const chapter = Number(url.searchParams.get('chapter') ?? '1')
    if (!Number.isInteger(chapter) || chapter < 1) return replyError(res, 400, 'BAD_INPUT', 'chapter 需为正整数')
    const bookRoot = r.bookRoot
    // P1 接线：过全局托底合并后喂 buildDraftPrompt——每章字数与文风注入档随配置生效
    const config = applyGlobalDefaults(readBookConfig(join(bookRoot, 'book.yaml')).config, ctx.userDataPath ?? null)
    // Q-5（第十五轮）：files = prompt 实际注入源清单——前端随 prompt 回传 POST /spawn
    // 透传进 promptMeta.files，「模型可见⟺已记录」文件级溯源闭合
    const d = buildDraftPrompt(bookRoot, chapter, readKind(bookRoot), config)
    reply(res, 200, { prompt: d.prompt, files: d.files })
  },
  })
}
