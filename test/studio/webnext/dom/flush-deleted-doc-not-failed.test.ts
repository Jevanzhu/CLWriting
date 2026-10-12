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
import { makeChapterNode, makeChapterNodeAt } from '../helpers/tree-node'

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

describe('NOT_FOUND 归属守卫：迟到 404 只清理本次保存依附的条目', () => {
  /** 在途保存的手动放行句柄（起一笔挂起的保存，稍后由用例决定以什么错误落定）。 */
  let rejectSave: ((e: unknown) => void) | null = null
  function startPendingSave(): void {
    rejectSave = null
    vi.mocked(saveContent).mockReturnValueOnce(
      new Promise<never>((_res, rej) => {
        rejectSave = rej
      }) as ReturnType<typeof saveContent>,
    )
  }
  function takeReject(): (e: unknown) => void {
    if (!rejectSave) throw new Error('保存请求未在途')
    const r = rejectSave
    rejectSave = null
    return r
  }

  it('A 书保存在途 → 切 B 书 → 迟到 NOT_FOUND → B 书同路径条目仍在（含 dirty 正文），且无删除提示', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    await doc.open(makeChapterNodeAt('写作/正文/第1章.md', 'd1'))
    doc.patch('d1', 'A 书未落盘改动')
    startPendingSave()
    const p = doc.save('d1', 'manual')
    // 在途切书：缓存清空。legacy docId 由路径派生、跨书可同 id（本文件 flush 系列同因），
    // B 书同路径条目即同 docId——旧实现在此处被 A 书迟到的 404 直接 delete
    doc.setBook('书B')
    await doc.open(makeChapterNodeAt('写作/正文/第1章.md', 'd1'))
    doc.patch('d1', 'B 书未落盘改动')
    const ui = useUiStore()

    takeReject()(new ApiError('文档不存在', 404, 'NOT_FOUND'))
    await expect(p).resolves.toBe(false)

    // 修复点：归属判定不过（书名 + 条目身份双复检）→ B 书条目原样保留，正文未丢
    expect(doc.get('d1')?.content).toBe('B 书未落盘改动')
    expect(doc.get('d1')?.dirty).toBe(true)
    // 未落盘正文的丢弃告警属 A 书那笔，不得打在 B 书界面
    expect(ui.toasts.some((t) => t.msg.includes('文档已被外部删除'))).toBe(false)
  })

  it('同书条目已替换（discard 后重开）→ 迟到 404 不误删新条目，对照：本书记录确被删时仍清理 + 提示', async () => {
    const doc = useDocStore()
    doc.setBook(BOOK)
    await doc.open(makeChapterNode('d1'))
    doc.patch('d1', '旧条目改动')
    startPendingSave()
    const p = doc.save('d1', 'manual')
    doc.discard('d1') // 条目已弃（删除确认链先例），同路径随即重开
    await doc.open(makeChapterNode('d1'))
    doc.patch('d1', '重开条目改动')

    takeReject()(new ApiError('文档不存在', 404, 'NOT_FOUND'))
    await expect(p).resolves.toBe(false)
    // 旧条目已脱离缓存，迟到 404 不得删掉后来者
    expect(doc.get('d1')?.content).toBe('重开条目改动')

    // 对照：本书记录确实被删（条目仍在缓存）→ 行为不变（清理条目 + 提示）
    const ui = useUiStore()
    vi.mocked(saveContent).mockRejectedValueOnce(new ApiError('文档不存在', 404, 'NOT_FOUND'))
    expect(await doc.save('d1', 'manual')).toBe(false)
    expect(doc.get('d1')).toBeUndefined()
    expect(ui.toasts.at(-1)?.msg).toBe('文档已被外部删除，这段键入未写入（已清理本地缓存）')
  })
})
