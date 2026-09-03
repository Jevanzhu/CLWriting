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
import { isImeComposing } from '../shared/ime'

// R66-33（十四轮）：发送失败 + 切书 → 文本找回。input 先清空、消息已进 A 书对话区；
// 失败返回时若已切到 B 书，popUser 被书名守卫拦下（误弹会 B 书末条），文本无处可去。
// 以书名键失败草稿：回切该书（watch）或随书重建实例（ChatDock 挂 :key=bookName，R27-76 起）
// setup 取稿时回填输入框；A 书对话区的幽灵气泡由切书重播种自动清掉。
// R28-23（二十八轮）：口径更正——旧表述「ChatPanel 挂 :key 全量重建」不实：ChatPanel 在
// WorkbenchView 无 :key（切书常驻，走下方 watch），随书重建的消费入口实为 ChatDock，
// 与 R27-75 注释及模板实状对齐。
const failedDrafts = new Map<string, string>()

/** R26-83（二十六轮，登记顺手补清）：删书成功后清该书的失败草稿残留——module 级
 *  Map 无书删除出口，残留条目会常驻内存；同名重建书也不该回填旧书的幽灵文本。 */
export function clearFailedDrafts(book: string): void {
  failedDrafts.delete(book)
}

export function useChatComposer(
  bookName: () => string,
  currentChapter: () => number | undefined,
  /** pushUser 后、sendChat 前的额外操作（ChatPanel: scrollToBottom, ChatDock: chatOpen=true） */
  onPushed?: () => void | Promise<void>,
) {
  const chat = useChatStore()
  const wb = useWorkbenchStore()

  const input = ref('')
  /** R66-33：取出本书的失败草稿回填输入框（仅输入框为空时回填，不打断已开始的新输入） */
  function restoreFailedDraft(book: string): void {
    const stash = failedDrafts.get(book)
    if (stash === undefined) return
    // R27-75（二十七轮）：先删后查——stash 存在即无条件销毁、回填却以输入框空为前提，
    // 「切书后回来」时输入框已有新输入反而永久删稿（R66-33 找回语义自毁）。
    // delete 移入「确实回填了」分支：未消费时草稿保留，等下次输入框空的取书时机再回填
    if (!input.value.trim()) {
      input.value = stash
      failedDrafts.delete(book)
    }
  }
  // R66-33：消费入口两条——随书重建的实例（ChatDock 挂 :key=bookName，R27-76 起）靠
  // setup 时取；切书仍常驻的实例（工作台 tab 内 ChatPanel，WorkbenchView 无 :key）靠 watch。
  // 重建实例的 watch 随销毁失效，两条并存不重复回填
  restoreFailedDraft(bookName())
  watch(bookName, (nb) => restoreFailedDraft(nb))
  const sending = ref(false)
  // E1a（steer）：对话运行中允许继续发消息（后端入队，当前轮结束自动续链）；
  // 仅写稿/自愈编排运行（wb.running）时禁发，避免生成中改稿并发
  const busy = computed(() => wb.running)
  // E1a（steer）：对话在跑即可显示停止按钮（interrupt）——停止与禁发语义分离：
  // 运行中追加消息走入队（不禁发），但仍可显式停止当前对话
  const chatRunning = computed(() => chat.running)
  // R35-11：章号语境单一事实源在 chat store（dock/工作台双 composer 实例 +
  // ChatMessages regenerate 共用；本组件不再私有一份）
  const selectedChapter = computed(() => chat.selectedChapter)

  // 首挂/编辑器换章跟随：仅本书无显式选择记忆时（R35-11——手动选择后不再被覆盖，
  // 切书由 chat.clear 复位到该书记忆）。setup 直调一次保持原「初值 = 当前章」行为
  chat.followChatChapter(bookName(), currentChapter())
  watch(currentChapter, (v) => chat.followChatChapter(bookName(), v))

  async function handleSend(): Promise<void> {
    const text = input.value.trim()
    if (!text || busy.value || sending.value) return
    // 第五轮：书名入口捕获——onPushed await 后（以及错误慢返回时）bookName() 可能已
    // 切到 B 书：消息会发进 B 书；失败回滚 popUser 盲弹「当前末条 user」会把 B 书
    // 刚恢复的末条用户消息弹掉、错误写进 B 对话区
    const book = bookName()
    input.value = ''
    // R72-11（二十轮 F-9）：sending 提前置位——原在 onPushed await 之后，双 Enter 在
    // await 间隙可双发（后端 queued 兜底非数据损坏，但 UI 出双气泡）。置位提前后
    // onPushed 的 await 一并纳入 try，任何抛错走 finally 复位，sending 不再可能永真
    sending.value = true
    chat.pushUser(text)
    // R40-37（四十轮）：捕获本次推送的幽灵气泡 id——失败回滚按 id 定位，防「切走又
    // 切回」（书名复检通过但上下文已被 clear+重播种换代）时 popUser 盲弹重播种历史
    // 的末条 user；也防双入口（ChatDock+工作台）并发时误弹对方的在途回滚位
    const ghostId = chat.messages[chat.messages.length - 1]?.id ?? null
    try {
      if (onPushed) await onPushed()
      const result = await sendChat(book, {
        message: text,
        ...(selectedChapter.value !== undefined ? { chapter: selectedChapter.value } : {}),
      })
      // E1a（steer）：入队成功提示（消息已入队，当前对话结束后处理）
      if (result.queued) {
        // R40-36（四十轮）：成功分支书名复检——await 窗口切书后 chat 上下文已换代为
        // B 书，A 书的入队提示/清错写入 B 对话区（对齐失败分支第五轮守卫族口径）
        if (bookName() !== book) return
        chat.error = null // 清历史错误态
        chat.notice = '已加入队列——当前对话结束后会自动处理这条消息。'
      }
    } catch (e) {
      if (bookName() === book) {
        // R40-37：末条仍是本次幽灵气泡才回滚——直接 popUser 弹「当前末条」在上下文
        // 换代后会误弹历史末条；错误文案用闭包内捕获的本次错误 e（非 store 暂存的
        // 「最近一次错误」）
        const last = chat.messages[chat.messages.length - 1]
        if (last && last.id === ghostId) chat.popUser()
        chat.error = e instanceof Error ? e.message : String(e)
      } else {
        // R66-33（十四轮）：失败时已切书——回滚被书名守卫拦下（popUser 会误弹 B 书末条），
        // 文本存入本书失败草稿，回切时回填输入框
        failedDrafts.set(book, text)
      }
    } finally {
      sending.value = false
    }
  }

  function handleKeydown(e: KeyboardEvent): void {
    // R61-3（第六十一轮）：IME 组合期确认候选的 Enter 让渡——此时 v-model 尚未同步
    // 组合文本，放行会以组合前旧值发送不完整消息
    if (e.key === 'Enter' && !e.shiftKey && !isImeComposing(e)) {
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
    // R35-11：写经 chat store（落本书记忆），双实例与 regenerate 同源可见
    chat.selectChatChapter(bookName(), ch)
    chapterMenuOpen.value = false
  }

  function onDocClick(e: MouseEvent): void {
    if (chapterMenuOpen.value && chapterWrapRef.value && !chapterWrapRef.value.contains(e.target as Node)) {
      chapterMenuOpen.value = false
    }
  }

  // R40-47（四十轮）：菜单开时 Esc 关闭自身且不外溢——对齐 ModelPicker R37-36 手法
  //（document capture + stopPropagation：先于外层 window 冒泡监听收口，本层消费后
  // 外层 Esc 链（useHotkeys 退专注/SettingsModal 关设置）不再触发）；IME 组合期 Esc
  // 归输入法候选框，不让渡外层（R75-E-P3e 同口径）
  function onDocKeydown(e: KeyboardEvent): void {
    if (!chapterMenuOpen.value || e.key !== 'Escape' || isImeComposing(e)) return
    e.preventDefault()
    e.stopPropagation()
    chapterMenuOpen.value = false
  }

  onMounted(() => {
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onDocKeydown, true)
  })
  onUnmounted(() => {
    document.removeEventListener('click', onDocClick)
    document.removeEventListener('keydown', onDocKeydown, true)
  })

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
