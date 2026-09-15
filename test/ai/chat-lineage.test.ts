/**
 * chat 血缘与分支事件域单测（R0916-5b 拆分件，2026-09-16）。
 *
 * 拆分来源：test/ai/chat.test.ts（原「W2 对话助手 agent 编排器测试」，原头注沿革
 * 见残核 chat.test.ts）——本件承接「F1-P3 chat 血缘事件」「F1-P4 chat 重新生成
 *（分支）」两个 describe 域整块搬移零改动（settings/snapshot 登记可回溯 /
 * regenerate 复用 user、新 assistant 带 branchId+parentSeq 分支可恢复）。
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { makeFakeDriver } from './fake-driver.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { runChat } from '../../src/ai/orchestrate/chat.js'
import { openSessionStore } from '../../src/events/store.js'
import type { DriverEvent } from '../../src/driver/types.js'
import { hasChatDone } from './chat-fixtures.js'

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

/** 带 fake provider 的 userData */
function setup(): string {
  const ud = tempUserData()
  dirs.push(ud)
  delete process.env.CLWRITING_DRIVER
  withFakeProvider(ud, fake.url)
  return ud
}

// ─── F1-P3 血缘事件 ───────────────────────────────

describe('F1-P3 chat 血缘事件', () => {
  it('单轮对话：settings/snapshot 登记 + assistant sourceSeqs 引用（可回溯、早于 assistant）', async () => {
    fake.setScript([{ type: 'text', content: '答案是谈判。' }])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()

    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName: 'lineage-e2e',
      message: '主角该硬闯还是谈判？',
    })
    expect(hasChatDone(events)).toBe(true)

    // 读事件库（对话会话 book = bookName）
    const store = openSessionStore(ud, bookRoot)!
    try {
      const evs = store.listEvents('lineage-e2e')
      const snap = evs.find((e) => e.type === 'settings/snapshot')
      expect(snap).toBeDefined()
      expect((snap!.data as { scope: string }).scope).toBe('settings')
      expect(typeof (snap!.data as { digest: string }).digest).toBe('string')

      const asst = evs.find((e) => e.type === 'assistant/message')
      expect(asst).toBeDefined()
      expect(asst!.sourceSeqs).toBeDefined()
      expect(asst!.sourceSeqs!.length).toBeGreaterThan(0)
      // 完整来源链可回溯：每个引用 seq 都能在事件流定位，且早于 assistant
      for (const s of asst!.sourceSeqs!) {
        expect(evs.some((e) => e.seq === s)).toBe(true)
        expect(s).toBeLessThan(asst!.seq)
      }
      // settings/snapshot seq 被 assistant 引用
      expect(asst!.sourceSeqs).toContain(snap!.seq)
    } finally {
      store.close()
    }
  })
})

describe('F1-P4 chat 重新生成（分支）', () => {
  it('regenerate：复用已有 user，新 assistant 带 branchId + parentSeq，分支可恢复', async () => {
    fake.setScript([
      { type: 'text', content: '第一版回复。' },
      { type: 'text', content: '重新生成的回复。' },
    ])
    const events: DriverEvent[] = []
    const driver = makeFakeDriver({ emitted: events })
    const ud = setup()
    const bookName = 'branch-e2e'

    // 第一轮：正常对话
    await runChat({
      driver,
      mainSession: { id: 's1', cwd: bookRoot, closed: false },
      userDataPath: ud,
      bookRoot,
      bookName,
      message: '怎么收尾？',
    })
    expect(hasChatDone(events)).toBe(true)

    const store = openSessionStore(ud, bookRoot)!
    try {
      const evs1 = store.listEvents(bookName)
      const userEv = evs1.find((e) => e.type === 'user/message')
      expect(userEv).toBeDefined()
      const userSeq = userEv!.seq
      expect(evs1.filter((e) => e.type === 'assistant/message')).toHaveLength(1)

      // 第二轮：重新生成（parentSeq = 第一轮 user 的全局 seq，新变体组 r1）
      await runChat({
        driver,
        mainSession: { id: 's1', cwd: bookRoot, closed: false },
        userDataPath: ud,
        bookRoot,
        bookName,
        regenerate: { parentSeq: userSeq, branchId: 'r1' },
      })
      expect(hasChatDone(events)).toBe(true)

      const evs2 = store.listEvents(bookName)
      const asst = evs2.filter((e) => e.type === 'assistant/message')
      expect(asst).toHaveLength(2) // 第一版 + 重新生成版
      const branchAsst = asst[asst.length - 1]!
      expect((branchAsst.data as { branchId?: string }).branchId).toBe('r1')
      expect((branchAsst.data as { parentSeq?: number }).parentSeq).toBe(userSeq)
      // 无新 user 事件（复用旧 user 消息）
      expect(evs2.filter((e) => e.type === 'user/message')).toHaveLength(1)

      // 分支可切换：新变体带 branchId → 分支树可识别；普通消息无 branchId（线性兜底）
      const branch = evs2.find((e) => e.type === 'assistant/message' && (e.data as { branchId?: string }).branchId === 'r1')
      expect(branch).toBeDefined()
      expect((branch!.data as { branchId?: string }).branchId).toBe('r1')
      // 第一版 assistant 无 branchId（普通线性消息）
      const firstAsst = asst[0]!
      expect((firstAsst.data as { branchId?: string }).branchId).toBeUndefined()
    } finally {
      store.close()
    }
  })
})
