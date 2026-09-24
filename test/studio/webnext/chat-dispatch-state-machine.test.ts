/**
 * RC 源码重审 B-5（Opus-5.5 轮）单测：对话 SSE 事件分发状态机
 * （src/studio/web-next/src/stores/chat-dispatch.ts）。
 *
 * 被测行为 = 抽出的状态机本身，不经 pinia/store 外壳：chat_* 事件的每个分支对
 * 消息列表、在途气泡索引、工具卡片、回合收尾标志的读写，以及 chat_turn/chat_done
 * 触发的裁尾。抽取前这些支路只能经 useChatStore 间接行使（chat-store.test.ts 走
 * store 面），本文件按「状态机 + 注入依赖」直接构造，钉住逐位语义（含沿革注释所述
 * 的 R-7/R-6/P2-9/AA-P3-8/R70-30/Q-8/AA-P3-1 各条口径）。
 *
 * 直测口径不替代既有 store 面回归（chat-store / chat-replay-rebuild / f6-regenbook 等
 * 仍全绿），是抽取后新增的针对性守护：状态机自身的行为面。
 */
import { describe, expect, it, vi } from 'vitest'
import { ref, toRaw } from 'vue'
import {
  createChatDispatch,
  createChatTurnState,
  type ChatMessage,
} from '../../../src/studio/web-next/src/stores/chat-dispatch'
import { CHAT_HISTORY_LIMIT } from '../../../src/studio/web-next/src/shared/chat-history'

/** 状态机装配：真实 ref/回合状态 + 桩回调（零 pinia，直测状态机本体）。 */
function setup(over?: { bookName?: string | null; gen?: number }) {
  const messages = ref<ChatMessage[]>([])
  const running = ref(false)
  const error = ref<string | null>(null)
  const errorEcho = ref<string | null>(null)
  const notice = ref<string | null>(null)
  const turn = createChatTurnState()
  const wsBookName = vi.fn((): string | null => over?.bookName === undefined ? '书A' : over.bookName)
  const refreshBranches = vi.fn()
  const currentGen = vi.fn(() => over?.gen ?? 7)
  const d = createChatDispatch({
    messages,
    running,
    error,
    errorEcho,
    notice,
    turn,
    wsBookName,
    refreshBranches,
    currentGen,
  })
  return { d, messages, running, error, errorEcho, notice, turn, wsBookName, refreshBranches, currentGen }
}

describe('RC B-5: chat 事件分发状态机——回合开跑与文本流', () => {
  it('chat_start → running=true 且清 error/errorEcho/notice（三清口径）', () => {
    const s = setup()
    s.error.value = '上次的错误'
    s.errorEcho.value = '上次的原文'
    s.notice.value = '上次的提示'
    s.d.dispatch({ type: 'chat_start' })
    expect(s.running.value).toBe(true)
    expect(s.error.value).toBeNull()
    expect(s.errorEcho.value).toBeNull()
    expect(s.notice.value).toBeNull()
  })

  it('chat_turn → 新 assistant 气泡且索引指向它；chat_text 追加到该气泡', () => {
    const s = setup()
    s.d.dispatch({ type: 'chat_start' })
    s.d.dispatch({ type: 'chat_turn' })
    expect(s.messages.value).toHaveLength(1)
    expect(s.messages.value[0]).toMatchObject({ role: 'assistant', content: '', done: false, tools: [] })
    expect(s.turn.currentIdx).toBe(0)
    s.d.dispatch({ type: 'chat_text', text: '你好' })
    s.d.dispatch({ type: 'chat_text', text: '世界' })
    expect(s.messages.value[0]!.content).toBe('你好世界')
  })

  it('chat_text 无在途气泡（索引 -1）→ 静默丢弃不抛错；非字符串 text 同样丢弃', () => {
    const s = setup()
    expect(() => s.d.dispatch({ type: 'chat_text', text: '孤儿增量' })).not.toThrow()
    expect(s.messages.value).toHaveLength(0)
    s.d.dispatch({ type: 'chat_turn' })
    s.d.dispatch({ type: 'chat_text', text: 123 })
    expect(s.messages.value[0]!.content).toBe('')
  })

  it('消息 id 稳定唯一（前缀 m + 自增序列，同一状态机内不重复）', () => {
    const s = setup()
    for (let i = 0; i < 3; i++) s.d.dispatch({ type: 'chat_turn' })
    const ids = s.messages.value.map((m) => m.id)
    expect(new Set(ids).size).toBe(3)
    expect(ids.every((id) => /^m\d+$/.test(id))).toBe(true)
  })
})

