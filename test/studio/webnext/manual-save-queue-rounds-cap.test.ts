// @vitest-environment happy-dom
/**
 * 0918二轮修复批（E105）回归：doc.save() 手动排队链的等待轮次上限。
 *
 * manual 遇在途保存链式排队（F8）：await 在途 → 复检 dirty → 尾递归重存。原递归
 * 无轮次上限——「在途落定后又立刻出现新在途（autosaveTick 节拍）+ 条目持续置脏」的
 * 极端交叠下等待无界（V8 无尾调用优化，深递归耗栈）。修复：同款
 * FLUSH_WAIT_INFLIGHT_MAX_ROUNDS=3 防活锁——超限仍 saving 返 false 交 autosaveTick
 * 兜底（dirty 保持，编辑不丢）。修复前本文件的「持续在途+持续置脏」用例永不 settle
 * （超时红）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const getContent = vi.hoisted(() => vi.fn())
const saveContent = vi.hoisted(() => vi.fn())
vi.mock('../../../src/studio/web-next/src/api/documents', () => {
  return {
    getContent,
    // 重评-0912-4 P1-1：doOpen 走完整载荷——委托默认包装既有 getContent mock
    getContentPayload: vi.fn(async (...a: Parameters<typeof getContent>) => ({ content: await getContent(...a) })),
    saveContent,
    finalizeDoc: vi.fn(),
  }
})
vi.mock('../../../src/studio/web-next/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/studio/web-next/src/api/client')>()
  return {
    ...actual,
    getToken: vi.fn(() => 'test-token'),
  }
})

import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

const OK = { ok: true as const, revision: 'sha256:x' as const, superseded: false }

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(getContent).mockResolvedValue('a')
})

async function openDirty(): Promise<ReturnType<typeof useDocStore>> {
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

describe('E105: manual save 排队链轮次上限', () => {
  it('持续在途 + 持续置脏 → 等待有界（3 轮封顶），最终返 false 交 autosaveTick 兜底', async () => {
    const doc = await openDirty()
    // 受控 saveContent：每次调用登记当前轮的手动 resolve（极端形态驱动器）
    let resolveSave!: (v: typeof OK) => void
    vi.mocked(saveContent).mockImplementation(
      () => new Promise<typeof OK>((r) => (resolveSave = r)),
    )

    const pAutosave = doc.save('d1', 'autosave') // A1 在途（快照 'b'）
    const pManual = doc.save('d1') // ⌘S：排队链入口（等待 A1）

    // 活锁形态复刻：每个在途落定即被置脏 + autosaveTick 恰好又起新在途
    for (let i = 0; i < 3; i++) {
      resolveSave(OK)
      doc.patch('d1', `c${i}`) // 在途快照之后的新输入（落定后仍 dirty）
      await Promise.resolve() // 让 doSave 落定（saving=false）
      void doc.save('d1', 'autosave') // 新在途（A{i+2}）
      await Promise.resolve() // 让排队链推进一轮（等待→复检→递归）
    }

    // 修复点：3 轮等待后封顶返 false（修复前：await 第 4 个在途——本用例永不 settle）
    expect(await pManual).toBe(false)
    // A1..A4 恰四次请求（第 4 次在途未被排队链等待）；dirty 保持，autosaveTick 兜底重扫
    expect(saveContent).toHaveBeenCalledTimes(4)
    expect(doc.get('d1')!.dirty).toBe(true)
    expect(doc.get('d1')!.saving).toBe(true) // A4 仍在途（测试驱动，无需落定）
    void pAutosave
  })

  it('对照：单轮排队即收束——F8 既有链式补存语义不回归', async () => {
    const doc = await openDirty()
    let resolve1!: (v: typeof OK) => void
    vi.mocked(saveContent)
      .mockImplementationOnce(() => new Promise<typeof OK>((r) => (resolve1 = r)))
      .mockImplementationOnce(async () => OK)

    const p1 = doc.save('d1', 'autosave') // 在途（快照 'b'）
    doc.patch('d1', 'c') // 在途窗口内新输入
    const p2 = doc.save('d1') // ⌘S：排队
    resolve1(OK)
    expect(await p2).toBe(true) // 补存成功（轮次上限不误伤正常一跳链）
    await p1
    expect(saveContent).toHaveBeenCalledTimes(2)
  })
})
