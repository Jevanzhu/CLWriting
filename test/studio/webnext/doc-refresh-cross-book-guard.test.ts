/**
 * 重评-P2-1（2026-09-09 全量代码重评）回归：doc.refresh 的书名快照 + await 窗口复检。
 *
 * refresh 此前裸读 bookName.value 且 await 窗口无复检（同文件 doOpen/doSave/
 * syncCleanWithTree 均有「入口快照 + 落地复检」纪律，唯此处缺位）：refresh 在途切书，
 * 迟到的旧书响应会 ①clean 归位分支按**新书名** clearDirtyMirror（B 书同 docId 崩溃
 * 镜像被误删）、②写 detached entry 状态、③失败 toast 落新书界面。修复后统一按入口
 * 书名复检，切书后静默退出（不 toast 不写状态）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const toastSpy = vi.fn()

vi.mock('../../../src/studio/web-next/src/api/documents', () => {
  const getContent = vi.fn()
  return {
    getContent,
    // 重评-0912-4 P1-1:doOpen 改走完整载荷——委托默认包装既有 getContent mock(suspect 分支默认不触发)
    getContentPayload: vi.fn(async (...a: Parameters<typeof getContent>) => ({ content: await getContent(...a) })),
    saveContent: vi.fn(),
    finalizeDoc: vi.fn(),
  }
})
vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  ApiError: class ApiError extends Error {
    status: number
    code?: string
    // 与真实 client.ApiError 同构（message, status, code）——doc.ts 判 instanceof + code
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
  useUiStore: () => ({ toast: toastSpy }),
}))

import { getContent } from '../../../src/studio/web-next/src/api/documents'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import { sha256Revision } from '../../../src/studio/web-next/src/shared/revision'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

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

/** 镜像 key（与 doc.ts MIRROR_KEY_PREFIX 同式：`clw:dirty-mirror:<book>:<docId>`）。 */
function mirrorKey(book: string, docId: string): string {
  return `clw:dirty-mirror:${book}:${docId}`
}

/** 注入 localStorage 桩（node 环境默认无）——观察 clearDirtyMirror 的删除落点。 */
function stubLocalStorage(initial: Record<string, string> = {}): Map<string, string> {
  const storage = new Map<string, string>(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
  })
  return storage
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  toastSpy.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('重评-P2-1 · refresh 切书窗口守卫', () => {
  it('refresh await 期间切书 → 静默退出：不 toast、旧书 entry 不写状态、不按新书名清镜像', async () => {
    const storage = stubLocalStorage()
    const doc = useDocStore()
    doc.setBook('A书')
    vi.mocked(getContent).mockResolvedValueOnce('旧内容')
    await doc.open(makeNode('写作/正文/第1章.md', 'd1'))
    const e = doc.get('d1')!
    const baseBefore = e.baselineRevision
    // 预置 B 书同 docId 的崩溃镜像：clean 归位分支的 clearDirtyMirror 按「当前书名」删键——
    // 切书后旧实现按 B 书删（B 书镜像无主复活面），修复后按入口快照只认 A 书
    storage.set(
      mirrorKey('B书', 'd1'),
      JSON.stringify({ book: 'B书', docId: 'd1', content: 'B书崩溃残留', savedAt: 1, baseRev: 'sha256:b' }),
    )
    doc.patch('d1', '已落盘内容') // 置 dirty；服务端内容与本地一致 → 若无守卫将走 clean 归位分支
    let resolveGet!: (v: string) => void
    vi.mocked(getContent).mockReturnValueOnce(new Promise<string>((r) => (resolveGet = r)))
    const p = doc.refresh('d1')
    doc.setBook('B书') // await 窗口内切书（A 书镜像随 setBook 清扫，e 脱离缓存）
    resolveGet('已落盘内容') // 迟到的旧书响应
    await expect(p).resolves.toBe(false)
    expect(toastSpy).not.toHaveBeenCalled()
    // 旧书 entry 状态不被迟到响应改写
    expect(e.dirty).toBe(true)
    expect(e.content).toBe('已落盘内容')
    expect(e.baselineRevision).toBe(baseBefore)
    // 关键：不按新书名清镜像（旧实现 clearDirtyMirror(bookName.value) 会删 B 书镜像）
    expect(storage.has(mirrorKey('B书', 'd1'))).toBe(true)
  })

  it('refresh 失败（getContent 拒绝）在途切书 → 失败 toast 不落新书界面', async () => {
    stubLocalStorage()
    const doc = useDocStore()
    doc.setBook('A书')
    vi.mocked(getContent).mockResolvedValueOnce('旧内容')
    await doc.open(makeNode('写作/正文/第1章.md', 'd1'))
    let rejectGet!: (e: Error) => void
    vi.mocked(getContent).mockReturnValueOnce(
      new Promise<string>((_res, rej) => {
        rejectGet = rej
      }),
    )
    const p = doc.refresh('d1')
    doc.setBook('B书') // 在途切书
    rejectGet(new Error('fetch failed'))
    await expect(p).resolves.toBe(false)
    expect(toastSpy).not.toHaveBeenCalled() // 旧书失败提示不落新书界面
  })

  it('对照：未切书时同链路照常归位（守卫不误伤常规 refresh）', async () => {
    stubLocalStorage()
    const doc = useDocStore()
    doc.setBook('A书')
    vi.mocked(getContent).mockResolvedValueOnce('旧内容')
    await doc.open(makeNode('写作/正文/第1章.md', 'd1'))
    doc.patch('d1', '已落盘内容')
    vi.mocked(getContent).mockResolvedValueOnce('已落盘内容')
    await expect(doc.refresh('d1')).resolves.toBe(true)
    const e = doc.get('d1')!
    expect(e.dirty).toBe(false)
    expect(e.baselineRevision).toBe(await sha256Revision('已落盘内容'))
  })
})
