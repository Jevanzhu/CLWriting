/**
 * config 设定台端点(P1,方案 8.1):book.yaml 结构化读写。
 *
 * GET  /api/books/:name/config             → {config: BookConfig}
 * PUT  /api/books/:name/config  body {config} → 文本级补丁写 book.yaml（kk-P1-5，保注释/
 *    未知段；现文件不可解析时回落 stringifyBookConfig 全量重生成）→ {ok}
 *
 * 文风铁律(8.2)复用 1.6 /file 读写 文风/文风铁律.md,本端点只管 book.yaml。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { readBookConfig, parseBookConfig, patchBookConfigText, stringifyBookConfig } from '../../../format/yaml.js'
import type { BookConfig } from '../../../format/types.js'
import { log } from '../../../log/index.js'

interface ConfigCtx {
  workDir: string | null
}

export function registerConfigRoutes(ctx: ConfigCtx): void {
  defineRoute('books.config.get', {
    method: 'GET',
    path: '/api/books/:name/config',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
    const r = resolveBook(ctx.workDir, params['name'])
    if ('error' in r) return replyError(res, r.status, r.code, r.error)
    const cfgResult = readBookConfig(join(r.bookRoot, 'book.yaml'))
    if (!cfgResult.ok) return replyError(res, 500, 'IO', `读 book.yaml 失败:${cfgResult.error}`)
    reply(res, 200, { config: (cfgResult as { config: BookConfig }).config })
  },
  })

  defineRoute('books.config.put', {
    method: 'PUT',
    path: '/api/books/:name/config',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
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
      const yamlPath = join(r.bookRoot, 'book.yaml')
      // kk-P1-5：文本级补丁写——此前 stringifyBookConfig 全量重生成会丢作者手写
      // 注释/未知段/未知子键（migrate-defaults 同款红线）。现文件读不出或解析失败
      // 时回落全量重生成（与旧行为一致，配置仍能保存）
      let yaml: string
      try {
        const raw = readFileSync(yamlPath, 'utf8')
        const parsed = parseBookConfig(raw, yamlPath)
        yaml = parsed.ok ? patchBookConfigText(raw, parsed.config, config) : stringifyBookConfig(config)
      } catch {
        yaml = stringifyBookConfig(config)
      }
      atomicWriteFile(yamlPath, yaml)
    } catch (e) {
      log.error('api', '写 book.yaml 失败', e)
      return replyError(res, 500, 'IO', '写 book.yaml 失败')
    }
    reply(res, 200, { ok: true })
  },
  })
}
