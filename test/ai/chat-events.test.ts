/**
 * F1-P1 对话助手事件溯源接入集成测试：
 * - 会话落库：事件完整 + 校验链通过 + deriveMessages 恢复与内存一致
 * - 跨重启恢复：清内存（模拟重启）后再次对话，模型收到的历史含上一轮
 * - 压缩走遮蔽：多轮累积触发 trim，库里写 compaction/end replace 遮蔽旧回合
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { runChat, clearChatHistory, getHistory } from '../../src/ai/orchestrate/chat.js'
import { openSessionStore } from '../../src/events/store.js'
import { deriveMessages, validateEventStream } from '../../src/events/projection.js'
import { loadHistoryWithSeqs } from '../../src/events/chat-bridge.js'
import { selectBranch } from '../../src/events/branch-tree.js'
import type { ContentBlock } from '../../src/ai/provider/types.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/types.js'

let fake: FakeProvider
const dirs: string[] = []
let bookRoot: string

beforeAll(async () => {
  fake = await createFakeProvider()
})

afterAll(async () => {
  await fake.close()
})

beforeEach(() => {
  bookRoot = makeDualTrackWorkdir()
  dirs.push(bookRoot)
  delete process.env.CLWRITING_DRIVER
})

afterEach(() => {
  delete process.env.CLWRITING_DRIVER
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(): string {
  const ud = tempUserData()
  dirs.push(ud)
  withFakeProvider(ud, fake.url)
  return ud
}

function makeDriver(emitted: DriverEvent[]): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'mock', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s, ev): void {
      emitted.push(ev)
    },
  }
}

/** 跑一轮对话管线；regenerate 时不传 message（复用已记录 user，与 regenerate 端点同形状）。
 *  返回本轮 emit 的 DriverEvent（失败路径断言 chat_error 用）。 */
async function runOne(
  ud: string,
  bookName: string,
  message: string | undefined,
  extra?: { regenerate?: { parentSeq: number; branchId: string } },
): Promise<DriverEvent[]> {
  const events: DriverEvent[] = []
  await runChat({
    driver: makeDriver(events),
    mainSession: { id: 's1', cwd: bookRoot, closed: false },
    userDataPath: ud,
    bookRoot,
    bookName,
    ...(message !== undefined ? { message } : {}),
    ...extra,
  })
  return events
}

describe('F1-P1 会话落库', () => {
  it('一轮对话后事件完整可重放，校验链通过', async () => {
    fake.setScript([{ type: 'text', content: '第一轮回复。' }])
    const ud = setup()
    await runOne(ud, 'evt-a', '第一轮问题')

    const store = openSessionStore(ud, bookRoot)!;
    const evs = store.listEvents('evt-a')
    store.close()
    // 事件序列：session/start, turn/start, user/message, assistant/message, turn/end, session/end
    const types = evs.map((e) => e.type)
    expect(types).toContain('session/start')
    expect(types).toContain('user/message')
    expect(types).toContain('assistant/message')
    expect(types).toContain('session/end')
    // 校验链通过
    expect(validateEventStream(evs)).toEqual([])
    // 重放恢复出与内存一致的历史
    expect(deriveMessages(evs)).toEqual([
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: '第一轮回复。' },
    ])
  })
})

describe('F1-P1 跨重启恢复', () => {
  it('清内存（模拟重启）后再次对话，模型收到的历史含上一轮', async () => {
    fake.setScript([{ type: 'text', content: '第一轮回复。' }])
    const ud = setup()
    await runOne(ud, 'evt-b', '第一轮问题')

    // 模拟重启：只清内存（不带 userDataPath → 不动库）
    clearChatHistory('evt-b')

    fake.setScript([{ type: 'text', content: '第二轮回复。' }])
    await runOne(ud, 'evt-b', '第二轮问题')

    // 模型收到的 messages 应包含第一轮的 user+assistant（跨重启恢复）。
    // OpenAI 格式首条是 system，历史从 index 1 起为 [user, assistant, ...]
    const body = fake.lastBody() as { messages: Array<{ role: string; content: unknown }> }
    const roles = body.messages.map((m) => m.role)
    expect(roles[1]).toBe('user')
    expect(roles[2]).toBe('assistant')
    expect(body.messages[1]!.content).toBe('第一轮问题')
    expect(body.messages[2]!.content).toBe('第一轮回复。')
    // 最后一条是第二轮 user
    expect(body.messages[body.messages.length - 1]!.content).toBe('第二轮问题')
  })
})

