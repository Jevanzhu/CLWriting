/**
 * book_search：全书关键词检索（readonly）。复用服务层 searchBook，不复制逻辑。
 */
import { searchBook } from '../../process/book-search.js'
// R75-A-P3c（批 A）：命中行截断改用码位口径助手——rewrite.ts 预览切片同款（R64-6 第 4 处
// 消费方先例），本处为第 5 处
import { clipByCodePoints } from '../../process/summary.js'
import type { ToolContext, ToolResult } from './context.js'

export function bookSearch(ctx: ToolContext, input: Record<string, unknown>): ToolResult {
  const q = String(input['query'] ?? '').trim()
  if (!q) return { ok: false, summary: '缺少搜索词 query。' }
  const scope = input['scope'] ? String(input['scope']) : undefined
  const out = searchBook(ctx.bookRoot, q, scope)
  if (out.results.length === 0) return { ok: true, summary: '全书未找到包含「' + q + '」的内容。' }
  const lines = out.results.slice(0, 10).map((hit) => {
    const first = hit.matches[0]!;
    // R75-A-P3c：slice(0,60) 按 UTF-16 码元截断——emoji 等增补平面字符恰在边界时被切出
    // 半个代理对（下游渲染乱码）；clipByCodePoints 按码位截 60（与 searchBook 的
    // MATCH_LINE_SLICE=200 同口径，R-11 家族）
    return '· ' + hit.path + '（第' + first.line + '行）：' + clipByCodePoints(first.text, 60)
  })
  const more = out.results.length > 10 ? '……（共 ' + out.results.length + ' 处命中，仅展示前 10）' : ''
  return { ok: true, summary: '找到 ' + out.results.length + ' 处包含「' + q + '」的命中：\n' + lines.join('\n') + more }
}

