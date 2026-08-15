/**
 * Y-P2-4 治理测试：「模型可见 ⟺ 已记录」校验器 verifyVisibleRecorded 的管线级回归锚
 * （CLAUDE.md AI 链路守则第一条的落地；模式同 dependency-direction.test.ts 的常驻守护）。
 *
 * 背景：src/events/lineage.ts 的 verifyVisibleRecorded 此前零生产调用（y 轮评审发现）。
 * 拍板：不接运行时，接成测试门——用真实管线（fake provider 驱动 runChat，事件落
 * tmp userData 的 SQLite 事件库）产出的事件流验证校验器：
 * - 正向：管线登记的 settings/snapshot 与「模型实际看见的 settings」配对通过校验；
 * - 负向：对同一真实事件流做破坏（删记录 / 指纹漂移），校验器必须报违规——证明有牙；
 * - 缺口固化：chapter 正文注入以 revision/ref 登记（载荷形状不被校验器消费）→
 *   如实断言其缺失，接线完成后翻转本用例（防缺口断言变僵尸，同 KNOWN 白名单思路）。
 *
 * 「可见」侧的两条来源（防循环论证）：
 * 1. 生产 prompt 组装函数 buildChatContext 重建（同一 bookRoot/chapter/userDataPath）；
 * 2. 锚点断言：settings 原文确实出现在发往 provider 的 system prompt 里（fake.lastBody）。
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider } from '../ai/fake-provider.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { runChat } from '../../src/ai/orchestrate/chat.js'
import { buildChatContext } from '../../src/ai/prompts/chat.js'
import { openSessionStore } from '../../src/events/store.js'
import { digest16, verifyVisibleRecorded, type VisibleInjection } from '../../src/events/lineage.js'
import type { ChatEvent } from '../../src/events/types.js'
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

/** 跑一轮真实（fake provider）对话管线；chapter 传入则以章节上下文运行 */
async function runOne(ud: string, bookName: string, message: string, chapter?: number): Promise<void> {
  const events: DriverEvent[] = []
  await runChat({
    driver: makeDriver(events),
    mainSession: { id: 's1', cwd: bookRoot, closed: false },
    userDataPath: ud,
    bookRoot,
    bookName,
    message,
    chapter,
  })
}

/** 读回管线落在事件库的会话事件流（对话会话 book = bookName） */
function collectEvents(ud: string, bookName: string): ChatEvent[] {
  const store = openSessionStore(ud, bookRoot)!
  try {
    return store.listEvents(bookName)
  } finally {
    store.close()
  }
}

/** 重建「模型可见」侧：生产 buildChatContext（与 runChat 内部同一入参） */
function visibleSettings(ud: string): VisibleInjection[] {
  const ctx = buildChatContext(bookRoot, 1, { userDataPath: ud })
  return [{ scope: 'settings', digest: digest16(ctx.settings) }]
}