describe('F1-P1 压缩走遮蔽', () => {
  it('多轮累积触发 trim → 库里写 compaction/end replace 遮蔽旧回合', async () => {
    const ud = setup()
    // 11 轮累积 22 条消息 → 超 MAX_HISTORY_TURNS(10)*2=20 → trim 触发。
    // 用户消息带足够细节：checkpoint 存档（前导+标签 ~100 字）须严格小于被压内容才走压缩路
    for (let i = 1; i <= 11; i++) {
      fake.setScript([{ type: 'text', content: '第' + i + '轮回复' }])
      await runOne(ud, 'evt-c', '第' + i + '轮问题' + String.fromCharCode(64 + i) + '细节'.repeat(60))
    }
    const store = openSessionStore(ud, bookRoot)!;
    const evs = store.listEvents('evt-c')
    store.close()
    const compactions = evs.filter((e) => e.type === 'compaction/end' && e.surfaceOp === 'replace')
    expect(compactions.length).toBeGreaterThan(0)
    // 校验链通过（遮蔽区间合法）
    expect(validateEventStream(evs)).toEqual([])
    // 恢复出的历史 = checkpoint 存档（Y-P2-2 事件化后投影带回）+ 最近回合，不含被遮蔽的旧回合
    const msgs = deriveMessages(evs)
    expect(msgs.length).toBeLessThanOrEqual(21)
    // 人类抄本保留：全量 append 事件仍可审计
    const userEvents = evs.filter((e) => e.type === 'user/message')
    expect(userEvents.length).toBeGreaterThanOrEqual(11)
  })
})

describe('Y-P2-2 压缩存档事件化', () => {
  // 足够长的用户消息：保证存档（前导+标签 ~100 字）严格小于被压的回合
  const q = (i: number): string => `第${i}轮问题` + '情节细节'.repeat(40)

  it('存档以 user/message{checkpoint} 入流（sourceSeqs=被压节点）；跨重启恢复带回存档', async () => {
    const ud = setup()
    for (let i = 1; i <= 10; i++) {
      fake.setScript([{ type: 'text', content: '第' + i + '轮回复' }])
      await runOne(ud, 'ckpt-c', q(i))
    }
    fake.setScript([
      { type: 'text', content: '第11轮回复' },
      { type: 'text', content: '1. Primary Request and Intent（作者连续讨论第1-11轮情节）2. Next Step（写第12章）' },
    ])
    await runOne(ud, 'ckpt-c', q(11))

    const store = openSessionStore(ud, bookRoot)!
    const evs = store.listEvents('ckpt-c')
    store.close()
    // 存档并入 compaction/end 载荷（Y-P2-2：replace 原位取代），sourceSeqs 覆盖被遮蔽区间
    const summaries = evs.filter(
      (e) => e.type === 'compaction/end' && typeof e.data['message'] === 'string' && e.surfaceOp === 'replace',
    )
    expect(summaries.length).toBe(1)
    const arc = summaries[0]!
    for (let s = arc.shadowStart!; s <= arc.shadowEnd!; s++) {
      expect(arc.sourceSeqs).toContain(s)
    }
    expect(validateEventStream(evs)).toEqual([])

    // 模拟重启：清内存（不带 ud → 库不动），投影恢复首条即 checkpoint 存档（原位取代）
    clearChatHistory('ckpt-c')
    const store2 = openSessionStore(ud, bookRoot)!
    const evs2 = store2.listEvents('ckpt-c')
    store2.close()
    const msgs = deriveMessages(evs2)
    expect(msgs.length).toBe(21)
    expect(msgs[0]!.role).toBe('user')
    expect(typeof msgs[0]!.content === 'string' && msgs[0]!.content.includes('<compacted-summary>')).toBe(true)
    expect(msgs[0]!.content).toContain('Primary Request and Intent')
    expect(msgs[1]!.content).toBe(q(2))
  })
})

