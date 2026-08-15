/**
 * P2 五层链路事件桥接（F1 方案 §二 v1 + §六 trace 合并计划）。
 *
 * 非对话链路事件（step/start、step/end、llm/call、llm/retry、retry/attempt、check/report）
 * 挂每书的 workspace 会话（store.workspaceSession，ws- 前缀）——与对话 turn/session 隔离。
 * 观测层纪律：写失败静默（同 appendTrace），不拖累业务流程；「先落库后等待」（llm/retry）。
 */
import type { NewEvent, SessionStore } from './store.js'
import type { LayerName } from './types.js'

// ── 事件构造辅助 ──────────────────────────────────

export function stepStartEvent(task: string, layer: LayerName): NewEvent {
  return { type: 'step/start', data: { task, layer } }
}

export function stepEndEvent(task: string, layer: LayerName, reason: string): NewEvent {
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

