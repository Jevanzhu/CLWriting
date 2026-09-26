/**
 * 事件溯源——事件类型字典与载荷（子集：对话助手会话）。
 *
 * 三类事件族（映射自方案 §二，按范围裁剪）：
 * - 边界类（不进 surface）：session/*、turn/*、compaction/*
 * - 消息类（surface-eligible）：user/message、assistant/message、tool/result
 * - 辅助记录：tool/call（审计用，不进 surface——tool_use 已含在 assistant/message 载荷里）
 *
 * 再扩展五层链路事件（step/*、llm/call、settings/snapshot 等）。
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
  // 0918四轮修复批（B406）：SessionRecorder pending 溢出断链标记（对话会话承载）——
  // 落库持续失败超限丢最旧事件时补入流的中断标记（data.dropped = 本次丢弃条数），
  // 让「丢事件必留痕」从日志层落进事件流。非 surface（不进 SURFACE_EVENT_TYPES）、
  // 无 surfaceOp：折叠/投影/校验链/前端种子化安全忽略（对齐边界类与 meta 类先例）
  | 'chat_gap'
  // 五层链路事件化（方案 §二 v1）
  | 'llm/call'
  | 'llm/retry'
  | 'retry/attempt'
  | 'check/report'
  // 机检误报标记（作者裁决信号——语料回归库的燃料入口；workspace 会话承载）
  | 'check/false-positive'
  // 血缘+检索（方案 §二 v1 + §五 血缘设计）
  | 'revision/ref'
  | 'settings/snapshot'
  // 技能包快照登记（与 settings/snapshot 同载荷形状 {scope, digest}，非 surface 血缘/审计类）
  | 'skills/snapshot'
  | 'foreshadow/change'
  | 'author/signal'
  | 'rule/hit'
  // goal 状态机 + todo 快照（DSH-11/DSH-12，第5.2/5.3节）
  | 'goal/change'
  | 'todo/write'
  // 阶段 24 章节结构操作（合并/拆分/撤销合并）——审计副录，挂 workspace 会话，
  // 不进 SURFACE_EVENT_TYPES（文件本位：盘上 fm/回收站是权威，事件只做审计与 undo 定位）
  | 'structure.merge'
  | 'structure.split'
  | 'structure.merge-undo'

// ── ：结构化终止原因（dsh 借鉴六种 + 场景补充）────────────────────
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
  /** 血缘：sourceEventSeqs（被遮蔽节点/输入事件 seq 列表）。
   *  语义收窄为「全局 seq」：只由 appendEvents 原样落库路径写入
   *  （compaction/end 遮蔽区间，store.appendEvents），投影校验/审计按全局 seq 读。
   *  批内 0-based 索引血缘走 NewEvent.sourceIdxs（仅 appendEventsResolveLineage 消费，
   *  落库时回写解析为全局 seq 后仍存本字段）——同名双语义陷阱就此按方法拆分闭合。 */
  sourceSeqs?: number[]
  /** 派生消息缓存失效判据 */
  replaceGeneration: number
  createdAt: number
}

// ── 五层链路事件载荷（§二 v1 + §六 trace 合并计划）─────────────────────

/** 五层链路（/DSH-8 绑定：每层一个 step）：context/draft/review/self-heal/chat */
export type LayerName = 'context' | 'draft' | 'review' | 'self-heal' | 'chat'

// ── 血缘+检索事件载荷（§二 v1 + §五）─────────────────────────────

/** llm/call —— 合并 trace.ts 的 TraceEntry（单一事实源） */
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
  // 清偿mptMeta 增可选 tools 摘要键（去重排序工具名——chat 每轮
  // 15 个工具 schema 模型可见，铁律②「模型可见 ⟺ 已记录」契约层补全；旧事件无此键）
  promptMeta?: { chars: number; files: string[]; hash: string; tools?: string[] }
  /** 调用归属章号（runTask 传 chapter 时记录——cost-stats 按章归集用；
   *  旧事件无此键按无章归集） */
  chapter?: number
  /** resolve 解析值随事件落库（铁律②「默认值显式 resolve」的重放口径）——
   *  实际生效的档位 effort 与整体超时 timeoutMs（含 DEFAULT_TIMEOUT_MS 回落后的最终值）。
   *  mock 快路 / 取 provider 失败路径未 resolve，无此两键（重放同样不依赖） */
  effort?: string
  timeoutMs?: number
  /** resolve 后终值补全——上线输出上限 maxTokens（适配器 done 事件透出
   *  经编排层透传；无兜底不发/early-error 无值）与逐 chunk 挂起时限（env resolver 与
   *  gen.generate 同源；RC改口径表述——原称「首字节超时」，字段名
   *  firstByteTimeoutMs 保名：已落库形状属重放契约，改名只到 gen.ts 符号层）。
   *  mock 快路 / 取 provider 失败路径无此两键 */
  maxTokens?: number
  /** 成功建流用的是降级参数面（剥 structured/剥 tools）——重放口径 */
  degraded?: boolean
  firstByteTimeoutMs?: number
  /** （十五轮登记销账）：本进程 model-quirks 参数表的 contentVersion——effort→wire
   *  翻译等表内容随版本演进，跨版本重放时据此检测漂移（旧事件无此键 = 表初版前）。
   *  表内容任何变更必须同步 bump MODEL_QUIRKS_VERSION（见 model-quirks.ts 头注） */
  quirksVersion?: string
}

/** llm/retry —— 重试记账（先落库后等待） */
export interface LlmRetryData {
  attempt: number
  delayMs: number
  errCode?: string
}

// ── goal 状态机 + todo 快照（DSH-11/DSH-12，第5.2/5.3节）────────────────

/** goal 生命周期动词（与伏笔状态机同词汇—— foreshadow/change 复用） */
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

// ── 阶段 24 章节结构操作事件载荷（审计副录）────────────────────────

/** structure.merge —— 章节合并：源章正文并入目标章 + 源章软删进回收站（留洞制） */
export interface StructureMergeData {
  op: 'merge'
  targetDocId: string
  sourceDocId: string
  targetChapterNo: number
  sourceChapterNo: number
  /** 合并后目标章 fm `并入` 数组（写侧链式折叠单跳化后） */
  mergedInto: number[]
  /** 源章回收站条目 id（TrashEntry.id = 源 docId）——undo 还原源章用 */
  trashEntryId: string
  /** 目标章合并前内容的留底版本 id（external-merge 强制留底产生）——undo 版本回滚
   *  用；快照未产生（罕见）时缺省，undo 定位走降级推演 */
  rollbackSnapshotId?: string
  /** 干跑指纹（apply 复核防 TOCTOU；undo 按它匹配「最近未被撤销的 merge」） */
  planHash: string
}

/** structure.split —— 章节拆分：原章光标处截断 + 新章落位 */
export interface StructureSplitData {
  op: 'split'
  docId: string
  newDocId: string
  originChapterNo: number
  newChapterNo: number
  /** 新章显示序（拆分点两侧有效序中值） */
  order: number
  title: string
}

/** structure.merge-undo —— 撤销合并：目标章版本回滚（摘 `并入`）+ 源章回收站还原 */
export interface StructureMergeUndoData {
  op: 'merge-undo'
  targetDocId: string
  sourceDocId: string
  sourceChapterNo: number
  trashEntryId: string
  /** 被回滚的合并的留底版本 id（merge 事件携带的 rollbackSnapshotId） */
  rollbackSnapshotId?: string
  /** 被撤销 merge 的 planHash（与 merge 事件配对） */
  planHash: string
}
