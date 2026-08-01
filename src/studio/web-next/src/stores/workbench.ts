import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * 工作台 store（细案 T3.1 地基）：SSE 事件日志缓冲 + running/connected。
 * T3.2 扩展态机（八阶段/草稿/审稿/rebook 等），T3.1 只做事件分派基础。
 */

/** driver SSE 事件（松类型，按 type 分支取字段；对齐 driver/types.ts DriverEvent）。 */
export interface SseEvent {
  type: string
  _ts: string
  [k: string]: unknown
}

/** 全自动写章终局（self_heal_result）。 */
export interface HealResult {
  outcome: 'pass' | 'escalate' | 'aborted' | 'failed'
  reds?: string[]
  docId?: string
  path?: string
  error?: string
}

/** 全自动写章进度（self_heal_progress：第 attempt/maxAttempts 次重写 + 剩余红项）。 */
export interface HealProgress {
  attempt: number
  maxAttempts: number
  remaining: string[]
}

function ts(): string {
  return new Date().toLocaleTimeString('zh-CN')
}

export const useWorkbenchStore = defineStore('workbench', () => {
  /** 事件日志（按序追加，右栏事件流消费）。 */
  const log = ref<SseEvent[]>([])
  /** 生成正文聚合（text 事件拼接，草稿保存源）。init/role_spawn 清空（新生成）。 */
  const textOut = ref('')
  /** 生成中（init/role_spawn→true，done/interrupted/error→false）。 */
  const running = ref(false)
  /** SSE 连接态。 */
  const connected = ref(false)
  /** 全自动写章：当前阶段 / 重写进度 / 终局（null = 未在跑或已清）。 */
  const healPhase = ref<'drafting' | 'checking' | 'rewriting' | null>(null)
  const healProgress = ref<HealProgress | null>(null)
  const healResult = ref<HealResult | null>(null)

  /** 分派一条 SSE 事件：追加日志 + 维护 running + 聚合正文。JSON.parse 已由 useSse 完成。 */
  function dispatch(ev: unknown): void {
    if (typeof ev !== 'object' || ev === null) return
    const raw = ev as Record<string, unknown>
    // 连接快照（服务端连接建立即发）：校正 running（刷新/新标签错过 init 的补救），不入事件日志
    if (raw['type'] === 'sync') {
      running.value = raw['running'] === true
      return
    }
    const e = { ...raw, _ts: ts() } as SseEvent
    log.value.push(e)
    if (e.type === 'init' || e.type === 'role_spawn') {
      running.value = true
      textOut.value = '' // 新生成清空旧正文
      // 新一轮全自动写章：清上一轮的阶段/进度/终局
      healPhase.value = null
      healProgress.value = null
      healResult.value = null
    } else if (e.type === 'done' || e.type === 'interrupted' || e.type === 'error') {
      running.value = false
    }
    if (e.type === 'text' && typeof e.text === 'string') textOut.value += e.text
    // 整章重写产出的是完整替换稿，不清缓冲会把多轮正文首尾拼接
    else if (e.type === 'self_heal_reset') textOut.value = ''
    else if (e.type === 'self_heal_phase') {
      healPhase.value = e.phase as 'drafting' | 'checking' | 'rewriting'
    } else if (e.type === 'self_heal_progress') {
      healProgress.value = {
        attempt: Number(e.attempt ?? 0),
        maxAttempts: Number(e.maxAttempts ?? 0),
        remaining: (e.remaining as string[] | undefined) ?? [],
      }
    } else if (e.type === 'self_heal_result') {
      healResult.value = {
        outcome: e.outcome as HealResult['outcome'],
        ...(e.reds ? { reds: e.reds as string[] } : {}),
        ...(e.docId ? { docId: String(e.docId) } : {}),
        ...(e.path ? { path: String(e.path) } : {}),
        ...(e.error ? { error: String(e.error) } : {}),
      }
      healPhase.value = null
      healProgress.value = null
    }
  }

  function clear(): void {
    log.value = []
    textOut.value = ''
    healPhase.value = null
    healProgress.value = null
    healResult.value = null
  }
  function setConnected(v: boolean): void {
    connected.value = v
  }

  return {
    log,
    textOut,
    running,
    connected,
    healPhase,
    healProgress,
    healResult,
    dispatch,
    clear,
    setConnected,
  }
})
