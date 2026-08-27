/**
 * Y-P2-4 治理测试：「模型可见 ⟺ 已记录」校验器 verifyVisibleRecorded 的管线级回归锚
 * （CLAUDE.md AI 链路守则第一条的落地；模式同 dependency-direction.test.ts 的常驻守护）。
 *
 * 背景：src/events/lineage.ts 的 verifyVisibleRecorded 此前零生产调用（y 轮评审发现）。
 * 拍板：不接运行时，接成测试门——用真实管线（fake provider 驱动 runChat，事件落
 * tmp userData 的 SQLite 事件库）产出的事件流验证校验器：
 * - 正向：管线登记的 settings/snapshot 与「模型实际看见的 settings」配对通过校验；
 * - 负向：对同一真实事件流做破坏（删记录 / 指纹漂移），校验器必须报违规——证明有牙；
 * - 缺口接线（G2-2 已翻转）：chapter（revision/ref）与 skills（skills/snapshot）注入
 *   均有登记，且可见侧改走生产收集器 visibleInjections → 全量 visible 校验通过；
 *   本用例原为缺口固化（TODO Y-P2-4），接线完成时翻转，防断言僵尸。
 *
 * 「可见」侧的两条来源（防循环论证；G2-2 起注入清单由生产收集器产出，不再手工拼）：
 * 1. 生产 prompt 组装函数 buildChatContext 重建 ctx（同一 bookRoot/chapter/userDataPath）
 *    → visibleInjections(ctx) 推导注入清单（settings/chapter/skills 的注入条件与
 *    chatSystem 一一镜像）；
 * 2. 锚点断言：注入原文（settings / skills 索引）确实出现在发往 provider 的
 *    system prompt 里（fake.lastBody）。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createFakeProvider, type FakeProvider } from '../ai/fake-provider.js'
import { withFakeProvider, tempUserData, makeDualTrackWorkdir } from '../studio/fixtures.js'
import { runChat } from '../../src/ai/orchestrate/chat.js'
import { buildChatContext, visibleInjections, visibleInjectionsFromDigests, type ChatContext } from '../../src/ai/prompts/chat.js'
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

/** 重建「模型可见」侧：生产收集器 visibleInjections 产出（G2-2 起不再手工拼 {scope,digest}——
 *  同一 bookRoot/chapter/userDataPath 重建 ctx，注入条件与 chatSystem 镜像） */
function visibleAll(ud: string): VisibleInjection[] {
  const ctx = buildChatContext(bookRoot, 1, { userDataPath: ud })
  return visibleInjections(ctx)
}

/** 聚焦 settings scope 的可见侧——负向两用例的破坏面只落在 settings/snapshot 上，
 *  可见侧须同步收窄（保持原断言语义：missing 恰为整份 visible） */
function visibleSettings(ud: string): VisibleInjection[] {
  return visibleAll(ud).filter((v) => v.scope === 'settings')
}

/** 在 tmp 工作区放一个可被发现的技巧包（项目根 <bookRoot>/设定/技巧/*.md，DSH-18 三根之首）。
 *  捆绑根 resources/skills 现有内容恰使 skillsIndex 非空，但测试自持不依赖它——
 *  仓库捆绑包增删不该悄悄改变本文件的判据 */
