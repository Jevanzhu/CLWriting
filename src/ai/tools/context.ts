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
  /**
   * Z-P1-1：chat 编排级中断信号。嵌套 AI 生成（rewrite_chapter/rewrite_selection/lead_update）
   * 据此同步中止——否则作者中断对话后这些生成会继续跑到 runTask 10 分钟总超时白烧 token。
   * 非 chat 调用点（单测直调）缺省不中断，行为不变。
   */
  signal?: AbortSignal
}

export interface ToolResult {
  ok: boolean
  /** 回填对话的摘要（模型如实汇报给作者） */
  summary: string
}

export type ToolExecutor = (ctx: ToolContext, input: Record<string, unknown>) => Promise<ToolResult> | ToolResult

