/**
 * 状态机端点（#6.8① enter 自动定位）。
 *
 * GET /api/books/:name/state → enter(bookRoot) 返当前态 + 人话 + 下章号 + kind
 *
 * 工作台进页拉此端点：顶部状态卡显示「现在该写第 N 章」/「第 N 章写到一半续写」，
 * 并自动填章号（态 7→nextChapter，态 4 续写章→chapterNum）。
 * 复用内核 enter()（自包含 rebuild + git 检查），失败不崩（500 + 错误）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { route } from '../router.js'
import { readBooks } from '../../../install/books.js'
import { enter, STATE_NAMES } from '../../../state/state.js'

interface StateCtx {
  workDir: string | null
}

export function registerStateRoutes(ctx: StateCtx): void {
  route('GET', '/api/books/:name/state', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const name = params['name']
    const entry = readBooks(ctx.workDir).find((b) => b.name === name)
    if (!entry) return reply(res, 404, { error: `没有这本书：${name}` })

    const bookRoot = join(ctx.workDir, entry.path)
    try {
      const r = enter(bookRoot)
      // 下一个该写的章/篇号：态 7→nextChapter；态 4（工作区未完成）→续写那章；其余→recap.nextChapter
      const d = r.detected
      const nextChapter =
        d.state === 7 ? d.nextChapter : d.state === 4 ? d.chapterNum : r.recap.nextChapter
      reply(res, 200, {
        state: r.route.state,
        stateName: STATE_NAMES[r.route.state],
        humanMsg: r.route.humanMsg,
        action: r.route.action,
        nextChapter,
        kind: r.kind,
      })
    } catch (e) {
      reply(res, 500, { error: e instanceof Error ? e.message : String(e) })
    }
  })
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
