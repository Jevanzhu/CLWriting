/**
 * 重评-0912-4 P1-1（2026-09-12 全量重评修复批）前端接线回归：doOpen 非 UTF-8 告警。
 *
 * 服务端 GET /file 对非 UTF-8 存量（isUtf8Bytes 权威探测，客户端 U+FFFD 启发式会漏检
 * ——GBK 双字节对可能合法解成拉丁扩展字符）回 encodingSuspect/encodingHint；doOpen 改取
 * 完整载荷，suspect 时 toast 告警指引先转码（作者在乱码上编辑保存会被 R66-1 防线
 * 400 拒绝）。本文件钉定三形态：suspect 带 hint / suspect 缺 hint 走兜底文案 / 干净载荷不告警。
 * mock 范式同 doc.test.ts（api/documents + api/client + stores/ui 三 mock；revision 真跑）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getContentPayload: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  getContentPayload: mocks.getContentPayload,
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
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
  useUiStore: () => ({ toast: mocks.toast }),
}))

import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = 'r0912-4-编码书'

function makeNode(path: string, docId: string): TreeNode {
  return {
    path,
    name: path.split('/').pop()!,
    isDirectory: false,
    role: 'chapter',
    docId,
    children: [],
  } as TreeNode
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('重评-0912-4 P1-1: doOpen 非 UTF-8 存量告警', () => {
  it('encodingSuspect + hint → toast 按服务端文案告警；内容照常入缓存可编辑', async () => {
    mocks.getContentPayload.mockResolvedValueOnce({
      content: '锟斤拷烫烫烫（GBK 旧稿解码形态）。',
      encodingSuspect: true,
      encodingHint: '该文件不是 UTF-8 编码，内容可能显示为乱码——请先在编辑器外转码为 UTF-8 再编辑保存',
    })
    const doc = useDocStore()
    doc.setBook(BOOK)
    await doc.open(makeNode('写作/正文/第一卷/0001-章.md', 'doc-enc-1'))
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    expect(mocks.toast).toHaveBeenCalledWith(
      '该文件不是 UTF-8 编码，内容可能显示为乱码——请先在编辑器外转码为 UTF-8 再编辑保存',
      'error',
    )
    // 告警不阻断打开：内容入缓存、基线已算、非 dirty
    const d = doc.docs.get('doc-enc-1')!
    expect(d.content).toBe('锟斤拷烫烫烫（GBK 旧稿解码形态）。')
    expect(d.dirty).toBe(false)
    expect(d.baselineRevision).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('encodingSuspect 但 hint 缺失 → 兜底文案告警', async () => {
    mocks.getContentPayload.mockResolvedValueOnce({ content: 'x', encodingSuspect: true })
    const doc = useDocStore()
    doc.setBook(BOOK)
    await doc.open(makeNode('写作/正文/第一卷/0002-章.md', 'doc-enc-2'))
    expect(mocks.toast).toHaveBeenCalledWith('该文件不是 UTF-8 编码，内容可能显示为乱码', 'error')
  })

  it('干净载荷（无 suspect 字段）→ 零告警', async () => {
    mocks.getContentPayload.mockResolvedValueOnce({ content: '正常 UTF-8 正文。' })
    const doc = useDocStore()
    doc.setBook(BOOK)
    await doc.open(makeNode('写作/正文/第一卷/0003-章.md', 'doc-enc-3'))
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(doc.docs.get('doc-enc-3')!.content).toBe('正常 UTF-8 正文。')
  })
})