describe('B2 checkpoint 压缩', () => {
  // 足够长的用户消息：保证存档（前导+标签 ~100 字）严格小于被压的 2 个回合
  const q = (i: number): string => `第${i}轮问题` + '情节细节'.repeat(40)

  it('溢出 → checkpoint 摘要成功：历史首条变存档 user 消息，旧回合 seq 遮蔽', async () => {
    const ud = setup()
    for (let i = 1; i <= 10; i++) {
      fake.setScript([{ type: 'text', content: '第' + i + '轮回复' }])
      await runOne(ud, 'ckpt-a', q(i))
    }
    // 第 11 轮：脚本第 2 条给 checkpoint 摘要调用（chat 回复后 finalizeHistory 发起）
    fake.setScript([
      { type: 'text', content: '第11轮回复' },
      { type: 'text', content: '1. Primary Request and Intent（作者连续讨论第1-11轮情节）2. Next Step（写第12章）' },
    ])
    await runOne(ud, 'ckpt-a', q(11))

    const h = getHistory('ckpt-a')
    // 存档 user 消息插入 + 最近 10 回合保留（1 + 20）
    expect(h.length).toBe(21)
    const first = h[0]!
    expect(first.role).toBe('user')
    expect(typeof first.content === 'string' && first.content.includes('<compacted-summary>')).toBe(true)
    expect(first.content).toContain('Primary Request and Intent')
    expect(h[1]!.content).toBe(q(2)) // toKeep 首条 = 回合2（11 回合压掉最旧 1 个，保 10）
    // 库里：被压回合 replace 遮蔽 + 校验链通过
    const store = openSessionStore(ud, bookRoot)!
    const evs = store.listEvents('ckpt-a')
    store.close()
    expect(evs.filter((e) => e.type === 'compaction/end' && e.surfaceOp === 'replace').length).toBeGreaterThan(0)
    expect(validateEventStream(evs)).toEqual([])

    // 第 12 轮：再次溢出 → 二次压缩「合并而非复制」——历史仍只有一条存档消息
    fake.setScript([{ type: 'text', content: '第12轮回复' }])
    await runOne(ud, 'ckpt-a', q(12))
    const h2 = getHistory('ckpt-a')
    expect(h2.length).toBe(21)
    const tagCount = h2.filter((m) => typeof m.content === 'string' && m.content.includes('<compacted-summary>')).length
    expect(tagCount).toBe(1)
  })

  it('摘要失败 → fail-open：保留原历史不遮蔽不占位；下次溢出回落硬截断', async () => {
    const ud = setup()
    for (let i = 1; i <= 10; i++) {
      fake.setScript([{ type: 'text', content: '第' + i + '轮回复' }])
      await runOne(ud, 'ckpt-b', q(i))
    }
    // 第 11 轮：chat 回复正常，checkpoint 调用 400（不可重试）→ 压缩失败
    fake.setScript([
      { type: 'text', content: '第11轮回复' },
      { type: 'error', status: 400, message: 'bad request' },
    ])
    await runOne(ud, 'ckpt-b', q(11))

    // fail-open：原历史全保留（22 条），无占位符，库里无遮蔽事件
    const h = getHistory('ckpt-b')
    expect(h.length).toBe(22)
    expect(h.some((m) => typeof m.content === 'string' && m.content.includes('<compacted-summary>'))).toBe(false)
    const store = openSessionStore(ud, bookRoot)!
    let evs = store.listEvents('ckpt-b')
    store.close()
    expect(evs.filter((e) => e.type === 'compaction/end').length).toBe(0)
    expect(validateEventStream(evs)).toEqual([])

    // 第 12 轮：溢出 + suppress → 不再调摘要，直接硬截断（F1-P1 原行为兜底）
    fake.setScript([{ type: 'text', content: '第12轮回复' }])
    await runOne(ud, 'ckpt-b', q(12))
    expect(getHistory('ckpt-b').length).toBe(20)
    const store2 = openSessionStore(ud, bookRoot)!
    evs = store2.listEvents('ckpt-b')
    store2.close()
    expect(evs.filter((e) => e.type === 'compaction/end' && e.surfaceOp === 'replace').length).toBeGreaterThan(0)
    expect(validateEventStream(evs)).toEqual([])
  })
})

