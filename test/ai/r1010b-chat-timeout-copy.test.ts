/**
 * R1010b-AI-P3-3（2026-09-10 内存专项重审修复批）回归：chat 超时文案按实际生效
 * deadline 换算（CC-P2-2 起 opts.deadlineMs 可注入）。
 *
 * 修复前：CHAT_EXIT_SPEC.timeout 恒按缺省 AGENT_DEADLINE_MS（30min）换算——注入短
 * deadline 的对话超时也报「超过 30 分钟」，文案与实际生效值漂移（R70-12 注释自认
 * 「文案按缺省口径展示」）。修复后：finishTurn 按 opts.deadlineMs ?? AGENT_DEADLINE_MS
 * 现算（与 chat.ts runChatInner 的 resolve 同式），mask 终态口径（aborted）不变。
 */
import { describe, expect, it, vi } from 'vitest'
import { finishTurn } from '../../src/ai/orchestrate/chat/finish.js'
import { SessionRecorder } from '../../src/events/chat-bridge.js'
import type { ChatOpts } from '../../src/ai/orchestrate/chat.js'
import type { DriverEvent, Session } from '../../src/driver/types.js'

function makeOpts(deadlineMs?: number): { opts: ChatOpts; emitted: DriverEvent[] } {
  const emitted: DriverEvent[] = []
  const opts: ChatOpts = {
    driver: {
      async startSession(cwd: string): Promise<Session> {
        return { id: 'mock', cwd, closed: false }
      },
      async *stream(): AsyncGenerator<DriverEvent> {},
      dispose(): void {},
      emit(_s, ev): void {
        emitted.push(ev)
      },
    },
    mainSession: { id: 's1', cwd: '.', closed: false },
    userDataPath: '.',
    bookRoot: '.',
    bookName: 'r1010b-timeout-copy',
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
  }
  return { opts, emitted }
}

function chatError(emitted: DriverEvent[]): string {
  const err = emitted.find((e) => e.type === 'chat_error') as { error: string } | undefined
  expect(err).toBeDefined()
  return err!.error
}

describe('R1010b-AI-P3-3：超时文案按实际生效 deadline 换算', () => {
  it('注入 deadlineMs → 文案随注入值换算；缺省 → 恒按 30 分钟；mask 终态口径不变', () => {
    const maskSpy = vi.spyOn(SessionRecorder.prototype, 'closeMaskingAll')
    try {
      // 注入 40ms（既有 chat-exits 注入形态）→ 按实际值换算，不再谎报 30 分钟
      const injected = makeOpts(40)
      finishTurn(injected.opts, [], 0, new SessionRecorder(null, 'r1010b-rec-1'), 'timeout')
      expect(chatError(injected.emitted)).toBe('对话超时（超过 0 分钟），已停止')

      // 分钟级注入值 → 四舍五入换算（45s → 1 分钟）
      const minute = makeOpts(45_000)
      finishTurn(minute.opts, [], 0, new SessionRecorder(null, 'r1010b-rec-2'), 'timeout')
      expect(chatError(minute.emitted)).toBe('对话超时（超过 1 分钟），已停止')

      // 缺省（生产路径）→ 30 分钟口径不变
      const def = makeOpts()
      finishTurn(def.opts, [], 0, new SessionRecorder(null, 'r1010b-rec-3'), 'timeout')
      expect(chatError(def.emitted)).toBe('对话超时（超过 30 分钟），已停止')

      // 终态 mask 三处一致（session/end 实参），参数化只动文案
      expect(maskSpy).toHaveBeenNthCalledWith(1, 'aborted')
      expect(maskSpy).toHaveBeenNthCalledWith(2, 'aborted')
      expect(maskSpy).toHaveBeenNthCalledWith(3, 'aborted')
    } finally {
      maskSpy.mockRestore()
    }
  })
})
