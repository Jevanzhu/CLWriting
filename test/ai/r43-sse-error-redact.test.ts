/**
 * R43-19（四十三轮）：SSE 错误事件脱敏第二层——行为断言。
 *
 * finishTurn 是 chat_error 的单一出口（六失败出口收敛）：{error} 分支的文案源自
 * provider 异常 message，可含 API Key 痕迹；R43-19 起 error 字段过 redactSecret
 * （与 stream.ts:216 R26-8 同款）再 emit。固定文案（超时/中断/截断）不匹配凭据
 * 模式，幂等无变化——chat-exits.test.ts 的既有文案断言即此对照。
 * self-heal/turns 的 onRetry warning 同模板同口径（redactSecret 包裹 error 再拼接）。
 */
import { describe, expect, it } from 'vitest'
import { finishTurn } from '../../src/ai/orchestrate/chat/finish.js'
import { redactSecret } from '../../src/ai/provider/redact.js'
import type { SessionRecorder } from '../../src/events/chat-bridge.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/types.js'
import type { ChatOpts } from '../../src/ai/orchestrate/chat.js'

const FAKE_KEY = 'sk-abcdef0123456789wxyz'

function makeDriver(events: DriverEvent[]): StudioDriver {
  return {
    async startSession(cwd: string): Promise<Session> {
      return { id: 'mock', cwd, closed: false }
    },
    async *stream(): AsyncGenerator<DriverEvent> {},
    dispose(): void {},
    emit(_s: Session, ev: DriverEvent): void {
      events.push(ev)
    },
  }
}

describe('R43-19: chat_error 文案过 redactSecret', () => {
  it('error 分支携带 sk- key → emit 出的 chat_error 已 ***REDACTED***，key 不残留', () => {
    const events: DriverEvent[] = []
    const opts = {
      driver: makeDriver(events),
      mainSession: { id: 's1', cwd: '/tmp/r43-redact', closed: false },
      userDataPath: null,
      bookRoot: '/tmp/r43-redact',
      bookName: 'r43-redact-check',
    } as unknown as ChatOpts
    const recorder = { closeMaskingAll: () => undefined } as unknown as SessionRecorder

    finishTurn(opts, [], 0, recorder, { error: `provider 请求失败：${FAKE_KEY}` })

    const ev = events[0] as { type: string; error: string } | undefined
    expect(ev?.type).toBe('chat_error')
    expect(ev?.error).toContain('***REDACTED***')
    expect(ev?.error).not.toContain(FAKE_KEY)
  })

  it('固定文案（中断）不匹配凭据模式 → 幂等无变化（对照组）', () => {
    const events: DriverEvent[] = []
    const opts = {
      driver: makeDriver(events),
      mainSession: { id: 's1', cwd: '/tmp/r43-redact', closed: false },
      userDataPath: null,
      bookRoot: '/tmp/r43-redact',
      bookName: 'r43-redact-fixed',
    } as unknown as ChatOpts
    const recorder = { closeMaskingAll: () => undefined } as unknown as SessionRecorder

    finishTurn(opts, [], 0, recorder, 'interrupted')

    const ev = events[0] as { type: string; error: string } | undefined
    expect(ev?.error).toBe('已中断')
  })

  it('self-heal/turns onRetry warning 模板同口径：redactSecret(error) 后拼接，key 不进拼接串', () => {
    // 模板实体（self-heal.ts / turns.ts 同款）：`AI 响应异常（${redactSecret(error)}），第 N 次重试中…`
    const warning = `AI 响应异常（${redactSecret(`HTTP 429 too many requests ${FAKE_KEY}`)}），第 2 次重试中…`
    expect(warning).toContain('***REDACTED***')
    expect(warning).not.toContain(FAKE_KEY)
  })
})
