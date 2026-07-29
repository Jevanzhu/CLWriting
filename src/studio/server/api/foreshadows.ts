/**
 * 伏笔/线索追踪 REST 端点。
 *
 * GET /api/books/:name/foreshadows → 伏笔列表（结构化 fm + 摘要）
 *
 * 数据源：定稿/设定/伏笔/*.md，front matter（标题/状态/埋设章号/回收章号/重要性）。
 * CRUD 复用 documents 端点（伏笔就是 md 文件）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { readdirSync, existsSync } from 'node:fs'
import { route } from '../router.js'
import { reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readFile, parseFlat } from '../../../format/frontmatter.js'

interface ForeshadowCtx {
  workDir: string | null
}

/** fm 值 → 正整数章号（非法/空 → null） */
function parseChapterNo(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function registerForeshadowRoutes(ctx: ForeshadowCtx): void {
  // 伏笔列表（轻量：只读 fm + 正文前 100 字摘要）
  route('GET', '/api/books/:name/foreshadows', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const dir = join(ctx.workDir, entry.path, '定稿', '设定', '伏笔')
    const items: unknown[] = []
    if (!existsSync(dir)) return reply(res, 200, items)
    try {
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.md') && !x.startsWith('._'))) {
        const fp = join(dir, f)
        const r = readFile(fp)
        const map = r.ok ? parseFlat(r.fmRaw) : new Map<string, unknown>()
        items.push({
          file: `定稿/设定/伏笔/${f}`,
          标题: String(map.get('标题') ?? f.replace(/\.md$/, '')),
          状态: String(map.get('状态') ?? '未回收'),
          埋设章号: parseChapterNo(map.get('埋设章号')),
          回收章号: parseChapterNo(map.get('回收章号')),
          重要性: String(map.get('重要性') ?? '中'),
          摘要: r.ok ? r.body.slice(0, 100).trim() : '',
        })
      }
    } catch { /* 目录读取失败 → 空列表 */ }
    reply(res, 200, items)
  })
}
