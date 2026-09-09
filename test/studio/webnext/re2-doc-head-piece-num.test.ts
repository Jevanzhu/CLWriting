// @vitest-environment happy-dom
/**
 * 重评2-P3-1（2026-09-09 全量重评 GLM-5.3）回归：EditorDocHead 短篇章号占位 NaN 穿透。
 *
 * 原 `Number(fm章号 || 路径提取 || 1)` 的 `||` 作用在操作数上——fm 章号为非数字串
 * （如 'x'）时 truthy 直取，Number('x')=NaN 穿透 `pieceNum !== undefined` 检查，经
 * JSON 序列化为 null 传 updateChapterMetaDoc。修复：resolvePieceNum 逐级
 * Number.isFinite 守卫，fm 坏值与原 falsy 兜底（''/0/undefined）同归路径提取/1。
 *
 * 手法沿用 review-editor-overwrite-confirm.test.ts（直挂 EditorDocHead + pinia 真实
 * store + tree.load spy）；提交链收尾断言对齐 r44-title-pending-recommit 的 vi.waitFor
 * 确定性 settle（blur → updateChapterMetaDoc 首调跨微任务拍，flushPromises 后断言会早跑）。
 * 路径须落在 写作/正文/ 下（isChapter/isBodyKind 前缀判定，否则标题输入框不渲染）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  updateChapterMetaDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: mocks.getContent,
  saveContent: mocks.saveContent,
  finalizeDoc: mocks.finalizeDoc,
  updateChapterMetaDoc: mocks.updateChapterMetaDoc,
}))
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {
    status = 0
    code?: string
  },
  getToken: vi.fn(() => null),
}))

import EditorDocHead from '../../../src/studio/web-next/src/components/editor/EditorDocHead.vue'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const BOOK = 'test-book'

/** 短篇正文节点（role=piece-body——章号占位链只在短篇正文走） */
function pieceNode(docId: string, path: string): TreeNode {
  return {
    path,
    name: path.split('/').pop()!,
    isDirectory: false,
    role: 'piece-body',
    docId,
    status: 'draft',
    children: [],
  } as TreeNode
}

/** 挂顶栏并驱动一次标题提交；返回 updateChapterMetaDoc 的第三参（meta 载荷） */
async function commitTitle(fm: string, path: string, newTitle: string): Promise<Record<string, unknown>> {
  const doc = useDocStore()
  const tree = useTreeStore()
  vi.spyOn(tree, 'load').mockResolvedValue(undefined)
  doc.setBook(BOOK)
  mocks.getContent.mockResolvedValue(fm)
  await doc.open(pieceNode('d1', path))
  useWorkspaceStore().activeDocId = 'd1'
  const w: VueWrapper = mount(EditorDocHead, {
    props: { docId: 'd1', bookKind: 'short', wordCount: 100, title: '旧标题' },
  })
  const input = w.find('input.bar-title')
  if (!input.exists()) throw new Error(`标题输入框未渲染（path=${path} 不在正文目录形态）`)
  await input.setValue(newTitle)
  await input.trigger('blur')
  // R45-1 同款确定性 settle：blur → meta 首调跨微任务拍，flushPromises + 宏任务泵各一拍
  //（vi.waitFor 首轮同步检查会早跑——轮询重试间不含微任务泵，勿改 waitFor 形态）
  await flushPromises()
  await new Promise((r) => setTimeout(r, 60))
  expect(mocks.updateChapterMetaDoc).toHaveBeenCalledTimes(1)
  const payload = mocks.updateChapterMetaDoc.mock.calls[0]![2] as Record<string, unknown>
  w.unmount()
  return payload
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.updateChapterMetaDoc.mockResolvedValue({ ok: true })
})

describe('重评2-P3-1: 短篇章号占位 NaN 穿透修复（resolvePieceNum 逐级兜底）', () => {
  it('fm 章号为非数字串（坏值）→ 落路径提取（修复前 NaN→null 传 API）', async () => {
    const payload = await commitTitle('---\n标题: 旧标题\n章号: x\n---\n正文', '写作/正文/0012-旧标题.md', '新标题')
    expect(payload['标题']).toBe('新标题')
    expect(payload['章号']).toBe(12) // fm 坏值不再穿透，路径 0012 兜底
    expect(payload['章号']).not.toBeNaN()
  })

  it('fm 章号为好值 → 原样沿用（不被路径/1 覆盖）', async () => {
    const payload = await commitTitle('---\n标题: 旧标题\n章号: 9\n---\n正文', '写作/正文/0012-旧标题.md', '新标题')
    expect(payload['章号']).toBe(9)
  })

  it('fm 章号坏值且路径无数字前缀 → 落 1 兜底', async () => {
    const payload = await commitTitle('---\n标题: 旧标题\n章号: 损坏\n---\n正文', '写作/正文/无数字前缀.md', '新标题')
    expect(payload['章号']).toBe(1)
  })

  it('fm 章号 0（原 `||` falsy 语义）→ 仍落路径提取（保底语义不变）', async () => {
    const payload = await commitTitle('---\n标题: 旧标题\n章号: 0\n---\n正文', '写作/正文/0034-旧标题.md', '新标题')
    expect(payload['章号']).toBe(34)
  })

  it('fm 缺章号 → 路径提取（P2 原语义保持）', async () => {
    const payload = await commitTitle('---\n标题: 旧标题\n---\n正文', '写作/正文/0056-旧标题.md', '新标题')
    expect(payload['章号']).toBe(56)
  })
})