function plantProjectSkill(): void {
  mkdirSync(join(bookRoot, '设定', '技巧'), { recursive: true })
  writeFileSync(
    join(bookRoot, '设定', '技巧', '测试技巧.md'),
    '---\nname: 测试技巧\ndescription: 治理测试专用技巧包\nwhenToUse: 验证 skills 注入血缘时。\n---\n\n测试技巧正文。',
  )
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

  it('缺口接线翻转（G2-2，原 TODO Y-P2-4）：chapter/skills 注入均有登记，收集器产出的全量 visible 全部 present', async () => {
    plantProjectSkill()
    fake.setScript([{ type: 'text', content: '这一章的钩子可以再强一点。' }])
    const ud = setup()
    await runOne(ud, 'gov-gap', '第 1 章写得怎么样？', 1)

    const evs = collectEvents(ud, 'gov-gap')
    const ctx = buildChatContext(bookRoot, 1, { userDataPath: ud })
    expect(ctx.currentChapter).toBeDefined()

    // chapter 注入对模型可见（进 system prompt 的「作者指定讨论的章节」段），
    // 管线以 revision/ref（{chapter,revision,path}）登记血缘；G2-1 起校验器把
    // revision/ref 归一化为 {scope:'chapter', digest:revision} 一并消费
    const revRef = evs.find((e) => e.type === 'revision/ref')
    expect(revRef).toBeDefined()
    expect((revRef!.data as { revision: string }).revision).toBe(digest16(ctx.currentChapter!))

    // G2-2 翻转后的通过断言：visible 侧改由生产收集器产出（不再手工拼 {scope,digest}），
    // 全量注入（settings + chapter + skills）对真实事件流校验 missing 为空——
    // 「模型可见 ⟺ 已记录」在本管线成立
    const visible = visibleInjections(ctx)
    expect(visible.map((v) => v.scope)).toEqual(['settings', 'chapter', 'skills'])
    const check = verifyVisibleRecorded(visible, evs)
    expect(check.missing).toEqual([])
    expect(check.present).toBe(visible.length)

    // 负向·登记漂移：revision/ref 的 revision 指纹被篡改 → chapter 注入报缺失
    //（证明上方的匹配不是空转——归一化消费真的在对指纹）
    const sabotaged = evs.map((e) =>
      e.type === 'revision/ref'
        ? { ...e, data: { ...(e.data as Record<string, unknown>), revision: 'deadbeefdeadbeef' } }
        : e,
    )
    const chapterInj = visible.find((v) => v.scope === 'chapter')!
    const check2 = verifyVisibleRecorded(visible, sabotaged)
    expect(check2.missing).toEqual([chapterInj])
    expect(check2.present).toBe(visible.length - 1)
  })

  it('skills 注入·正向（G2-2）：项目技巧包进索引 → 管线登记 skills/snapshot，收集器全量 visible 全部 present', async () => {
    plantProjectSkill()
    fake.setScript([{ type: 'text', content: '我会按技巧包里的清单来讨论。' }])
    const ud = setup()
    await runOne(ud, 'gov-skills', '帮我看看第 1 章的场面调度', 1)

    const evs = collectEvents(ud, 'gov-skills')
    // 前提自查：技巧包确实进了可见侧（收集器产出 skills 注入）且管线确实登记了
    // skills/snapshot——任一不成立说明 fixture/接线退化，而非校验器失守
    const ctx = buildChatContext(bookRoot, 1, { userDataPath: ud })
    const visible = visibleInjections(ctx)
    expect(visible.some((v) => v.scope === 'skills')).toBe(true)
    expect(evs.filter((e) => e.type === 'skills/snapshot').length).toBeGreaterThanOrEqual(1)

    // 锚点断言（防循环论证）：技巧包索引原文确实出现在发往 provider 的 system prompt 里
    const body = fake.lastBody() as { messages: Array<{ role: string; content: unknown }> }
    expect(
      typeof body.messages[0]!.content === 'string' && (body.messages[0]!.content as string).includes(ctx.skillsIndex!),
      'skills 索引未出现在实际请求的 system prompt——「可见」侧推导失真',
    ).toBe(true)

    const check = verifyVisibleRecorded(visible, evs)
    expect(check.missing).toEqual([])
    expect(check.present).toBe(visible.length)
  })

  it('skills 注入·负向（G2-2）：从事件流抽掉 skills/snapshot → 校验器精确报 skills 注入缺失（有牙）', async () => {
    plantProjectSkill()
    fake.setScript([{ type: 'text', content: '好的，我们聊聊场面调度。' }])
    const ud = setup()
    await runOne(ud, 'gov-skills-del', '聊聊场面调度', 1)

    const evs = collectEvents(ud, 'gov-skills-del')
    const visible = visibleAll(ud)
    expect(verifyVisibleRecorded(visible, evs).missing).toEqual([])

    // 破坏：抽掉 skills/snapshot 登记 → skills 注入「模型可见但不可回溯」，
    // 其余注入（settings/chapter）不受牵连——缺失精确落在被破坏的那条
    const sabotaged = evs.filter((e) => e.type !== 'skills/snapshot')
    const skillsInj = visible.find((v) => v.scope === 'skills')!
    const check = verifyVisibleRecorded(visible, sabotaged)
    expect(check.missing).toEqual([skillsInj])
    expect(check.present).toBe(visible.length - 1)
  })
})

// ── R66-9（十四轮）：可见清单单源一致性 ──────────────────────────────────
// CLW_VERIFY_VISIBLE 诊断开关（turns.ts）此前手工镜像 visibleInjections 形状——
// 两侧改拼接源即失配（恰是开关要抓的漂移）。形状逻辑下沉 FromDigests 单源后，
// 两入口对同一 ctx 必须产出逐项相等。
describe('R66-9: 可见清单单源一致性（visibleInjections ↔ FromDigests）', () => {
  it('三注入齐全 → 两入口产出逐项相等', () => {
    const ctx: ChatContext = {
      settings: '设定段落甲',
      currentChapter: '正文段落乙',
      skillsIndex: '技巧索引丙',
      files: [],
    }
    expect(
      visibleInjectionsFromDigests({
        settings: digest16(ctx.settings),
        chapter: digest16(ctx.currentChapter!),
        skills: digest16(ctx.skillsIndex!),
      }),
    ).toEqual(visibleInjections(ctx))
  })

  it('条件注入缺席（无章/无技巧）→ 两入口仍一致（settings 恒在）', () => {
    const bare: ChatContext = { settings: '只有设定', files: [] }
    expect(visibleInjectionsFromDigests({ settings: digest16('只有设定') })).toEqual(
      visibleInjections(bare),
    )
  })
})
