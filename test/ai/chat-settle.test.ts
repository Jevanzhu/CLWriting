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
import { runChat, isChatRunning, waitChatSettled, sendChatMessage } from '../../src/ai/orchestrate/chat.js'
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

  // M-3 回归：drainNextChat 续链会在旧收尾 Promise resolve 前同步替换 settling 表项——
  // 旧实现调用时同步捕获 settling.get() 的那一项，该项 resolve 即返回，续链新 run 仍在途，
  // 随后的删库/改名就与新 run 的收尾写库竞争。真锚要点：必须在第一轮仍在途时发起
  // waitChatSettled（此刻表项是 p1；若等第一轮结束再发起，表项已被续链同步替换成 p2，
  // 旧实现也能等对——那是假锚）。循环版每轮重取表项，追上续链 run。
  it('steer 续链：第一轮完成后链入的第二轮在途时，waitChatSettled 仍不 resolve（M-3）', { timeout: 15_000 }, async () => {
    const ud = tempUserData()
    dirs.push(ud)
    delete process.env.CLWRITING_DRIVER
    withFakeProvider(ud, fake.url)
    // 第 1 条秒回；第 2 条（排队续链）挂住 700ms 制造「续链在途」窗口
    fake.setScript([
      { type: 'text', content: '第一轮回复' },
      { type: 'text', content: '第二轮回复', delayMs: 700 },
    ])

    const events: DriverEvent[] = []
    const driver = makeDriver(events)
    const bookName = 'settle-chain-book'
    const common = {
      driver,
      mainSession: { id: 's1', cwd: workDir, closed: false } as Session,
      userDataPath: ud,
      bookRoot: longRoot,
      bookName,
    }
    const first = runChat({ ...common, message: '第一轮' })
    await waitFor(() => isChatRunning(bookName))
    // 发起等待时第一轮仍在途 → 捕获的是 p1（旧实现返回时机 = p1 resolve，
    // 恰在续链 p2 同步接管之后、p2 收尾之前——正是竞争窗本体）
    let settled = false
    void waitChatSettled(bookName).then(() => {
      settled = true
    })
    // 运行中发第二条 → 入队（E1a steer「入队让出」）
    expect(sendChatMessage({ ...common, message: '第二轮' })).toBe('queued')
    await first
    // 此刻第一轮已收尾、续链第二轮已同步接管 running（delayMs 挂住在途）
    expect(isChatRunning(bookName)).toBe(true)
    await new Promise((r) => setTimeout(r, 150))
    expect(settled).toBe(false) // 旧实现只等 p1，此处已提前 resolve（续链 run 仍在途）

    await waitChatSettled(bookName)
    expect(settled).toBe(true)
    expect(isChatRunning(bookName)).toBe(false) // 续链 run 也完整收尾
  })
})
