/**
 * W3 chat store 单测：事件分派 + 工具卡片状态机 + 历史回合。
 * Y-P2-5：对话历史种子化（空时拉取 / 已有消息不拉取 / 竞态守卫）。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  sendChat: vi.fn(),
  clearChatHistory: vi.fn(),
  confirmTool: vi.fn(),
  fetchChatHistory: vi.fn(),
  fetchChatBranches: vi.fn(),
  regenerateChat: vi.fn(),
}))

import { fetchChatHistory, fetchChatBranches, regenerateChat, type ChatHistoryMessage } from '../../../src/studio/web-next/src/api/chat'
import { useChatStore } from '../../../src/studio/web-next/src/stores/chat'

const fetchMock = fetchChatHistory as ReturnType<typeof vi.fn>
const branchesMock = fetchChatBranches as ReturnType<typeof vi.fn>
const regenMock = regenerateChat as ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // G1：branches 默认空成功（个别用例覆写；防止上个用例的 rejected 残留污染）
  branchesMock.mockResolvedValue({ branches: [], activeBranchId: null })
})

describe('W3: chat store 事件分派', () => {
  it('chat_start → running=true', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    expect(chat.running).toBe(true)
  })

  it('chat_turn + chat_text → 新气泡 + 文本追加', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_text', text: '你好' })
    chat.dispatch({ type: 'chat_text', text: '世界' })
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0]!.content).toBe('你好世界')
    expect(chat.messages[0]!.role).toBe('assistant')
  })

  it('第二个 chat_turn → 新气泡（不拼接到旧气泡）', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_text', text: '第一轮' })
    chat.dispatch({ type: 'chat_turn', turn: 1 })
    chat.dispatch({ type: 'chat_text', text: '第二轮' })
    expect(chat.messages).toHaveLength(2)
    expect(chat.messages[0]!.content).toBe('第一轮')
    expect(chat.messages[1]!.content).toBe('第二轮')
  })

  it('chat_reset → 只清当前回合文本', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_text', text: '旧的' })
    chat.dispatch({ type: 'chat_reset' })
    expect(chat.messages[0]!.content).toBe('')
  })

  it('chat_done → running=false + 气泡标记 done', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_done' })
    expect(chat.running).toBe(false)
    expect(chat.messages[0]!.done).toBe(true)
  })

  it('chat_error → running=false + error 有值', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_error', error: '出错了' })
    expect(chat.running).toBe(false)
    expect(chat.error).toBe('出错了')
  })

  // R-7（第十六轮）：chat_error 收尾在途气泡（对齐 chat_done 口径）——末气泡 done + currentIdx 复位
  it('R-7: chat_start → chat_turn → chat_error → 末气泡 done 且后续文本不错位追加', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_text', text: '半截' })
    chat.dispatch({ type: 'chat_error', error: '服务开小差' })
    expect(chat.running).toBe(false)
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0]!.done).toBe(true) // 修复前：气泡永久「生成中」
    // currentIdx 已复位：错误后的迟到 chat_text 不再追加进已收尾气泡
    chat.dispatch({ type: 'chat_text', text: '迟到文本' })
    expect(chat.messages[0]!.content).toBe('半截')
  })

  it('AA-P3-1: notice 事件 → notice 提示（队列丢弃可感知）', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'notice', message: '对话队列已满：已丢弃最旧的排队消息…' })
    expect(chat.notice).toContain('已丢弃最旧的排队消息')
    chat.clear()
    expect(chat.notice).toBeNull()
  })
})

describe('W3: 工具卡片状态流转', () => {
  it('pending → running → ok', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_tool_pending', callId: 'c1', name: 'write_chapter', input: { chapter: 5 } })
    chat.dispatch({ type: 'chat_tool', callId: 'c1', name: 'write_chapter', input: { chapter: 5 } })
    chat.dispatch({ type: 'chat_tool_result', callId: 'c1', summary: '写好了', ok: true })

    const tool = chat.messages[0]!.tools[0]!
    expect(tool.status).toBe('ok')
    expect(tool.summary).toBe('写好了')
  })

  it('pending → failed（ok=false 的 tool_result；R-6 十五轮登记销账：对齐种子化路径口径）', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_tool_pending', callId: 'c2', name: 'write_chapter', input: { chapter: 1 } })
    chat.dispatch({ type: 'chat_tool_result', callId: 'c2', summary: '执行失败', ok: false })

    const tool = chat.messages[0]!.tools[0]!
    // 工具确实执行了且失败 = failed；cancelled 仅保留给「无 tool_result 回填」的兜底
    expect(tool.status).toBe('failed')
  })

  it('readonly 工具不走 pending，直接 tool → result', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    // check_chapter 是 readonly → 只有 chat_tool + chat_tool_result，没有 chat_tool_pending
    chat.dispatch({ type: 'chat_tool', callId: 'c3', name: 'check_chapter', input: { chapter: 1 } })
    chat.dispatch({ type: 'chat_tool_result', callId: 'c3', summary: '全绿', ok: true })

    expect(chat.messages[0]!.tools).toHaveLength(1)
    expect(chat.messages[0]!.tools[0]!.status).toBe('ok')
    expect(chat.messages[0]!.tools[0]!.name).toBe('check_chapter')
  })
})

describe('W3: pushUser + clear', () => {
  it('pushUser 添加用户气泡', () => {
    const chat = useChatStore()
    chat.pushUser('帮我看看第5章')
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0]!.role).toBe('user')
    expect(chat.messages[0]!.content).toBe('帮我看看第5章')
  })

  it('clear 清空全部', () => {
    const chat = useChatStore()
    chat.pushUser('hi')
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_text', text: 'hello' })
    chat.clear()
    expect(chat.messages).toHaveLength(0)
    expect(chat.error).toBeNull()
  })
})

// ── Y-P2-5：历史种子化 ────────────────────────────────

/** 一轮带工具往返的历史投影（后端 GET /chat/history 的响应形状） */
const HISTORY: { messages: ChatHistoryMessage[] } = {
  messages: [
    { role: 'user', content: '帮我看看第 1 章' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我先检查一下。' },
        { type: 'reasoning', text: '思考过程不该显示' },
        { type: 'tool_use', id: 'tu-1', name: 'check_chapter', input: { chapter: 1 } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'tu-1', content: '全绿', isError: false }],
    },
    { role: 'assistant', content: '检查完毕，没有问题。' },
  ],
}

