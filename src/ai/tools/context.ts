/**
 * agent 工具层公共类型（F1 阶段 1 工具面扩展）。
 *
 * 每个工具 = ToolExecutor(ctx, input) → ToolResult。
 * ctx 是 chat.ts runChat 传入的执行上下文；input 是模型按 input_schema 填的参数。
 */

export interface ToolContext {
  bookRoot: string
  bookName: string
  /** 可为 null（无 userDataPath 时 AI 链路仍可用，个别工具受限） */
  userDataPath: string | null
}

export interface ToolResult {
  ok: boolean
  /** 回填对话的摘要（模型如实汇报给作者） */
  summary: string
}

export type ToolExecutor = (ctx: ToolContext, input: Record<string, unknown>) => Promise<ToolResult> | ToolResult

