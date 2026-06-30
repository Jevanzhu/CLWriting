import { onMounted, onUnmounted, ref } from 'vue'

// 1.5 单写者协作：进书心跳写 工作区/.gui-active（每 20s 续期），CLI 写命令据此轻提示。
// 原在 BookTabs.vue，第三刀 BookTabs 处置后迁入 AppShell（常驻布局，挂心跳更稳）。
// serverOnline：心跳探活的连接状态（statusbar 真实显示，替代硬编码）。
export const serverOnline = ref(true)

export function useHeartbeat(encName: () => string): void {
  let timer: ReturnType<typeof setInterval> | null = null

  async function beat(): Promise<void> {
    const enc = encName()
    if (!enc) return
    try {
      const res = await fetch(`/api/books/${enc}/heartbeat`, { method: 'POST' })
      serverOnline.value = res.ok
    } catch {
      // 网络拒绝（server 不在线）→ 标记离线；statusbar 据此显示
      serverOnline.value = false
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