/** 手动决议的 Promise（竞态测试：让 fetch 挂起到指定时机） */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('Y-P2-5: 历史种子化', () => {
  it('messages 为空 → 拉取并种子化（user 文本 / assistant 块 / tool_result 回填卡片 / reasoning 跳过）', async () => {
    fetchMock.mockResolvedValueOnce(HISTORY)
    const chat = useChatStore()
    await chat.seedHistory('书A')
    expect(fetchMock).toHaveBeenCalledWith('书A')
    // tool_result 合成的 user 消息不渲染为气泡 → 4 条投影 = 3 个气泡
    expect(chat.messages).toHaveLength(3)
    expect(chat.messages[0]!.role).toBe('user')
    expect(chat.messages[0]!.content).toBe('帮我看看第 1 章')
    expect(chat.messages[0]!.done).toBe(true)
    expect(chat.messages[1]!.role).toBe('assistant')
    expect(chat.messages[1]!.content).toBe('我先检查一下。') // reasoning 不入内容
    expect(chat.messages[1]!.tools).toHaveLength(1)
    expect(chat.messages[1]!.tools[0]).toMatchObject({
      callId: 'tu-1',
      name: 'check_chapter',
      input: { chapter: 1 },
      status: 'ok',
      summary: '全绿',
    })
    expect(chat.messages[2]!.content).toBe('检查完毕，没有问题。')
  })

  it('tool_result isError → 卡片标 failed', async () => {
    fetchMock.mockResolvedValueOnce({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu-9', name: 'write_chapter', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: 'tu-9', content: '写失败', isError: true }],
        },
      ],
    })
    const chat = useChatStore()
    await chat.seedHistory('书A')
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0]!.tools[0]!.status).toBe('failed')
    expect(chat.messages[0]!.tools[0]!.summary).toBe('写失败')
  })

  it('已有消息 → 不拉取', async () => {
    const chat = useChatStore()
    chat.pushUser('已经在聊了')
    await chat.seedHistory('书A')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(chat.messages).toHaveLength(1)
  })

  it('正在生成（running）→ 不拉取', async () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    await chat.seedHistory('书A')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('拉取期间 SSE 新消息到达 → 放弃种子化（不插入错位）', async () => {
    const d = deferred<typeof HISTORY>()
    fetchMock.mockReturnValueOnce(d.promise)
    const chat = useChatStore()
    const p = chat.seedHistory('书A')
    // 等待期间 SSE 推来新回合（如后端对话在跑）
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_text', text: '新消息' })
    d.resolve(HISTORY)
    await p
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0]!.content).toBe('新消息') // 只有 SSE 的气泡，历史被放弃
  })

  it('拉取期间切书（clear）→ 旧书历史不再种入', async () => {
    const d = deferred<typeof HISTORY>()
    fetchMock.mockReturnValueOnce(d.promise)
    const chat = useChatStore()
    const p = chat.seedHistory('书A')
    chat.clear() // 切到书B：clear 使在途响应失效
    d.resolve(HISTORY)
    await p
    expect(chat.messages).toHaveLength(0)
  })

  it('拉取失败 → 静默放弃（不抛错，messages 保持空）', async () => {
    fetchMock.mockRejectedValueOnce(new Error('后端未起'))
    const chat = useChatStore()
    await expect(chat.seedHistory('书A')).resolves.toBeUndefined()
    expect(chat.messages).toHaveLength(0)
  })

  it('空历史（messages: []）→ 不种入任何气泡', async () => {
    fetchMock.mockResolvedValueOnce({ messages: [] })
    const chat = useChatStore()
    await chat.seedHistory('书A')
    expect(chat.messages).toHaveLength(0)
  })
})

