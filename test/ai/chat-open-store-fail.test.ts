/**
 * H-1（第六轮）回归：openSessionStore 抛错（库文件损坏/磁盘满/目录只读）不再死锁。
 *
 * 修复背景：runChatInner 里 openSessionStore 裸调位于 running.set 之后、主 try 之前——
 * DatabaseSync 与 PRAGMA 在上述条件下同步抛错，finally 不执行：running 永不释放、
 * deadline 定时器不清、drainNextChat 永不消费，该书对话功能死锁到进程重启。
 * 本测试锁三件事：
 * 1. 库打开抛错 → 对话仍以内存模式完成（不抛出、正常收尾）；
 * 2. 完成后 isChatRunning 归 false（并发锁释放）；
 * 3. 随后再次发消息返回 'started'（若锁泄漏则只会 'queued'），且降级有 notice 提示。
 */
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir, LONG_BOOK } from '../studio/fixtures.js'
import { runChat, isChatRunning, sendChatMessage } from '../../src/ai/orchestrate/chat.js'
import { bookHash } from '../../src/events/store.js'
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

/** 在 <ud>/clwriting/session/ 预埋垃圾字节——DatabaseSync/PRAGMA 打开即抛「不是数据库」 */
function corruptSessionDb(ud: string, bookRoot: string): void {
  const dir = join(ud, 'clwriting', 'session')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, bookHash(bookRoot) + '.db'), 'garbage bytes, definitely not a sqlite database')
}

describe('H-1: 事件库打开失败不死锁（降级内存模式）', () => {
  it('库损坏 → 对话完成 + 锁释放 + 再次发送正常启动 + notice 提示', { timeout: 10_000 }, async () => {
    const ud = tempUserData()
    dirs.push(ud)
    delete process.env.CLWRITING_DRIVER
    withFakeProvider(ud, fake.url)
    corruptSessionDb(ud, longRoot)
    fake.setScript([{ type: 'text', content: '回复内容' }])

    const events: DriverEvent[] = []
    const driver = makeDriver(events)
    const bookName = 'corrupt-db-book'

    // 修复前：runChatInner 在进 try 前抛错，runChat reject；锁不释放
    await runChat({
      driver,
      mainSession: { id: 's1', cwd: workDir, closed: false },
      userDataPath: ud,
      bookRoot: longRoot,
      bookName,
      message: '随便聊聊',
    })

    // 内存模式收尾正常：锁释放（修复前恒 true——死锁到进程重启）
    expect(isChatRunning(bookName)).toBe(false)

    // 降级可感知：作者收到「本次对话不留审计记录」提示
    const notice = events.find((e) => e.type === 'notice' && String((e as { message?: unknown }).message ?? '').includes('事件库打开失败'))
    expect(notice).toBeTruthy()

    // 队列链未死：再次发送直接启动（若锁泄漏，这里只会返回 'queued' 且永不消费）
    fake.setScript([{ type: 'text', content: '第二次回复' }])
    const r = sendChatMessage({
      driver,
      mainSession: { id: 's1', cwd: workDir, closed: false },
      userDataPath: ud,
      bookRoot: longRoot,
      bookName,
      message: '再聊一句',
    })
    expect(r).toBe('started')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(isChatRunning(bookName)).toBe(false)
  })
})
