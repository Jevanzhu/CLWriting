// @vitest-environment happy-dom
/**
 * R43-16（四十三轮）回归：doc store save 成功对齐 treeRev 至当前树版本——dirty 窗口
 * 错过的树刷新不再把自客户端保存当外部变更重拉
 * （原 r43-frontend-batch R43-16 节，按行为拆分落位）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  getConfig: vi.fn(),
  getTree: vi.fn(),
  getWordsDiary: vi.fn(),
  postBaseline: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  // 重评-0912-4 P1-1:doOpen 改走完整载荷——委托默认包装既有 getContent mock(suspect 分支默认不触发)
  getContentPayload: vi.fn(async (...a: Parameters<typeof mocks.getContent>) => ({ content: await mocks.getContent(...a) })),
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
  updateChapterMetaDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  getTree: mocks.getTree,
  getWordsDiary: mocks.getWordsDiary,
  postBaseline: mocks.postBaseline,
}))
// prefs API mock：doc.setBook → loadBookPrefs 持久化通道 mock 掉防落盘副作用
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getGlobalPrefs: vi.fn(async () => ({ prefs: {}, revision: 'r0' })),
  putGlobalPrefs: vi.fn(async () => ({ revision: 'r1' })),
  getBookPrefs: vi.fn(async () => ({})),
  putBookPrefs: vi.fn(async () => ({})),
}))

import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = 'r43-book'

function makeNode(docId: string, path: string): TreeNode {
  return {
    path,
    name: path.split('/').pop() ?? path,
    isDirectory: false,
    role: 'chapter',
    docId,
    status: 'draft',
    children: [],
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.getContent.mockResolvedValue('正文')
  mocks.saveContent.mockResolvedValue({ revision: 'sha256:new' })
  mocks.getConfig.mockResolvedValue({ kind: 'long' })
  mocks.getWordsDiary.mockRejectedValue(new Error('离线降级'))
})

describe('R43-16: doc store save 成功对齐 treeRev 至当前树版本', () => {
  it('open 记 r1 → dirty 窗口树推进 r2 → save 成功 → treeRev === r2（不再被判外部变更）', async () => {
    const doc = useDocStore()
    const tree = useTreeStore()
    doc.setBook(BOOK)
    tree.revision = 'r1'
    await doc.open(makeNode('d1', '写作/正文/第1章-标题.md'))
    expect(doc.get('d1')!.treeRev).toBe('r1')

    // dirty 窗口期间树版本推进（syncCleanWithTree 跳过 dirty 项，不回填 treeRev）
    tree.revision = 'r2'
    doc.patch('d1', '正文改')
    await expect(doc.save('d1')).resolves.toBe(true)
    // 修复前：treeRev 滞留 r1，下一次树刷新（curRev=r2）把自客户端保存当外部变更重拉
    expect(doc.get('d1')!.treeRev).toBe('r2')
  })
})
