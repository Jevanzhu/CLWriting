/**
 * 低-1（第十轮）回归：checkpoint 摘要（finish.ts summarizeCheckpoint）的 registerCtrl
 * 必须带 'chat' owner 分槽——与第八轮 M-1 的 owner 分槽口径一致。
 *
 * 修复背景：轮循环（turns.ts）的 runTask register 已带 owner='chat'（M-1 第八轮），
 * checkpoint 摘要处的同款调用漏带 owner——落到无主 '' 槽，与 M-1 口径分叉：
 * 两本书共享 session 的部署形态（测试/嵌入式）下，后书的摘要 register 会在 '' 槽
 * 触发 P2-6「换新先 abort 旧」，把前书在途压缩的 ctrl 静默掐断（摘要失败回落硬截断）。
 * 对齐后：摘要 register 与轮循环同槽同 ctrl（幂等 no-op），不同 owner 并发互不影响。
 *
 * 手法：预灌 11 回合历史（> MAX_HISTORY_TURNS=10）触发收尾压缩，用记录型 driver
 * （实现 cc.ts M-1 同款 owner 分槽语义）捕获全部 registerCtrl 调用的 owner 实参。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir, LONG_BOOK } from '../studio/fixtures.js'
import { runChat, clearChatHistory } from '../../src/ai/orchestrate/chat.js'
import { histories } from '../../src/ai/orchestrate/chat/state.js'
import type { ChatMsg } from '../../src/ai/provider/types.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/types.js'

const BOOK = 'ckpt-owner-10'

let fake: FakeProvider
const dirs: string[] = []
let workDir: string
let bookRoot: string

beforeAll(async () => {
  fake = await createFakeProvider()
})

afterAll(async () => {
  await fake.close()
})

beforeEach(() => {
  workDir = makeDualTrackWorkdir()
  bookRoot = join(workDir, '长篇', LONG_BOOK)
  dirs.push(workDir)
})

afterEach(() => {
  delete process.env.CLWRITING_DRIVER
  clearChatHistory(BOOK)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(): string {
  const ud = tempUserData()
  dirs.push(ud)
  delete process.env.CLWRITING_DRIVER
  withFakeProvider(ud, fake.url)
  return ud
}

/** 记录型 driver：捕获 registerCtrl 的 owner 实参 + 实现 cc.ts M-1 同款 owner 分槽语义
 *  （同槽换新先 abort 旧；跨槽互不影响）——断言才有真实抢占语义可依。 */
interface RegEntry {
  ctrl: AbortController
  owner: string | undefined
}
function makeRecordingDriver(events: DriverEvent[], regs: RegEntry[], slots: Map<string, AbortController>): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'ckpt-owner-s', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s, ev): void {
      events.push(ev)
    },
    registerCtrl(_s: Session, ctrl: AbortController, owner?: string): void {
      regs.push({ ctrl, owner })
      const own = owner ?? ''
      const old = slots.get(own)
      if (old === ctrl) return // 同 ctrl 重复登记幂等（cc.ts 同款）
      if (old && !old.signal.aborted) old.abort() // P2-6：同槽换新先 abort 旧
      slots.set(own, ctrl)
    },
    unregisterCtrl(_s: Session, ctrl: AbortController): void {
      for (const [own, c] of slots) if (c === ctrl) slots.delete(own)
    },
  }
}

/** 预灌 11 回合完整历史（user/assistant 纯文本对）——加上本回合即超 keepTurns=10，
 *  收尾 finalizeHistory 必走 checkpoint 摘要分支（summarizeCheckpoint 的 runTask register）。 */
function seedOverflowHistory(): void {
  const h: ChatMsg[] = []
  for (let i = 1; i <= 11; i++) {
    h.push({ role: 'user', content: `问题${i}：` + '细节'.repeat(30) })
    h.push({ role: 'assistant', content: `回答${i}：` + '内容'.repeat(30) })
  }
  histories.set(BOOK, h)
}

describe('低-1（第十轮）：checkpoint 摘要 registerCtrl 的 owner 分槽', () => {
  it('溢出压缩触发的摘要 register 带 owner=chat（轮循环同槽同 ctrl，无主槽零调用）', { timeout: 15_000 }, async () => {
    seedOverflowHistory()
    const events: DriverEvent[] = []
    const regs: RegEntry[] = []
    const slots = new Map<string, AbortController>()
    const driver = makeRecordingDriver(events, regs, slots)
    fake.setScript([
      { type: 'text', content: '本回合的答复。' },
      { type: 'text', content: '摘要：作者在第 1 卷推进，玉佩悬念已埋。' },
    ])

    await runChat({
      driver,
      mainSession: { id: 'ckpt-owner-s', cwd: workDir, closed: false },
      userDataPath: setup(),
      bookRoot,
      bookName: BOOK,
      message: '继续',
    })

    // 压缩确实发生（否则 register 次数断言无意义）：历史被摘要替换后远小于 22 条
    expect(histories.get(BOOK)!.length).toBeLessThan(22)
    // 轮循环 1 次 + 摘要 1 次，全部带 'chat' owner——修复前摘要调用 owner=undefined 落 '' 槽
    expect(regs.length).toBeGreaterThanOrEqual(2)
    expect(regs.every((r) => r.owner === 'chat')).toBe(true)
    // 摘要 register 与轮循环是同一个编排级 ctrl：同槽幂等 no-op，绝不自 abort
    expect(regs[0]!.ctrl).toBe(regs.at(-1)!.ctrl)
    expect(regs.at(-1)!.ctrl.signal.aborted).toBe(false)
  })

  it('不同 owner 并发 register/abort 互不影响（chat 摘要在途不被 self-heal 抢占）', { timeout: 15_000 }, async () => {
    seedOverflowHistory()
    const events: DriverEvent[] = []
    const regs: RegEntry[] = []
    const slots = new Map<string, AbortController>()
    const driver = makeRecordingDriver(events, regs, slots)
    fake.setScript([
      { type: 'text', content: '本回合的答复。' },
      { type: 'text', content: '摘要：第 1 卷推进中。' },
    ])

    const chatPromise = runChat({
      driver,
      mainSession: { id: 'ckpt-owner-s', cwd: workDir, closed: false },
      userDataPath: setup(),
      bookRoot,
      bookName: BOOK,
      message: '继续',
    })
    await chatPromise

    const chatCtrl = regs.at(-1)!.ctrl
    expect(chatCtrl.signal.aborted).toBe(false)
    // 同 session 并发一路 self-heal（不同 owner）：register 与 abort 均不波及 chat 的 ctrl
    const heal = new AbortController()
    driver.registerCtrl!({ id: 'ckpt-owner-s', cwd: workDir, closed: false }, heal, 'self-heal')
    expect(heal.signal.aborted).toBe(false)
    expect(chatCtrl.signal.aborted).toBe(false)
    heal.abort()
    expect(chatCtrl.signal.aborted).toBe(false)
  })
})