describe('F1-P4 regenerate 回合分支元数据（G1 接线修复回归）', () => {
  it('普通回合 surface 事件不带 branchId；regenerate 带工具往返 → 分支视图保留 tool_result 合成消息与最终 assistant', async () => {
    const ud = setup()
    // 第一轮普通对话（线性）：user + assistant
    fake.setScript([{ type: 'text', content: '初版回复：节奏偏慢。' }])
    await runOne(ud, 'evt-regen', '第 3 章写得如何？')

    let userSeq: number
    {
      const store = openSessionStore(ud, bookRoot)!
      const evs = store.listEvents('evt-regen')
      store.close()
      userSeq = evs.find((e) => e.type === 'user/message')!.seq
      // 无回归锚：普通（非 regenerate）回合的 surface 事件一律不带 branchId
      for (const e of evs) {
        if (e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result') {
          expect(e.data['branchId']).toBeUndefined()
          expect(e.data['parentSeq']).toBeUndefined()
        }
      }
    }

    // regenerate（parentSeq = 触发 user 的全局 seq，branchId = 变体组）：
    // 脚本含一个 readonly 工具往返（book_search）+ 文本回复
    fake.setScript([
      { type: 'tool', name: 'book_search', input: { query: '玉佩' } },
      { type: 'text', content: '重写版回复：钩子可以再强一点。' },
    ])
    await runOne(ud, 'evt-regen', undefined, { regenerate: { parentSeq: userSeq, branchId: 'b1' } })

    const store = openSessionStore(ud, bookRoot)!
    const evs = store.listEvents('evt-regen')
    store.close()
    // 校验链通过（tool/result 载荷新增 parentSeq/branchId 不违反 validateEventStream）
    expect(validateEventStream(evs)).toEqual([])

    // 整个 regenerate 回合进同一变体组：首条 assistant(tool_use)、tool/result、最终 assistant
    // 都带 branchId=b1 + parentSeq=userSeq（修复前 tool/result 缺元数据 → 丢出分支视图）
    const grouped = evs.filter((e) => e.data['branchId'] === 'b1')
    expect(grouped.map((e) => e.type)).toEqual(['assistant/message', 'tool/result', 'assistant/message'])
    for (const e of grouped) expect(e.data['parentSeq']).toBe(userSeq)

    // 分支视图（selectBranch + loadHistoryWithSeqs，与 GET /chat/history?branch=b1 同源）：
    // selectBranch 语义 = 组内 + 祖先链 + 组外线性（含续聊）——初版 assistant（2）在顶替槽
    // (userSeq, 组根) 内，是被顶替的原始回复，从视图剔除（Z-P1-2：防默认视图新旧答案堆叠、
    // 与进程内「截断到 user 再答」口径分裂）；其后整段重写回合：assistant(tool_use) +
    // tool_result 合成消息 + 最终 assistant（修复前 tool/result 缺元数据 → 分支视图只剩首条 assistant，工具往返丢失）
    const { msgs } = loadHistoryWithSeqs(selectBranch(evs, 'b1'))
    expect(msgs).toHaveLength(4)
    expect(msgs[0]).toEqual({ role: 'user', content: '第 3 章写得如何？' })
    // 重写回合首条 assistant：含 book_search 的 tool_use block
    expect(msgs[1]!.role).toBe('assistant')
    const asstBlocks = msgs[1]!.content as ContentBlock[]
    const toolUse = asstBlocks.find((b) => b.type === 'tool_use') as { id: string; name: string } | undefined
    expect(toolUse?.name).toBe('book_search')
    // tool_result 合成消息：user role + 与 tool_use id 对齐的 tool_result block（readonly 执行非 error）
    expect(msgs[2]!.role).toBe('user')
    const trBlocks = msgs[2]!.content as ContentBlock[]
    expect(trBlocks).toHaveLength(1)
    expect(trBlocks[0]).toMatchObject({ type: 'tool_result', toolUseId: toolUse!.id, isError: false })
    expect((trBlocks[0] as { content: string }).content).toContain('玉佩')
    // 最终 assistant 文本
    expect(msgs[3]).toEqual({ role: 'assistant', content: '重写版回复：钩子可以再强一点。' })
  })

  it('regenerate 轮数触顶：收尾 assistant 也进变体组（分支视图末条 = 收尾文案）', async () => {
    const ud = setup()
    fake.setScript([{ type: 'text', content: '初版回复。' }])
    await runOne(ud, 'evt-max', '第 1 章写得怎么样？')
    let userSeq: number
    {
      const store = openSessionStore(ud, bookRoot)!
      const evs = store.listEvents('evt-max')
      store.close()
      userSeq = evs.find((e) => e.type === 'user/message')!.seq
    }

    // 5 个工具响应打满 MAX_AGENT_TURNS(5) → 走轮数触顶收尾路径（补固定文案）
    fake.setScript([
      { type: 'tool', name: 'book_search', input: { query: '林远' } },
      { type: 'tool', name: 'book_search', input: { query: '玉佩' } },
      { type: 'tool', name: 'book_search', input: { query: '宗门' } },
      { type: 'tool', name: 'book_search', input: { query: '长老' } },
      { type: 'tool', name: 'book_search', input: { query: '妖兽' } },
    ])
    await runOne(ud, 'evt-max', undefined, { regenerate: { parentSeq: userSeq, branchId: 'b1' } })

    const store = openSessionStore(ud, bookRoot)!
    const evs = store.listEvents('evt-max')
    store.close()
    expect(validateEventStream(evs)).toEqual([])
    // 收尾 assistant（轮数触顶固定文案）带分支元数据（修复前缺 → 丢出分支视图）
    const closing = evs.find(
      (e) => e.type === 'assistant/message' && String(e.data['message']).includes('工具调用上限'),
    )
    expect(closing).toBeDefined()
    expect(closing!.data['branchId']).toBe('b1')
    expect(closing!.data['parentSeq']).toBe(userSeq)

    // 分支视图：5 轮工具往返（5 条 tool_result 合成消息）+ 收尾 assistant 全部在组内
    const { msgs } = loadHistoryWithSeqs(selectBranch(evs, 'b1'))
    expect(msgs.filter((m) => m.role === 'user' && Array.isArray(m.content))).toHaveLength(5)
    expect(msgs[msgs.length - 1]).toEqual({
      role: 'assistant',
      content: '已达到单次对话的工具调用上限，先到这里——你可以基于以上结果继续提问。',
    })
  })
})


