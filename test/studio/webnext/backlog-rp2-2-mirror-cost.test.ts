// @vitest-environment happy-dom
/**
 * R-P2-2（评审修复批）回归：镜像峰值开销收敛。
 *
 * 现状：doc.ts 节流到点对 200 万字文档每 2s 一次全量 JSON.stringify +
 * localStorage.setItem 同步写，主线程数十 ms 级 CPU 峰值。修复两招（R55-F-3 崩溃
 * 恢复语义不回退）：
 * ① 内容未变不重写——节流到点先与上次落镜像内容全等比对（值级比对，无误跳过面），
 *    一致跳过 stringify+setItem；
 * ② 按 payload 规模自适应拉长节流间隔——≤256K 维持 2s，>256K 4s，>1M 8s（大文档
 *    崩溃窗口拉宽是 R55-F-3「镜像落后编辑 ≤ 一个节流间隔」取舍的规模延伸，镜像
 *    仍远快于 autosave（默认 30s）主兜底）。
 * mock 与夹具沿用 r55-f3-dirty-mirror.test.ts 惯例。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const toastMock = vi.hoisted(() => vi.fn())
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
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
  useUiStore: () => ({ toast: toastMock }),
}))
vi.mock('../../../src/studio/web-next/src/stores/words', () => ({
  useWordsStore: () => ({ ensureBaseline: vi.fn(async () => {}) }),
}))

import { getContent } from '../../../src/studio/web-next/src/api/documents'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

// happy-dom localStorage 在 vitest 集成下缺 clear()/length，Map-backed 替身（r30 范型）
function createLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}
vi.stubGlobal('localStorage', createLocalStorage())

const KEY = (book: string, docId: string): string => `clw:dirty-mirror:${book}:${docId}`

function makeNode(docId: string, path = `写作/正文/${docId}.md`): TreeNode {
  return { path, name: path.split('/').pop()!, isDirectory: false, role: 'chapter', docId, children: [] } as TreeNode
}

async function openDoc(doc: ReturnType<typeof useDocStore>, docId: string, serverContent: string): Promise<void> {
  vi.mocked(getContent).mockResolvedValueOnce(serverContent)
  await doc.open(makeNode(docId))
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('R-P2-2 ② 按 payload 规模自适应节流间隔', () => {
  it('小文档（≤256K）维持 2s 节拍不回归', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上内容')
    doc.patch('d1', '小文档编辑')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(localStorage.getItem(KEY('书A', 'd1'))).not.toBeNull()
  })

  it('中档（>256K ≤1M）：2s 不落盘、4s 落盘', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上内容')
    doc.patch('d1', 'y'.repeat(300_000))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull() // 修复点：不再 2s 高频拍
    await vi.advanceTimersByTimeAsync(2_000)
    const p = JSON.parse(localStorage.getItem(KEY('书A', 'd1'))!)
    expect(p.content).toHaveLength(300_000)
  })

  it('大档（>1M）：2s/4s 均不落盘、8s 落盘（峰值拍频减半再减半）', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上内容')
    doc.patch('d1', 'x'.repeat(1_100_000)) // payload < MIRROR_MAX_CHARS（2M），仍可镜像
    await vi.advanceTimersByTimeAsync(4_000)
    expect(localStorage.getItem(KEY('书A', 'd1'))).toBeNull() // 修复点：2s/4s 档均不拍
    await vi.advanceTimersByTimeAsync(4_000)
    const p = JSON.parse(localStorage.getItem(KEY('书A', 'd1'))!)
    expect(p.content).toHaveLength(1_100_000)
  })
})

describe('R-P2-2 ① 内容未变不重写', () => {
  it('净零编辑（改了又改回）→ 到点全等命中跳过 stringify+setItem，镜像不重写', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上内容')
    const setSpy = vi.spyOn(localStorage, 'setItem')
    doc.patch('d1', 'v1')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(setSpy).toHaveBeenCalledTimes(1) // 首拍照常落镜像
    // 净零编辑：调度面允许（每次 patch 都变了才调度），但到点内容已回到上次镜像值
    doc.patch('d1', 'v2')
    doc.patch('d1', 'v1')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(setSpy).toHaveBeenCalledTimes(1) // 修复点：值级全等 → 跳过重写
    expect((JSON.parse(localStorage.getItem(KEY('书A', 'd1'))!) as { content: string }).content).toBe('v1')
    setSpy.mockRestore()
  })

  it('内容真变 → 照常重写（跳过优化不误伤正常镜像更新）', async () => {
    const doc = useDocStore()
    doc.setBook('书A')
    await openDoc(doc, 'd1', '盘上内容')
    doc.patch('d1', 'v1')
    await vi.advanceTimersByTimeAsync(2_000)
    doc.patch('d1', 'v2') // 真编辑
    await vi.advanceTimersByTimeAsync(2_000)
    expect((JSON.parse(localStorage.getItem(KEY('书A', 'd1'))!) as { content: string }).content).toBe('v2')
  })
})
