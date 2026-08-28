import { useWorkspaceStore } from './workspace'
import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { str } from './sse-guards'
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
 */

/** 工具卡片状态 */
export type ToolStatus = 'pending' | 'running' | 'ok' | 'failed' | 'cancelled'

/** 工具卡片 */
export interface ToolCard {
  callId: string
  name: string
  input: unknown
  status: ToolStatus
  summary?: string
}

/** 聊天消息气泡（文本 + 关联工具卡片按时序穿插） */
export interface ChatMessage {
  /** 稳定唯一 id（v-for key 用，防裁剪/弹出后索引错位导致动画重播） */
  id: string
  role: 'user' | 'assistant'
  content: string
  done: boolean
  /** 本回合的工具卡片（按时序） */
  tools: ToolCard[]
  /** G1：该消息事件 seq（历史种子化时取 seqs[i][0]；实时 SSE 消息无此字段） */
  seq?: number
}

/** 消息列表上限（防长对话内存膨胀） */
const MAX_MESSAGES = 200

/** 工具入参落存截断上限（码位）。内存闸（2026-08-24 审计 C3）：工具卡 input 是
 *  整章正文级文本（如 write_chapter 的正文入参），原样入 store 常驻——列表上限只
 *  限消息条数不限体积（200 条 × 全文章节 = MB 级驻留）。落存前统一截到 2000 码位
 *  + … 尾标（方案原文写 ToolCard.summary，以实际字段为准 = input）。 */
const TOOL_INPUT_MAX = 2000

/** 码位计数（不展开数组；代理对成对计 1，与 Array.from 口径一致） */
function codePointLength(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    // 高代理项后随低代理项 → 成对算一个码位，跳过低代理项
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) i++
    }
    n++
  }
  return n
}

/** 码位截断（口径同 src/process/summary.ts clipByCodePoints：Array.from 迭代码点——
 *  String.slice 按 UTF-16 码元会把增补平面字符切成半个代理对） */
function clipByCodePoints(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('')
}

/** 内存闸（2026-08-24 审计 C3）：工具入参落存前截断——SSE 两条路（chat_tool_pending
 *  追加 / readonly chat_tool 经 ensureTool 补建）与历史种子化（seedFromHistory 的
 *  tool_use）三处收口。字符串超限 → 截断 + …；对象序列化后超限才替换为截断串
 *  （小对象原形落存，不动既有展示与断言口径）；其余类型原样透传。 */
function clipToolInput(input: unknown): unknown {
  let text: string
  if (typeof input === 'string') {
    text = input
  } else {
    try {
      text = JSON.stringify(input) ?? ''
    } catch {
      return input // 循环引用等不可序列化：原样透传（不为此抛错）
    }
  }
  return codePointLength(text) > TOOL_INPUT_MAX ? clipByCodePoints(text, TOOL_INPUT_MAX) + '…' : input
}

/** 自增序列——生成稳定消息 id（不用 crypto.randomUUID 避免 happy-dom 兼容问题） */
let _msgSeq = 0