describe('Z-P1-2 写侧谱系：活跃分支延续（G1 分支投影口径统一）', () => {
  it('regenerate 成功 → 其后普通回合的 user/assistant 事件带 branchId 进组；切其他变体时续聊被正确排除', async () => {
    const ud = setup()
    fake.setScript([{ type: 'text', content: '初版回复。' }])
    await runOne(ud, 'z-lineage', '第一问')
    let userSeq: number
    {
      const store = openSessionStore(ud, bookRoot)!
      userSeq = store.listEvents('z-lineage').find((e) => e.type === 'user/message')!.seq
      store.close()
    }

    // regenerate b1 成功 → 激活 b1
    fake.setScript([{ type: 'text', content: '重写版回复。' }])
    await runOne(ud, 'z-lineage', undefined, { regenerate: { parentSeq: userSeq, branchId: 'b1' } })

    // 普通续聊：事件应带 branchId=b1（进组），且不带 parentSeq（不是变体根）
    fake.setScript([{ type: 'text', content: '续聊回复。' }])
    await runOne(ud, 'z-lineage', '续聊问题')
    {
      const store = openSessionStore(ud, bookRoot)!
      const evs = store.listEvents('z-lineage')
      store.close()
      expect(validateEventStream(evs)).toEqual([])
      const contUser = evs.find((e) => e.type === 'user/message' && e.data['message'] === '续聊问题')
      expect(contUser).toBeDefined()
      expect(contUser!.data['branchId']).toBe('b1')
      expect(contUser!.data['parentSeq']).toBeUndefined()
      const contAsst = evs.find((e) => e.type === 'assistant/message' && e.data['message'] === '续聊回复。')
      expect(contAsst).toBeDefined()
      expect(contAsst!.data['branchId']).toBe('b1')
      expect(contAsst!.data['parentSeq']).toBeUndefined()
    }

    // 再生一个变体 b2（同 parent）：续聊（b1 组成员）不得泄入 b2 视图
    fake.setScript([{ type: 'text', content: '重写二版。' }])
    await runOne(ud, 'z-lineage', undefined, { regenerate: { parentSeq: userSeq, branchId: 'b2' } })
    const store = openSessionStore(ud, bookRoot)!
    const evs = store.listEvents('z-lineage')
    store.close()
    // b1 视图：user + 重写版 + 续聊往返（续聊进组 → 归属 b1）
    const b1 = loadHistoryWithSeqs(selectBranch(evs, 'b1')).msgs
    expect(b1).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '重写版回复。' },
      { role: 'user', content: '续聊问题' },
      { role: 'assistant', content: '续聊回复。' },
    ])
    // b2（默认）视图：只有 user + 重写二版——b1 组（含续聊）被组过滤排除，
    // 被顶替的初版回复在顶替槽内剔除
    const b2 = loadHistoryWithSeqs(selectBranch(evs)).msgs
    expect(b2).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '重写二版。' },
    ])
  })

  it('regenerate 失败（400 终态）→ 不激活新分支：后续普通回合事件无 branchId（防归因到幽灵组）', async () => {
    const ud = setup()
    fake.setScript([{ type: 'text', content: '初版回复。' }])
    await runOne(ud, 'z-fail', '第一问')
    let userSeq: number
    {
      const store = openSessionStore(ud, bookRoot)!
      userSeq = store.listEvents('z-fail').find((e) => e.type === 'user/message')!.seq
      store.close()
    }

    // regenerate b1 失败：400 不可重试 → chat_error；半截组事件被遮蔽
    fake.setScript([{ type: 'error', status: 400, message: 'bad request' }])
    const evs1 = await runOne(ud, 'z-fail', undefined, { regenerate: { parentSeq: userSeq, branchId: 'b1' } })
    expect(evs1.some((e) => e.type === 'chat_error')).toBe(true)

    // 后续普通回合：无 branchId（b1 未激活——激活会把续聊归因到被遮蔽的幽灵组）
    fake.setScript([{ type: 'text', content: '后续回复。' }])
    await runOne(ud, 'z-fail', '后续问题')
    const store = openSessionStore(ud, bookRoot)!
    const evs = store.listEvents('z-fail')
    store.close()
    const after = evs.filter((e) => e.type === 'user/message' && e.data['message'] === '后续问题')
    expect(after).toHaveLength(1)
    expect(after[0]!.data['branchId']).toBeUndefined()
    expect(validateEventStream(evs)).toEqual([])
  })

  it('跨重启恢复走默认分支投影：模型收到的历史不含被顶替的初版回复（与视图/进程内口径一致）', async () => {
    const ud = setup()
    fake.setScript([{ type: 'text', content: '初版回复。' }])
    await runOne(ud, 'z-recover', '第一问')
    let userSeq: number
    {
      const store = openSessionStore(ud, bookRoot)!
      userSeq = store.listEvents('z-recover').find((e) => e.type === 'user/message')!.seq
      store.close()
    }
    fake.setScript([{ type: 'text', content: '重写版回复。' }])
    await runOne(ud, 'z-recover', undefined, { regenerate: { parentSeq: userSeq, branchId: 'b1' } })

    // 模拟重启：只清内存（不带 userDataPath → 不动库；活跃分支映射一并归零）
    clearChatHistory('z-recover')

    fake.setScript([{ type: 'text', content: '重启后回复。' }])
    await runOne(ud, 'z-recover', '重启后问题')

    // 模型收到的 messages：system 后应为 [user 第一问, assistant 重写版回复, user 重启后问题]——
    // 初版回复（被顶替）不得堆进上下文（修复前全量投影 = 新旧两版答案并列，答非所问）
    const body = fake.lastBody() as { messages: Array<{ role: string; content: unknown }> }
    const flat = JSON.stringify(body.messages)
    expect(flat).not.toContain('初版回复')
    expect(flat).toContain('重写版回复')
    expect(body.messages[1]!.content).toBe('第一问')
    expect(body.messages[2]!.content).toBe('重写版回复。')
    expect(body.messages[body.messages.length - 1]!.content).toBe('重启后问题')
  })
})
