/**
 * shelf store 单测（第十一轮 P1-TST-1）：
 * 书架列表加载 / workDir 缺失提示 / 错误处理。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/shelf', () => ({
  listBooks: vi.fn(),
}))

import { listBooks } from '../../../src/studio/web-next/src/api/shelf'
import { useShelfStore } from '../../../src/studio/web-next/src/stores/shelf'

const listMock = listBooks as ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('shelf: 加载书架', () => {
  it('load 成功 → books 填充 + workDirMissing false', async () => {
    listMock.mockResolvedValue({
      books: [{ name: '长篇1', kind: 'long' }, { name: '短篇集1', kind: 'short' }],
      workDir: true,
    })
    const s = useShelfStore()
    await s.load()
    expect(s.books).toHaveLength(2)
    expect(s.workDirMissing).toBe(false)
    expect(s.hint).toBeNull()
    expect(s.loading).toBe(false)
    expect(s.error).toBeNull()
  })

  it('load 无 workDir → workDirMissing true + hint', async () => {
    listMock.mockResolvedValue({
      books: [],
      workDir: false,
      hint: '请先选择书库目录',
    })
    const s = useShelfStore()
    await s.load()
    expect(s.books).toHaveLength(0)
    expect(s.workDirMissing).toBe(true)
    expect(s.hint).toBe('请先选择书库目录')
  })

  it('load 失败 → error 设置', async () => {
    listMock.mockRejectedValue(new Error('网络断开'))
    const s = useShelfStore()
    await s.load()
    expect(s.error).not.toBeNull()
    expect(s.loading).toBe(false)
  })

  // N-12（第五十四轮）：并发两次 load，先发的慢响应迟到不回填——后发者生效
  it('N-12: 并发两次 load → 后发者生效（慢响应迟到不回填旧数据）', async () => {
    let resolveSlow!: (v: { books: { name: string; kind: string }[]; workDir: boolean; hint?: string }) => void
    listMock.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveSlow = r
        }),
    )
    listMock.mockResolvedValueOnce({ books: [{ name: '新书', kind: 'long' }], workDir: true })
    const s = useShelfStore()
    const p1 = s.load()
    const p2 = s.load() // 后发：先返回
    resolveSlow({ books: [{ name: '旧书', kind: 'long' }], workDir: true }) // 先发的慢响应迟到
    await Promise.all([p1, p2])
    expect(s.books.map((b) => b.name)).toEqual(['新书'])
    expect(s.loading).toBe(false)
  })
})
