/**
 * mock driver(批1):无 CLI / 无认证的假事件流,供前端开发与无认证环境。
 *
 * 架构红线:mock 不调任何大模型(纯定时器模拟流式产出)。
 * 复刻 StudioDriver 契约:spawnRole/send 触发 → 假 role_spawn + 分块 text + usage + done。
 */
import type {
  Session,
  SessionOptions,
  ApprovalResponse,
  DriverEvent,
  StudioDriver,
} from './types.js'

/** 每 session 一个事件总线(push 到队列,stream 排空 / 等) */
interface MockChannel {
  events: DriverEvent[]
  waiters: Array<() => void>
}

const channels = new Map<string, MockChannel>()
const sessions = new Map<string, Session>()
let sessionSeq = 0

function channel(id: string): MockChannel {
  let ch = channels.get(id)
  if (!ch) {
    ch = { events: [], waiters: [] }
    channels.set(id, ch)
  }
  return ch
}

function push(id: string, ev: DriverEvent): void {
  const ch = channel(id)
  ch.events.push(ev)
  for (const w of ch.waiters) w()
  ch.waiters = []
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const mockDriver: StudioDriver = {
  async startSession(cwd: string, _opts?: SessionOptions): Promise<Session> {
    const id = `mock-${Date.now()}-${++sessionSeq}`
    const session: Session = { id, cwd, closed: false }
    channel(id)
    sessions.set(id, session)
    push(id, {
      type: 'init',
      sessionId: id,
      agents: ['writer', 'continuity-review', 'editor-review', 'reader-review', 'analyst'],
      tools: ['Read', 'Edit', 'Write', 'Bash(clwriting:*)'],
    })
    return session
  },

  spawnRole(session: Session, role: string, prompt: string): void {
    void runMockGenerate(session, role, prompt, 'spawnRole')
  },

  send(session: Session, prompt: string): void {
    void runMockGenerate(session, 'main', prompt, 'send')
  },

  async *stream(session: Session): AsyncIterable<DriverEvent> {
    const ch = channel(session.id)
    while (!session.closed) {
      while (ch.events.length) {
        yield ch.events.shift() as DriverEvent
      }
      if (session.closed) return
      await new Promise<void>((resolve) => ch.waiters.push(resolve))
    }
  },

  respondApproval(_session: Session, _approval: ApprovalResponse): void {
    // mock 不产生 approval
  },

  async resume(sessionId: string): Promise<Session> {
    const session = sessions.get(sessionId)
    if (!session || session.closed || !channels.has(sessionId)) {
      throw new Error(`无法恢复未知或已关闭的 mock session:${sessionId}`)
    }
    return session
  },

  dispose(session: Session): void {
    session.closed = true
    const ch = channels.get(session.id)
    if (ch) {
      for (const w of ch.waiters) w()
      ch.waiters = []
    }
    channels.delete(session.id)
    sessions.delete(session.id)
  },
}

/** 三审 lens role 的 mock issues（供三审 e2e 断言意见；evidence 非空过硬闸）。 */
const MOCK_REVIEW_ISSUES = JSON.stringify([
  {
    category: 'pacing',
    severity: 'S3',
    location: '开头',
    evidence: ['主角登场'],
    issue: 'mock 三审：开篇节奏偏快，可加环境铺垫',
    fix: '补充场景描写',
  },
])

/** analyst 各 kind 的 mock 载荷（按 prompt `[kind:x]` 标记分发；B4 四载荷固定 JSON 供 e2e 断言）。 */
const MOCK_ANALYST_PAYLOAD: Record<string, unknown> = {
  score: { score: 8, verdict: 'mock 体验：节奏稳健，爽点集中章尾', dims: { 爽点: 8, 节奏感: 7, 拖沓: 3 } },
  emotion: [
    { seg: '开头', emotion: 0, label: 'mock 平稳' },
    { seg: '高潮', emotion: 2, label: 'mock 高点' },
  ],
  hooks: { hooks: [{ pos: '章尾', type: '悬念钩', strength: 4, note: 'mock 悬念' }], density: '中' },
  style: { drift: 'mock 稳定', 口癖: ['mock 口癖'], 重复度评价: 'mock 正常', 建议: ['mock 建议'] },
  tags: { 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '转折', 场景: '对话' },
}

/** 按 prompt 的 `[kind:x]` 标记挑 analyst mock 载荷；缺省 score（B4.1 先行）。 */
function pickAnalystMock(prompt: string): string {
  const m = prompt.match(/\[kind:([a-z]+)\]/)
  const kind = m?.[1] ?? 'score'
  return JSON.stringify(MOCK_ANALYST_PAYLOAD[kind] ?? MOCK_ANALYST_PAYLOAD['score'])
}

/** 模拟一次单步生成:send 显 role_spawn + 分块 text + usage + done(spawnRole 干净,无 role_spawn) */
async function runMockGenerate(
  session: Session,
  role: string,
  prompt: string,
  mode: 'spawnRole' | 'send',
): Promise<void> {
  if (session.closed) return
  if (mode === 'send') {
    push(session.id, { type: 'role_spawn', role, parentToolUseId: `tu-${Date.now()}` })
  }
  const preview = prompt.length > 30 ? `${prompt.slice(0, 30)}…` : prompt
  const isReviewRole = role.endsWith('-review')
  const isAnalyst = role === 'analyst'
  const sample = isReviewRole
    ? MOCK_REVIEW_ISSUES
    : isAnalyst
      ? pickAnalystMock(prompt)
      : `【mock · ${role}】收到「${preview}」,这是 mock driver 的模拟产出。真 driver(批2)将经 claude CLI 生成。\n`
  for (const chunk of chunkText(sample, 12)) {
    if (session.closed) return
    await sleep(60)
    push(session.id, { type: 'text', text: chunk, role })
  }
  push(session.id, { type: 'usage', cost: 0.0001, tokens: 120 })
  push(session.id, { type: 'done', cost: 0.0001, usage: 120, reason: 'success' })
}

function* chunkText(text: string, size: number): Generator<string> {
  for (let i = 0; i < text.length; i += size) {
    yield text.slice(i, i + size)
  }
}
