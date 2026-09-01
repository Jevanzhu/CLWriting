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

describe('R34D-22: save 返 false 的「排队 no-op」不误读为保存失败', () => {
  /**
   * 场景（stores/doc.ts:190-196）：manual 保存遇在途保存排队，等在途 settle 后复查
   * `!cur.dirty` 返 false（F8 契约：无需重存）——在途保存已把全部内容落盘，dirty 已清。
   * rewrite 此前无差别按「保存失败」取消改写；修复后复查 dirty：已清 → 内容实已在
   * 磁盘，改写基线安全，照常发起改写。
   */
  function stubDoc(opts: { saveClearsDirty: boolean }): void {
    let dirty = true
    vi.mocked(useDocStore).mockReturnValue({
      // get 每次取实况（save 副作用清 dirty 后，rewrite 的复查读到 false）
      get: vi.fn(() => ({ content: '旧', dirty, conflict: false, error: null })),
      // F8 排队 no-op 形态：save 返 false；在途保存成功时副作用清 dirty
      save: vi.fn(async () => {
        if (opts.saveClearsDirty) dirty = false
        return false
      }),
      patch: vi.fn(),
    } as unknown as ReturnType<typeof useDocStore>)
  }

  it('save 返 false 但 dirty 已清（在途保存已落盘）→ 不取消，照常发起改写', async () => {
    stubDoc({ saveClearsDirty: true })
    rewriteMock.mockResolvedValue({ ok: true, mode: 'whole', original: '旧', rewritten: '新', diff: [] })
    const s = useRewriteStore()
    await s.run('book1', 'doc_1', '改写', '')
    // 修复点：不再误读为失败（修复前 error='改写前保存失败' 且 rewriteMock 不被调）
    expect(rewriteMock).toHaveBeenCalledTimes(1)
    expect(s.error).toBeNull()
    expect(s.result).not.toBeNull()
  })

  it('对照组：save 返 false 且 dirty 仍在（真失败/冲突）→ 取消改写（既有语义不误伤）', async () => {
    stubDoc({ saveClearsDirty: false })
    const s = useRewriteStore()
    await s.run('book1', 'doc_1', '改写', '')
    expect(rewriteMock).not.toHaveBeenCalled()
    expect(s.error).toBe('改写前保存失败，已取消改写')
    expect(s.result).toBeNull()
  })
})