// ── G1：分支（变体）与重新生成 ────────────────────────

/** 本地构造一轮已完成对话（[user, assistant(done)]，走真实 dispatch 路径） */
function seedLocalTurn(chat: ReturnType<typeof useChatStore>): void {
  chat.pushUser('写第二章')
  chat.dispatch({ type: 'chat_start' })
  chat.dispatch({ type: 'chat_turn', turn: 0 })
  chat.dispatch({ type: 'chat_text', text: '好的，马上写。' })
  chat.dispatch({ type: 'chat_done' })
}

/** 带权威 seqs 的默认分支历史（regenerate 取 parentSeq 的数据源） */
const SEQ_HISTORY: { messages: ChatHistoryMessage[]; seqs: number[][]; branchId: string } = {
  messages: [
    { role: 'user', content: '写第二章' },
    { role: 'assistant', content: '好的，马上写。' },
  ],
  seqs: [[10], [11]],
  branchId: 'b1',
}

/** 分支 b2 的历史（带工具回合——验证切换复用种子化路径，tool_result 回填不分叉） */
const BRANCH2_HISTORY: { messages: ChatHistoryMessage[]; seqs: number[][]; branchId: string } = {
  messages: [
    { role: 'user', content: '换一版' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我先机检。' },
        { type: 'tool_use', id: 'tu-7', name: 'check_chapter', input: { chapter: 2 } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'tu-7', content: '全绿', isError: false }],
    },
    { role: 'assistant', content: '变体二完成。' },
  ],
  seqs: [[20], [21], [22, 23], [24]],
  branchId: 'b2',
}

