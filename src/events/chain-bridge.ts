/**
 * P2 五层链路事件桥接（F1 方案 §二 v1 + §六 trace 合并计划）。
 *
 * 非对话链路事件（step/start、step/end、llm/call、llm/retry、retry/attempt、check/report）
 * 挂每书的 workspace 会话（store.workspaceSession，ws- 前缀）——与对话 turn/session 隔离。
 * 观测层纪律：写失败静默（同 appendTrace），不拖累业务流程；「先落库后等待」（llm/retry）。
 */
import type { NewEvent, SessionStore } from './store.js'
import type { LayerName, StepEndReason } from './types.js'

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
}): NewEvent {
  return { type: 'llm/call', data: { ...data } }
}

export function llmRetryEvent(data: { attempt: number; delayMs: number; errCode?: string }): NewEvent {
  return { type: 'llm/retry', data: { ...data } }
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

/** 链路事件录制器：薄封装 store + workspace session；写失败静默（观测层不拖累业务） */
export class ChainRecorder {
  constructor(
    private readonly store: SessionStore | null,
    private readonly sessionId: string | null,
  ) {}

  add(ev: NewEvent): void {
    if (!this.store || !this.sessionId) return
    try {
      this.store.appendEvent(this.sessionId, ev)
    } catch {
      // 观测层：写失败不炸业务流程（与 appendTrace 一致）
    }
  }

  close(): void {
    try {
      this.store?.close()
    } catch {
      // 静默
    }
  }
}

// ── F1-P3 伏笔状态变化登记（foreshadow/change）──────────────────

/** 对比新旧伏笔列表，把状态变化登记为 foreshadow/change 事件（create/edit/complete/block/clear）。
 *  伏笔条目由文件系统驱动（无写 API），此函数供未来写点复用；store/session 缺失静默跳过。 */
export function recordForeshadowChanges(
  store: SessionStore | null,
  sessionId: string | null,
  prev: { title: string; 状态: string }[],
  next: { title: string; 状态: string }[],
): void {
  if (!store || !sessionId) return
  const prevMap = new Map(prev.map((p) => [p.title, p]))
  const events: NewEvent[] = []
  for (const n of next) {
    const p = prevMap.get(n.title)
    if (!p) {
      events.push(foreshadowChangeEvent({ operation: 'create', title: n.title }))
    } else if (p.状态 !== n.状态) {
      const op = n.状态 === '已回收' ? 'complete' : n.状态 === '已废弃' ? 'block' : 'edit'
      events.push(foreshadowChangeEvent({ operation: op, title: n.title }))
    }
  }
  const nextTitles = new Set(next.map((n) => n.title))
  for (const p of prev) {
    if (!nextTitles.has(p.title)) events.push(foreshadowChangeEvent({ operation: 'clear', title: p.title }))
  }
  if (events.length === 0) return
  try {
    store.appendEvents(sessionId, events)
  } catch {
    // 观测层：写失败静默
  }
}

