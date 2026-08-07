/**
 * 对话发送/停止/清空/章节选择共享逻辑（P2-11 去重）。
 * ChatPanel 与 ChatDock 共用，差异点通过 onPushed 回调注入。
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useChatStore } from '../stores/chat'
import { useWorkbenchStore } from '../stores/workbench'
import { sendChat, clearChatHistory } from '../api/chat'
import { interrupt } from '../api/stream'

export function useChatComposer(
  bookName: () => string,
  currentChapter: () => number | undefined,
  /** pushUser 后、sendChat 前的额外操作（ChatPanel: scrollToBottom, ChatDock: chatOpen=true） */
  onPushed?: () => void | Promise<void>,
) {
  const chat = useChatStore()
  const wb = useWorkbenchStore()

  const input = ref('')
  const sending = ref(false)
  const busy = computed(() => chat.running || wb.running)
  const selectedChapter = ref<number | undefined>(currentChapter())

  watch(currentChapter, (v) => {
    if (v !== undefined) selectedChapter.value = v
  })

  async function handleSend(): Promise<void> {
    const text = input.value.trim()
    if (!text || busy.value || sending.value) return
    input.value = ''
    chat.pushUser(text)
    if (onPushed) await onPushed()
    sending.value = true
    try {
      await sendChat(bookName(), {
        message: text,
        ...(selectedChapter.value !== undefined ? { chapter: selectedChapter.value } : {}),
      })
    } catch (e) {
      chat.popUser()
      chat.error = e instanceof Error ? e.message : String(e)
    } finally {
      sending.value = false
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  /** 章节下拉菜单（自定义浮层，替代原生 select 以掌控定位） */
  const chapterMenuOpen = ref(false)
  const chapterWrapRef = ref<HTMLElement | null>(null)

  function toggleChapterMenu(): void {
    chapterMenuOpen.value = !chapterMenuOpen.value
  }

  function selectChapter(ch: number | undefined): void {
    selectedChapter.value = ch
    chapterMenuOpen.value = false
  }

  function onDocClick(e: MouseEvent): void {
    if (chapterMenuOpen.value && chapterWrapRef.value && !chapterWrapRef.value.contains(e.target as Node)) {
      chapterMenuOpen.value = false
    }
  }

  onMounted(() => document.addEventListener('click', onDocClick))
  onUnmounted(() => document.removeEventListener('click', onDocClick))

  async function stopChat(): Promise<void> {
    try { await interrupt(bookName()) } catch { /* 忽略 */ }
  }

  async function handleClear(): Promise<void> {
    if (chat.running) await stopChat()
    try { await clearChatHistory(bookName()) } catch { /* 忽略 */ }
    chat.clear()
  }

  return {
    input, sending, busy, selectedChapter,
    chapterMenuOpen, chapterWrapRef,
    handleSend, handleKeydown, stopChat, handleClear,
    toggleChapterMenu, selectChapter,
  }
}