describe('G1: regenerate 重新生成', () => {
  it('正常路径：fetch 权威历史 → POST(parentSeq+新 branchId) → 截断到 user + activeBranchId=新 id', async () => {
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    regenMock.mockResolvedValueOnce({ ok: true })
    const chat = useChatStore()
    seedLocalTurn(chat)
    await chat.regenerate('书A', 5)
    expect(regenMock).toHaveBeenCalledTimes(1)
    const [name, body] = regenMock.mock.calls[0] as [
      string,
      { parentSeq: number; branchId: string; chapter?: number },
    ]
    expect(name).toBe('书A')
    expect(body.parentSeq).toBe(10) // 最后一条真实 user 的事件 seq
    expect(typeof body.branchId).toBe('string')
    expect(body.branchId).not.toBe('b1') // 每次重新生成传新 branchId
    expect(body.chapter).toBe(5)
    // 截断：user 保留、其后旧 assistant 全删；activeBranchId = 新 branchId
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0]!.role).toBe('user')
    expect(chat.activeBranchId).toBe(body.branchId)
    expect(chat.error).toBeNull()
  })

  it('最后一条是 user → 拒绝（不发任何请求）', async () => {
    const chat = useChatStore()
    chat.pushUser('只有用户消息')
    await chat.regenerate('书A')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(regenMock).not.toHaveBeenCalled()
    expect(chat.error).toBeNull()
  })

  it('最后一条 assistant 未 done → 拒绝', async () => {
    const chat = useChatStore()
    chat.pushUser('写')
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.running = false // 隔离变量：只留「未 done」这一个拒绝条件
    await chat.regenerate('书A')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(regenMock).not.toHaveBeenCalled()
  })

  it('running → 拒绝', async () => {
    const chat = useChatStore()
    seedLocalTurn(chat)
    chat.dispatch({ type: 'chat_start' }) // 新回合开跑（steer），最后消息仍是 done 的 assistant
    await chat.regenerate('书A')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(regenMock).not.toHaveBeenCalled()
  })

  it('防重入：进行中二次调用直接返回（只 POST 一次）', async () => {
    const d = deferred<typeof SEQ_HISTORY>()
    fetchMock.mockReturnValueOnce(d.promise)
    const chat = useChatStore()
    seedLocalTurn(chat)
    const p1 = chat.regenerate('书A')
    const p2 = chat.regenerate('书A')
    await p2
    expect(regenMock).not.toHaveBeenCalled()
    d.resolve(SEQ_HISTORY)
    await p1
    expect(regenMock).toHaveBeenCalledTimes(1)
  })

  it('POST 失败 → 置 error 且保留原视图', async () => {
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    regenMock.mockRejectedValueOnce(new Error('服务开小差'))
    const chat = useChatStore()
    seedLocalTurn(chat)
    await chat.regenerate('书A')
    expect(chat.error).toBe('服务开小差')
    expect(chat.messages).toHaveLength(2) // 原视图原样保留
    expect(chat.activeBranchId).toBeNull()
  })

  it('fetch 权威历史失败 → 置 error 且保留原视图', async () => {
    fetchMock.mockRejectedValueOnce(new Error('网络断了'))
    const chat = useChatStore()
    seedLocalTurn(chat)
    await chat.regenerate('书A')
    expect(chat.error).toBe('获取对话历史失败，请稍后重试')
    expect(chat.messages).toHaveLength(2)
    expect(regenMock).not.toHaveBeenCalled()
  })

  it('权威历史无可用 user seq → 拒绝（置 error、不发 POST、保留原视图）', async () => {
    fetchMock.mockResolvedValueOnce({ messages: [{ role: 'assistant', content: '只有回复' }], seqs: [[7]], branchId: null })
    fetchMock.mockResolvedValueOnce({ messages: SEQ_HISTORY.messages, seqs: [] }) // user 消息无 seq
    const chat = useChatStore()
    seedLocalTurn(chat)
    await chat.regenerate('书A') // 无 user 消息
    expect(chat.error).toBe('未找到可重新生成的消息')
    await chat.regenerate('书A') // user 的 seq 缺失
    expect(chat.error).toBe('未找到可重新生成的消息')
    expect(regenMock).not.toHaveBeenCalled()
    expect(chat.messages).toHaveLength(2)
  })

  it('POST 在 SSE 抢先完成后才返回 → 新回复气泡不被截断误删', async () => {
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    const d = deferred<{ ok: boolean }>()
    const posted = deferred<void>() // POST 已发出（快照已拍）的信号
    regenMock.mockImplementationOnce(() => {
      posted.resolve()
      return d.promise
    })
    const chat = useChatStore()
    seedLocalTurn(chat)
    const p = chat.regenerate('书A')
    await posted.promise // 服务端收到请求后才可能回流 SSE
    // POST 未返回，但 SSE 已开跑并快速完成（新气泡已 done）
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 1 })
    chat.dispatch({ type: 'chat_text', text: '新版回复' })
    chat.dispatch({ type: 'chat_done' })
    d.resolve({ ok: true })
    await p
    expect(chat.messages).toHaveLength(2)
    expect(chat.messages[0]!.role).toBe('user')
    expect(chat.messages[1]!.content).toBe('新版回复')
    expect(chat.messages[1]!.done).toBe(true)
  })

  it('AA-P3-8: sync(chatRunning=false) 复位 regenPending 陷阱态——SSE 全断后仍可再次重新生成', async () => {
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    regenMock.mockResolvedValueOnce({ ok: true })
    const chat = useChatStore()
    seedLocalTurn(chat)
    await chat.regenerate('书A') // POST 成功 → handedOff=true → regenPending=true（陷阱态）
    expect(chat.messages).toHaveLength(1) // 已截断到 user
    // SSE 全断且无 chat_done/chat_error → 重连的 sync 快照：后端不在跑
    chat.dispatch({ type: 'sync', chatRunning: false })
    // 复位后允许再次触发：先走完一轮新对话（最后一条 assistant done）
    chat.pushUser('再问一次')
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_text', text: '新回复' })
    chat.dispatch({ type: 'chat_done' })
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    regenMock.mockResolvedValueOnce({ ok: true })
    await chat.regenerate('书A') // 未被 regenPending 永久卡死 → POST 再次发出
    expect(regenMock).toHaveBeenCalledTimes(2)
  })

  it('AA-P3-8 回归: sync(chatRunning=true) 不误复位——回合在途时防重入标志保留', async () => {
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    regenMock.mockResolvedValueOnce({ ok: true })
    const chat = useChatStore()
    seedLocalTurn(chat)
    await chat.regenerate('书A') // regenPending=true, regenBook='书A'
    branchesMock.mockClear()
    // 重连 sync：后端仍在跑那次 regenerate → chatRunning=true → 标志必须保留
    chat.dispatch({ type: 'sync', chatRunning: true })
    // 后续 chat_done 正常复位 + 刷新分支（若 sync 误复位了标志，这里就不会刷新）
    chat.dispatch({ type: 'chat_done' })
    await vi.waitFor(() => expect(branchesMock).toHaveBeenCalledTimes(1))
    expect(regenMock).toHaveBeenCalledTimes(1) // 期间没有第二次 regenerate 被误放行
  })
})

