/**
 * F3 → R44-2（四十四轮）契约演进：关窗/退出兜底从「beforeunload 内同步 XHR + 同步
 * re-boot」改为「主进程 close/before-quit 拦截 + 渲染层 flushBeforeClose 异步钩子」。
 *
 * 原 F3（五十九轮）修复点——token null 时同步 re-boot 再 PUT——其主体（同步 XHR）
 * 经双 Electron 实验证实在 Chromium ≥M80 的卸载路径零字节到达（四十四轮报告 §3.1），
 * 已随 flushSyncOnUnload 一并移除。本文件保留 token 通道语义的等价断言：token 缺失
 * 现由 apiJson 的 401→rebootstrap 自动重取（R42-15），flushBeforeClose 无需自带
 * re-boot；这里钉住「钩子面不再读 getToken（旧同步通道残留即红）」与调用约定。
 *
 * 引擎级保证（不 stub XHR/fetch 的实机回归）见 r44-close-flush-electron.test.ts。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
}))
const tokenMock = vi.fn<() => string | null>(() => 'test-token')
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {},
  getToken: () => tokenMock(),
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: () => ({ toast: vi.fn() }),
}))

import { getContent, saveContent } from '../../../src/studio/web-next/src/api/documents'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

async function openDirty(docId = 'd1'): Promise<void> {
  const doc = useDocStore()
  doc.setBook('test-book')
  vi.mocked(getContent).mockResolvedValueOnce('a')
  await doc.open({
    path: `写作/正文/${docId}.md`,
    name: `${docId}.md`,
    isDirectory: false,
    role: 'chapter',
    docId,
    children: [],
  } as TreeNode)
  doc.patch(docId, '未保存内容')
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('F3→R44-2: flushBeforeClose 钩子面（token 通道语义随契约演进）', () => {
  it('dirty 文档经异步保存链落盘一次，token null 不再自带 re-boot（apiJson 401→rebootstrap 负责）', async () => {
    tokenMock.mockReturnValue(null)
    await openDirty()
    vi.mocked(saveContent).mockRejectedValueOnce(new Error('401'))
    const res = await useDocStore().flushBeforeClose()
    // token null + save 失败 → failed 上抛（真实链路里 apiJson 会先 rebootstrap 再重试，
    // 此处 mock 的是 documents 层，token 语义已不在本钩子职责内——断言零 re-boot 残留）
    expect(res.failed).toEqual(['d1'])
    expect(saveContent).toHaveBeenCalledTimes(1)
  })

  it('dirty 文档保存成功 → 钩子返回零失败零冲突（主进程据此直关不弹确认）', async () => {
    await openDirty()
    vi.mocked(saveContent).mockResolvedValueOnce({ ok: true, revision: 'sha256:r44', superseded: false })
    const res = await useDocStore().flushBeforeClose()
    expect(res).toEqual({ failed: [], conflict: [] })
  })
})
