/**
 * config 设定台端点(P1,方案 8.1):book.yaml 结构化读写。
 *
 * GET  /api/books/:name/config             → {config: BookConfig, revision}
 * PUT  /api/books/:name/config  body {config, expectedRevision?} → 文本级补丁写 book.yaml
 *    （kk-P1-5，保注释/未知段；现文件不可解析时回落 stringifyBookConfig 全量重生成）
 *    → {ok, revision}
 *
 * R34D-25（三十四轮）：GG-P2-7 乐观并发——revision 为 book.yaml 内容指纹（sha256
 * 前 4 字节 uint32，文件缺失/不可读视为 0）。与 prefs 的内嵌计数键不同，book.yaml
 * 是作者手写文件（保注释补丁写），不能被服务端塞管理键，故用内容指纹：任何来源的
 * 写入（另一标签页/手工编辑/脚本）都会改变指纹。PUT 带可选 expectedRevision 比对，
 * 失配回 409（revision-guard 单源口径），不带则放行（旧客户端向后兼容）。
 *
 * 文风铁律(8.2)复用 1.6 /file 读写 文风/文风铁律.md,本端点只管 book.yaml。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { readBookConfig, parseBookConfig, patchBookConfigText, stringifyBookConfig } from '../../../format/yaml.js'
import type { BookConfig } from '../../../format/types.js'
import { revisionError } from './revision-guard.js'
import { log } from '../../../log/index.js'

/** R34D-25：book.yaml 内容指纹 revision（见文件头注）。 */
function yamlRevision(yamlPath: string): number {
  try {
    return createHash('sha256').update(readFileSync(yamlPath, 'utf8')).digest().readUInt32BE(0)
  } catch {
    return 0 // 文件缺失/不可读：与 prefs「存量文件无 revision 键视为 0」同口径
  }
}

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
    // 低-2（第十轮）：error 是 ParseError {file,line,message} 对象——直接插值会串成
    // 「[object Object]」，取 .message 展示真实解析错误（与 books.ts 同场景口径）
    if (!cfgResult.ok) return replyError(res, 500, 'IO_ERROR', `读 book.yaml 失败:${cfgResult.error.message}`)
    // R34D-25：内容指纹随 GET 回传，供前端下次 PUT 带 expectedRevision
    reply(res, 200, { config: (cfgResult as { config: BookConfig }).config, revision: yamlRevision(join(r.bookRoot, 'book.yaml')) })
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
    // Q-15（第十五轮）：拒含控制字符的标题——含换行标题落盘后 book.yaml 行结构破坏
    // （回读静默丢键/错键）；yaml 层的引号转义是纵深防线，入口直接拒收最稳
    if (/[\u0000-\u001f\u007f]/.test(config.book.title)) {
      return replyError(res, 400, 'BAD_INPUT', 'config.book.title 不能包含换行等控制字符')
    }
    // R72-10（二十轮 D-6）：已知数值键的类型+下界校验（简版白名单）——此前负数/非有限
    // 值可落 book.yaml（下游容错不崩但配置面失真）。未列字段维持透传（book.yaml 扩展面）
    const numericChecks: Array<[string, unknown, number]> = [
      ['book.target_words', config.book?.target_words, 0],
      ['book.chapter_target_words', config.book?.chapter_target_words, 0],
      ['budget.calls_per_chapter', config.budget?.calls_per_chapter, 0],
      ['auto.batch_size', config.auto?.batch_size, 1],
      ['snapshots.max_days', config.snapshots?.max_days, 1],
      ['snapshots.max_count', config.snapshots?.max_count, 1],
    ]
    for (const [key, v, min] of numericChecks) {
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < min)) {
        return replyError(res, 400, 'BAD_INPUT', `config.${key} 须为 ≥${min} 的有限数值`)
      }
    }
    try {
      const yamlPath = join(r.bookRoot, 'book.yaml')
      // R34D-25：读盘/指纹比对/写盘三段同步无 await（GG-P2-7 单事件循环原子口径）——
      // 失配 409 早于一切写动作，双标签页后写者不再静默覆盖先写者
      const current = yamlRevision(yamlPath)
      const revErr = revisionError(body['expectedRevision'], current, '书籍配置')
      if (revErr) return replyError(res, 409, 'REVISION_CONFLICT', revErr)
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
      // 回传写入后指纹（下次保存的 expectedRevision 基线）
      reply(res, 200, { ok: true, revision: createHash('sha256').update(yaml).digest().readUInt32BE(0) })
    } catch (e) {
      log.error('api', '写 book.yaml 失败', e)
      return replyError(res, 500, 'IO_ERROR', '写 book.yaml 失败')
    }
  },
  })
}
