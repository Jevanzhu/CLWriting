import { watch, onUnmounted, type WatchSource } from 'vue'
import { useWorkbenchStore } from '../stores/workbench'
import { useChatStore } from '../stores/chat'

/**
 * SSE 订阅（细案 T3.1）：dev 直连 127.0.0.1:7878（vite proxy + 系统代理会 buffer 断流，旧版踩坑），
 * 生产同源相对路径。EventSource onmessage → JSON.parse → 分流：
 * chat_* → chat store，其余 → workbench.dispatch。
 * bookName 变 → 重连；组件卸载 → 断开。
 * 退避策略：前 5 次错误由浏览器自动重连；超过后改为手动指数退避（2s→4s→…→60s 封顶）。
 */
const FAST_RETRY_LIMIT = 5
const BASE_BACKOFF_MS = 2_000
const MAX_BACKOFF_MS = 60_000

export function useSse(bookName: WatchSource<string>): void {
  const wb = useWorkbenchStore()
  // setup 内提前获取 chat store 实例：onmessage 回调不在组件上下文，
  // 运行时再 useChatStore() 会撞 activePinia 未设置（抛错被 catch 吞掉 → chat 事件丢失）
  const chat = useChatStore()
  let es: EventSource | null = null
  let errorCount = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let currentName = ''

  function doConnect(): void {
    const base = import.meta.env.DEV ? 'http://127.0.0.1:7878' : ''
    es = new EventSource(`${base}/api/books/${encodeURIComponent(currentName)}/stream`)
    es.onopen = () => {
      errorCount = 0
      wb.setConnected(true)
    }
    es.onerror = () => {
      wb.setConnected(false)
      errorCount++
      // 超过快速重连阈值：接管重连，用指数退避避免疯狂请求
      if (errorCount > FAST_RETRY_LIMIT && es) {
        es.close()
        es = null
        const delay = Math.min(BASE_BACKOFF_MS * 2 ** (errorCount - FAST_RETRY_LIMIT - 1), MAX_BACKOFF_MS)
        reconnectTimer = setTimeout(doConnect, delay)
      }
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

  function connect(name: string): void {
    if (!name) return
    currentName = name
    disconnect()
    doConnect()
  }

  function disconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    es?.close()
    es = null
    errorCount = 0
    wb.setConnected(false)
  }

  watch(bookName, (n) => (n ? connect(n) : disconnect()), { immediate: true })
  onUnmounted(() => disconnect())
}

