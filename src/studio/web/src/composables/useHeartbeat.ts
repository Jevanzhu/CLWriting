import { onMounted, onUnmounted } from 'vue'

// 1.5 单写者协作：进书心跳写 工作区/.gui-active（每 20s 续期），CLI 写命令据此轻提示。
// 原在 BookTabs.vue，第三刀 BookTabs 处置后迁入 AppShell（常驻布局，挂心跳更稳）。
export function useHeartbeat(encName: () => string): void {
  let timer: ReturnType<typeof setInterval> | null = null

  async function beat(): Promise<void> {
    const enc = encName()
    if (!enc) return
    try {
      await fetch(`/api/books/${enc}/heartbeat`, { method: 'POST' })
    } catch {
      // 心跳失败忽略（尽力而为，不阻塞 UI）
    }
  }

  onMounted(() => {
    void beat()
    timer = setInterval(() => void beat(), 20_000)
  })
  onUnmounted(() => {
    if (timer) clearInterval(timer)
  })
}
