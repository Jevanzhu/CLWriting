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
  /** pass 时终稿黄项复查：仍命中的规则违规（message 列表，空 = 已收敛） */
  yellows?: string[]
  docId?: string
  path?: string
  error?: string
}
/** F-P1-4：SSE 事件字段白名单（拒绝非预期值） */
const HEAL_PHASES = ['drafting', 'checking', 'rewriting'] as const
const HEAL_OUTCOMES = ['pass', 'escalate', 'aborted', 'failed'] as const

/** 全自动写章进度（self_heal_progress：第 attempt/maxAttempts 次重写 + 剩余红项）。 */
export interface HealProgress {
  attempt: number
  maxAttempts: number
  remaining: string[]
}

function ts(): string {
  return new Date().toLocaleTimeString('zh-CN')
}

/** 事件日志上限：SSE 长会话只 push 不裁剪会内存膨胀，超出即丢弃最旧条目。 */
const MAX_LOG = 500

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
  /** 非致命警告（如 max_tokens 截断）——UI watch 后 toast。null = 无。 */
  const warning = ref<string | null>(null)

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
    if (log.value.length > MAX_LOG) log.value.splice(0, log.value.length - MAX_LOG)
    if (e.type === 'role_spawn') {
      // 生成开始（provider 直连路径即以此事件声明生成在途）
      running.value = true
      textOut.value = '' // 新生成清空旧正文
      healPhase.value = null
      healProgress.value = null
      healResult.value = null
    } else if (e.type === 'init') {
      // 会话建连元数据（mock driver 每次连接都发）——不代表生成在途，不置 running
      textOut.value = ''
      healPhase.value = null
      healProgress.value = null
      healResult.value = null
    } else if (e.type === 'done' || e.type === 'interrupted' || e.type === 'error') {
      running.value = false
    }
    if (e.type === 'text' && typeof e.text === 'string') textOut.value += e.text
    // 整章重写 / 流式重试前清正文缓冲，不清会把多轮正文首尾拼接
    else if (e.type === 'self_heal_reset' || e.type === 'text_reset') textOut.value = ''
    else if (e.type === 'self_heal_phase') {
      // F-P1-4：白名单校验（防 SSE 非预期值致 UI 渲染异常）
      if (HEAL_PHASES.includes(e.phase as typeof HEAL_PHASES[number])) {
        healPhase.value = e.phase as typeof HEAL_PHASES[number]
      }
    } else if (e.type === 'self_heal_progress') {
      healProgress.value = {
        attempt: Number(e.attempt ?? 0),
        maxAttempts: Number(e.maxAttempts ?? 0),
        remaining: (e.remaining as string[] | undefined) ?? [],
      }
    } else if (e.type === 'self_heal_result') {
      const oc = e.outcome as string
      if (HEAL_OUTCOMES.includes(oc as typeof HEAL_OUTCOMES[number])) {
        healResult.value = {
          outcome: oc as HealResult['outcome'],
          ...(e.reds ? { reds: e.reds as string[] } : {}),
          ...(e.yellows ? { yellows: e.yellows as string[] } : {}),
          ...(e.docId ? { docId: String(e.docId) } : {}),
          ...(e.path ? { path: String(e.path) } : {}),
          ...(e.error ? { error: String(e.error) } : {}),
        }
        healPhase.value = null
        healProgress.value = null
      }
    } else if (e.type === 'warning') {
      warning.value = e.message as string
    }
  }

  function clear(): void {
    log.value = []
    textOut.value = ''
    healPhase.value = null
    healProgress.value = null
    healResult.value = null
    warning.value = null
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
    warning,
    dispatch,
    clear,
    setConnected,
  }
})
