import { ref, onUnmounted, watch } from 'vue'
import { apiFetch } from '../api/client'

// 协作心跳：进书后每 20s POST /heartbeat 续期；卸载/切书 DELETE 清除（单写者互斥）。
// serverOnline 为全局信号（状态栏连接徽章 + 右栏 AI 置灰消费）。
const online = ref(true)
export const serverOnline = online

export function useHeartbeat(getBookName: () => string | null): void {
  let timer: ReturnType<typeof setInterval> | null = null

  async function beat(): Promise<void> {
    const name = getBookName()
    if (!name) return
    try {
      const r = await apiFetch(`/api/books/${encodeURIComponent(name)}/heartbeat`, { method: 'POST' })
      online.value = r.ok
    } catch {
      online.value = false
    }
  }

  function start(): void {
    stop()
    void beat()
    timer = setInterval(() => void beat(), 20_000)
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  async function leave(): Promise<void> {
    stop()
    const name = getBookName()
    if (name) {
      try {
        await apiFetch(`/api/books/${encodeURIComponent(name)}/heartbeat`, { method: 'DELETE' })
      } catch {
        /* 退书心跳清除失败忽略 */
      }
    }
  }

  watch(
    () => getBookName(),
    (n) => {
      if (n) start()
      else stop()
    },
    { immediate: true },
  )
  onUnmounted(() => {
    void leave()
  })
}
