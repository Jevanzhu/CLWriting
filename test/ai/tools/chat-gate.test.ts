/**
 * 工具面扩展集成测试：新工具经 executeChatTool 分派 + 确认闸。
 * 用 fake-provider 跑真实 HTTP 全链路。
 * 验收：write 类（move_chapter）弹 chat_tool_pending 确认后才执行；
 *       readonly 类（book_search）直跑不打断。
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider } from '../fake-provider.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir, LONG_BOOK } from '../../studio/fixtures.js'
import { runChat, resolveChatConfirm } from '../../../src/ai/orchestrate/chat.js'
import type { DriverEvent, Session, StudioDriver } from '../../../src/driver/types.js'

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
})

afterEach(() => {
  delete process.env.CLWRITING_DRIVER
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(): string {
  const ud = tempUserData()
  dirs.push(ud)
  delete process.env.CLWRITING_DRIVER
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

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout after ' + timeoutMs + 'ms')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('工具面扩展确认闸', () => {
  it('move_chapter（write）→ pending 确认后执行，文件真实移动', async () => {
    fake.setScript([
      { type: 'tool', name: 'move_chapter', input: { chapter: 1, toDir: '写作/正文/第一卷' } },
      { type: 'text', content: '已移动。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeDriver(events)
    const ud = setup()
    const bookName = 'gate-move'

    const chatPromise = runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot: join(bookRoot, '长篇', LONG_BOOK),
      bookName,
      message: '把第一章移到第一卷',
      confirmTimeoutMs: 5000,
    })

    await waitFor(() => events.some((e) => e.type === 'chat_tool_pending'))
    const pending = events.find((e) => e.type === 'chat_tool_pending') as { callId: string } | undefined
    expect(pending).toEqual(expect.objectContaining({ type: 'chat_tool_pending' }))
    // 确认前文件未移动
    expect(existsSync(join(bookRoot, '长篇', LONG_BOOK, '写作/正文/0001-初入宗门.md'))).toBe(true)

    resolveChatConfirm(bookName, pending!.callId, true)
    await chatPromise

    expect(events.some((e) => e.type === 'chat_tool_result')).toBe(true)
    expect(existsSync(join(bookRoot, '长篇', LONG_BOOK, '写作/正文/第一卷/0001-初入宗门.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '长篇', LONG_BOOK, '写作/正文/0001-初入宗门.md'))).toBe(false)
  })

  it('book_search（readonly）→ 不弹 pending，直跑并回填结果', async () => {
    fake.setScript([
      { type: 'tool', name: 'book_search', input: { query: '玉佩' } },
      { type: 'text', content: '找到了。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeDriver(events)
    const ud = setup()

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot: join(bookRoot, '长篇', LONG_BOOK),
      bookName: 'gate-search',
      message: '找找玉佩相关',
    })

    expect(events.some((e) => e.type === 'chat_tool_pending')).toBe(false)
    expect(events.some((e) => e.type === 'chat_tool')).toBe(true)
    expect(events.some((e) => e.type === 'chat_tool_result')).toBe(true)
  })
})