describe('Y-P2-4 治理：模型可见 ⟺ 已记录（verifyVisibleRecorded 管线级回归锚）', () => {
  it('正向：真实管线（含工具调用回合）产出的事件流通过校验——注入的 settings 有同 scope+digest 的 settings/snapshot', async () => {
    // 脚本含 readonly 工具往返（book_search 自动执行）→ 两轮 agent turn，每轮各登记一次血缘
    fake.setScript([
      { type: 'tool', name: 'book_search', input: { query: '玉佩' } },
      { type: 'text', content: '已检索，玉佩线索埋在第 1 章。' },
    ])
    const ud = setup()
    await runOne(ud, 'gov-vis', '帮我搜一下玉佩的线索', 1)

    const evs = collectEvents(ud, 'gov-vis')
    // 前提自查：这轮管线确实走了工具往返 + 血缘登记（任一不成立说明本测试已退化，而非校验器失守）
    expect(evs.filter((e) => e.type === 'tool/result')).toHaveLength(1)
    expect(evs.filter((e) => e.type === 'settings/snapshot').length).toBeGreaterThanOrEqual(1)
    expect(evs.filter((e) => e.type === 'revision/ref').length).toBeGreaterThanOrEqual(1)

    // 锚点断言（防循环论证）：重建出的 settings 原文确实出现在发往 provider 的 system prompt 里
    const ctx = buildChatContext(bookRoot, 1, { userDataPath: ud })
    const body = fake.lastBody() as { messages: Array<{ role: string; content: unknown }> }
    expect(body.messages[0]!.role).toBe('system')
    expect(
      typeof body.messages[0]!.content === 'string' && (body.messages[0]!.content as string).includes(ctx.settings),
      'settings 原文未出现在实际请求的 system prompt——「可见」侧推导失真',
    ).toBe(true)

    // 治理判据：模型可见的 settings 注入，事件流中有同 scope+digest 的 settings/snapshot 记录
    const visible = visibleSettings(ud)
    const check = verifyVisibleRecorded(visible, evs)
    expect(check.missing).toEqual([])
    expect(check.present).toBe(visible.length)
  })

  it('负向·删记录：从真实事件流剔除 settings/snapshot → 校验器报注入缺失（有牙证明一）', async () => {
    fake.setScript([{ type: 'text', content: '好的，我们聊聊设定。' }])
    const ud = setup()
    await runOne(ud, 'gov-del', '聊聊玉佩', 1)

    const evs = collectEvents(ud, 'gov-del')
    const visible = visibleSettings(ud)
    // 自查：未破坏前通过——保证下面的失败确由破坏引起，不是环境噪音
    expect(verifyVisibleRecorded(visible, evs).missing).toEqual([])

    // 破坏：模拟「登记丢失」（事件库无记录 = 模型可见但不可回溯）
    const sabotaged = evs.filter((e) => e.type !== 'settings/snapshot')
    const check = verifyVisibleRecorded(visible, sabotaged)
    expect(check.present).toBe(0)
    expect(check.missing).toEqual(visible)
  })

  it('负向·指纹漂移：settings/snapshot 的 digest 与实际注入不符 → 校验器报缺失（有牙证明二）', async () => {
    fake.setScript([{ type: 'text', content: '好的，我们聊聊设定。' }])
    const ud = setup()
    await runOne(ud, 'gov-tamper', '聊聊玉佩', 1)

    const evs = collectEvents(ud, 'gov-tamper')
    const visible = visibleSettings(ud)
    expect(verifyVisibleRecorded(visible, evs).missing).toEqual([])

    // 破坏：记录存在但指纹错（模拟「登记时内容已变 / 登记错版本」——scope 对得上也无效）
    const sabotaged = evs.map((e) =>
      e.type === 'settings/snapshot'
        ? { ...e, data: { ...(e.data as Record<string, unknown>), digest: 'deadbeefdeadbeef' } }
        : e,
    )
    const check = verifyVisibleRecorded(visible, sabotaged)
    expect(check.present).toBe(0)
    expect(check.missing).toEqual(visible)
  })

  it('已知缺口固化（TODO Y-P2-4）：chapter 正文注入以 revision/ref 登记，校验器只认 settings/snapshot → 如实报缺失', async () => {
    fake.setScript([{ type: 'text', content: '这一章的钩子可以再强一点。' }])
    const ud = setup()
    await runOne(ud, 'gov-gap', '第 1 章写得怎么样？', 1)

    const evs = collectEvents(ud, 'gov-gap')
    const ctx = buildChatContext(bookRoot, 1, { userDataPath: ud })
    expect(ctx.currentChapter).toBeDefined()

    // chapter 注入对模型可见（进 system prompt 的「作者指定讨论的章节」段），
    // 管线也确实登记了血缘——但形状是 revision/ref（{chapter,revision,path}），
    // 不是校验器消费的 settings/snapshot（{scope,digest}）→ 校验器只能报缺失。
    const revRef = evs.find((e) => e.type === 'revision/ref')
    expect(revRef).toBeDefined()
    expect((revRef!.data as { revision: string }).revision).toBe(digest16(ctx.currentChapter!))

    const visible: VisibleInjection[] = [
      ...visibleSettings(ud),
      { scope: 'chapter', digest: digest16(ctx.currentChapter!) },
    ]
    const check = verifyVisibleRecorded(visible, evs)
    expect(check.missing).toEqual([{ scope: 'chapter', digest: digest16(ctx.currentChapter!) }])

    // TODO(Y-P2-4) 管线级接线缺口（接线完成后翻转本用例为通过断言）：
    // 1) chapter 注入：runChat 以 revision/ref 登记（chat.ts:542），verifyVisibleRecorded
    //    只匹配 settings/snapshot 的 scope+digest，两种载荷形状不互通；
    // 2) skillsIndex（DSH-18）注入 system prompt 但完全无登记（本 fixture 技巧包为空，
    //    恰好未触发；有技巧包的环境下「可见 ⟺ 已记录」不成立）；
    // 3) 「可见」侧无生产收集器：VisibleInjection[] 由 runChat 手工登记时隐式得知，
    //    prompt 组装函数（buildChatContext）不产出注入清单，校验器因此无法在生产侧自证。
  })
})
