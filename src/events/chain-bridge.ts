/**
 * P2 五层链路事件桥接（F1 方案 §二 v1 + §六 trace 合并计划）。
 *
 * 非对话链路事件（step/start、step/end、llm/call、llm/retry、retry/attempt、check/report）
 * 挂每书的 workspace 会话（store.workspaceSession，ws- 前缀）——与对话 turn/session 隔离。
 * 观测层纪律：写失败静默（同 appendTrace），不拖累业务流程；「先落库后等待」（llm/retry）。
 */
import type { NewEvent, SessionStore } from './store.js'
import type { GoalChangeData, LayerName, StepEndReason, TodoWriteData } from './types.js'

// ── 事件构造辅助 ──────────────────────────────────

export function stepStartEvent(task: string, layer: LayerName): NewEvent {
  return { type: 'step/start', data: { task, layer } }
}

export function stepEndEvent(task: string, layer: LayerName, reason: StepEndReason): NewEvent {
  return { type: 'step/end', data: { task, layer, reason } }
}

export function llmCallEvent(data: {
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
  chapter?: number
  /** I7（第十一轮）：resolve 解析值（实际生效 effort/timeoutMs）——重放口径，见 LlmCallData */
  effort?: string
  timeoutMs?: number
  /** Q-13（第十五轮）：resolve 后终值——上线输出上限（适配器 done 事件透出，编排层
   *  透传；无兜底不发/early-error 无值）与首字节超时（env resolver，同 gen.generate 源） */
  maxTokens?: number
  firstByteTimeoutMs?: number
}): NewEvent {
  return { type: 'llm/call', data: { ...data } }
}

export function llmRetryEvent(data: { attempt: number; delayMs: number; errCode?: string }): NewEvent {
  return { type: 'llm/retry', data: { ...data } }
}

/** B1（批 6）：机检误报标记事件。excerpt 为命中区间 ±50 字摘录（语料本身）；
 *  同章同 checkId 重复标记幂等——append 多条、查询侧按 (chapter, checkId) 取最近一条。 */
export function checkFalsePositiveEvent(data: {
  checkId: string
  chapter: number
  excerpt: string
  docId?: string
}): NewEvent {
  return { type: 'check/false-positive', data: { ...data } }
}

export function retryAttemptEvent(data: {
  attempt: number;
  maxAttempts: number;
  redIssues?: string[];
}): NewEvent {
  return { type: 'retry/attempt', data: { ...data } }
}

export function checkReportEvent(data: { chapter: number; reds: string[]; yellows?: string[] }): NewEvent {
  return { type: 'check/report', data: { ...data } }
}

// ── P3 血缘+检索事件构造器 ───────────────────────────

export function revisionRefEvent(data: {
  chapter: number
  revision: string
  path: string
}): NewEvent {
  return { type: 'revision/ref', data: { ...data } }
}

export function settingsSnapshotEvent(data: {
  scope: string
  version?: string
  digest: string
}): NewEvent {
  return { type: 'settings/snapshot', data: { ...data } }
}

/** G2-1 技能包快照登记（镜像 settingsSnapshotEvent；scope 固定 'skills'，载荷同形状 {scope, digest}） */
export function skillsSnapshotEvent(data: { digest: string }): NewEvent {
  return { type: 'skills/snapshot', data: { scope: 'skills', digest: data.digest } }
}

export function foreshadowChangeEvent(data: {
  operation: 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'block' | 'clear'
  title: string
  entry?: Record<string, unknown>
}): NewEvent {
  return { type: 'foreshadow/change', data: { ...data } }
}

export function authorSignalEvent(data: { ruleId: string; message: string; task: string }): NewEvent {
  return { type: 'author/signal', data: { ...data } }
}

export function ruleHitEvent(data: { ruleId: string; task: string; chapter?: number; message: string }): NewEvent {
  return { type: 'rule/hit', data: { ...data } }
}

// ── F5 goal 状态机 + todo 快照事件构造器 ──────────────────────────

export function goalChangeEvent(data: GoalChangeData): NewEvent {
  return { type: 'goal/change', data: { operation: data.operation, goal: data.goal } }
}

export function todoWriteEvent(data: TodoWriteData): NewEvent {
  return { type: 'todo/write', data: { todos: data.todos } }
}

