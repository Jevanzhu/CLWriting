import { useWorkspaceStore } from './workspace'
import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { rawErrorMessage } from '../shared/error'
import { useStaleGuard } from '../composables/useStaleGuard'
import {
  createChatDispatch,
  createChatTurnState,
  clipToolInput,
  nextMsgId,
  type ChatMessage,
  type ToolCard,
} from './chat-dispatch'
import {
  fetchChatHistory,
  fetchChatBranches,
  regenerateChat,
  type ChatHistoryMessage,
  type ChatHistoryResult,
  type ChatBranchInfo,
} from '../api/chat'

/**
 * 对话助手 store（方案 §3.7.3）。
 *
 * 消息列表 + 工具卡片状态机 + running。
 * chat_* 事件在 useSse 消费点分流到 dispatch()（不塞进 workbench.dispatch）。
 * Y-P2-5：刷新/切书后经 seedHistory 从事件库投影恢复历史（仅 messages 为空时种子化）。
 * G1：重新生成（regenerate）与分支切换（switchBranch）——消息带 seq、维护
 * activeBranchId/branches，多分支书支持在变体组间切换。
 *
 * RC 源码重审 B-5（Opus-5.5 轮）：事件分发状态机（dispatch / ensureTool / updateTool /
 * trimMessages + 消息与工具卡片模型 + 在途回合状态）随批抽入 ./chat-dispatch——本文件
 * 只留 store 外壳、网络面（种子化/分支/重新生成）与章号语境。对外类型面经下方
 * re-export 原样保持（ChatMessages.vue 的具名导入等调用方零改动）。
 */

// RC 源码重审 B-5：消息/工具卡片模型迁入 ./chat-dispatch——对外类型面原样转发。
export type { ChatMessage, ToolStatus } from './chat-dispatch'

