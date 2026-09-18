/**
 * 四轮-A402（2026-09-18 全量源码独立重评四轮修复批）回归：chat 内嵌写章期间 sync 快照
 * 的写手腿在途（driver.isWriterRunning）为真。
 *
 * 修复前：turns-tools write_chapter 不传 register（Z-P2-5 单槽登记时代的顾虑），嵌入式
 * runSelfHeal 的编排级 ctrl 不在 cc driver 在册——E002 收窄口径（cc.isWriterRunning 只
 * 排除 `chat:` 前缀槽）下，写章全程 SSE sync 快照 running 假空闲（workbench 误显
 * 「可生成」）。修复后：内嵌写章以独立 owner `self-heal:<书名>` 登记 ctrl（cc 跨 owner
 * 互不 abort，不伤外层对话；同 ctrl 逐轮重复登记经 cc 幂等跳过），settle 后 finally
 * 注销；/interrupt 走 abortAllCtrls 全停，在册的 self-heal 槽一并中止（与既有
 * abortChat→abortSelfHeal 桥接殊途同归，全停语义不变）。
 *
 * 口径钉死（口径翻转记档：四轮-A402 起「内嵌写章期间 running:false」旧口径作废）：
 * - 内嵌 write_chapter 执行期间 isWriterRunning=true、结束后 false；
 * - `chat:` 前缀排除口径不翻转（E002 一轮的「对话期假忙」修复语义保持）——仅 chat 腿
 *   在册时快照仍 false；
 * - /interrupt 全停：chat 腿与 self-heal 槽同中止，interrupt 即注销全部槽位。
 *
 * 本测直接驱动 executeChatTool（确认闸 waitConfirm 在 turns.ts 轮循环层，不经此缝）；
 * ctrl 登记经桥接 driver 落真实 ccDriver（sync 快照判定正本）；生成走 fake provider 全
 * 链路（非 mock 分支——CLWRITING_DRIVER=mock 的 tryMockTool 快路在 runTask 内先于
 * register 短路，测不到登记时机）。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider } from './fake-provider.js'
import { makeFakeDriver } from './fake-driver.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir, SHORT_BOOK } from '../studio/fixtures.js'
import { executeChatTool } from '../../src/ai/orchestrate/chat/turns-tools.js'
import type { ChatOpts } from '../../src/ai/orchestrate/chat.js'
import { isSelfHealRunning } from '../../src/ai/orchestrate/self-heal.js'
import { ccDriver } from '../../src/driver/cc.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/index.js'
import { waitFor } from '../helpers/wait-for.js'

let fake: FakeProvider
const dirs: string[] = []
let ccSession: Session
let opts: ChatOpts

/** submit_chapter 工具入参（assembleChapter 结构化产出；字数红 → 触顶 escalate，链路仍闭合） */
const CHAPTER_INPUT = {
  标题: '第五夜',
  钩子类型: '悬念钩',
  钩子强弱: '中',
  情绪定位: '铺垫',
  正文: '门铃在雨夜里响起，猫眼外没有人。\n\n他打开门，走廊尽头的灯闪了两下，熄了。',
}

beforeAll(async () => {
  fake = await createFakeProvider()
})

/** 桥接 driver：emit 走事件收集型 fake，ctrl 登记族转发真实 ccDriver（登记正本） */
function bridgeDriver(session: Session, emitted: DriverEvent[]): StudioDriver {
  return {
    ...makeFakeDriver({ emitted }),
    registerCtrl: (_s, ctrl, owner) => ccDriver.registerCtrl?.(session, ctrl, owner),
    unregisterCtrl: (_s, ctrl) => ccDriver.unregisterCtrl?.(session, ctrl),
  }
}

beforeEach(async () => {
  delete process.env.CLWRITING_DRIVER
  const workDir = makeDualTrackWorkdir()
  dirs.push(workDir)
  const ud = tempUserData()
  dirs.push(ud)
  withFakeProvider(ud, fake.url)
  ccSession = await ccDriver.startSession(workDir)
  const mainSession: Session = { id: 'main', cwd: workDir, closed: false }
  opts = {
    driver: bridgeDriver(ccSession, []),
    mainSession,
    userDataPath: ud,
    bookRoot: join(workDir, '短篇', SHORT_BOOK),
    bookName: SHORT_BOOK,
    chapter: 5,
  }
})

