/**
 * rewrite store 单测（第十一轮 P1-TST-1）：
 * 改写触发（whole/local/append）/ 接受 / 拒绝 / 清空。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/rewrite', () => ({
  runRewriteDoc: vi.fn(),
  reportAiVersion: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: vi.fn(() => ({ patch: vi.fn() })),
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
    vi.mocked(useDocStore).mockReturnValue({ patch: docPatch } as unknown as ReturnType<typeof useDocStore>)
    const s = useRewriteStore()
    await s.run('book1', 'doc_1', '改写', '')

    s.accept('book1', 'doc_1')
    expect(docPatch).toHaveBeenCalledWith('doc_1', '新内容')
    expect(reportMock).toHaveBeenCalledWith('book1', 'doc_1', '新内容')
    expect(s.result).toBeNull()
  })

  it('accept 无 result → no-op', () => {
    const s = useRewriteStore()
    s.accept('book1', 'doc_1')
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
})
