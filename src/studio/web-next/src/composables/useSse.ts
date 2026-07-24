import { watch, onUnmounted, type WatchSource } from 'vue'
import { useWorkbenchStore } from '../stores/workbench'

/**
 * SSE 订阅（细案 T3.1）：dev 直连 127.0.0.1:7878（vite proxy + 系统代理会 buffer 断流，旧版踩坑），
 * 生产同源相对路径。EventSource onmessage → JSON.parse → workbench.dispatch（失败静默丢弃）。
 * bookName 变 → 重连；组件卸载 → 断开。浏览器遇错自动重连（不需手动）。
 */
export function useSse(bookName: WatchSource<string>): void {
  const wb = useWorkbenchStore()
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
        wb.dispatch(JSON.parse(e.data))
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
