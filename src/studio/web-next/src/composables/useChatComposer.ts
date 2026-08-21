/**
 * 对话发送/停止/清空/章节选择共享逻辑（P2-11 去重）。
 * ChatPanel 与 ChatDock 共用，差异点通过 onPushed 回调注入。
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useChatStore } from '../stores/chat'
import { useWorkbenchStore } from '../stores/workbench'
import { friendlyError } from '../shared/error'
import { useUiStore } from '../stores/ui'
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
  // E1a（steer）：对话运行中允许继续发消息（后端入队，当前轮结束自动续链）；
  // 仅写稿/自愈编排运行（wb.running）时禁发，避免生成中改稿并发
  const busy = computed(() => wb.running)
  // E1a（steer）：对话在跑即可显示停止按钮（interrupt）——停止与禁发语义分离：
  // 运行中追加消息走入队（不禁发），但仍可显式停止当前对话
  const chatRunning = computed(() => chat.running)
  const selectedChapter = ref<number | undefined>(currentChapter())

  watch(currentChapter, (v) => {
    if (v !== undefined) selectedChapter.value = v
  })

  async function handleSend(): Promise<void> {
    const text = input.value.trim()
    if (!text || busy.value || sending.value) return
    // 第五轮：书名入口捕获——onPushed await 后（以及错误慢返回时）bookName() 可能已
    // 切到 B 书：消息会发进 B 书；失败回滚 popUser 盲弹「当前末条 user」会把 B 书
    // 刚恢复的末条用户消息弹掉、错误写进 B 对话区
    const book = bookName()
    input.value = ''
    chat.pushUser(text)
    if (onPushed) await onPushed()
    sending.value = true
    try {
      const result = await sendChat(book, {
        message: text,
        ...(selectedChapter.value !== undefined ? { chapter: selectedChapter.value } : {}),
      })
      // E1a（steer）：入队成功提示（消息已入队，当前对话结束后处理）
      if (result.queued) {
        chat.error = null // 清历史错误态
        chat.notice = '已加入队列——当前对话结束后会自动处理这条消息。'
      }
    } catch (e) {
      if (bookName() === book) {
        chat.popUser()
        chat.error = e instanceof Error ? e.message : String(e)
      }
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
    // M-8（第六轮）：书名入口捕获——确认弹窗 await 期间书可能已切换（弹窗可跨书滞留）。
    // 弹窗按发起时的书提问，确认时已不在该书 → 中止：不删错书的服务端历史、不清错书的前端对话区
    const book = bookName()
    // CC-P2-16：清空连服务端历史一起删（不可恢复）——danger 二次确认后才执行
    const ok = await useUiStore().ask({
      title: '清空对话',
      message: '将删除本书的全部对话记录（不可恢复），确定清空吗？',
      confirmText: '清空',
      danger: true,
    })
    if (!ok) return
    if (bookName() !== book) return
    if (chat.running) await stopChat()
    // dd-P3：失败即中止本地清空并提示——否则前端显示已清、事件库保留，刷新后旧对话复活
    try {
      await clearChatHistory(book)
    } catch (e) {
      useUiStore().toast(friendlyError(e), 'error')
      return
    }
    // 清除请求在途切书 → 本地不清（B 书历史刚由切书流程恢复，clear 会把它清掉）
    if (bookName() === book) chat.clear()
  }

  return {
    input, sending, busy, chatRunning, selectedChapter,
    chapterMenuOpen, chapterWrapRef,
    handleSend, handleKeydown, stopChat, handleClear,
    toggleChapterMenu, selectChapter,
  }
}
