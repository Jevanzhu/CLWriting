/**
 * F1 事件溯源——事件类型字典与载荷（P1 子集：对话助手会话）。
 *
 * 三类事件族（映射自 F1 方案 §二，按 P1 范围裁剪）：
 * - 边界类（不进 surface）：session/*、turn/*、compaction/*
 * - 消息类（surface-eligible）：user/message、assistant/message、tool/result
 * - 辅助记录：tool/call（审计用，不进 surface——tool_use 已含在 assistant/message 载荷里）
 *
 * P2 再扩展五层链路事件（step/*、llm/call、settings/snapshot 等）。
 */

/** 投影操作：append=追加到可见序列尾；replace=遮蔽闭区间 [start,end] 内全部旧节点 */
export type SurfaceOp = 'append' | 'replace'

export type EventType =
  | 'session/start'
  | 'session/end'
  | 'turn/start'
  | 'turn/end'
  | 'user/message'
  | 'assistant/message'
  | 'tool/call'
  | 'tool/result'
  | 'compaction/start'
  | 'compaction/end'

/** 可上 surface 的事件类型（投影只处理这三类） */
export const SURFACE_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'user/message',
  'assistant/message',
  'tool/result',
])

/** 事件行（DB 行 ↔ 内存模型） */
export interface ChatEvent {
  /** 全局单调 seq（SQLite rowid；会话内重放按 seq 排序） */
  seq: number
  sessionId: string
  turn?: number
  step?: number
  type: EventType
  /** JSON 载荷 */
  data: Record<string, unknown>
  /** 仅 surface-eligible 事件可带 */
  surfaceOp?: SurfaceOp
  /** replace 遮蔽闭区间 [start, end]（seq） */
  shadowStart?: number
  shadowEnd?: number
  /** 血缘：sourceEventSeqs（被遮蔽节点/输入事件 seq 列表） */
  sourceSeqs?: number[]
  /** 派生消息缓存失效判据 */
  replaceGeneration: number
  createdAt: number
}

/** 事件载荷类型（P1 对话助手） */
export interface UserMessageData {
  message: string
  /** 作者选定讨论的章号（上下文快照用，血缘） */
  chapter?: number
}

export interface AssistantMessageData {
  /** ChatMsg.content：纯文本或 ContentBlock[]（含 text/reasoning/tool_use） */
  message: string | unknown[]
  usage?: { inputTokens: number; outputTokens: number }
  stopReason?: string
}

export interface ToolCallData {
  callId: string
  name: string
  arguments: unknown
}

export interface ToolResultData {
  callId: string
  content: string
  isError?: boolean
}

export interface TurnEndData {
  reason: 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted'
}