describe('G1: switchBranch 分支切换', () => {
  it('成功 → 整体替换 messages（tool_result 回填不分叉）+ activeBranchId=返回值 + 刷新 branches', async () => {
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    const chat = useChatStore()
    await chat.seedHistory('书A')
    expect(chat.activeBranchId).toBe('b1')

    fetchMock.mockResolvedValueOnce(BRANCH2_HISTORY)
    branchesMock.mockResolvedValueOnce({
      branches: [
        { branchId: 'b1', messageCount: 2, rootSeq: 10, lastSeq: 11, isDefault: false, parentSeq: null },
        { branchId: 'b2', messageCount: 4, rootSeq: 20, lastSeq: 24, isDefault: true, parentSeq: 10 },
      ],
      activeBranchId: 'b2',
    })
    await chat.switchBranch('书A', 'b2')
    expect(fetchMock).toHaveBeenLastCalledWith('书A', 'b2')
    // 整体替换：旧视图 2 气泡 → 新分支 3 气泡（合成 user 不渲染为气泡）
    expect(chat.messages).toHaveLength(3)
    expect(chat.messages[0]!.content).toBe('换一版')
    expect(chat.messages[0]!.seq).toBe(20)
    // 复用种子化路径：tool_result 回填前一条 assistant 的工具卡片
    expect(chat.messages[1]!.tools[0]).toMatchObject({ callId: 'tu-7', status: 'ok', summary: '全绿' })
    expect(chat.messages[2]!.content).toBe('变体二完成。')
    expect(chat.activeBranchId).toBe('b2')
    expect(chat.branches).toHaveLength(2)
  })

  it('返回 branchId=null（线性书）→ activeBranchId 用返回值，不回落传入 id', async () => {
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    const chat = useChatStore()
    await chat.seedHistory('书A')
    fetchMock.mockResolvedValueOnce({ messages: SEQ_HISTORY.messages, seqs: SEQ_HISTORY.seqs, branchId: null })
    await chat.switchBranch('书A', 'bX')
    expect(chat.activeBranchId).toBeNull()
  })

  it('running → 拒绝（不拉取）', async () => {
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    const chat = useChatStore()
    await chat.seedHistory('书A')
    chat.running = true
    await chat.switchBranch('书A', 'b2')
    expect(fetchMock).toHaveBeenCalledTimes(1) // 只有种子化那一次
    expect(chat.messages).toHaveLength(2)
  })

  it('fetch 失败 → 静默保留原视图', async () => {
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    const chat = useChatStore()
    await chat.seedHistory('书A')
    fetchMock.mockRejectedValueOnce(new Error('后端未起'))
    await chat.switchBranch('书A', 'b2')
    expect(chat.messages).toHaveLength(2)
    expect(chat.messages[1]!.content).toBe('好的，马上写。')
    expect(chat.activeBranchId).toBe('b1')
  })

  it('在途切换被 clear 作废 → 旧响应不再替换视图', async () => {
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    const chat = useChatStore()
    await chat.seedHistory('书A')
    const d = deferred<typeof BRANCH2_HISTORY>()
    fetchMock.mockReturnValueOnce(d.promise)
    const p = chat.switchBranch('书A', 'b2')
    chat.clear() // ++seedGen 作废在途切换
    d.resolve(BRANCH2_HISTORY)
    await p
    expect(chat.messages).toHaveLength(0)
    expect(chat.activeBranchId).toBeNull()
  })

  it('在途种子化被切换作废（seedGen 语义）→ 切换后的视图不被旧历史覆盖', async () => {
    const d = deferred<typeof SEQ_HISTORY>()
    fetchMock.mockReturnValueOnce(d.promise) // seedHistory 的拉取挂起
    const chat = useChatStore()
    const sp = chat.seedHistory('书A')
    fetchMock.mockResolvedValueOnce(BRANCH2_HISTORY)
    await chat.switchBranch('书A', 'b2') // ++seedGen 作废在途种子化
    d.resolve(SEQ_HISTORY)
    await sp
    expect(chat.messages).toHaveLength(3) // 仍是 b2 视图，书A 旧历史未种入
    expect(chat.activeBranchId).toBe('b2')
  })
})

