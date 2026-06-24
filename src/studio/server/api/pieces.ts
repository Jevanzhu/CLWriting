/**
 * 篇详情 REST 端点（#6.5，短篇专属）。
 *
 * - GET /api/books/:name/pieces     篇列表（PieceMeta 摘要：篇号/标题/目标情绪/核心反转/字数）
 * - GET /api/books/:name/piece/:no  单篇详情（元数据 + 正文 body + 清单 PieceList）
 *
 * 数据源现成（零解析新增）：readPieceDir（篇/）+ readPieceList（篇/N-T/清单.md）+ readFile（正文 body）。
 * 短篇账本降级为单篇清单（反转线索表 + 情绪曲线 + 伏笔回收），单篇闭合，归本页（非七类账本，见 leads.ts 短篇分支）。
 *
 * 安全：:no 仅用于与 readPieceDir 扫到的合法篇目录（^\d+-）匹配，不拼路径；篇号非整数 → 400。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, dirname } from 'node:path'
import { route } from '../router.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { readPieceDir } from '../../../format/pieces.js'
import { readPieceList, emptyPieceList } from '../../../format/manifest.js'
import { readFile } from '../../../format/frontmatter.js'
import type { PieceMeta, PieceList } from '../../../format/types.js'

interface PiecesCtx {
  workDir: string | null
}

/** 前端 DTO：去内部 _ 字段，_wordCount → 字数 */
function toSummary(p: PieceMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {
    篇号: p.篇号,
    标题: p.标题,
    字数: p._wordCount ?? 0,
  }
  if (p.目标情绪) out['目标情绪'] = p.目标情绪
  if (p.核心反转) out['核心反转'] = p.核心反转
  return out
}

export function registerPiecesRoutes(ctx: PiecesCtx): void {
  // 篇列表
  route('GET', '/api/books/:name/pieces', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const name = params['name']
    const entry = readBooks(ctx.workDir).find((b) => b.name === name)
    if (!entry) return reply(res, 404, { error: `没有这本书：${name}` })

    const bookRoot = join(ctx.workDir, entry.path)
    const { config } = readBookConfig(join(bookRoot, 'book.yaml'))
    if (config.kind !== 'short') {
      return reply(res, 400, { error: '篇详情为短篇集专属（这本书是长篇）' })
    }
    const { pieces } = readPieceDir(join(bookRoot, '篇'))
    const sorted = pieces.slice().sort((a, b) => a.篇号 - b.篇号)
    reply(res, 200, { pieces: sorted.map(toSummary) })
  })

  // 单篇详情
  route('GET', '/api/books/:name/piece/:no', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const name = params['name']
    const noRaw = params['no']
    const no = Number(noRaw)
    if (!Number.isInteger(no) || no <= 0) return reply(res, 400, { error: `篇号非法：${noRaw}` })
    const entry = readBooks(ctx.workDir).find((b) => b.name === name)
    if (!entry) return reply(res, 404, { error: `没有这本书：${name}` })

    const bookRoot = join(ctx.workDir, entry.path)
    const { pieces } = readPieceDir(join(bookRoot, '篇'))
    const piece = pieces.find((p) => p.篇号 === no)
    if (!piece || !piece._path) return reply(res, 404, { error: `没有第 ${no} 篇` })

    // 正文 body（front matter 之后）
    const bodyResult = readFile(piece._path)
    const body = bodyResult.ok ? bodyResult.body : ''

    // 清单（容错：不存在/坏 → 空清单，不崩）
    const listPath = join(dirname(piece._path), '清单.md')
    const listResult = readPieceList(listPath)
    const list: PieceList = listResult.ok ? listResult.list : emptyPieceList()
    // 去内部 _ 字段（_path/_raw）
    const cleanList = { ...list }
    delete cleanList._path
    delete cleanList._raw

    reply(res, 200, { meta: toSummary(piece), body, list: cleanList })
  })
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
