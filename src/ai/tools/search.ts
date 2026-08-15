/**
 * book_search：全书关键词检索（readonly）。复用服务层 searchBook，不复制逻辑。
 */
import { searchBook } from '../../process/book-search.js'
import type { ToolContext, ToolResult } from './context.js'

export function bookSearch(ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  const q = String(input['query'] ?? '').trim()
  if (!q) return { ok: false, summary: '缺少搜索词 query。' }
  const scope = input['scope'] ? String(input['scope']) : undefined
  const out = searchBook(ctx.bookRoot, q, scope)
  if (out.results.length === 0) return { ok: true, summary: '全书未找到包含「' + q + '」的内容。' }
  const lines = out.results.slice(0, 10).map((hit) => {
    const first = hit.matches[0]!;
    return '· ' + hit.path + '（第' + first.line + '行）：' + first.text.slice(0, 60)
  })
  const more = out.results.length > 10 ? '……（共 ' + out.results.length + ' 处命中，仅展示前 10）' : ''
  return { ok: true, summary: '找到 ' + out.results.length + ' 处包含「' + q + '」的命中：\n' + lines.join('\n') + more }
}