describe('RC B-5: chat 事件分发状态机——工具卡片状态机', () => {
  it('chat_tool_pending → pending 卡片入当前气泡（无在途气泡则丢弃）', () => {
    const s = setup()
    s.d.dispatch({ type: 'chat_tool_pending', callId: 'c1', name: 'write_chapter', input: { chapter: 5 } })
    expect(s.messages.value).toHaveLength(0) // 无在途气泡：不建卡
    s.d.dispatch({ type: 'chat_turn' })
    s.d.dispatch({ type: 'chat_tool_pending', callId: 'c1', name: 'write_chapter', input: { chapter: 5 } })
    expect(s.messages.value[0]!.tools).toEqual([
      { callId: 'c1', name: 'write_chapter', input: { chapter: 5 }, status: 'pending' },
    ])
    // 字段缺失（callId/name 非字符串）→ 不入卡
    s.d.dispatch({ type: 'chat_tool_pending', name: 'write_chapter' })
    expect(s.messages.value[0]!.tools).toHaveLength(1)
  })

  it('chat_tool（readonly 直通）→ 补建卡片并置 running；已存在同 callId 不重复建卡', () => {
    const s = setup()
    s.d.dispatch({ type: 'chat_turn' })
    s.d.dispatch({ type: 'chat_tool', callId: 'c9', name: 'check_chapter', input: { chapter: 1 } })
    expect(s.messages.value[0]!.tools).toEqual([
      { callId: 'c9', name: 'check_chapter', input: { chapter: 1 }, status: 'running' },
    ])
    s.d.dispatch({ type: 'chat_tool', callId: 'c9', name: 'check_chapter', input: { chapter: 1 } })
    expect(s.messages.value[0]!.tools).toHaveLength(1) // ensureTool 幂等
  })

  it('chat_tool_result → ok/failed 按 ok 字段判定；summary 仅非空字符串写入', () => {
    const s = setup()
    s.d.dispatch({ type: 'chat_turn' })
    s.d.dispatch({ type: 'chat_tool', callId: 'c1', name: 'write_chapter', input: {} })
    s.d.dispatch({ type: 'chat_tool_result', callId: 'c1', summary: '写好了', ok: true })
    expect(s.messages.value[0]!.tools[0]).toMatchObject({ status: 'ok', summary: '写好了' })
    s.d.dispatch({ type: 'chat_tool', callId: 'c2', name: 'write_chapter', input: {} })
    s.d.dispatch({ type: 'chat_tool_result', callId: 'c2', ok: false })
    // R-6：ok !== true 即 failed（cancelled 只留给「无 tool_result 回填」的兜底语义）
    expect(s.messages.value[0]!.tools[1]).toMatchObject({ status: 'failed' })
    expect(s.messages.value[0]!.tools[1]!.summary).toBeUndefined() // 空 summary 不写字段
  })

  it('updateTool 反向命中最近同 callId 卡（R62-19：callId 跨回合重复不串卡）', () => {
    const s = setup()
    s.d.dispatch({ type: 'chat_turn' })
    s.d.dispatch({ type: 'chat_tool', callId: 'dup', name: 'check_chapter', input: {} })
    s.d.dispatch({ type: 'chat_done' })
    s.d.dispatch({ type: 'chat_turn' })
    s.d.dispatch({ type: 'chat_tool', callId: 'dup', name: 'check_chapter', input: {} })
    s.d.dispatch({ type: 'chat_tool_result', callId: 'dup', summary: '第二轮', ok: true })
    expect(s.messages.value[0]!.tools[0]!.status).toBe('running') // 旧回合卡不动
    expect(s.messages.value[1]!.tools[0]).toMatchObject({ status: 'ok', summary: '第二轮' })
  })

  it('工具入参落存截断（C3 内存闸：超 2000 码位的串截断 + …；未超限原样透传）', () => {
    const s = setup()
    s.d.dispatch({ type: 'chat_turn' })
    const long = '甲'.repeat(2500)
    s.d.dispatch({ type: 'chat_tool_pending', callId: 'big', name: 'write_chapter', input: long })
    const clipped = s.messages.value[0]!.tools[0]!.input as string
    expect(clipped).toHaveLength(2001) // 2000 码位 + … 尾标
    expect(clipped.endsWith('…')).toBe(true)
    s.d.dispatch({ type: 'chat_tool_pending', callId: 'small', name: 'write_chapter', input: '短正文' })
    expect(s.messages.value[0]!.tools[1]!.input).toBe('短正文')
  })

  it('对象入参截断保结构（P2-3 收口）：长文本字段截断、键保留——摘要不因截断整条落空', () => {
    const s = setup()
    s.d.dispatch({ type: 'chat_turn' })
    s.d.dispatch({
      type: 'chat_tool_pending',
      callId: 'obj',
      name: 'rewrite_selection',
      input: { chapter: 12, instruction: '甲'.repeat(2500) },
    })
    const input = s.messages.value[0]!.tools[0]!.input as Record<string, unknown>
    expect(input['chapter']).toBe(12) // 结构字段原样：摘要靠它解析章名
    const instruction = String(input['instruction'])
    expect(instruction.endsWith('…')).toBe(true)
    expect(Array.from(instruction).length).toBeLessThanOrEqual(1001) // 2 键 → 额度均分 1000 + 尾标
  })

  it('对象入参未超限 → 原形落存（对象身份不变，不动既有展示与断言口径）', () => {
    const s = setup()
    s.d.dispatch({ type: 'chat_turn' })
    const small = { chapter: 5, newTitle: '雪落无声' }
    s.d.dispatch({ type: 'chat_tool_pending', callId: 'smallobj', name: 'rename_chapter', input: small })
    // toRaw：messages 是 ref，读回的是响应式代理——比对底层对象身份即「原样落存」
    expect(toRaw(s.messages.value[0]!.tools[0]!.input)).toBe(small)
  })

  it('字段级后仍超闸（嵌套大值）与不可序列化 → 退回整串截断 / 原样透传，闸恒为准', () => {
    const s = setup()
    s.d.dispatch({ type: 'chat_turn' })
    s.d.dispatch({
      type: 'chat_tool_pending',
      callId: 'nest',
      name: 'write_chapter',
      input: { chapter: 1, list: Array.from({ length: 40 }, () => '乙'.repeat(100)) },
    })
    const nested = s.messages.value[0]!.tools[0]!.input
    expect(typeof nested).toBe('string') // 无字符串字段可截 → 整串截断分支
    expect((nested as string).endsWith('…')).toBe(true)
    expect(Array.from(nested as string).length).toBeLessThanOrEqual(2001)

    const cyclic: Record<string, unknown> = { chapter: 1 }
    cyclic['self'] = cyclic
    s.d.dispatch({ type: 'chat_tool_pending', callId: 'cyclic', name: 'write_chapter', input: cyclic })
    expect(toRaw(s.messages.value[0]!.tools[1]!.input)).toBe(cyclic) // 不为此抛错
  })

  it('chat_reset → 清当前回合文本与工具卡片（旧结果不残留），不影响在途标志', () => {
    const s = setup()
    s.d.dispatch({ type: 'chat_turn' })
    s.d.dispatch({ type: 'chat_text', text: '半截输出' })
    s.d.dispatch({ type: 'chat_tool', callId: 'c1', name: 'check_chapter', input: {} })
    s.d.dispatch({ type: 'chat_reset' })
    expect(s.messages.value[0]).toMatchObject({ content: '', tools: [] })
    expect(s.turn.currentIdx).toBe(0) // 气泡仍在途，索引不动
  })
})