describe('G1: seqs 透传与分支态', () => {
  it('种子化带 seqs → 气泡 seq=seqs[i][0]，activeBranchId=history 返回值，branches 落库', async () => {
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    branchesMock.mockResolvedValueOnce({
      branches: [{ branchId: 'b1', messageCount: 2, rootSeq: 10, lastSeq: 11, isDefault: true, parentSeq: null }],
      activeBranchId: 'b1',
    })
    const chat = useChatStore()
    await chat.seedHistory('书A')
    expect(chat.messages[0]!.seq).toBe(10)
    expect(chat.messages[1]!.seq).toBe(11)
    expect(chat.activeBranchId).toBe('b1')
    expect(chat.branches).toHaveLength(1)
  })

  it('branches 拉取失败 → 静默降级（种子化与 activeBranchId 不受影响）', async () => {
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    branchesMock.mockRejectedValueOnce(new Error('后端未起'))
    const chat = useChatStore()
    await chat.seedHistory('书A')
    expect(chat.messages).toHaveLength(2)
    expect(chat.activeBranchId).toBe('b1')
    expect(chat.branches).toHaveLength(0)
  })

  it('clear → 分支态重置（activeBranchId/branches）', async () => {
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    const chat = useChatStore()
    await chat.seedHistory('书A')
    expect(chat.activeBranchId).toBe('b1')
    chat.clear()
    expect(chat.activeBranchId).toBeNull()
    expect(chat.branches).toHaveLength(0)
  })

  it('重新生成回合 chat_done → best-effort 刷新 branches + 新回复经 SSE 落位', async () => {
    fetchMock.mockResolvedValueOnce(SEQ_HISTORY)
    regenMock.mockResolvedValueOnce({ ok: true })
    const chat = useChatStore()
    seedLocalTurn(chat)
    await chat.regenerate('书A')
    expect(chat.messages).toHaveLength(1) // 已截断到 user
    // SSE 接管：新回合回流
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 1 })
    chat.dispatch({ type: 'chat_text', text: '新回复' })
    branchesMock.mockResolvedValueOnce({
      branches: [{ branchId: 'bn', messageCount: 2, rootSeq: 11, lastSeq: 12, isDefault: true, parentSeq: 10 }],
      activeBranchId: 'bn',
    })
    chat.dispatch({ type: 'chat_done' })
    await vi.waitFor(() => expect(chat.branches).toHaveLength(1))
    expect(chat.messages).toHaveLength(2) // user + SSE 新气泡
    expect(chat.messages[1]!.done).toBe(true)
    expect(chat.running).toBe(false)
  })
})

