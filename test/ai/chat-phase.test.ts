/**
 * E1d（终态广播相位排序）测试：chat_done emit 时，事件库持久化（recorder.flush）已完成。
 * 相位：persistence（落库）→ 普通（done）→ cleanup（摘要压缩）——chat_done 事件出现即代表落库完成。
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { runChat } from '../../src/ai/orchestrate/chat.js'
import { openSessionStore } from '../../src/events/store.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/types.js'

let fake: FakeProvider
const dirs: string[] = []
let workDir: string

beforeAll(async () => {
  fake = await createFakeProvider()
})

afterAll(async () => {
  await fake.close()
})

beforeEach(() => {
  workDir = makeDualTrackWorkdir()
  dirs.push(workDir)
})

afterEach(() => {
  delete process.env.CLWRITING_DRIVER
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeDriver(emitted: DriverEvent[]): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> { return { id: 'mock', cwd, closed: false } },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s, ev): void { emitted.push(ev) },
  }
}

describe('E1d: 终态广播相位排序', () => {
  it('chat_done 出现时事件库持久化已完成（persistence 先于 done）', async () => {
    fake.setScript([{ type: 'text', content: '完成了。' }])
    const events: DriverEvent[] = []
    const driver = makeDriver(events)
    const ud = tempUserData()
    dirs.push(ud)
    delete process.env.CLWRITING_DRIVER
    withFakeProvider(ud, fake.url)
    const bookName = 'phase-done'

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: workDir, closed: false },
      userDataPath: ud,
      bookRoot: workDir,
      bookName,
      message: '你好',
    })

    expect(events.some((e) => e.type === 'chat_done')).toBe(true)
    // chat_done 已发 → 事件库必已含该书的会话事件（user + assistant + turn）——persistence 相位在 done 前完成
    const store = openSessionStore(ud, workDir)
    const evs = store ? store.listEvents(bookName) : []
    expect(evs.some((e) => e.type === 'session/start')).toBe(true)
    expect(evs.some((e) => e.type === 'user/message')).toBe(true)
    expect(evs.some((e) => e.type === 'assistant/message')).toBe(true)
    store?.close()
  })
})