describe('RC B-5: chat 事件分发状态机——回合收尾', () => {
  it('chat_done → running=false、在途气泡置 done、索引失效（P2-9）', () => {
    const s = setup()
    s.d.dispatch({ type: 'chat_start' })
    s.d.dispatch({ type: 'chat_turn' })
    s.d.dispatch({ type: 'chat_text', text: '完整回复' })
    s.d.dispatch({ type: 'chat_done' })
    expect(s.running.value).toBe(false)
    expect(s.messages.value[0]!.done).toBe(true)
    expect(s.turn.currentIdx).toBe(-1) // 回合结束即失效索引
  })

  it('chat_done 复位 regenPending 并用 regenBook + 现行代刷分支列表（无 pending 不刷）', () => {
    const s = setup({ gen: 11 })
    s.d.dispatch({ type: 'chat_done' })
    expect(s.refreshBranches).not.toHaveBeenCalled() // 非 regenerate 回合：不刷
    s.turn.regenPending = true
    s.turn.regenBook = '书B'
    s.d.dispatch({ type: 'chat_done' })
    expect(s.turn.regenPending).toBe(false)
    expect(s.turn.regenBook).toBeNull()
    expect(s.refreshBranches).toHaveBeenCalledWith('书B', 11)
  })

  it('chat_error → running=false、error 兜底「未知错误」、echo 回显、notice 清、在途气泡收尾', () => {
    const s = setup()
    s.d.dispatch({ type: 'chat_start' })
    s.d.dispatch({ type: 'chat_turn' })
    s.d.dispatch({ type: 'chat_error', error: '服务开小差', echo: '作者原文' })
    expect(s.running.value).toBe(false)
    expect(s.error.value).toBe('服务开小差')
    expect(s.errorEcho.value).toBe('作者原文')
    expect(s.messages.value[0]!.done).toBe(true) // R-7：异常中断同样收尾在途气泡
    expect(s.turn.currentIdx).toBe(-1)
    s.notice.value = '已入队'
    s.d.dispatch({ type: 'chat_error' })
    expect(s.error.value).toBe('未知错误') // 缺 error 字段
    expect(s.errorEcho.value).toBeNull()
    expect(s.notice.value).toBeNull() // E005：error 与 notice 双清
  })

  it('chat_error 复位 regenerate 防重入标志（可再次触发）', () => {
    const s = setup()
    s.turn.regenPending = true
    s.turn.regenBook = '书A'
    s.d.dispatch({ type: 'chat_error', error: '失败' })
    expect(s.turn.regenPending).toBe(false)
    expect(s.turn.regenBook).toBeNull()
  })

  it('notice → 非空才写（空串/非字符串忽略）', () => {
    const s = setup()
    s.d.dispatch({ type: 'notice', message: '消息已入队，当前对话结束后处理' })
    expect(s.notice.value).toBe('消息已入队，当前对话结束后处理')
    s.notice.value = '旧提示'
    s.d.dispatch({ type: 'notice', message: '' })
    expect(s.notice.value).toBe('旧提示')
  })

  it('未知事件类型 → no-op（不抛错、不动状态）', () => {
    const s = setup()
    expect(() => s.d.dispatch({ type: 'chat_unknown_type' })).not.toThrow()
    expect(s.messages.value).toHaveLength(0)
    expect(s.running.value).toBe(false)
  })
})

