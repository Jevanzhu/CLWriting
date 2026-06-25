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
import { writeFileSync } from 'node:fs'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig, stringifyBookConfig } from '../../../format/yaml.js'
import type { BookConfig } from '../../../format/types.js'

interface ConfigCtx {
  workDir: string | null
}

export function registerConfigRoutes(ctx: ConfigCtx): void {
  route('GET', '/api/books/:name/config', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const cfgResult = readBookConfig(join(ctx.workDir, entry.path, 'book.yaml'))
    if (!cfgResult.ok) return reply(res, 500, { error: `读 book.yaml 失败:${cfgResult.error}` })
    reply(res, 200, { config: (cfgResult as { config: BookConfig }).config })
  })

  route('PUT', '/api/books/:name/config', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const body = await readJson(req)
    const config = body['config'] as BookConfig | undefined
    if (!config || typeof config !== 'object') return reply(res, 400, { error: 'config 必填' })
    try {
      const yaml = stringifyBookConfig(config)
      writeFileSync(join(ctx.workDir, entry.path, 'book.yaml'), yaml, 'utf8')
    } catch (e) {
      return reply(res, 500, { error: `写 book.yaml:${e instanceof Error ? e.message : String(e)}` })
    }
    reply(res, 200, { ok: true })
  })
}
