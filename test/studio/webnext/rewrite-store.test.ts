/**
 * rewrite store 单测（第十一轮 P1-TST-1）：
 * 改写触发（whole/local/append）/ 接受 / 拒绝 / 清空。
 * W-P1-4 起 run/accept 依赖 doc store（前置 flush / 基线校验）——mock 需带 get/save/patch。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/rewrite', () => ({
  runRewriteDoc: vi.fn(),
  reportAiVersion: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  // 默认 get → undefined：文档未打开 → run 前置 flush 直接跳过（不触发保存）
  useDocStore: vi.fn(() => ({
    get: vi.fn(() => undefined),
    save: vi.fn(async () => true),
    patch: vi.fn(),
  })),
}))

import { runRewriteDoc, reportAiVersion } from '../../../src/studio/web-next/src/api/rewrite'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useRewriteStore } from '../../../src/studio/web-next/src/stores/rewrite'

const rewriteMock = runRewriteDoc as ReturnType<typeof vi.fn>
const reportMock = reportAiVersion as ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('rewrite: 触发改写', () => {
  it('run whole（无选区无 append）→ result 填充', async () => {
    rewriteMock.mockResolvedValue({ ok: true, mode: 'whole', original: '旧', rewritten: '新', diff: [] })
    const s = useRewriteStore()
    await s.run('book1', 'doc_1', '改得更紧凑', '')
    expect(rewriteMock).toHaveBeenCalledWith('book1', 'doc_1', { instruction: '改得更紧凑' })
    expect(s.result).not.toBeNull()
    expect(s.result!.mode).toBe('whole')
    expect(s.loading).toBe(false)
    expect(s.error).toBeNull()
  })

  it('run local（有选区）→ 传 selection', async () => {
    rewriteMock.mockResolvedValue({ ok: true, mode: 'local', original: '旧', rewritten: '新', diff: [] })
    const s = useRewriteStore()
    await s.run('book1', 'doc_1', '改这一段', '选中的文字')
    expect(rewriteMock).toHaveBeenCalledWith('book1', 'doc_1', { instruction: '改这一段', selection: '选中的文字' })
  })

  it('run append → 传 append:true', async () => {
    rewriteMock.mockResolvedValue({ ok: true, mode: 'append', original: '', rewritten: '续写内容', diff: [] })
    const s = useRewriteStore()
    await s.run('book1', 'doc_1', '继续写', '', true)
    expect(rewriteMock).toHaveBeenCalledWith('book1', 'doc_1', { instruction: '继续写', append: true })
  })

  it('run 失败 → error 设置 + result 清空', async () => {
    rewriteMock.mockRejectedValue(new Error('AI 超时'))
    const s = useRewriteStore()
    await s.run('book1', 'doc_1', '改写', '')
    expect(s.error).not.toBeNull()
    expect(s.result).toBeNull()
    expect(s.loading).toBe(false)
  })
})

describe('rewrite: 接受/拒绝', () => {
  it('accept → patch doc + report AI 版 + 清 result', async () => {
    rewriteMock.mockResolvedValue({ ok: true, mode: 'whole', original: '旧', rewritten: '新内容', diff: [] })
    reportMock.mockResolvedValue(undefined)
    const docPatch = vi.fn()
    // W-P1-4：accept 需读文档内容做基线校验（无 fm 文档：stripFrontmatter 原样返回）
    vi.mocked(useDocStore).mockReturnValue({
      get: vi.fn(() => ({ content: '旧', dirty: false, conflict: false })),
      save: vi.fn(async () => true),
      patch: docPatch,
    } as unknown as ReturnType<typeof useDocStore>)
    const s = useRewriteStore()
    await s.run('book1', 'doc_1', '改写', '')

    expect(s.accept('book1', 'doc_1')).toBe(true)
    expect(docPatch).toHaveBeenCalledWith('doc_1', '新内容')
    expect(reportMock).toHaveBeenCalledWith('book1', 'doc_1', '新内容')
    expect(s.result).toBeNull()
  })

  it('accept 无 result → no-op', () => {
    const s = useRewriteStore()
    expect(s.accept('book1', 'doc_1')).toBe(false)
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('reject → 清 result', async () => {
    rewriteMock.mockResolvedValue({ ok: true, mode: 'whole', original: '', rewritten: 'x', diff: [] })
    const s = useRewriteStore()
    await s.run('book1', 'doc_1', '改写', '')

    s.reject()
    expect(s.result).toBeNull()
  })
})

describe('rewrite: clear', () => {
  it('clear → result + error 重置', async () => {
    rewriteMock.mockRejectedValue(new Error('err'))
    const s = useRewriteStore()
    await s.run('book1', 'doc_1', '改写', '')

    s.clear()
    expect(s.result).toBeNull()
    expect(s.error).toBeNull()
  })

  it('X-2：clear 于 loading=true（run 在途）时调用 → loading 复位 false（改写面板不永久禁用）', async () => {
    let resolveRun: (v: unknown) => void = () => {}
    rewriteMock.mockReturnValue(
      new Promise((r) => {
        resolveRun = r
      }),
    )
    const s = useRewriteStore()
    const p = s.run('book1', 'doc_1', '改写', '')
    expect(s.loading).toBe(true) // 前置：run 在途
    s.clear() // 切书：作废在途改写
    expect(s.loading).toBe(false)
    resolveRun({ ok: true, mode: 'whole', original: '', rewritten: 'x', diff: [] })
    await p // 迟到结果不回填（代守卫），loading 仍 false
    expect(s.loading).toBe(false)
    expect(s.result).toBeNull()
  })
})
