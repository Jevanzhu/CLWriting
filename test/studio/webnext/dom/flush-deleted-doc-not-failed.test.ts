/**
 * 0918二轮修复批（E101）回归：flushDirty 不把外部已删除（NOT_FOUND）文档计入 failed。
 *
 * doSave 的 NOT_FOUND 分支（R33-13）已把条目移出缓存——文档不再 dirty、无编辑可丢，
 * 但 save 返 false 使同轮 flushDirty 的 failed.add 仍收进 phantom 条目。Book.vue 切书
 * 守卫对 failed>0 弹「保存失败将永久丢弃」确认框——对一个已不存在的文档假警报
 * （R33-13 注释宣称已修而同轮残留）。修复：条目身份复检（docs.get(docId) === e）——
 * 条目仍在且仍是同一实例才是「保存失败仍 dirty」。
 *
 * 同分支第二契约：条目本体被移除即连未落盘正文一并丢弃（快照与 await 窗口内的新键入
 * 都在条目上），提示面须覆盖 autosave 路径（此前仅手动保存有一条 info）；提示只是告知，
 * 不得重新引入 failed 计数（上款契约不回归）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const getContent = vi.hoisted(() => vi.fn())
const saveContent = vi.hoisted(() => vi.fn())
vi.mock('../../../../src/studio/web-next/src/api/documents', () => {
  return {
    getContent,
    // 重评-0912-4 P1-1：doOpen 走完整载荷——委托默认包装既有 getContent mock
    getContentPayload: vi.fn(async (...a: Parameters<typeof getContent>) => ({ content: await getContent(...a) })),
    saveContent,
    finalizeDoc: vi.fn(),
  }
})
// 真类单源：ApiError 取真实 client 导出（doSave 的 instanceof 判别依赖同类）
vi.mock('../../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    getToken: vi.fn(() => 'test-token'),
  }
})

import { ApiError } from '../../../../src/studio/web-next/src/api/client'
import { useDocStore } from '../../../../src/studio/web-next/src/stores/doc'
import { useUiStore } from '../../../../src/studio/web-next/src/stores/ui'
import { makeChapterNode } from '../helpers/tree-node'

const BOOK = '书A'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(getContent).mockResolvedValue('a')
})

describe('E101: flushDirty 不计入 NOT_FOUND 已删文档', () => {
  it('dirty 文档 flush 前被外部删除（404 NOT_FOUND）→ 条目清理且 failed 不含它（修复前：同轮 phantom 入 failed）', async () => {
    const doc = useDocStore()
    doc.setBook(BOOK)
    await doc.open(makeChapterNode('d1'))
    doc.patch('d1', '改')
    // doSave NOT_FOUND 分支：删缓存条目 + return false（mock saveContent 404 走 ApiError 链）
    vi.mocked(saveContent).mockRejectedValueOnce(new ApiError('文档不存在', 404, 'NOT_FOUND'))

    const failed = await doc.flushDirty()

    expect(failed).toEqual([]) // 修复点：已删条目不算「保存失败仍 dirty」
    expect(doc.get('d1')).toBeUndefined() // R33-13 缓存清理不回归
  })

  it('对照：真失败（500，仍 dirty）→ 仍计入 failed（F1 契约不回归）', async () => {
    const doc = useDocStore()
    doc.setBook(BOOK)
    await doc.open(makeChapterNode('d1'))
    doc.patch('d1', '改')
    vi.mocked(saveContent).mockRejectedValueOnce(new ApiError('服务器错误', 500, 'INTERNAL'))

    const failed = await doc.flushDirty()

    expect(failed).toEqual(['d1']) // 条目仍在且 dirty：真失败照常上报
    expect(doc.get('d1')!.dirty).toBe(true)
  })

  it('混合形态：一个已删 + 一个真失败 → failed 只含真失败的', async () => {
    const doc = useDocStore()
    doc.setBook(BOOK)
    await doc.open(makeChapterNode('d1'))
    await doc.open(makeChapterNode('d2'))
    doc.patch('d1', '改1')
    doc.patch('d2', '改2')
    vi.mocked(saveContent).mockImplementation(async (_b: string, docId: string) => {
      if (docId === 'd1') throw new ApiError('文档不存在', 404, 'NOT_FOUND')
      throw new ApiError('服务器错误', 500, 'INTERNAL')
    })

    const failed = await doc.flushDirty()

    expect(failed).toEqual(['d2'])
    expect(doc.get('d1')).toBeUndefined()
    expect(doc.get('d2')!.dirty).toBe(true)
  })
})

describe('NOT_FOUND 提示：外部删除导致的未落盘键入丢弃必须可见', () => {
  it('autosave 路径（flushDirty 撞 404）→ 提示「文档已被外部删除，这段键入未写入」（此前零提示），failed 仍为空', async () => {
    const doc = useDocStore()
    doc.setBook(BOOK)
    await doc.open(makeChapterNode('d1'))
    doc.patch('d1', '改')
    vi.mocked(saveContent).mockRejectedValueOnce(new ApiError('文档不存在', 404, 'NOT_FOUND'))
    const ui = useUiStore()

    const failed = await doc.flushDirty()

    expect(failed).toEqual([]) // 提示不得重新引入 failed 计数（切书守卫假警报）
    const last = ui.toasts.at(-1)
    expect(last?.kind).toBe('warning')
    expect(last?.msg).toContain('文档已被外部删除')
    expect(last?.msg).toContain('这段键入未写入')
  })

  it('手动保存路径同一条提示，条目清理与 failed 语义不变', async () => {
    const doc = useDocStore()
    doc.setBook(BOOK)
    await doc.open(makeChapterNode('d1'))
    doc.patch('d1', '改')
    vi.mocked(saveContent).mockRejectedValueOnce(new ApiError('文档不存在', 404, 'NOT_FOUND'))
    const ui = useUiStore()

    const ok = await doc.save('d1', 'manual')

    expect(ok).toBe(false)
    expect(ui.toasts.at(-1)?.msg).toBe('文档已被外部删除，这段键入未写入（已清理本地缓存）')
    expect(doc.get('d1')).toBeUndefined() // R33-13 缓存清理不回归
    expect(await doc.flushDirty()).toEqual([]) // 幽灵条目不入 failed
  })
})
