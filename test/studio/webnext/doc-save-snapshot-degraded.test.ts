// @vitest-environment happy-dom
/**
 * RC 源码重审 A-5（Opus-5.5 轮）回归：留底降级的作者可见性（doc store 侧）。
 *
 * 故障面：服务端 `.版本` 目录坏掉时，保存前留底（maybeSnapshot）失败曾把整笔保存改判
 * WRITE_ERROR——手动保存弹错误、autosave 失败只落状态条（不弹 toast），作者面对的是
 * 「写不进去且只有一行小字」的永久死锁。服务端已改 fail-open（正文照常保存 +
 * snapshotDegraded 旗），本用例锁定前端半边的契约：首次见到该旗 → info 提示一次并
 * 点名原因与出路；同一文档再次降级不再重复提示（autosave 每 30s 一拍，不设闸会刷屏）；
 * 健康保存（无该旗）零提示。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const getContent = vi.hoisted(() => vi.fn())
const saveContent = vi.hoisted(() => vi.fn())
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent,
  getContentPayload: vi.fn(async (...a: Parameters<typeof getContent>) => ({ content: await getContent(...a) })),
  saveContent,
  finalizeDoc: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return { ...actual, getToken: vi.fn(() => 'test-token') }
})

import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const OK = { ok: true as const, revision: 'sha256:x' as const, superseded: false }
/** 服务端留底失败（fail-open）时的成功响应形状：正文已保存 + 降级旗 */
const DEGRADED = { ...OK, snapshotDegraded: true }

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(getContent).mockResolvedValue('a')
  vi.mocked(saveContent).mockResolvedValue(OK)
})

async function openDoc(): Promise<ReturnType<typeof useDocStore>> {
  const doc = useDocStore()
  doc.setBook('test-book')
  await doc.open({
    path: '写作/正文/第1章.md',
    name: '第1章.md',
    isDirectory: false,
    role: 'chapter',
    docId: 'd1',
    children: [],
  } as TreeNode)
  doc.patch('d1', 'b')
  return doc
}

/** 只看「留底降级」那一条 toast（手动保存另有「已保存」成功 toast，不混入计数）。 */
function degradedCalls(toast: { mock: { calls: unknown[][] } }): unknown[][] {
  return toast.mock.calls.filter((c) => String(c[0]).includes('未生成版本留底'))
}

describe('RC 源码重审 A-5：留底降级提示（每文档一次）', () => {
  it('首次见到 snapshotDegraded → info 提示一次，点名缺口与「正文已保存」', async () => {
    const doc = await openDoc()
    vi.mocked(saveContent).mockResolvedValue(DEGRADED)
    const toast = vi.spyOn(useUiStore(), 'toast')

    expect(await doc.save('d1')).toBe(true) // 正文保存成功（降级不阻断）
    const calls = degradedCalls(toast)
    expect(calls).toHaveLength(1)
    expect(calls[0]![1]).toBe('info')
    expect(String(calls[0]![0])).toContain('正文已保存') // 出路：告诉作者保存本身没丢
    expect(doc.get('d1')!.snapshotDegradedNotified).toBe(true)
  })

  it('同文档再次降级（autosave 节拍重试）→ 不再重复提示', async () => {
    const doc = await openDoc()
    vi.mocked(saveContent).mockResolvedValue(DEGRADED)
    const toast = vi.spyOn(useUiStore(), 'toast')

    expect(await doc.save('d1', 'autosave')).toBe(true)
    doc.patch('d1', 'c')
    expect(await doc.save('d1', 'autosave')).toBe(true)
    doc.patch('d1', 'e')
    expect(await doc.save('d1')).toBe(true)

    expect(saveContent).toHaveBeenCalledTimes(3) // 三笔都真发了请求（降级不影响保存）
    expect(degradedCalls(toast)).toHaveLength(1) // 修复点：只提示一次，不随节拍刷屏
  })

  it('对照：健康保存（响应无该旗）→ 零降级提示', async () => {
    const doc = await openDoc()
    const toast = vi.spyOn(useUiStore(), 'toast')

    expect(await doc.save('d1')).toBe(true)
    expect(degradedCalls(toast)).toHaveLength(0)
    expect(doc.get('d1')!.snapshotDegradedNotified).toBeUndefined()
  })
})
