/**
 * 0918三拍板批（A006 轻量档）回归：失败出口回显作者原文。
 *
 * 现状（拍板维持）：六失败出口统一回滚 + 遮蔽本回合 user 消息（P1-S4/R1a 防连续
 * user → Anthropic 400 + F1-P1 防重放废数据），瞬态失败（429 耗尽/断网）也吞——
 * 作者长指令须整段重打。拍板改法（轻量档）：chat_error 随带 echo 字段回显原文，
 * 前端「复制重发」；回滚/遮蔽语义分毫不动。echo 只走 SSE 内存链不落事件库
 *（DriverEvent 与落库 EventType 两套字典，chat_error 无 recorder.add 路径）。
 *
 * 本文件直测 finishTurn 单元（六出口唯一咽喉，集成面由 chat-exits.test.ts
 * assertExit 扩例覆盖全部六出口）：
 * ① 三类 reason（{error}/timeout/interrupted）均随 echo 回显原文；
 * ② regenerate 回合无 echo（原文在 baseLen 之前的恢复历史里、不随回滚消失）；
 * ③ message 为空不随 echo（空串无回显价值）；
 * ④ echo 原样往返不过 redactSecret（脱敏即破坏复制重发可用性）——对照 error 文案
 *    仍走 redactSecret（R43-19 口径）。
 */
import { describe, expect, it, vi } from 'vitest'
import { finishTurn } from '../../src/ai/orchestrate/chat/finish.js'
import type { ChatOpts } from '../../src/ai/orchestrate/chat.js'
import type { ChatMsg } from '../../src/ai/provider/types.js'
import type { SessionRecorder } from '../../src/events/chat-bridge.js'
import type { DriverEvent } from '../../src/driver/types.js'

type ChatErrorEvent = Extract<DriverEvent, { type: 'chat_error' }>

function makeOpts(message?: string, regenerate?: boolean): ChatOpts {
  const events: DriverEvent[] = []
  return {
    driver: { emit: (_s: unknown, ev: DriverEvent) => void events.push(ev) },
    mainSession: { id: 's1', cwd: '/tmp/x', closed: false },
    message,
    ...(regenerate ? { regenerate: { parentSeq: 1, branchId: 'b' } } : {}),
    __events: events,
  } as unknown as ChatOpts
}

function emitted(opts: ChatOpts): ChatErrorEvent[] {
  return ((opts as unknown as { __events: DriverEvent[] }).__events
    .filter((e) => e.type === 'chat_error')) as ChatErrorEvent[]
}

const HISTORY = (): ChatMsg[] => [{ role: 'user', content: '旧消息' }]

function expectEcho(opts: ChatOpts): ChatErrorEvent {
  const errs = emitted(opts)
  expect(errs.length).toBeGreaterThan(0)
  return errs[0]!
}

describe('A006 轻量档：chat_error 回显作者原文', () => {
  it('① {error} 出口 → echo = 作者原文（回滚后原文仅存于事件）', () => {
    const opts = makeOpts('请帮我把第三章的伏笔全部收掉', false)
    finishTurn(opts, HISTORY(), 1, { closeMaskingAll: vi.fn() } as unknown as SessionRecorder, {
      error: '上游 429 耗尽',
    })
    const err = expectEcho(opts)
    expect(err.error).toBe('上游 429 耗尽')
    expect(err.echo).toBe('请帮我把第三章的伏笔全部收掉')
  })

  it('① timeout / interrupted 出口同款回显', () => {
    const t = makeOpts('超时前的长指令', false)
    finishTurn(t, HISTORY(), 1, { closeMaskingAll: vi.fn() } as unknown as SessionRecorder, 'timeout')
    expect(emitted(t)[0]!.echo).toBe('超时前的长指令')

    const i = makeOpts('中断前的长指令', false)
    finishTurn(i, HISTORY(), 1, { closeMaskingAll: vi.fn() } as unknown as SessionRecorder, 'interrupted')
    expect(emitted(i)[0]!.echo).toBe('中断前的长指令')
  })

  it('② regenerate 回合无 echo（原文在恢复历史里、不随回滚消失）', () => {
    const opts = makeOpts(undefined, true)
    finishTurn(opts, HISTORY(), 1, { closeMaskingAll: vi.fn() } as unknown as SessionRecorder, {
      error: 'x',
    })
    expect(expectEcho(opts).echo).toBeUndefined()
  })

  it('③ message 为空不随 echo', () => {
    const opts = makeOpts('', false)
    finishTurn(opts, HISTORY(), 1, { closeMaskingAll: vi.fn() } as unknown as SessionRecorder, {
      error: 'x',
    })
    expect(emitted(opts)[0]!.echo).toBeUndefined()
  })

  it('④ echo 原样往返不过 redactSecret；error 文案仍脱敏（R43-19 口径）', () => {
    const secret = 'sk-ant-api03-0123456789abcdef0123456789abcdef'
    const opts = makeOpts(`我的密钥是 ${secret}，请检查配置`, false)
    finishTurn(opts, HISTORY(), 1, { closeMaskingAll: vi.fn() } as unknown as SessionRecorder, {
      error: `鉴权失败：${secret}`,
    })
    const err = expectEcho(opts)
    // error：凭据模式被脱敏
    expect(err.error).not.toContain(secret)
    // echo：作者原文原样往返（复制重发可用性优先——脱敏后的密文无法重放输入）
    expect(err.echo).toBe(`我的密钥是 ${secret}，请检查配置`)
  })
})
