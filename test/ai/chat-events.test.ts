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

async function runOne(ud: string, bookName: string, message: string): Promise<void> {
  const events: DriverEvent[] = []
  await runChat({
    driver: makeDriver(events),
    mainSession: { id: 's1', cwd: bookRoot, closed: false },
    userDataPath: ud,
    bookRoot,
    bookName,
    message,
  })
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

