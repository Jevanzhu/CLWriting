/**
 * rewrite store · W-P1-4 回归：改写链路「服务端读盘基线 vs 前端 buffer」版本错位防护。
 *
 * 覆盖四条防线：
 *   ① run 前置 flush——dirty 文档先落盘再改写（服务端 readDraft 读的是磁盘）
 *   ② flush 受阻（保存失败 / 冲突未决）→ 中止改写，不拿旧版当基线
 *   ③ accept 基线校验——生成期间正文又被编辑 → fail-closed 拒绝接受
 *   ④ accept fm 保留——rewritten 是剥 fm 的正文级产出，patch 前须 mergeFm 拼回
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/rewrite', () => ({
  runRewriteDoc: vi.fn(),
  reportAiVersion: vi.fn(async () => {}),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {
    status: number
    code?: string
    constructor(message: string, status: number, code?: string) {
      super(message)
      this.name = 'ApiError'
      this.status = status
      this.code = code
    }
  },
  getToken: vi.fn(() => 'test-token'),
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: () => ({ toast: vi.fn() }),
}))

import { runRewriteDoc, type RewriteResult } from '../../../src/studio/web-next/src/api/rewrite'
import { getContent, saveContent } from '../../../src/studio/web-next/src/api/documents'
import { ApiError } from '../../../src/studio/web-next/src/api/client'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useRewriteStore } from '../../../src/studio/web-next/src/stores/rewrite'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = 'test-book'
const DOC_ID = 'doc_ch01'
const FM = '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺设\n---\n\n'
const BODY = '剑光如虹，横贯长空。'

function makeNode(path: string, docId: string): TreeNode {
  return {
    path,
    name: path.split('/')!.pop()!,
    isDirectory: false,
    role: 'chapter',
    docId,
    children: [],
  } as TreeNode
}

/** 打开章节文档（content = fm + body）。 */
async function openChapter(content: string) {
  const doc = useDocStore()
  doc.setBook(BOOK)
  vi.mocked(getContent).mockResolvedValueOnce(content)
  await doc.open(makeNode('写作/正文/001-开篇.md', DOC_ID))
  return doc
}

function rewriteResult(original: string, rewritten: string): RewriteResult {
  return { ok: true, mode: 'local', original, rewritten, diff: [] }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('W-P1-4 ①② run 前置 flush', () => {
  it('dirty → 先 saveContent 落盘，再 runRewriteDoc', async () => {
    const doc = await openChapter(FM + BODY)
    doc.patch(DOC_ID, FM + BODY + '新增段落。') // 未保存编辑
    vi.mocked(saveContent).mockResolvedValueOnce({ ok: true, revision: 'sha256:new' })
    vi.mocked(runRewriteDoc).mockResolvedValueOnce(rewriteResult(BODY, '改写后'))

    const rewrite = useRewriteStore()
    await rewrite.run(BOOK, DOC_ID, '润色', BODY)

    expect(saveContent).toHaveBeenCalledTimes(1)
    expect(runRewriteDoc).toHaveBeenCalledTimes(1)
    // flush 成功后 dirty 应被清（save 成功路径）
    expect(doc.get(DOC_ID)!.dirty).toBe(false)
  })

  it('非 dirty → 直接改写，不触发保存', async () => {
    await openChapter(FM + BODY)
    vi.mocked(runRewriteDoc).mockResolvedValueOnce(rewriteResult(BODY, '改写后'))

    const rewrite = useRewriteStore()
    await rewrite.run(BOOK, DOC_ID, '润色', BODY)

    expect(saveContent).not.toHaveBeenCalled()
    expect(runRewriteDoc).toHaveBeenCalledTimes(1)
  })

  it('flush 保存失败 → 中止改写（不拿旧版当基线），error 有值', async () => {
    const doc = await openChapter(FM + BODY)
    doc.patch(DOC_ID, FM + BODY + '新增段落。')
    vi.mocked(saveContent).mockRejectedValueOnce(new ApiError('网络错误', 500))

    const rewrite = useRewriteStore()
    await rewrite.run(BOOK, DOC_ID, '润色', BODY)

    expect(runRewriteDoc).not.toHaveBeenCalled()
    expect(rewrite.error).toBeTruthy()
    expect(rewrite.result).toBeNull()
    expect(doc.get(DOC_ID)!.dirty).toBe(true) // 本地编辑仍在
  })

  it('保存冲突未决 → 中止改写', async () => {
    const doc = await openChapter(FM + BODY)
    doc.patch(DOC_ID, FM + BODY + '新增段落。')
    vi.mocked(saveContent).mockRejectedValueOnce(new ApiError('版本冲突', 409, 'REVISION_CONFLICT'))
    await doc.save(DOC_ID, 'manual') // 置 conflict
    expect(doc.get(DOC_ID)!.conflict).toBe(true)

    const rewrite = useRewriteStore()
    await rewrite.run(BOOK, DOC_ID, '润色', BODY)

    expect(runRewriteDoc).not.toHaveBeenCalled()
    expect(rewrite.error).toContain('冲突')
  })
})

describe('W-P1-4 ③④ accept 防线', () => {
  it('基线一致 → 接受：rewritten 拼回 fm（正文级 → 全文级），doc 变 dirty', async () => {
    const doc = await openChapter(FM + BODY)
    vi.mocked(runRewriteDoc).mockResolvedValueOnce(rewriteResult(BODY, '改写后的正文。'))

    const rewrite = useRewriteStore()
    await rewrite.run(BOOK, DOC_ID, '润色', BODY)
    expect(rewrite.accept(BOOK, DOC_ID)).toBe(true)

    const e = doc.get(DOC_ID)!
    expect(e.dirty).toBe(true)
    expect(e.content.startsWith('---\n章号: 1')).toBe(true) // fm 保留（此前直接 patch 会丢 fm）
    expect(e.content).toContain('改写后的正文。')
    expect(rewrite.result).toBeNull()
  })

  it('生成期间正文又被编辑 → 拒绝接受，本地内容不动，结果保留可重试', async () => {
    const doc = await openChapter(FM + BODY)
    vi.mocked(runRewriteDoc).mockResolvedValueOnce(rewriteResult(BODY, '改写后的正文。'))

    const rewrite = useRewriteStore()
    await rewrite.run(BOOK, DOC_ID, '润色', BODY)
    doc.patch(DOC_ID, FM + BODY + '生成期间的新编辑。') // AI 生成 1-2 分钟窗口内的输入

    expect(rewrite.accept(BOOK, DOC_ID)).toBe(false)
    expect(doc.get(DOC_ID)!.content).toContain('生成期间的新编辑。') // 未被覆盖
    expect(rewrite.result).not.toBeNull() // 结果保留，撤销新编辑后可再接受
  })

  it('接受后 fm-only 差异不算新编辑（mergeFm 规范化不误伤）', async () => {
    // e.content 与 original 的差异仅在 fm/body 分隔空白 → 视为基线一致
    const doc = await openChapter('---\n章号: 1\n---\n' + BODY)
    vi.mocked(runRewriteDoc).mockResolvedValueOnce(rewriteResult(BODY, '改写后的正文。'))

    const rewrite = useRewriteStore()
    await rewrite.run(BOOK, DOC_ID, '润色', BODY)
    expect(rewrite.accept(BOOK, DOC_ID)).toBe(true)
    expect(doc.get(DOC_ID)!.content).toContain('改写后的正文。')
  })
})
