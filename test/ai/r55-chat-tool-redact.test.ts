/**
 * R55-C-4（五十五轮）回归：executeChatTool 兜底 catch 错误文案过 redactSecret。
 *
 * 修复前：兜底 catch 拼 `执行失败：${e.message}` 经 chat_tool_result SSE 直达前端并
 * 回填模型上下文——全链唯一未按 R43-19 口径脱敏的错误出口（上游异常 message 可能
 * 携带 URL query param / Bearer / 裸 key 形态的凭据痕迹）。
 *
 * 触发源说明：真实注册表 executor 内部各自吞异常返回 ToolResult，天然路径难达兜底
 * catch——测试用 vi.mock 提供必抛错的 executor（readonly 工具，绕开确认闸）直测
 * executeChatTool（R55-C-4 起导出，仿 waitConfirm「导出供单测」先例）。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/ai/tools/index.js', () => ({
  TOOL_EXECUTORS: {
    book_search: () => {
      throw new Error('上游网关拒绝：https://api.example.com/v1/chat?api_key=sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456')
    },
    chapter_status: (): never => {
      throw '非 Error 抛出（String(e) 路径）：Bearer sk-abcdefghijklmnop1234567890'
    },
  },
}))

import { executeChatTool } from '../../src/ai/orchestrate/chat/turns.js'
import type { ChatOpts } from '../../src/ai/orchestrate/chat.js'

const SECRET_URL_KEY = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'
const SECRET_BEARER_KEY = 'sk-abcdefghijklmnop1234567890'

function makeOpts(): ChatOpts {
  return {
    driver: {
      async startSession(cwd: string) {
        return { id: 'mock', cwd, closed: false }
      },
      async *stream(): AsyncGenerator<never> {},
      dispose(): void {},
      emit(): void {},
    },
    mainSession: { id: 's1', cwd: '/tmp/r55-c4', closed: false },
    userDataPath: '/tmp/r55-c4-ud',
    bookRoot: '/tmp/r55-c4-book',
    bookName: 'r55-c4',
  }
}

describe('R55-C-4: executeChatTool 兜底 catch 脱敏', () => {
  it('Error.message 含 URL query param 形态 key → 文案已脱敏（原文不外溢）', async () => {
    const r = await executeChatTool({ id: 'c1', name: 'book_search', input: {} }, makeOpts(), new AbortController().signal)
    expect(r.ok).toBe(false)
    expect(r.summary.startsWith('执行失败：')).toBe(true)
    expect(r.summary).not.toContain(SECRET_URL_KEY)
    expect(r.summary).toContain('***REDACTED***')
  })

  it('非 Error 抛出（String(e) 路径）含 Bearer key → 文案同样已脱敏', async () => {
    const r = await executeChatTool({ id: 'c2', name: 'chapter_status', input: {} }, makeOpts(), new AbortController().signal)
    expect(r.ok).toBe(false)
    expect(r.summary.startsWith('执行失败：')).toBe(true)
    expect(r.summary).not.toContain(SECRET_BEARER_KEY)
    expect(r.summary).toContain('***REDACTED***')
  })
})