// Q-8（第十五轮）：切书窗口内 B 书在途回合——气泡先建后被 clear() 抹掉，seedHistory
// 被 running 守卫直接放弃（修复前）→ 该回合 UI 全程失明。修复：running 中登记
// pendingReseed，回合收尾（running 翻 false）自动补种。
describe('Q-8：clear 后遇 running 登记 pending，回合收尾自动补种', () => {
  it('chat_done（running 翻 false）后自动从服务端补种历史', async () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_text', text: '在途回合的流式内容' })
    expect(chat.messages).toHaveLength(1)

    // 切书流程：clear() 抹掉在途气泡 → seedHistory 在 running 中（修复前直接 return 丢掉）
    chat.clear()
    expect(chat.messages).toHaveLength(0)
    fetchMock.mockResolvedValueOnce(HISTORY)
    await chat.seedHistory('书B')
    expect(fetchMock).not.toHaveBeenCalled() // running 中不发请求，只登记 pending

    // 回合收尾 → watch 自动补种
    chat.dispatch({ type: 'chat_done' })
    await vi.waitFor(() => expect(chat.messages.length).toBeGreaterThan(0))
    expect(fetchMock).toHaveBeenCalledWith('书B')
    expect(chat.running).toBe(false)
  })

  it('对照：clear() 重置 pending——补种不跨书误种', async () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.clear()
    fetchMock.mockResolvedValueOnce(HISTORY)
    await chat.seedHistory('书B') // 登记 pending=书B
    chat.clear() // 再切书：pending 作废
    chat.dispatch({ type: 'chat_done' })
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchMock).not.toHaveBeenCalled() // 不再自动种书B
  })
})