export const useChatStore = defineStore('chat', () => {
  /** 消息列表 */
  const messages = ref<ChatMessage[]>([])
  /** 对话进行中 */
  const running = ref(false)
  /** 最近一次错误 */
  const error = ref<string | null>(null)
  /** 0918三拍板批（A006 轻量档）：最近一次失败回合作者原文（chat_error echo 字段）——
   *  服务端已回滚/遮蔽该回合，原文仅存于此供「复制重发」；随 chat_start / clear 失效 */
  const errorEcho = ref<string | null>(null)
  /** E1a（steer）：非错误提示（如「消息已入队，当前对话结束后处理」） */
  const notice = ref<string | null>(null)
  /** RC 源码重审 B-5：在途回合宿主状态——原 setup 内四个可变本地量（回合目标 /
   *  pendingReseed / regenPending / regenBook）随事件分发状态机迁入 ./chat-dispatch
   *  的 ChatTurnState（字段沿革注释随迁）；本 store 与状态机共享同一实例，读写口不变。
   *  R0916-7-P3-27：回合目标 current 持气泡的响应式对象引用（原数组下标 currentIdx）。 */
  const turn = createChatTurnState()
  /** Y-P2-5：种子化代数——clear/新调用使在途响应失效（连切书防旧书历史种到新书，参考 bookGen 守卫）
   *  E6（复审-0914-优化修复批）：裸计数器换装 useStaleGuard（seed/switch 用 begin，regenerate/chat_done 观测点 current，clear invalidate）。 */
  const seedGen = useStaleGuard()
  // R70-30：sync 事件不带书名——延迟取 workspace store 当前书（pinia 惰性激活防循环引用）
  const wsBookName = (): string | null => {
    try {
      const ws = useWorkspaceStore()
      return ws.bookName || null
    } catch {
      return null
    }
  }
  /** G1：当前激活分支（history 返回的实际采用分支；无分支语义/未拉取时 null） */
  const activeBranchId = ref<string | null>(null)
  /** G1：分支（变体组）列表（种子化/切换/重新生成后 best-effort 维护，失败静默降级） */
  const branches = ref<ChatBranchInfo[]>([])
  /**
   * 重评-0912-2 P3（2026-09-12 全量重评修复批）：最近一次视图加载（seedHistory/switchBranch）
   * 的历史尾窗截断态（L-S2：limit=200 生效时服务端回 truncated=true）——此前全前端零消费，
   * 长书超 200 条的旧消息静默消失无提示；ChatMessages 列表顶部据此渲染 muted 提示。
   * regenerate 的历史拉取只取 parentSeq 定位、不重建视图，不更新截断态。
   */
  const historyTruncated = ref(false)
  /** 重评-0912-2 P3：历史规模指标（与 truncated 同源对齐；未知 = null）。
   *  0917清库修复批口径分流：未截断 = 投影消息数；截断态 = 服务端骨架事件行数
   *  （chat/history 真尾窗改造，全量投影消息数需全量 parse 不再随截断态出网）。 */
  const historyTotal = ref<number | null>(null)

  // ── R35-11：章号语境（对话作用于「全书」还是某章）单一事实源 ──
  // 此前 ChatDock 与 ChatPanel 各建一份 useChatComposer 实例（dock 开窗时双实例并存），
  // selectedChapter 互不同步：「重新生成」按 ChatPanel 那份带错章号语境。上提到本 store：
  // dock 输入框 / 工作台输入区 / ChatMessages regenerate 三处消费同一份；按书记忆
  // （显式选择过才记，切书换到目标书的记忆值），显式选择后 currentChapter 不再覆盖。
  const selectedChapter = ref<number | undefined>(undefined)
  /** 显式选择记忆（书 → 章；含显式「全书」=undefined）。有记忆即视为手动选择态。 */
  const chapterMemo = new Map<string, number | undefined>()

  /** 显式选定章号语境（章节菜单入口；同时落本书记忆） */
  function selectChatChapter(book: string, ch: number | undefined): void {
    chapterMemo.set(book, ch)
    selectedChapter.value = ch
  }

  /** 跟随编辑器当前章——仅本书无显式选择记忆时；有记忆（含显式「全书」）不覆盖 */
  function followChatChapter(book: string, current: number | undefined): void {
    if (chapterMemo.has(book)) return
    // R37-29（三十七轮批E）：补 undefined 分支——切到非正文文档（细纲/设定/总纲无章号，
    // currentChapter() 为 undefined）时原只在有值时赋值，章号语境残留上一章，发送会把
    // 对话挂到错误章上下文。非正文文档无章语境 → 显式回落「全书」
    selectedChapter.value = current
  }

  /** R37-28（三十七轮批E）：删书时清理该书的章号显式记忆——chapterMemo 此前无书删除
   *  出口，删除书的记忆常驻内存；同名重建书会回填旧书的章号语境（跨书残留）。
   *  只清指定书（其它书记忆不受牵连），若清的是当前书，selectedChapter 随之回落
   *  「全书」（与 clear 的复位口径一致）。 */
  function clearChapterMemo(book: string): void {
    chapterMemo.delete(book)
    if (wsBookName() === book) selectedChapter.value = undefined
  }

  /** R46-6（四十六轮）：改名迁移章号显式记忆——改名路径此前零迁移（删除路径有
   *  clearChapterMemo），旧名条目常驻内存且新名侧章号语境清零；值搬家不丢状态。 */
  function migrateChapterMemo(oldName: string, newName: string): void {
    if (oldName === newName || !chapterMemo.has(oldName)) return
    chapterMemo.set(newName, chapterMemo.get(oldName))
    chapterMemo.delete(oldName)
  }

  /** R46-6 配套：章号显式记忆只读访问器（迁移链回归测试面；无记忆 = undefined）。 */
  function chatChapterMemoFor(book: string): number | undefined {
    return chapterMemo.get(book)
  }

  /** 是否有消息 */
  const hasMessages = computed(() => messages.value.length > 0)

  /** RC 源码重审 B-5：事件分发状态机随批迁入 ./chat-dispatch（dispatch 的 11 个
   *  chat_* 分支 + ensureTool/updateTool/trimMessages + 在途回合状态）——此处只注入
   *  宿主依赖面：store 的 refs、共享回合状态，与本文件其余职责的两个回调
   *  （wsBookName 惰性取当前书 / refreshBranches 刷分支列表）。refreshBranches 为
   *  函数声明、wsBookName 为箭头常量：均只在事件到达时被调用（不在装配期求值），
   *  与迁移前的调用时机逐位一致。 */
  const chatDispatch = createChatDispatch({
    messages,
    running,
    error,
    errorEcho,
    notice,
    turn,
    wsBookName,
    refreshBranches,
    currentGen: () => seedGen.current(),
  })
  const dispatch = chatDispatch.dispatch
  const updateTool = chatDispatch.updateTool

  /** 添加用户消息（发送时调用） */
  function pushUser(text: string): void {
    messages.value.push({ id: nextMsgId(), role: 'user', content: text, done: true, tools: [] })
    chatDispatch.trimMessages()
  }

  // ── Y-P2-5：历史种子化（刷新/切书后从事件库投影恢复）────

  /** 历史消息 → 气泡模型（与 SSE 实时渲染等价：tool 结果回填到 assistant 的工具卡片，不渲染为用户气泡）。
   *  G1：seqs 与 msgs 平行，气泡 seq 取该消息事件 seq（seqs[i][0]；tool-result 合成消息不渲染为气泡可忽略）。 */
  function seedFromHistory(msgs: ChatHistoryMessage[], seqs?: number[][]): void {
    const seeded: ChatMessage[] = []
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]!
      const seq = seqs?.[i]?.[0]
      if (typeof m.content === 'string') {
        seeded.push({ id: nextMsgId(), role: m.role, content: m.content, done: true, tools: [], ...(typeof seq === 'number' ? { seq } : {}) })
        continue
      }
      if (m.role === 'user') {
        // tool_result 合成消息：结果按 callId 回填前一条 assistant 气泡的工具卡片（等价 chat_tool_result）
        for (const b of m.content) {
          if (b.type === 'tool_result') {
            applySeedToolResult(seeded, b.toolUseId, b.content, b.isError === true)
          }
        }
        continue
      }
      // assistant 块结构：text 拼进气泡内容；tool_use → 工具卡片；reasoning 不渲染（SSE 流本就不透出思维链）
      let text = ''
      const tools: ToolCard[] = []
      for (const b of m.content) {
        if (b.type === 'text') text += b.text
        // C3：历史种子化路径与 SSE 同口径截断（tool_use 的整章正文级 input）
        else if (b.type === 'tool_use') tools.push({ callId: b.id, name: b.name, input: clipToolInput(b.input), status: 'running' })
      }
      seeded.push({ id: nextMsgId(), role: 'assistant', content: text, done: true, tools, ...(typeof seq === 'number' ? { seq } : {}) })
    }
    // 兜底：无 tool_result 回填的卡片（异常残留的半截回合）标 cancelled，防永久转圈
    for (const m of seeded) {
      for (const t of m.tools) {
        if (t.status === 'running') t.status = 'cancelled'
      }
    }
    messages.value.push(...seeded)
    // 种子化只在空列表进行（见 seedHistory 守卫），回合引用必为空；防御性复位防未来不变式漂移
    turn.current = null
    chatDispatch.trimMessages()
  }

  /** 历史 tool_result 回填：反向找最近的同 callId 卡片（等价 SSE 的 updateTool） */
  function applySeedToolResult(seeded: ChatMessage[], callId: string, summary: string, isError: boolean): void {
    for (let i = seeded.length - 1; i >= 0; i--) {
      const tool = seeded[i]!.tools.find((t) => t.callId === callId)
      if (tool) {
        tool.status = isError ? 'failed' : 'ok'
        if (summary) tool.summary = summary
        return
      }
    }
  }

  /**
   * 拉取并种子化对话历史（Y-P2-5）：仅当前消息为空且不在生成中时执行。
   * 竞态守卫：拉取期间若有新 SSE 消息到达（messages 非空）/开始生成（running）/
   * 切书（clear 使 seedGen 失效）→ 宁可放弃种子化也不覆盖/插入错位。
   * G1：种子化成功后 best-effort 拉 branches（失败静默不影响种子化），
   * branches 存列表、activeBranchId 用 history 返回的 branchId（两者解耦）。
   * R33D-8（三十三轮）：`replace:true` 替换式补种——pendingReseed 场景下 messages
   * 已被历史种子化（非空），原空列表守卫使补种恒 no-op（在途回合回复界面缺失）。
   * replace 跳过「非空即弃」守卫（gen/running 守卫保留），先清后种（对齐 switchBranch
   * 整体替换写法），把服务端含该回合结果的权威历史回填界面。
   */
  async function seedHistory(bookName: string, opts?: { replace?: boolean }): Promise<void> {
    const replace = opts?.replace === true
    if (!bookName) return
    // Q-8：running 中种子化会吞掉在途回合的增量（clear 后回合引用已复位）——改为
    // 登记 pendingReseed 等回合收尾后补种，不再直接放弃
    if (running.value) {
      turn.pendingReseed = bookName
      return
    }
    if (!replace && messages.value.length > 0) return
    const gen = seedGen.begin()
    let data: ChatHistoryResult
    try {
      data = await fetchChatHistory(bookName)
    } catch {
      return // 后端未起/离线：静默放弃（对话区留白，可正常发起新对话）
    }
    // 非 replace：fetch 窗口内 SSE 新消息已到（messages 非空）→ 放弃（不插入错位，Y-P2-5）
    if (seedGen.stale(gen) || running.value || (!replace && messages.value.length > 0)) return
    // R33D-8 / R0911b-C1-P3-2 / 重评-0912-2 P3 注锚随实现移入 applyHistoryView（复审-0914-优化修复批 P3）
    await applyHistoryView(bookName, gen, data, replace ? { replace: true } : {})
  }

  /**
   * 复审-0914-优化修复批（P3）：seedHistory / switchBranch 公共核心收口——拿到权威
   * history 后的「（替换式先清）→ 种子化 → activeBranchId 对齐 → 截断态对齐 →
   * best-effort 刷分支列表」原是两处逐行双写，收敛本函数防再漂移。语义逐位等价：
   * - replace:true（switchBranch / seedHistory 的 R33D-8 替换式补种）先清旧种子再回填，
   *   防 append 错位（fetch 窗口内无在途回合）；不传不清（seedHistory 原路径，种子化
   *   只在空列表进行，回合引用必空）；
   * - fallbackBranchId：switchBranch 传请求的 branchId（≡原
   *   `data.branchId !== undefined ? data.branchId : branchId ?? null`）；seedHistory 不传
   *   （≡原 `data.branchId ?? null`，undefined ?? null = null）。
   * 竞态守卫（stale/running/非空放弃）留在各自入口，不入本函数。
   * R0911b-C1-P3-2（2026-09-11 全量重评 GLM-5.3 修复批）：空历史不提前 return——
   * 分支态（activeBranchId/branches）仍以本次权威拉取对齐（对齐 switchBranch 空历史
   * 同款刷新口径），否则 replace 补种（pendingReseed）落空历史时（他窗清空服务端
   * 历史等罕达路径）旧分支态滞留在已清空的对话界面。
   */
  async function applyHistoryView(
    bookName: string,
    gen: number,
    data: ChatHistoryResult,
    opts: { replace?: boolean; fallbackBranchId?: string | null } = {},
  ): Promise<void> {
    if (opts.replace === true) {
      // R33D-8：替换式——先清旧种子再回填，防 append 错位
      messages.value = []
      turn.current = null
    }
    if (data.messages.length > 0) seedFromHistory(data.messages, data.seqs)
    // G1：activeBranchId 用 history 返回的实际采用分支——拉取成功即写（空历史同，
    // R0911b-C1-P3-2），与 branches 拉取解耦（后者失败只降级隐藏切换器，不丢当前分支定位）；
    // 仅旧后端缺字段（undefined）才回落传入 id / null
    activeBranchId.value = data.branchId !== undefined ? data.branchId : opts.fallbackBranchId ?? null
    // 重评-0912-2 P3：截断态随本次权威视图对齐（视图自此历史重建，提示面向当前视图）
    historyTruncated.value = data.truncated === true
    historyTotal.value = data.total ?? null
    // 分支列表 best-effort 拉取（失败静默——变体切换器降级隐藏，对话不受影响）
    await refreshBranches(bookName, gen)
  }

  /** G1：best-effort 刷新分支列表（失败静默；gen 不符丢弃防旧书数据污染新书） */
  async function refreshBranches(bookName: string, gen: number): Promise<void> {
    try {
      const d = await fetchChatBranches(bookName)
      if (seedGen.stale(gen)) return
      branches.value = d.branches ?? []
    } catch {
      /* 静默 */
    }
  }

  /**
   * G1：切换到指定分支（变体组）。仅 !running 时允许；seedGen 作废在途种子化/切换。
   * 成功且无竞态 → 整体替换 messages（新种子，带 seqs）+ activeBranchId=返回的 branchId，
   * 再 best-effort 刷新分支列表；失败静默返回（保留原视图）。
   * 复审-0914-优化修复批（P3）：落视图五连收口 applyHistoryView（公共核心见该函数注）。
   */
  async function switchBranch(bookName: string, branchId: string | null): Promise<void> {
    if (running.value) return
    const gen = seedGen.begin()
    let data: ChatHistoryResult
    try {
      data = await fetchChatHistory(bookName, branchId ?? undefined)
    } catch {
      return // 静默失败：保留原视图
    }
    if (seedGen.stale(gen) || running.value) return
    await applyHistoryView(bookName, gen, data, { replace: true, fallbackBranchId: branchId })
  }

  /** G1：生成新分支 id（b + 时间戳 36 进制 + 随机尾，防同毫秒碰撞） */
  function newBranchId(): string {
    return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  }

  /**
   * G1：重新生成最后一条回复（新分支变体）。
   * 仅 !running 且最后一条消息为已完成 assistant 时允许；进行中标志防重入。
   * 流程：拉当前激活分支权威历史（拿 seqs）→ 反向定位最后一条 user 的事件 seq 作
   * parentSeq → 生成新 branchId → POST regenerate → 成功后本地截断 messages 到
   * 该 user 为止、activeBranchId=新 branchId，SSE 自然接管追加新气泡；
   * 任一步失败 → error 置错并保留原视图。
   */
  async function regenerate(bookName: string, chapter?: number): Promise<void> {
    const last = messages.value[messages.value.length - 1]
    if (turn.regenPending || running.value || !last || last.role !== 'assistant' || !last.done) return
    turn.regenPending = true
    const gen = seedGen.current()
    let handedOff = false // 已交由 SSE 接管（标志改由 chat_done/chat_error 复位）
    try {
      let data: ChatHistoryResult
      try {
        // R34D-5（三十四轮）：带 activeBranchId 拉当前显示分支的历史（对齐 switchBranch
        // 的 branchId ?? undefined 写法）——此前不带 branchId 恒拉默认分支：非默认分支 B
        // 上点重新生成时，本地截断/激活作用于 B 分支视图，POST 的 fork 基点 parentSeq 却
        // 取自主线，服务端按主线上下文生成 →「B 分支前缀 + 主线上文的回答」混合血统视图
        // 落库（新 branchId），分支语义被破坏。
        data = await fetchChatHistory(bookName, activeBranchId.value ?? undefined)
      } catch {
        error.value = '获取对话历史失败，请稍后重试'
        return
      }
      if (seedGen.stale(gen) || running.value) return // 期间清空/切分支/新回合开跑：放弃
      // 反向找最后一条真实 user 文本消息（tool_result 合成的 user 不算）的事件 seq
      let parentSeq: number | undefined
      for (let i = data.messages.length - 1; i >= 0; i--) {
        const m = data.messages[i]!
        if (m.role === 'user' && typeof m.content === 'string') {
          const seq = data.seqs?.[i]?.[0]
          if (typeof seq === 'number') parentSeq = seq
          break
        }
      }
      if (parentSeq === undefined) {
        error.value = '未找到可重新生成的消息'
        return
      }
      const branchId = newBranchId()
      // POST 前快照本地消息 id：截断只删快照内的旧消息——SSE 抢先开跑追加的新气泡
      // （即使已快速 done）不属于旧视图，不得误删
      const preIds = new Set(messages.value.map((m) => m.id))
      // F6（五十九轮）：regenBook 前置到 POST 之前——原实现「POST 成功返回后才赋值」的
      // 窗口内 SSE 可抢跑（服务端收到请求即开跑并回流 chat_done），届时读 null 漏刷
      // 分支列表。POST 失败由 finally（!handedOff）清；POST 成功则无论后续路径，回合
      // 结束（chat_done）都能读到书名
      turn.regenBook = bookName
      try {
        await regenerateChat(bookName, {
          parentSeq,
          branchId,
          ...(chapter !== undefined ? { chapter } : {}),
        })
      } catch (e) {
        error.value = rawErrorMessage(e) // 保留原视图（复审-0914-优化修复批：表达式收编 shared/error 单源）
        return
      }
      if (seedGen.stale(gen)) return // 期间清空/切分支：不污染新视图
      // 本地截断到最后一条 user 气泡（其后旧消息全删、user 保留；SSE 抢先追加的新气泡保留）
      let lastUser = -1
      for (let i = messages.value.length - 1; i >= 0; i--) {
        if (messages.value[i]!.role === 'user') {
          lastUser = i
          break
        }
      }
      if (lastUser >= 0) {
        messages.value = messages.value.filter(
          (m, i) => i <= lastUser || !m.done || !preIds.has(m.id),
        )
        // R0916-7-P3-27：截断只位移数组、消息对象身份不变（filter 留下的在途回合气泡
        // 还是同一响应式代理）——回合目标持对象引用自动跟随，原「反向扫 last undone
        // 重定位 currentIdx」的补偿块随之退役（漏重定位即增量写错位的根源形态）
      }
      activeBranchId.value = branchId
      handedOff = true
    } finally {
      // F6（五十九轮）：未交接（POST 失败/前置拒绝/期间清空）时连带清前置登记的 regenBook，
      // 防 POST 失败后残留书名被下一轮无关 chat_done 误刷分支
      if (!handedOff) {
        turn.regenPending = false
        turn.regenBook = null
      }
    }
  }

  /** 裁剪最旧消息，保持列表不超过上限（在 push / chat_done 后调） */
  // RC 源码重审 B-5：实现迁入 ./chat-dispatch（trimMessages 与在途回合状态同处一模块
  // ——R0916-7-P3-27 起回合目标持对象引用，裁剪位移自动跟随），本文件经
  // chatDispatch.trimMessages() 调用。

  /** 回滚最后一条用户消息（sendChat 失败时调，防幽灵消息） */
  function popUser(): void {
    const last = messages.value[messages.value.length - 1]
    if (last && last.role === 'user') messages.value.pop()
  }

  /** 清空对话 */
  function clear(): void {
    messages.value = []
    error.value = null
    errorEcho.value = null
    notice.value = null
    turn.current = null
    seedGen.invalidate() // Y-P2-5：在途种子化响应作废（切书/清空后旧历史不得再种入）
    turn.pendingReseed = null // Q-8：待补种随清空作废（每次切换由随后的 seedHistory 重新登记，防跨书误种）
    // 0918独立重评修复批（E006）：running 一并复位——旧实现残留 true 会让 clear 后的
    // seedHistory 被 running 守卫拦成 pendingReseed（无人收尾时永不补种）。新书真实运行态
    // 由重连 sync 权威校正（workbench.clear 的 M-12 同口径）。须在 pendingReseed 清空之后
    // 置位：true→false 会触发补种 watch，先清登记防其抢跑复活刚作废的补种
    running.value = false
    // G1：重置分支态 + 复位重新生成进行中标志（清空后旧分支/在途操作不得残留）
    activeBranchId.value = null
    branches.value = []
    // 重评-0912-2 P3：截断态随视图清空复位（同分支态口径）
    historyTruncated.value = false
    historyTotal.value = null
    turn.regenPending = false
    turn.regenBook = null
    // R35-11：切书在此收口（Book.vue 切书链统一调 clear）——章号语境换到目标书的
    // 显式记忆值（无记忆 = 「全书」，随后的 currentChapter 跟随照常）；同书清空对话
    // 时记忆值即当前值，选择不丢。记忆 Map 不清：按书记忆跨切书保留
    const book = wsBookName()
    selectedChapter.value = book ? chapterMemo.get(book) : undefined
  }

  // Q-8：在途回合收尾（running 翻 false）自动补种登记中的书——切书窗口内被 clear
  // 掉的回合届时从服务端历史回填，不再失明。store 常驻（App 级），watch 不卸载。
  // R33D-8：补种走 replace:true——pendingReseed 登记时 messages 已非空（历史先于
  // sync 种子化），原空列表守卫使补种恒 no-op；替换式重播种回填在途回合的权威结果。
  watch(running, (v) => {
    if (!v && turn.pendingReseed) {
      const b = turn.pendingReseed
      turn.pendingReseed = null
      void seedHistory(b, { replace: true })
    }
  })

  return {
    messages,
    running,
    error,
    errorEcho,
    notice,
    hasMessages,
    activeBranchId,
    branches,
    historyTruncated,
    historyTotal,
    selectedChapter,
    selectChatChapter,
    followChatChapter,
    clearChapterMemo,
    migrateChapterMemo,
    chatChapterMemoFor,
    dispatch,
    pushUser,
    popUser,
    clear,
    updateTool,
    seedHistory,
    switchBranch,
    regenerate,
  }
})
