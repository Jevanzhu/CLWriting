/**
 * 重评二轮-P3-2（2026-09-13 全库源码重评二轮 GLM-5.3）：clearChatHistory 的
 * opts.gate 清库前复查闸语义（单源 helper = audit.ts chatClearGateReason 六闸，
 * 由 stream.ts chat.clear 接线）。
 *
 * 修复背景：openSessionStoreAsync 的 await 让出窗口内新起任务（chat/spawn/
 * self-heal/三审/task-gate/后台收尾）时入口闸检已过、清库照走——任务收尾继续向
 * 已清 session 追加事件（清不彻底 + 事件复活）。修法 = 窗口后 clearBooks 前经
 * gate 回调复查，非 null 即拒清（返回理由由调用方转 409），双键事件库原样保旧。
 *
 * 本文件钉 state.ts 机制面（gate 触发/放行/缺省三态）；端点接线面（入口收编 +
 * audit DELETE 同口径）见 test/studio/chat-clear-gates.test.ts。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { clearChatHistory } from '../../src/ai/orchestrate/chat.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const BOOK = '重验闸书'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 播种双键各一条事件（对话 bookName / 工作流 bookHash），返回 ud + bookRoot。 */
function seed(): { ud: string; bookRoot: string } {
  const ud = mkdtempTracked(join(tmpdir(), 'clw-clear-gate-'))
  dirs.push(ud)
  const bookRoot = join(ud, '长篇', BOOK)
  const store = openSessionStore(ud, bookRoot)!
  const chatSid = store.createSession(BOOK)
  store.appendEvent(chatSid, { type: 'user/message', data: { message: 'm' }, surfaceOp: 'append' })
  const wsSid = store.workspaceSession(bookHash(bookRoot))
  store.appendEvent(wsSid, { type: 'llm/call', data: { task: 'chat' } })
  store.close()
  return { ud, bookRoot }
}

function counts(ud: string, bookRoot: string): { chat: number; ws: number } {
  const s = openSessionStore(ud, bookRoot)!
  try {
    return {
      chat: s.listEvents(BOOK).length,
      ws: s.listEvents(bookHash(bookRoot)).length,
    }
  } finally {
    s.close()
  }
}

describe('重评二轮-P3-2: clearChatHistory gate 清库前复查', () => {
  it('gate 触发 → 返回拒清理由，双键事件库原样（clearBooks 未执行）', async () => {
    const { ud, bookRoot } = seed()
    const reason = await clearChatHistory(BOOK, ud, bookRoot, { gate: () => '本书有任务在跑（analyze），先等它完成后再清空对话' })
    expect(reason).toBe('本书有任务在跑（analyze），先等它完成后再清空对话')
    expect(counts(ud, bookRoot)).toEqual({ chat: 1, ws: 1 })
  })

  it('gate 放行（null）→ 清库且返回 null', async () => {
    const { ud, bookRoot } = seed()
    const reason = await clearChatHistory(BOOK, ud, bookRoot, { gate: () => null })
    expect(reason).toBe(null)
    expect(counts(ud, bookRoot)).toEqual({ chat: 0, ws: 0 })
  })

  it('无 opts（books.ts 删书/改名等既有调用方形态）→ 返回 null 且清库（回归不变）', async () => {
    const { ud, bookRoot } = seed()
    const reason = await clearChatHistory(BOOK, ud, bookRoot)
    expect(reason).toBe(null)
    expect(counts(ud, bookRoot)).toEqual({ chat: 0, ws: 0 })
  })

  // 复审-0914-修复批 P3-R3-2：调用序时点钉——gate 必须在 openSessionStoreAsync 的
  // await 之后回调（复查才有意义）。全新 ud 无库文件，首开创建 db；gate 视角库文件
  // 已存在 = 时序正确。若复查被挪到开库 await 之前（窗口防护失效），本断言即红。
  it('gate 调用时点 = 开库 await 之后（全新 ud 上首开库文件在 gate 视角已落盘）', async () => {
    const ud = mkdtempTracked(join(tmpdir(), 'clw-clear-gate-ts-'))
    dirs.push(ud)
    const bookRoot = join(ud, '长篇', BOOK)
    const dbPath = join(ud, 'clwriting', 'session', bookHash(bookRoot) + '.db')
    expect(existsSync(dbPath)).toBe(false) // 前置：全新 ud 无库文件
    let gateSawDb = false
    const reason = await clearChatHistory(BOOK, ud, bookRoot, {
      gate: () => {
        gateSawDb = existsSync(dbPath)
        return null
      },
    })
    expect(reason).toBe(null)
    expect(gateSawDb).toBe(true)
  })
})
