/**
 * @vitest-environment happy-dom
 *
 * 0918独立重评修复批（E001）回归：SSE 重连回放 chat 腿事件的幂等重建（rebuild 模式）。
 *
 * 跨端契约：服务端在 chat 腿活跃且 ring 非空时，对每个新连接消费者在回放数组最前发一次
 * chat_replay_begin（无载荷），随后重放 chat 腿 ring（chat_turn/chat_text/...，可能从头
 * 重建整回合；ring 截断时回合展示不全）。修复前 chat_turn 无条件 push 新气泡 → 重连回放
 * 产出重复气泡 + 孤儿气泡；修复后 chat_replay_begin 移除未 done 的 assistant 在途气泡
 * （保留 done 历史与 user 消息）+ currentIdx=-1 + 登记 pendingReseed（R70-30/Q-8 既有
 * 自愈通道：chat_done/chat_error 后 running 翻 false 触发 seedHistory(replace:true) 从
 * 事件库重播种）。重连后视图状态 = 等价新连接。
 *
 * 时序注：真实 SSE 事件各自独立任务（watcher 在事件间 flush）——测试以 nextTick 泵
 * 复刻该时序；同步连发会让 Vue watch 批处理塌缩成一次回调，与真实事件流不符。
 * harness 对齐 chat-store.test.ts（pinia + api/chat mock）。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'

vi.mock('../../../src/studio/web-next/src/api/chat', () => ({
  sendChat: vi.fn(),
  clearChatHistory: vi.fn(),
  confirmTool: vi.fn(),
  fetchChatHistory: vi.fn(),
  fetchChatBranches: vi.fn(),
  regenerateChat: vi.fn(),
}))

import { fetchChatHistory, fetchChatBranches } from '../../../src/studio/web-next/src/api/chat'
import { useChatStore } from '../../../src/studio/web-next/src/stores/chat'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'

const fetchMock = fetchChatHistory as ReturnType<typeof vi.fn>
const branchesMock = fetchChatBranches as ReturnType<typeof vi.fn>

/** 重播种的权威历史（断连回合的完整结果，事件库投影形态） */
const RESEED_HISTORY = {
  messages: [
    { role: 'user', content: '问一' },
    { role: 'assistant', content: '答一' },
    { role: 'user', content: '问二' },
    { role: 'assistant', content: '回放重建的完整回复' },
  ],
  seqs: [[1], [2], [3], [4]],
  branchId: null,
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  branchesMock.mockResolvedValue({ branches: [], activeBranchId: null })
  useWorkspaceStore().bookName = '书A' // chat.ts wsBookName() 的数据源（sync/replay 不带书名）
})

/** 断连前状态：一轮 done 历史 + user 新问 + 在途半截气泡（4 条消息） */
async function seedPreDisconnect(chat: ReturnType<typeof useChatStore>): Promise<void> {
  chat.pushUser('问一')
  chat.dispatch({ type: 'chat_start' })
  await nextTick()
  chat.dispatch({ type: 'chat_turn' })
  chat.dispatch({ type: 'chat_text', text: '答一' })
  chat.dispatch({ type: 'chat_done' })
  await nextTick()
  chat.pushUser('问二')
  chat.dispatch({ type: 'chat_start' })
  await nextTick()
  chat.dispatch({ type: 'chat_turn' })
  chat.dispatch({ type: 'chat_text', text: '断连前半截' })
  await nextTick()
}

