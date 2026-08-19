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
  | 'step/start'
  | 'step/end'
  | 'user/message'
  | 'assistant/message'
  | 'tool/call'
  | 'tool/result'
  | 'compaction/start'
  | 'compaction/end'
  // P2 五层链路事件化（F1 方案 §二 v1）
  | 'llm/call'
  | 'llm/retry'
  | 'retry/attempt'
  | 'check/report'
  // P3 血缘+检索（F1 方案 §二 v1 + §五 血缘设计）
  | 'revision/ref'
  | 'settings/snapshot'
  // G2-1 技能包快照登记（与 settings/snapshot 同载荷形状 {scope, digest}，非 surface 血缘/审计类）
  | 'skills/snapshot'
  | 'foreshadow/change'
  | 'author/signal'
  | 'rule/hit'
  // F5 goal 状态机 + todo 快照（DSH-11/DSH-12，第5.2/5.3节）
  | 'goal/change'
  | 'todo/write'

// ── F2：结构化终止原因（dsh 借鉴六种 + 场景补充）────────────────────
// turn/end：单轮 agent 收敛（六种 + max-turns——agent loop 达到轮数上限是真实收敛原因）
export const TURN_END_REASONS = [
  'completed',
  'aborted',
  'blocked',
  'error',
  'max-tokens',
  'interrupted',
  'max-turns',
] as const
export type TurnEndReason = (typeof TURN_END_REASONS)[number]

// step/end：单次任务调用收敛（六种；step 无轮数概念）
export const STEP_END_REASONS = [
  'completed',
  'aborted',
  'blocked',
  'error',
  'max-tokens',
  'interrupted',
] as const
export type StepEndReason = (typeof STEP_END_REASONS)[number]

// session/end：整会话结束（max-tokens = 回复截断导致会话提前终止）
export const SESSION_END_REASONS = [
  'completed',
  'interrupted',
  'aborted',
  'error',
  'max-tokens',
] as const
export type SessionEndReason = (typeof SESSION_END_REASONS)[number]

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
  /** P3-14：复用 TurnEndReason 词表——此前手写字面量漏了 'max-turns'（agent loop 触顶真实收敛原因），与 TURN_END_REASONS 校验词表不一致 */
  reason: TurnEndReason
}

// ── P2 五层链路事件载荷（F1 §二 v1 + §六 trace 合并计划）─────────────────────

/** 五层链路（F2/DSH-8 绑定：每层一个 step）：context/draft/review/self-heal/chat */
export type LayerName = 'context' | 'draft' | 'review' | 'self-heal' | 'chat'

export interface StepStartData {
  task: string
  layer: LayerName
}

export interface StepEndData {
  task: string
  layer: LayerName
  /** 结构化终止原因：completed / max-tokens / error / aborted / timeout */
  reason: string
}

// ── P3 血缘+检索事件载荷（F1 §二 v1 + §五）─────────────────────────────

/** revision/ref —— 正文版本指纹引用（血缘锚点） */
export interface RevisionRefData {
  chapter: number
  /** 正文内容指纹（sha256 前 16 位） */
  revision: string
  /** 相对书库根的正文路径 */
  path: string
}

/** settings/snapshot —— 注入设定快照（「模型可见 ⟺ 已记录」登记） */
export interface SettingsSnapshotData {
  scope: string
  /** 快照版本（如设定文件 mtime/显式版本）；缺省由 digest 表达 */
  version?: string
  /** 快照内容指纹（sha256 前 16 位） */
  digest: string
}

/** skills/snapshot —— 技能包注入快照（G2-1：与 settings/snapshot 同载荷形状，scope 固定 'skills'） */
export interface SkillsSnapshotData {
  scope: 'skills'
  /** 技能包内容指纹（sha256 前 16 位） */
  digest: string
}

/** foreshadow/change —— 伏笔状态机（goal 词汇） */
export interface ForeshadowChangeData {
  operation: 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'block' | 'clear'
  /** 伏笔标题 */
  title: string
  /** 变化后的伏笔条目快照（可选，减轻载荷） */
  entry?: Record<string, unknown>
}

/** author/signal —— 作者删除信号（套话类规则命中，B5 闭环） */
export interface AuthorSignalData {
  ruleId: string
  message: string
  task: string
}

/** rule/hit —— 规则命中（B3/B4 事件化） */
export interface RuleHitData {
  ruleId: string
  task: string
  chapter?: number
  message: string
}

/** llm/call —— 合并 trace.ts 的 TraceEntry（P2 单一事实源） */
export interface LlmCallData {
  runId: string
  task: string
  tierKind: string
  model: string
  attempt: number
  stopReason: string
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  durationMs: number
  ok: boolean
  errCode?: string
  promptMeta?: { chars: number; files: string[]; hash: string }
  /** D2（批 5）：调用归属章号（runTask 传 chapter 时记录——cost-stats 按章归集用；
   *  旧事件无此键按无章归集） */
  chapter?: number
}

/** llm/retry —— 重试记账（先落库后等待） */
export interface LlmRetryData {
  attempt: number
  delayMs: number
  errCode?: string
}

/** retry/attempt —— 自愈重写轮次（「连续相同红项换策略」canonical key 来源） */
export interface RetryAttemptData {
  attempt: number
  maxAttempts: number
  redIssues?: string[]
}

/** check/report —— 机检报告（自愈打回判据来源） */
export interface CheckReportData {
  chapter: number
  reds: string[]
  yellows?: string[]
}

// ── F5 goal 状态机 + todo 快照（DSH-11/DSH-12，第5.2/5.3节）────────────────

/** goal 生命周期动词（与伏笔状态机同词汇——F3 foreshadow/change 复用） */
export const GOAL_OPERATIONS = [
  'create',
  'edit',
  'pause',
  'resume',
  'complete',
  'block',
  'clear',
] as const
export type GoalOperation = (typeof GOAL_OPERATIONS)[number]

/** goal 状态 */
export type GoalState = 'active' | 'paused' | 'blocked' | 'complete'

/** goal 完整快照（每次变更整快照落库，last-write-wins） */
export interface GoalSnapshot {
  id: string
  title: string
  description?: string
  state: GoalState
  /** 已启动的自动轮次数 */
  roundsStarted: number
  maxGoalRounds?: number
  blockedReason?: string
  createdAt: number
  updatedAt: number
}

/** goal/change —— goal 状态机变更（完整快照 + 动词） */
export interface GoalChangeData {
  operation: GoalOperation
  goal: GoalSnapshot
}

/** todo 条目（无 id——整表快照，三态） */
export interface Todo {
  text: string
  state: 'pending' | 'in_progress' | 'completed'
}

/** todo/write —— 任务清单整表快照（last-write-wins，空表 = 清空） */
export interface TodoWriteData {
  todos: Todo[]
}