afterEach(() => {
  ccDriver.dispose(ccSession)
  delete process.env.CLWRITING_DRIVER
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

afterAll(async () => {
  await fake.close()
})

describe('四轮-A402: chat 内嵌写章期间 sync 快照写手腿在途', () => {
  it('执行期间 isWriterRunning=true、结束后 false；chat: 前缀排除口径不翻转（E002 语义保持）', { timeout: 30_000 }, async () => {
    // 模拟 turns.ts 的 chat 腿登记（`chat:<书>` owner 全程在册）——先钉 E002 边界
    const chatLeg = new AbortController()
    ccDriver.registerCtrl!(ccSession, chatLeg, `chat:${SHORT_BOOK}`)
    expect(ccDriver.isWriterRunning!(ccSession)).toBe(false) // 仅对话腿 = 假忙修复语义不翻转
    expect(ccDriver.isRunning!(ccSession)).toBe(true)

    // 首稿生成挂住在途窗口（delayMs）；重写轮（脚本重复末条）不再挂
    fake.setScript([
      { type: 'tool', name: 'submit_chapter', input: CHAPTER_INPUT, delayMs: 1500 },
      { type: 'tool', name: 'submit_chapter', input: CHAPTER_INPUT },
    ])

    const ctrl = new AbortController()
    const tool = executeChatTool({ id: 'c1', name: 'write_chapter', input: { chapter: 5 } }, opts, ctrl.signal)
    // 生成请求已到 stub（runTask 先 register 后发请求）→ 写手腿在册（修复前全程假空闲）
    await waitFor(() => fake.requestCount() >= 1)
    expect(ccDriver.isWriterRunning!(ccSession)).toBe(true)
    expect(isSelfHealRunning(SHORT_BOOK)).toBe(true)

    // 短篇机检字数红 → 3 轮重写触顶 escalate（B-P1-6：escalate 亦 ok——章已落盘）
    const r = await tool
    expect(r.ok).toBe(true)
    // settle 后注销：快照归 false（写手腿收尾，仅剩 chat 腿）
    expect(ccDriver.isWriterRunning!(ccSession)).toBe(false)
    expect(ccDriver.isRunning!(ccSession)).toBe(true) // chat 腿仍在册
    expect(isSelfHealRunning(SHORT_BOOK)).toBe(false)
    ccDriver.unregisterCtrl!(ccSession, chatLeg)
    expect(ccDriver.isRunning!(ccSession)).toBe(false)
  })

  it('/interrupt 全停：在册 self-heal 槽与 chat 腿同中止，槽位即注销（全停语义不变）', { timeout: 30_000 }, async () => {
    fake.setScript([
      { type: 'tool', name: 'submit_chapter', input: CHAPTER_INPUT, delayMs: 8_000 }, // 长挂制造在途窗口
    ])
    const chatLeg = new AbortController()
    ccDriver.registerCtrl!(ccSession, chatLeg, `chat:${SHORT_BOOK}`)

    const ctrl = new AbortController()
    const tool = executeChatTool({ id: 'c2', name: 'write_chapter', input: { chapter: 6 } }, opts, ctrl.signal)
    await waitFor(() => fake.requestCount() >= 1)
    expect(ccDriver.isWriterRunning!(ccSession)).toBe(true)

    // /interrupt → cc interrupt → abortAllCtrls + 全槽注销
    ccDriver.interrupt!(ccSession)
    const r = await tool
    expect(r.ok).toBe(false)
    expect(r.summary).toBe('写章已中断。')
    expect(chatLeg.signal.aborted).toBe(true) // chat 腿同被中止（全停）
    expect(isSelfHealRunning(SHORT_BOOK)).toBe(false)
    expect(ccDriver.isRunning!(ccSession)).toBe(false)
    expect(ccDriver.isWriterRunning!(ccSession)).toBe(false)
  })
})