/** task 名 → 五层 layer 映射（F2/DSH-8：五层每层一个 step） */
export function layerForTask(task: string): LayerName {
  switch (task) {
    case 'chat': return 'chat'
    case 'spawn-write':
    case 'rewrite': return 'draft'
    case 'review':
    case 'analysis': return 'review'
    case 'self-heal': return 'self-heal'
    default: return 'context' // outline/onboard/lead-updates/relation-mine 等
  }
}

/** 链路事件录制器：薄封装 store + workspace session；写失败静默（观测层不拖累业务）。
 *  Z-P2-7 批事务：add 只进内存缓冲，凑批/显式 flush/close 时走 appendEvents 单事务落库
 *  （此前每事件一个 BEGIN/COMMIT，llm/call+retry 高频观测路径每条一次提交）。
 *  退避等待等「先落库后等待」语义点由调用方显式 flush（runner.ts 重试 sleep 前）。 */
const CHAIN_FLUSH_THRESHOLD = 32
// O-1（第十三轮）：flush 失败保 buffer 下次重试的累积上限——观测事件越旧价值越低，超限丢最旧
const CHAIN_BUFFER_MAX = 256

export class ChainRecorder {
  private buffer: NewEvent[] = []

  constructor(
    private readonly store: SessionStore | null,
    private readonly sessionId: string | null,
  ) {}

  add(ev: NewEvent): void {
    if (!this.store || !this.sessionId) return
    this.buffer.push(ev)
    if (this.buffer.length >= CHAIN_FLUSH_THRESHOLD) this.flush()
  }

  /** 显式持久化点：把缓冲一次事务落库（调用方在长等待/关键节点前调；失败静默）。 */
  flush(): void {
    if (!this.store || !this.sessionId || this.buffer.length === 0) return
    const evs = this.buffer
    this.buffer = []
    try {
      this.store.appendEvents(this.sessionId, evs)
    } catch {
      // 观测层：写失败不炸业务流程（与 appendTrace 一致）。O-1（第十三轮）：
      // 失败不整批丢弃——换回 buffer 待下次 flush 重试；持续失败超上限时丢最旧防无限增长
      this.buffer = [...evs, ...this.buffer]
      if (this.buffer.length > CHAIN_BUFFER_MAX) {
        this.buffer = this.buffer.slice(this.buffer.length - CHAIN_BUFFER_MAX)
      }
    }
  }

  close(): void {
    this.flush()
    try {
      this.store?.close()
    } catch {
      // 静默
    }
  }
}

// ── F1-P3 伏笔状态变化登记（foreshadow/change）──────────────────

/** 对比新旧伏笔列表，把状态变化登记为 foreshadow/change 事件（create/edit/complete/block/clear）。
 *  Z-P2-6 接线：字段形状与 document/foreshadow.ts ForeshadowEntry 对齐（标题/状态），
 *  由 documents API 的保存/PATCH/新建/软删四个变更点调用（快照-差分）。
 *  store/session 缺失静默跳过。 */
export function recordForeshadowChanges(
  store: SessionStore | null,
  sessionId: string | null,
  prev: { 标题: string; 状态: string }[],
  next: { 标题: string; 状态: string }[],
): void {
  if (!store || !sessionId) return
  const prevMap = new Map(prev.map((p) => [p.标题, p]))
  const events: NewEvent[] = []
  for (const n of next) {
    const p = prevMap.get(n.标题)
    if (!p) {
      events.push(foreshadowChangeEvent({ operation: 'create', title: n.标题 }))
    } else if (p.状态 !== n.状态) {
      const op = n.状态 === '已回收' ? 'complete' : n.状态 === '已废弃' ? 'block' : 'edit'
      events.push(foreshadowChangeEvent({ operation: op, title: n.标题 }))
    }
  }
  const nextTitles = new Set(next.map((n) => n.标题))
  for (const p of prev) {
    if (!nextTitles.has(p.标题)) events.push(foreshadowChangeEvent({ operation: 'clear', title: p.标题 }))
  }
  if (events.length === 0) return
  try {
    store.appendEvents(sessionId, events)
  } catch {
    // 观测层：写失败静默
  }
}