describe('RC B-5: chat 事件分发状态机——sync/回放重连自愈', () => {
  it('sync chatRunning=false → 收尾在途气泡并复位索引（重评2-P2-1）', () => {
    const s = setup()
    s.d.dispatch({ type: 'chat_start' })
    s.d.dispatch({ type: 'chat_turn' })
    s.d.dispatch({ type: 'sync', chatRunning: false })
    expect(s.running.value).toBe(false)
    expect(s.messages.value[0]!.done).toBe(true)
    expect(s.turn.currentIdx).toBe(-1)
  })

  it('sync chatRunning=false → 复位 regenPending 陷阱态（AA-P3-8：防永久锁死重新生成）', () => {
    const s = setup()
    s.turn.regenPending = true
    s.turn.regenBook = '书A'
    s.d.dispatch({ type: 'sync', chatRunning: false })
    expect(s.turn.regenPending).toBe(false)
    expect(s.turn.regenBook).toBeNull()
  })

  it('sync chatRunning=true + 无可续气泡 → 索引落 -1 并登记 pendingReseed（R70-30）', () => {
    const s = setup({ bookName: '书A' })
    s.messages.value.push({ id: 'u1', role: 'user', content: '问', done: true, tools: [] })
    s.d.dispatch({ type: 'sync', chatRunning: true })
    expect(s.running.value).toBe(true)
    expect(s.turn.currentIdx).toBe(-1)
    expect(s.turn.pendingReseed).toBe('书A')
  })

  it('sync chatRunning=true → 重建索引到最后一条未 done 的 assistant 气泡（P2-9）', () => {
    const s = setup()
    s.messages.value.push(
      { id: 'a0', role: 'assistant', content: '旧完', done: true, tools: [] },
      { id: 'u1', role: 'user', content: '问', done: true, tools: [] },
      { id: 'a1', role: 'assistant', content: '半截', done: false, tools: [] },
    )
    s.d.dispatch({ type: 'sync', chatRunning: true })
    expect(s.turn.currentIdx).toBe(2)
    s.d.dispatch({ type: 'chat_text', text: '续写' })
    expect(s.messages.value[2]!.content).toBe('半截续写') // 追加到正确气泡
    expect(s.turn.pendingReseed).toBeNull() // 有可续气泡：不登记补种
  })

  it('sync chatRunning=true 未取到书名（ws 未载入）→ 不登记 pendingReseed', () => {
    const s = setup({ bookName: null })
    s.d.dispatch({ type: 'sync', chatRunning: true })
    expect(s.turn.pendingReseed).toBeNull()
  })

  it('chat_replay_begin → 移除未 done 的 assistant 在途气泡 + 索引复位 + 登记补种（E001）', () => {
    const s = setup({ bookName: '书B' })
    s.messages.value.push(
      { id: 'a0', role: 'assistant', content: '历史答', done: true, tools: [] },
      { id: 'u1', role: 'user', content: '问', done: true, tools: [] },
      { id: 'a1', role: 'assistant', content: '断连前半截', done: false, tools: [] },
    )
    s.d.dispatch({ type: 'chat_replay_begin' })
    expect(s.messages.value.map((m) => m.id)).toEqual(['a0', 'u1']) // 只删在途气泡
    expect(s.turn.currentIdx).toBe(-1)
    expect(s.turn.pendingReseed).toBe('书B')
  })

  it('chat_replay_begin 无在途气泡 → 仅复位索引与登记（幂等，不误删 done 历史）', () => {
    const s = setup()
    s.messages.value.push({ id: 'a0', role: 'assistant', content: '历史答', done: true, tools: [] })
    s.d.dispatch({ type: 'chat_replay_begin' })
    expect(s.messages.value).toHaveLength(1)
    expect(s.turn.currentIdx).toBe(-1)
  })
})

