import { watch, onUnmounted, type WatchSource } from 'vue'
import { useWorkbenchStore } from '../stores/workbench'
import { useChatStore } from '../stores/chat'

/**
 * SSE 订阅（细案 T3.1）：dev 直连 127.0.0.1:7878（vite proxy + 系统代理会 buffer 断流，旧版踩坑），
 * 生产同源相对路径。EventSource onmessage → JSON.parse → 分流：
 * chat_* → chat store，其余 → workbench.dispatch。
 * bookName 变 → 重连；组件卸载 → 断开。浏览器遇错自动重连（不需手动）。
 */
export function useSse(bookName: WatchSource<string>): void {
  const wb = useWorkbenchStore()
  // setup 内提前获取 chat store 实例：onmessage 回调不在组件上下文，
  // 运行时再 useChatStore() 会撞 activePinia 未设置（抛错被 catch 吞掉 → chat 事件丢失）
  const chat = useChatStore()
  let es: EventSource | null = null

  function connect(name: string): void {
    if (!name) return
    disconnect()
    const base = import.meta.env.DEV ? 'http://127.0.0.1:7878' : ''
    es = new EventSource(`${base}/api/books/${encodeURIComponent(name)}/stream`)
    es.onopen = () => wb.setConnected(true)
    es.onerror = () => {
      wb.setConnected(false)
      // 不手动重连：浏览器 EventSource 内置自动重连
    }
    es.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data)
        // chat_* → chat store；sync → 同时给 chat（同步运行态防锁死）和 workbench
        const t = typeof data?.type === 'string' ? data.type : ''
        if (t === 'sync' || t.startsWith('chat_')) chat.dispatch(data)
        if (t === 'sync' || !t.startsWith('chat_')) wb.dispatch(data)
      } catch {
        /* 非 JSON 静默丢弃（细案 §2.2） */
      }
    }
  }
  function disconnect(): void {
    es?.close()
    es = null
    wb.setConnected(false)
  }

  watch(bookName, (n) => (n ? connect(n) : disconnect()), { immediate: true })
  onUnmounted(() => disconnect())
}
