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

function ts(): string {
  return new Date().toLocaleTimeString('zh-CN')
}

export const useWorkbenchStore = defineStore('workbench', () => {
  /** 事件日志（按序追加，右栏事件流消费）。 */
  const log = ref<SseEvent[]>([])
  /** 生成中（init/role_spawn→true，done/interrupted/error→false）。 */
  const running = ref(false)
  /** SSE 连接态。 */
  const connected = ref(false)

  /** 分派一条 SSE 事件：追加日志 + 维护 running。JSON.parse 已由 useSse 完成。 */
  function dispatch(ev: unknown): void {
    if (typeof ev !== 'object' || ev === null) return
    const e = { ...(ev as Record<string, unknown>), _ts: ts() } as SseEvent
    log.value.push(e)
    if (e.type === 'init' || e.type === 'role_spawn') {
      running.value = true
    } else if (e.type === 'done' || e.type === 'interrupted' || e.type === 'error') {
      running.value = false
    }
  }

  function clear(): void {
    log.value = []
  }
  function setConnected(v: boolean): void {
    connected.value = v
  }

  return { log, running, connected, dispatch, clear, setConnected }
})
