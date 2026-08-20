/**
 * #7 回归：waitChatSettled 等待原语——改名/删书/优雅退出的「等在途编排收尾」依据。
 *
 * 修复背景：books.ts 改名/删书 handler 此前 abort 后立即同步关库/搬目录——abort 只是
 * 异步信号，straggler 编排恢复后对已关库写会抛「连接未打开」（对话以 error 收尾）。
 * 收尾 Promise 登记使等待成为可能；本测试锁三件事：
 * 1. 在途时 waitChatSettled 不 resolve；
 * 2. runChat 完整收尾后 resolve（清理链跑完）；
 * 3. 无在途时立即 resolve（不悬挂）。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir, LONG_BOOK } from '../studio/fixtures.js'
import { runChat, isChatRunning, waitChatSettled } from '../../src/ai/orchestrate/chat.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/types.js'

let fake: FakeProvider
const dirs: string[] = []
let workDir: string
let longRoot: string

beforeAll(async () => {
  fake = await createFakeProvider()
})

afterAll(async () => {
  await fake.close()
})

beforeEach(() => {
  workDir = makeDualTrackWorkdir()
  longRoot = join(workDir, '长篇', LONG_BOOK)
  dirs.push(workDir)
})

afterEach(() => {
  delete process.env.CLWRITING_DRIVER
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

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
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout after ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('#7: waitChatSettled 收尾等待原语', () => {
  it('在途不 resolve；runChat 收尾后 resolve；无在途立即 resolve', { timeout: 10_000 }, async () => {
    const ud = tempUserData()
    dirs.push(ud)
    delete process.env.CLWRITING_DRIVER
    withFakeProvider(ud, fake.url)
    // delayMs 挂住在途响应，制造「运行中」窗口
    fake.setScript([{ type: 'text', content: '回复内容', delayMs: 800 }])

    const events: DriverEvent[] = []
    const driver = makeDriver(events)
    const bookName = 'settle-book'
    const chatPromise = runChat({
      driver,
      mainSession: { id: 's1', cwd: workDir, closed: false },
      userDataPath: ud,
      bookRoot: longRoot,
      bookName,
      message: '随便聊聊',
    })

    await waitFor(() => isChatRunning(bookName))
    let settled = false
    void waitChatSettled(bookName).then(() => {
      settled = true
    })

    await new Promise((r) => setTimeout(r, 100))
    expect(settled).toBe(false) // 在途：收尾未到，等待不 resolve

    await chatPromise
    await new Promise((r) => setTimeout(r, 50)) // 收尾 Promise 的 then 清理链跑完
    expect(settled).toBe(true) // 完整收尾（finally 清库/注销）后才 resolve
    expect(isChatRunning(bookName)).toBe(false)

    // 无在途 → 立即 resolve（改名/删书 handler 不被悬挂拖住）
    await waitChatSettled(bookName)
  })
})
