/**
 * R60-A-1（六十轮）回归：executeChatTool 的 input 空值/非对象守卫。
 *
 * 修复前：`call.input as Record<string, unknown>` 直接断言无守卫——模型产出
 * input: null（工具 args 为字符串 "null" 等 JSON 解析产物）时，switch 分支
 * `input['chapter']` 抛 TypeError 落兜底 catch，回填「执行失败：Cannot read
 * properties of null (reading 'chapter')」，模型与作者均不可诊断；字符串/数字
 * 形态则流进字段校验给出误导文案。
 *
 * 守卫口径与契约侧 assembleChapter（src/ai/contract/chapter.ts「产出为空或
 * 非对象」）对齐：null/undefined/字符串/数字等非对象拒收并给可诊断文案（含
 * 工具名与实际 input 类型）；数组 typeof 'object' 按契约侧同口径放行（走各
 * 工具字段校验，不在守卫层二次成形）。
 *
 * harness 同 chat-tool-error-redact.test.ts（executeChatTool 直测 + vi.mock
 * TOOL_EXECUTORS——R55-C-4「导出供单测」先例）。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/ai/tools/index.js', () => ({
  TOOL_EXECUTORS: {
    // 只读注册表工具：收到入参即回显标记——守卫命中时 summary 不含此标记，
    // 即可断言「未触达执行体」
    book_search: (_tctx: unknown, input: unknown): { ok: boolean; summary: string } => ({
      ok: true,
      summary: `MOCK_EXECUTOR_CALLED:${JSON.stringify(input) ?? 'null'}`,
    }),
  },
}))

import { executeChatTool } from '../../src/ai/orchestrate/chat/turns.js'
import { makeFakeDriver } from './fake-driver.js'
import type { ChatOpts } from '../../src/ai/orchestrate/chat.js'

const GUARD_PREFIX = '工具入参为空或非对象'

function makeOpts(): ChatOpts {
  return {
    driver: makeFakeDriver(),
    mainSession: { id: 's1', cwd: '/tmp/r60a1', closed: false },
    userDataPath: '/tmp/r60a1-ud',
    bookRoot: '/tmp/r60a1-book',
    bookName: 'r60a1',
  }
}

function run(call: { id: string; name: string; input: unknown }): Promise<{ ok: boolean; summary: string }> {
  return executeChatTool(call, makeOpts(), new AbortController().signal)
}

describe('R60-A-1: executeChatTool input 空值/非对象守卫', () => {
  // 同断言体 + 多输入（注册表工具）一表：拒收文案 = 前缀 + 工具名 + 实际类型，
  // 且不触达执行体（mock 标记不出现）。用例名带输入形态，红了直接定位是哪条。
  const guardCases: Array<[string, string, string, unknown, string]> = [
    ['null（注册表工具）', 'c1', 'book_search', null, 'null'],
    ['undefined（注册表工具）', 'c3', 'book_search', undefined, 'undefined'],
    ['数字 42（注册表工具）', 'c5', 'book_search', 42, 'number'],
  ]

  it.each(guardCases)('input 为 %s → 守卫文案拒收，不触达执行体', async (_caseLabel, id, name, input, typeLabel) => {
    const r = await run({ id, name, input })
    expect(r.ok).toBe(false)
    expect(r.summary.startsWith(GUARD_PREFIX)).toBe(true)
    expect(r.summary).toContain(name) // 文案含工具名（可诊断）
    expect(r.summary).toContain(typeLabel) // 文案标出实际 input 类型
    expect(r.summary).not.toContain('MOCK_EXECUTOR_CALLED')
  })

  it('input 为 null（switch 路径 check_chapter）→ 守卫文案，不再落兜底 catch 的 TypeError 文案', async () => {
    const r = await run({ id: 'c2', name: 'check_chapter', input: null })
    expect(r.ok).toBe(false)
    expect(r.summary.startsWith(GUARD_PREFIX)).toBe(true)
    expect(r.summary).not.toContain('执行失败')
    expect(r.summary).not.toContain('Cannot read properties')
  })

  it('input 为字符串（"null" / "str"）→ 按契约侧口径拒收（typeof 非 object）', async () => {
    for (const s of ['null', 'str']) {
      const r = await run({ id: 'c4', name: 'check_chapter', input: s })
      expect(r.ok).toBe(false)
      expect(r.summary.startsWith(GUARD_PREFIX)).toBe(true)
      expect(r.summary).toContain('string')
    }
  })

  it('input 为数组 → 按契约侧口径放行（typeof object）：switch 路径走既有字段校验诊断', async () => {
    // check_chapter 空数组：input['chapter'] undefined → NaN → 既有「章号需为正整数。」
    const r = await run({ id: 'c6', name: 'check_chapter', input: [] })
    expect(r.ok).toBe(false)
    expect(r.summary).toBe('章号需为正整数。')
  })

  it('input 为数组 → 注册表路径原样透传执行体（守卫层不二次成形）', async () => {
    const r = await run({ id: 'c7', name: 'book_search', input: [] })
    expect(r.ok).toBe(true)
    expect(r.summary).toBe('MOCK_EXECUTOR_CALLED:[]')
  })

  it('input 为合法对象 → 行为不变（回归基线，守卫不误伤）', async () => {
    const r = await run({ id: 'c8', name: 'book_search', input: { query: 'x' } })
    expect(r.ok).toBe(true)
    expect(r.summary).toBe('MOCK_EXECUTOR_CALLED:{"query":"x"}')
  })
})