export const useChatStore = defineStore('chat', () => {
  /** 消息列表 */
  const messages = ref<ChatMessage[]>([])
  /** 对话进行中 */
  const running = ref(false)
  /** 最近一次错误 */
  const error = ref<string | null>(null)
  /** E1a（steer）：非错误提示（如「消息已入队，当前对话结束后处理」） */
  const notice = ref<string | null>(null)
  /** 当前正在填充的 assistant 气泡索引（chat_text 追加目标） */
  let currentIdx = -1
  /** Y-P2-5：种子化代数——clear/新调用使在途响应失效（连切书防旧书历史种到新书，参考 bookGen 守卫） */
  let seedGen = 0
  /** Q-8（第十五轮）：切书 clear 时该书在途回合被清（running 守卫跳过 seedHistory）→
   *  记待补种书名，running 翻 false（chat_done/chat_error）后自动补种——在途回合
   *  不再 UI 失明（服务端历史本就完好）。clear() 复位（每次切换重新登记，防跨书误种）。 */
  let pendingReseed: string | null = null
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
  /** G1：重新生成进行中（防重入；POST 成功后保持 true 直到 chat_done/chat_error 复位） */
  let regenPending = false
  /** G1：重新生成的书名（chat_done 时 best-effort 刷新分支列表用） */
  let regenBook: string | null = null

  /** 是否有消息 */
  const hasMessages = computed(() => messages.value.length > 0)

  /** 分派一条 chat_* SSE 事件 */
  function dispatch(ev: { type: string; [k: string]: unknown }): void {
    switch (ev.type) {
      case 'sync': {
        // 连接快照（SSE 重连补发）：同步后端真实 chat 运行态，防断连错过 chat_done 致永久锁死
        running.value = ev['chatRunning'] === true
        // AA-P3-8：regenPending 陷阱态恢复——regenPending 只由 chat_done/chat_error 复位，
        // 若 SSE 全断且这两者都没到，防重入标志永久卡死「重新生成」。重连的 sync 是权威
        // 快照：后端不在跑对话（chatRunning=false）→ 那次 regenerate 的回合要么从未启动、
        // 要么已结束（chat_done 已消费掉但前端没收到）→ 必须复位标志，允许再次触发。
        if (!running.value && regenPending) {
          regenPending = false
          regenBook = null
        }
        // P2-9：重连时后端只补发 chatRunning，不重发 chat_turn——若旧 currentIdx 已随回合结束失效，
        // 找到最后一个未 done 的 assistant 气泡重建索引（否则 chat_text 追加到错误气泡或被静默丢弃）
        if (running.value && (currentIdx < 0 || messages.value[currentIdx]?.done)) {
          // 反向找最后一个未 done 的 assistant 气泡（lib=ES2022 无 findLastIndex，手写循环）
          let lastUndone = -1
          for (let i = messages.value.length - 1; i >= 0; i--) {
            const m = messages.value[i]
            if (m && m.role === 'assistant' && !m.done) {
              lastUndone = i
              break
            }
          }
          currentIdx = lastUndone
          // R70-30（十八轮）：running=true 但无可续气泡（seedHistory 先于 sync 到达的
          // 时序边界）——在途回合的 chat_text 会因 currentIdx=-1 全部被丢且 chat_done
          // 后无人补种（Q-8 只覆盖「clear 时在跑」反向序）；登记 pendingReseed 由
          // 回合收尾补种（事件库无损，此处纯展示缺口的自愈）
          if (lastUndone === -1 && wsBookName()) pendingReseed = wsBookName()
        }
        break
      }
      case 'chat_start': {
        running.value = true
        error.value = null
        notice.value = null
        break
      }
      case 'chat_turn': {
        // 新回合 = 新 assistant 气泡
        messages.value.push({ id: `m${_msgSeq++}`, role: 'assistant', content: '', done: false, tools: [] })
        currentIdx = messages.value.length - 1
        break
      }
      case 'chat_text': {
        const text = str(ev['text'])
        if (text && currentIdx >= 0) {
          messages.value[currentIdx]!.content += text
        }
        break
      }
      case 'chat_tool_pending': {
        const callId = str(ev['callId'])
        const name = str(ev['name'])
        if (callId && name && currentIdx >= 0) {
          // C3：入参落存前截断（整章正文级 input 不得原样常驻）
          messages.value[currentIdx]!.tools.push({
            callId,
            name,
            input: clipToolInput(ev['input']),
            status: 'pending',
          })
        }
        break
      }
      case 'chat_tool': {
        // readonly 工具不经 pending 直接 tool → 创建卡片
        const callId = str(ev['callId'])
        const name = str(ev['name'])
        if (callId && name) {
          ensureTool(callId, name, ev['input'])
          updateTool(callId, { status: 'running' })
        }
        break
      }
      case 'chat_tool_result': {
        const callId = str(ev['callId'])
        if (callId) {
          // R-6（十五轮登记销账）：失败结果标 failed 对齐种子化路径同口径；
          // cancelled 仅保留给「无 tool_result 回填」的兜底语义（异常中断 ≠ 工具执行失败）
          updateTool(callId, {
            status: ev['ok'] === true ? 'ok' : 'failed',
            ...(str(ev['summary']) ? { summary: str(ev['summary']) } : {}),
          })
        }
        break
      }
      case 'chat_reset': {
        // 重试防拼接：清当前回合的文本和工具卡片（旧工具结果不残留）
        if (currentIdx >= 0) {
          messages.value[currentIdx]!.content = ''
          messages.value[currentIdx]!.tools = []
        }
        break
      }
      case 'chat_done': {
        running.value = false
        if (currentIdx >= 0) {
          messages.value[currentIdx]!.done = true
        }
        // P2-9：回合结束即失效 currentIdx——SSE 断线重连后 sync 不会重发 chat_turn，
        // 旧索引指向已 done 气泡会让后续 chat_text 追加错误位置
        currentIdx = -1
        trimMessages()
        // G1：重新生成的回合结束 → 复位进行中标志 + best-effort 刷新分支列表（变体计数更新）
        if (regenPending) {
          regenPending = false
          const book = regenBook
          regenBook = null
          if (book) void refreshBranches(book, seedGen)
        }
        break
      }
      case 'chat_error': {
        running.value = false
        error.value = str(ev['error']) ?? '未知错误'
        // R-7（第十六轮）：收尾在途气泡（对齐 chat_done 口径）——异常中断时 currentIdx
        // 指向的未完成 assistant 气泡置 done + 复位索引，防永久「生成中」+ 后续文本错位
        if (currentIdx >= 0) {
          messages.value[currentIdx]!.done = true
        }
        currentIdx = -1
        // G1：重新生成回合异常中断 → 复位防重入标志（防永久锁死，可再次触发）
        if (regenPending) {
          regenPending = false
          regenBook = null
        }
        break
      }
      case 'notice': {
        // AA-P3-1：队列超容丢弃最旧消息等非错误提示（与「已加入队列」同通道展示）
        const msg = str(ev['message'])
        if (msg) notice.value = msg
        break
      }
    }
  }

  /** 确保工具卡片存在（readonly 工具不经 pending，chat_tool 时补建） */
  function ensureTool(callId: string, name: string, input: unknown): void {
    if (currentIdx < 0) return
    const tools = messages.value[currentIdx]!.tools
    if (!tools.some((t) => t.callId === callId)) {
      // C3：readonly 工具补建卡片同样走截断收口
      tools.push({ callId, name, input: clipToolInput(input), status: 'pending' })
    }
  }

  /** 更新工具卡片状态 */
  function updateTool(callId: string, patch: Partial<ToolCard>): void {
    // R62-19：反向遍历取最近的同 callId 卡——SSE 的 updateTool 与种子化 applySeedToolResult
    // 原先一个正向首个、一个反向最近，callId 跨回合重复时同事件打在两张卡上（状态错乱）。
    // 统一反向：新回合的事件精确落回本回合卡片（旧回合卡是历史只读呈现）。
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const tool = messages.value[i]!.tools.find((t) => t.callId === callId)
      if (tool) {
        Object.assign(tool, patch)
        return
      }
    }
  }

  /** 添加用户消息（发送时调用） */
  function pushUser(text: string): void {
    messages.value.push({ id: `m${_msgSeq++}`, role: 'user', content: text, done: true, tools: [] })
    trimMessages()
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
        seeded.push({ id: `m${_msgSeq++}`, role: m.role, content: m.content, done: true, tools: [], ...(typeof seq === 'number' ? { seq } : {}) })
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
      seeded.push({ id: `m${_msgSeq++}`, role: 'assistant', content: text, done: true, tools, ...(typeof seq === 'number' ? { seq } : {}) })
    }
    // 兜底：无 tool_result 回填的卡片（异常残留的半截回合）标 cancelled，防永久转圈
    for (const m of seeded) {
      for (const t of m.tools) {
        if (t.status === 'running') t.status = 'cancelled'
      }
    }
    messages.value.push(...seeded)
    // 种子化只在空列表进行（见 seedHistory 守卫），currentIdx 必为 -1；防御性复位防未来不变式漂移
    currentIdx = -1
    trimMessages()
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
   */
  async function seedHistory(bookName: string): Promise<void> {
    if (!bookName) return
    // Q-8：running 中种子化会吞掉在途回合的增量（clear 后 currentIdx=-1）——改为
    // 登记 pendingReseed 等回合收尾后补种，不再直接放弃
    if (running.value) {
      pendingReseed = bookName
      return
    }
    if (messages.value.length > 0) return
    const gen = ++seedGen
    let data: ChatHistoryResult
    try {
      data = await fetchChatHistory(bookName)
    } catch {
      return // 后端未起/离线：静默放弃（对话区留白，可正常发起新对话）
    }
    if (gen !== seedGen || messages.value.length > 0 || running.value) return
    if (data.messages.length === 0) return
    seedFromHistory(data.messages, data.seqs)
    // G1：activeBranchId 用 history 返回的实际采用分支——种子化成功即写，
    // 与 branches 拉取解耦（后者失败只降级隐藏切换器，不丢当前分支定位）
    activeBranchId.value = data.branchId ?? null
    // 分支列表 best-effort 拉取（失败静默——变体切换器降级隐藏，对话不受影响）
    await refreshBranches(bookName, gen)
  }

  /** G1：best-effort 刷新分支列表（失败静默；gen 不符丢弃防旧书数据污染新书） */
  async function refreshBranches(bookName: string, gen: number): Promise<void> {
    try {
      const d = await fetchChatBranches(bookName)
      if (gen !== seedGen) return
      branches.value = d.branches ?? []
    } catch {
      /* 静默 */
    }
  }

  /**
   * G1：切换到指定分支（变体组）。仅 !running 时允许；seedGen++ 作废在途种子化/切换。
   * 成功且无竞态 → 整体替换 messages（新种子，带 seqs）+ activeBranchId=返回的 branchId，
   * 再 best-effort 刷新分支列表；失败静默返回（保留原视图）。
   */
  async function switchBranch(bookName: string, branchId: string | null): Promise<void> {
    if (running.value) return
    const gen = ++seedGen
    let data: ChatHistoryResult
    try {
      data = await fetchChatHistory(bookName, branchId ?? undefined)
    } catch {
      return // 静默失败：保留原视图
    }
    if (gen !== seedGen || running.value) return
    messages.value = []
    currentIdx = -1
    if (data.messages.length > 0) seedFromHistory(data.messages, data.seqs)
    // activeBranchId = history 返回值（线性书显式 null；仅旧后端缺字段时才回落传入 id）
    activeBranchId.value = data.branchId !== undefined ? data.branchId : branchId ?? null
    await refreshBranches(bookName, gen)
  }

  /** G1：生成新分支 id（b + 时间戳 36 进制 + 随机尾，防同毫秒碰撞） */
  function newBranchId(): string {
    return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  }

  /**
   * G1：重新生成最后一条回复（新分支变体）。
   * 仅 !running 且最后一条消息为已完成 assistant 时允许；进行中标志防重入。
   * 流程：拉默认分支权威历史（拿 seqs）→ 反向定位最后一条 user 的事件 seq 作
   * parentSeq → 生成新 branchId → POST regenerate → 成功后本地截断 messages 到
   * 该 user 为止、activeBranchId=新 branchId，SSE 自然接管追加新气泡；
   * 任一步失败 → error 置错并保留原视图。
   */
  async function regenerate(bookName: string, chapter?: number): Promise<void> {
    const last = messages.value[messages.value.length - 1]
    if (regenPending || running.value || !last || last.role !== 'assistant' || !last.done) return
    regenPending = true
    const gen = seedGen
    let handedOff = false // 已交由 SSE 接管（标志改由 chat_done/chat_error 复位）
    try {
      let data: ChatHistoryResult
      try {
        data = await fetchChatHistory(bookName)
      } catch {
        error.value = '获取对话历史失败，请稍后重试'
        return
      }
      if (gen !== seedGen || running.value) return // 期间清空/切分支/新回合开跑：放弃
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
      regenBook = bookName
      try {
        await regenerateChat(bookName, {
          parentSeq,
          branchId,
          ...(chapter !== undefined ? { chapter } : {}),
        })
      } catch (e) {
        error.value = e instanceof Error ? e.message : String(e) // 保留原视图
        return
      }
      if (gen !== seedGen) return // 期间清空/切分支：不污染新视图
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
        // 截断移动了在途回合气泡的索引 → 重定位 currentIdx（SSE 已开跑时）
        if (currentIdx >= 0) {
          let live = -1
          for (let i = messages.value.length - 1; i >= 0; i--) {
            const m = messages.value[i]!
            if (m.role === 'assistant' && !m.done) {
              live = i
              break
            }
          }
          currentIdx = live
        }
      }
      activeBranchId.value = branchId
      handedOff = true
    } finally {
      // F6（五十九轮）：未交接（POST 失败/前置拒绝/期间清空）时连带清前置登记的 regenBook，
      // 防 POST 失败后残留书名被下一轮无关 chat_done 误刷分支
      if (!handedOff) {
        regenPending = false
        regenBook = null
      }
    }
  }

  /** 裁剪最旧消息，保持列表不超过上限（在 push / chat_done 后调） */
  function trimMessages(): void {
    if (messages.value.length > MAX_MESSAGES) {
      const cut = messages.value.length - MAX_MESSAGES
      messages.value.splice(0, cut)
      // 防御性修正：splice 从头部删后 currentIdx 偏移
      if (currentIdx >= 0) currentIdx = Math.max(-1, currentIdx - cut)
    }
  }

  /** 回滚最后一条用户消息（sendChat 失败时调，防幽灵消息） */
  function popUser(): void {
    const last = messages.value[messages.value.length - 1]
    if (last && last.role === 'user') messages.value.pop()
  }

  /** 清空对话 */
  function clear(): void {
    messages.value = []
    error.value = null
    notice.value = null
    currentIdx = -1
    seedGen++ // Y-P2-5：在途种子化响应作废（切书/清空后旧历史不得再种入）
    pendingReseed = null // Q-8：待补种随清空作废（每次切换由随后的 seedHistory 重新登记，防跨书误种）
    // G1：重置分支态 + 复位重新生成进行中标志（清空后旧分支/在途操作不得残留）
    activeBranchId.value = null
    branches.value = []
    regenPending = false
    regenBook = null
  }

  // Q-8：在途回合收尾（running 翻 false）自动补种登记中的书——切书窗口内被 clear
  // 掉的回合届时从服务端历史回填，不再失明。store 常驻（App 级），watch 不卸载。
  watch(running, (v) => {
    if (!v && pendingReseed) {
      const b = pendingReseed
      pendingReseed = null
      void seedHistory(b)
    }
  })

  return {
    messages,
    running,
    error,
    notice,
    hasMessages,
    activeBranchId,
    branches,
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
