/**
 * config 设定台端点(P1,方案 8.1):book.yaml 结构化读写。
 *
 * GET  /api/books/:name/config             → {config: BookConfig}
 * PUT  /api/books/:name/config  body {config} → stringifyBookConfig → 写 book.yaml → {ok}
 *
 * 文风铁律(8.2)复用 1.6 /file 读写 文风/文风铁律.md,本端点只管 book.yaml。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { route } from '../router.js'
import { readJson, reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { readBookConfig, stringifyBookConfig } from '../../../format/yaml.js'
import type { BookConfig } from '../../../format/types.js'

interface ConfigCtx {
  workDir: string | null
}

export function registerConfigRoutes(ctx: ConfigCtx): void {
  route('GET', '/api/books/:name/config', (_req: IncomingMessage, res: ServerResponse, params) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const cfgResult = readBookConfig(join(r.bookRoot, 'book.yaml'))
    if (!cfgResult.ok) return replyError(res, 500, 'IO', `读 book.yaml 失败:${cfgResult.error}`)
    reply(res, 200, { config: (cfgResult as { config: BookConfig }).config })
  })

  route('PUT', '/api/books/:name/config', async (req: IncomingMessage, res: ServerResponse, params) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const body = await readJson(req)
    const config = body['config'] as BookConfig | undefined
    if (!config || typeof config !== 'object') return replyError(res, 400, 'BAD_INPUT', 'config 必填')
    // 结构校验（K6）：防畸形 config 写出损坏的 book.yaml
    if (typeof config.book?.title !== 'string' || !config.book.title.trim()) {
      return replyError(res, 400, 'BAD_INPUT', 'config.book.title 必填且须为非空字符串')
    }
    try {
      const yaml = stringifyBookConfig(config)
      atomicWriteFile(join(r.bookRoot, 'book.yaml'), yaml)
    } catch (e) {
      console.error('[api] 写 book.yaml:', e)
      return replyError(res, 500, 'IO', '写 book.yaml 失败')
    }
    reply(res, 200, { ok: true })
  })
}