describe('RC B-5: chat 事件分发状态机——裁尾与索引偏移', () => {
  it('chat_turn 推新气泡即裁尾（E103：单次长跑不无界膨胀），在途气泡恒在尾不受影响', () => {
    const s = setup()
    s.messages.value = Array.from({ length: CHAT_HISTORY_LIMIT }, (_, i) => ({
      id: `old${i}`,
      role: 'assistant' as const,
      content: '历史',
      done: true,
      tools: [],
    }))
    s.d.dispatch({ type: 'chat_turn' })
    expect(s.messages.value).toHaveLength(CHAT_HISTORY_LIMIT)
    expect(s.turn.currentIdx).toBe(CHAT_HISTORY_LIMIT - 1) // 新气泡在尾，索引正确
    s.d.dispatch({ type: 'chat_text', text: '新回合' })
    expect(s.messages.value[s.turn.currentIdx]!.content).toBe('新回合')
  })

  it('裁尾同步偏移在途索引：索引进位前 push 的历史被裁后 currentIdx 落在正确气泡', () => {
    const s = setup()
    s.d.dispatch({ type: 'chat_turn' }) // idx=0（此气泡将被裁掉）
    s.messages.value.push(
      ...Array.from({ length: CHAT_HISTORY_LIMIT }, (_, i) => ({
        id: `pad${i}`,
        role: 'user' as const,
        content: '填充',
        done: true,
        tools: [],
      })),
    )
    s.d.dispatch({ type: 'chat_turn' }) // 触发裁尾：旧在途气泡出列，新气泡在尾
    expect(s.messages.value).toHaveLength(CHAT_HISTORY_LIMIT)
    expect(s.turn.currentIdx).toBe(CHAT_HISTORY_LIMIT - 1)
    expect(s.messages.value[s.turn.currentIdx]!.done).toBe(false)
  })
})
