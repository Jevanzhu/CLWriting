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
})
