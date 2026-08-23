import { ref, onUnmounted, watch } from 'vue'
import { apiFetch, getToken } from '../api/client'

// 协作心跳：进书后每 20s POST /heartbeat 续期；卸载（onUnmounted）DELETE 清除（单写者互斥）。
// 切书不发 DELETE（依赖服务端过期回收）——L-F5（第八轮）注释校准：原「切书 DELETE」与实现不符。
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
    // E-6a（第五十三轮）：停止心跳时把全局在线信号复位回初始「在线/未知」态——
    // 否则退书前最后一次 beat 失败的假阴性会挂到下次进书（StatusBar 误显离线），
    // 且退书后不再探测，无机会自愈。下次进书 start() 的首次 beat 会立即校正。
    online.value = true
  }

  async function leave(): Promise<void> {
    stop()
    const name = getBookName()
    // E-6b（第五十三轮）：token null（boot 未成功）时跳过 DELETE——必 401 徒劳且会
    // 误触发 apiFetch 的 re-boot（E-2）；本地直接放弃清除，让服务端过期回收心跳。
    if (name && getToken()) {
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
