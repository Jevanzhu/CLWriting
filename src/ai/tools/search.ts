/**
 * book_search：全书关键词检索（readonly）。复用服务层 searchBookAsync，不复制逻辑。
 * R46-3（四十六轮）：同步版 searchBook 切异步孪生——chat 工具经 TOOL_EXECUTORS 在
 * studio 服务进程事件循环内执行（非 spawn CLI 子进程面），同步全书扫描（冷门词扫完
 * 写作/设定/大纲/布线/工作区 全部 .md，每文件整读+小写副本）期间同进程全部书的
 * SSE 心跳/保存停摆；ToolExecutor 契约本就支持 Promise（harvest_style 先例），
 * agent 循环调用处 await 不变。
 */
import { searchBookAsync } from '../../process/book-search.js'
// R75-A-P3c（批 A）：命中行截断改用码位口径助手——rewrite.ts 预览切片同款（R64-6 第 4 处
// 消费方先例），本处为第 5 处
import { clipByCodePoints } from '../../process/summary.js'
import type { ToolContext, ToolResult } from './context.js'

export async function bookSearch(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const q = String(input['query'] ?? '').trim()
  if (!q) return { ok: false, summary: '缺少搜索词 query。' }
  const scope = input['scope'] ? String(input['scope']) : undefined
  const out = await searchBookAsync(ctx.bookRoot, q, scope)
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