describe('E001: chat_replay_begin 重连回放重建', () => {
  it('①完整回放：在途气泡先移除 → 回放重建单气泡无重复 → chat_done 后经 pendingReseed 重播种', async () => {
    const chat = useChatStore()
    await seedPreDisconnect(chat)
    expect(chat.messages).toHaveLength(4)
    expect(chat.messages[3]!.done).toBe(false)

    // 重连序列：sync(chatRunning=true) → chat_replay_begin → ring 回放（各自独立任务）
    chat.dispatch({ type: 'sync', chatRunning: true })
    await nextTick()
    chat.dispatch({ type: 'chat_replay_begin' })
    await nextTick()
    // 修复点：未 done 的在途气泡被移除；done 历史与 user 消息保留
    expect(chat.messages).toHaveLength(3)
    expect(chat.messages.map((m) => m.content)).toEqual(['问一', '答一', '问二'])

    // 回放 ring 从头重建整回合：chat_turn 不再产生重复气泡（旧的已在 replay_begin 移除）
    chat.dispatch({ type: 'chat_turn' })
    chat.dispatch({ type: 'chat_text', text: '回放重建的完整回复' })
    // mock 须先于收尾登记：running 翻 false 的 watch 在收尾任务即触发补种拉取
    fetchMock.mockResolvedValueOnce(RESEED_HISTORY)
    chat.dispatch({ type: 'chat_done' })
    await nextTick()
    expect(chat.messages).toHaveLength(4) // 单气泡、无重复
    expect(chat.messages[3]!.content).toBe('回放重建的完整回复')
    expect(chat.messages[3]!.done).toBe(true)
    expect(chat.running).toBe(false)

    // 重播种：chat_done 后 running 翻 false → pendingReseed watch → seedHistory(replace:true)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith('书A')
    // 重播种以事件库权威历史替换视图（与刷新路径同口径）
    await vi.waitFor(() => expect(chat.messages).toHaveLength(4))
    expect(chat.messages[3]!.content).toBe('回放重建的完整回复')
    expect(chat.messages.every((m) => m.done)).toBe(true)
  })

  it('②ring 截断：replay_begin 后无 chat_turn 直接 chat_text/chat_done → 无新气泡无崩溃，重播种恢复完整历史', async () => {
    const chat = useChatStore()
    await seedPreDisconnect(chat)

    chat.dispatch({ type: 'sync', chatRunning: true })
    await nextTick()
    chat.dispatch({ type: 'chat_replay_begin' })
    await nextTick()
    expect(chat.messages).toHaveLength(3) // 在途半截气泡已移除

    // ring 截断形态：无 chat_turn（currentIdx=-1）直接 chat_text——无处追加，静默丢弃不崩溃
    expect(() => chat.dispatch({ type: 'chat_text', text: '孤儿增量' })).not.toThrow()
    expect(chat.messages).toHaveLength(3) // 无新气泡
    expect(chat.messages[2]!.content).toBe('问二')

    // mock 须先于收尾登记：running 翻 false 的 watch 在收尾任务即触发补种拉取
    fetchMock.mockResolvedValueOnce({
      messages: [
        { role: 'user', content: '问一' },
        { role: 'assistant', content: '答一' },
        { role: 'user', content: '问二' },
        { role: 'assistant', content: '完整回复（事件库权威）' },
      ],
      seqs: [[1], [2], [3], [4]],
      branchId: null,
    })
    chat.dispatch({ type: 'chat_done' })
    await nextTick()
    expect(chat.running).toBe(false)

    // 重播种自愈：截断导致的展示不全从事件库恢复完整历史
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(chat.messages).toHaveLength(4))
    expect(chat.messages[3]!.content).toBe('完整回复（事件库权威）')
  })

  it('③无在途气泡时 replay_begin 为 no-op（新消费者首连形态），消息零扰动', async () => {
    const chat = useChatStore()
    chat.pushUser('历史问')
    chat.dispatch({ type: 'chat_start' })
    await nextTick()
    chat.dispatch({ type: 'chat_turn' })
    chat.dispatch({ type: 'chat_text', text: '历史答' })
    chat.dispatch({ type: 'chat_done' })
    await nextTick()

    chat.dispatch({ type: 'sync', chatRunning: true })
    await nextTick()
    chat.dispatch({ type: 'chat_replay_begin' })
    await nextTick()
    expect(chat.messages).toHaveLength(2) // done 历史与 user 消息原样保留
    expect(chat.messages.every((m) => m.done || m.role === 'user')).toBe(true)
  })

  it('④chat_error 收尾同样触发重播种（replay 重建的回合异常中断自愈同口径）', async () => {
    const chat = useChatStore()
    await seedPreDisconnect(chat)
    chat.dispatch({ type: 'sync', chatRunning: true })
    await nextTick()
    chat.dispatch({ type: 'chat_replay_begin' })
    await nextTick()
    chat.dispatch({ type: 'chat_turn' })
    chat.dispatch({ type: 'chat_text', text: '回放重建半截' })
    // mock 须先于收尾登记：running 翻 false 的 watch 在收尾任务即触发补种拉取
    fetchMock.mockResolvedValueOnce(RESEED_HISTORY)
    chat.dispatch({ type: 'chat_error', error: '服务开小差' })
    await nextTick()
    expect(chat.running).toBe(false)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(chat.messages).toHaveLength(4))
  })

  it('⑤workbench 侧守卫：chat_replay_begin 对 workbench dispatch 是 no-op（不入日志、不动状态）', () => {
    const wb = useWorkbenchStore()
    wb.dispatch({ type: 'role_spawn' }) // 造 running=true 基线
    expect(wb.running).toBe(true)
    expect(() => wb.dispatch({ type: 'chat_replay_begin' })).not.toThrow()
    // 不入事件日志（WORKBENCH_LOG_TYPES 白名单外）、不复位写手腿 running
    expect(wb.log).toHaveLength(1)
    expect(wb.running).toBe(true)
  })
})
