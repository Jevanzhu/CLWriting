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
import { runChat, clearChatHistory } from '../../src/ai/orchestrate/chat.js'
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
    // 11 轮累积 22 条消息 → 超 MAX_HISTORY_TURNS(10)*2=20 → trim 触发
    for (let i = 1; i <= 11; i++) {
      fake.setScript([{ type: 'text', content: '第' + i + '轮回复' }])
      await runOne(ud, 'evt-c', '第' + i + '轮问题' + String.fromCharCode(64 + i))
    }
    const store = openSessionStore(ud, bookRoot)!;
    const evs = store.listEvents('evt-c')
    store.close()
    const compactions = evs.filter((e) => e.type === 'compaction/end' && e.surfaceOp === 'replace')
    expect(compactions.length).toBeGreaterThan(0)
    // 校验链通过（遮蔽区间合法）
    expect(validateEventStream(evs)).toEqual([])
    // 恢复出的历史是最近回合（不含被遮蔽的旧回合）
    const msgs = deriveMessages(evs)
    expect(msgs.length).toBeLessThanOrEqual(20)
    // 人类抄本保留：全量 append 事件仍可审计
    const userEvents = evs.filter((e) => e.type === 'user/message')
    expect(userEvents.length).toBeGreaterThanOrEqual(11)
  })
})

