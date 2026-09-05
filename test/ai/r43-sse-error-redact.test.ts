/**
 * R43-19（四十三轮）：SSE 错误事件脱敏第二层——行为断言。
 *
 * finishTurn 是 chat_error 的单一出口（六失败出口收敛）：{error} 分支的文案源自
 * provider 异常 message，可含 API Key 痕迹；R43-19 起 error 字段过 redactSecret
 * （与 stream.ts:216 R26-8 同款）再 emit。固定文案（超时/中断/截断）不匹配凭据
 * 模式，幂等无变化——chat-exits.test.ts 的既有文案断言即此对照。
 * self-heal/turns 的 onRetry warning 同模板同口径（redactSecret 包裹 error 再拼接）。
 * R49-1：finish.ts 摘要调用（summarizeCheckpoint）的 onRetry 漏同款——补齐后以
 * mock runTask 直喂原始 error 驱动真回调断言（适配器第一层已脱敏，真 HTTP 链路
 * 无法区分本层是否生效，故在插值点上游注入未脱敏形态）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/ai/runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ai/runner.js')>()),
  runTask: vi.fn(),
}))

import { finishTurn, finalizeHistory } from '../../src/ai/orchestrate/chat/finish.js'
import { runTask } from '../../src/ai/runner.js'
import { compactionSuppressed, histories, msgSeqMap, type ChatRunState } from '../../src/ai/orchestrate/chat/state.js'
import { redactSecret } from '../../src/ai/provider/redact.js'
import type { SessionRecorder } from '../../src/events/chat-bridge.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/types.js'
import type { ChatOpts } from '../../src/ai/orchestrate/chat.js'
import type { ChatMsg } from '../../src/ai/provider/types.js'

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

describe('R49-1：历史压缩摘要 onRetry warning 过 redactSecret', () => {
  const book = 'r49-onretry-check'

  afterEach(() => {
    histories.delete(book)
    msgSeqMap.delete(book)
    compactionSuppressed.delete(book)
    vi.mocked(runTask).mockReset()
  })

  it('摘要 runTask 收到未脱敏 sk- key error → emit 出的 warning 已掩码，key 不残留', async () => {
    const events: DriverEvent[] = []
    const opts = {
      driver: makeDriver(events),
      mainSession: { id: 's1', cwd: '/tmp/r43-redact', closed: false },
      userDataPath: null,
      bookRoot: '/tmp/r43-redact',
      bookName: book,
    } as unknown as ChatOpts
    const state: ChatRunState = {
      ctrl: new AbortController(),
      deadline: Number.MAX_SAFE_INTEGER,
      pending: new Map(),
    }
    const recorder = { close: () => 901 } as unknown as SessionRecorder

    // 11 回合（22 条）溢出历史 → finalizeHistory 走 checkpoint 摘要分支（compaction.ts 真逻辑）
    const history: ChatMsg[] = []
    for (let i = 1; i <= 11; i++) {
      history.push({ role: 'user', content: `问题${i}：` + '情节'.repeat(40) })
      history.push({ role: 'assistant', content: `回答${i}：` + '内容'.repeat(40) })
    }
    const seqs = history.map((_, i) => [100 + i])

    // 模拟 runner.ts:658 直传原始 e.message（上游未脱敏形态）：首次 attempt 失败 → onRetry → 重试成功
    vi.mocked(runTask).mockImplementationOnce((async (task: { onRetry?: (attempt: number, error: string) => void }) => {
      task.onRetry?.(0, `HTTP 500 upstream 崩溃：${FAKE_KEY}`)
      return { ok: true, data: { text: '累计摘要：第一卷推进完毕。', usage: null, stopReason: 'stop' } }
    }) as unknown as typeof runTask)

    await finalizeHistory(opts, history, seqs, recorder, 'sys', state)

    const warnings = events.filter((e) => e.type === 'warning') as { message: string }[]
    expect(warnings.length).toBe(1)
    expect(warnings[0]!.message).toContain('历史压缩摘要生成异常')
    expect(warnings[0]!.message).toContain('***REDACTED***')
    expect(warnings[0]!.message).not.toContain(FAKE_KEY)
    expect(warnings[0]!.message).toContain('第 1 次重试中')
    // 摘要成功 → 压缩发生（非 fail-open），证明警告确出自摘要链路的重试回调
    expect(histories.get(book)!.length).toBeLessThan(22)
  })
})