// ── C3（内存闸 2026-08-24 审计）：工具入参落存截断 ─────────────────
// 整章正文级 tool input 原样常驻 store（只限消息条数不限体积）→ 落存前统一截到
// 2000 码位 + … 尾标；SSE 与历史种子化两条路径同口径。

describe('C3: 工具入参超长截断（2000 码位 + … 尾标）', () => {
  const LONG = '雪'.repeat(2500) // 整章正文级超长入参（BMP 字符）
  const CLIPPED = '雪'.repeat(2000) + '…'

  // 队列净化：Q-8「对照」用例按设计排了 mockResolvedValueOnce(HISTORY) 却断言不发请求
  // （Once 队列残留，clearAllMocks 只清调用记录不清实现）——本组先 mockReset 清空
  // 共享 Once 队列再各自排桩，保证种子化用例拿到本组载荷而非残留 HISTORY。
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('SSE 路径：chat_tool_pending / readonly chat_tool 的超长 input 落存前截断，短入参原样', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    // pending 路径（整章正文字符串入参）
    chat.dispatch({ type: 'chat_tool_pending', callId: 'c1', name: 'write_chapter', input: LONG })
    expect(chat.messages[0]!.tools[0]!.input).toBe(CLIPPED)
    // readonly 路径（对象入参内嵌超长正文 → 序列化超限同样截断为字符串）
    chat.dispatch({ type: 'chat_tool', callId: 'c2', name: 'check_chapter', input: { chapter: 1, text: LONG } })
    const obj = chat.messages[0]!.tools[1]!.input as string
    expect(typeof obj).toBe('string')
    expect(obj.endsWith('…')).toBe(true)
    // 短入参不误伤：小对象原形落存（既有展示/断言口径不变）
    chat.dispatch({ type: 'chat_tool', callId: 'c3', name: 'check_chapter', input: { chapter: 1 } })
    expect(chat.messages[0]!.tools[2]!.input).toEqual({ chapter: 1 })
  })

  it('码位安全：增补平面字符（代理对）不被切半——截断点在码位边界', () => {
    const emoji = '\u{20BB7}' // 佢：增补平面，一个码位 = 高低两个代理项
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    chat.dispatch({ type: 'chat_tool_pending', callId: 'c1', name: 'write_chapter', input: emoji.repeat(2500) })
    const clipped = chat.messages[0]!.tools[0]!.input as string
    // 2000 个完整码位 + …（若按 UTF-16 码元 slice 会得到 1000 对 + 半个高代理项）
    expect(clipped).toBe(emoji.repeat(2000) + '…')
    // 落存串无孤立代理项（首尾都不在代理对中间切断）
    expect(Array.from(clipped)).toHaveLength(2001)
  })

  it('种子化路径：历史 tool_use 的超长 input 落存前截断（与 SSE 同口径）', async () => {
    fetchMock.mockResolvedValueOnce({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu-1', name: 'write_chapter', input: LONG }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: 'tu-1', content: '写好了', isError: false }],
        },
      ],
    })
    const chat = useChatStore()
    await chat.seedHistory('书A')
    const tool = chat.messages[0]!.tools[0]!
    expect(tool.input).toBe(CLIPPED)
    expect(tool.status).toBe('ok') // 截断不影响 tool_result 回填状态机
  })

  it('边界：恰好 2000 码位不截断、不加尾标', () => {
    const chat = useChatStore()
    chat.dispatch({ type: 'chat_start' })
    chat.dispatch({ type: 'chat_turn', turn: 0 })
    const exact = '风'.repeat(2000)
    chat.dispatch({ type: 'chat_tool_pending', callId: 'c1', name: 'write_chapter', input: exact })
    expect(chat.messages[0]!.tools[0]!.input).toBe(exact)
  })
})
