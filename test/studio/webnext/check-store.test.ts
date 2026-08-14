/**
 * check store 单测（第十一轮 P1-TST-1）：
 * 机检触发 / 红/黄项分组 / 清空。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/check', () => ({
  runCheck: vi.fn(),
}))

import { runCheck } from '../../../src/studio/web-next/src/api/check'
import { useCheckStore } from '../../../src/studio/web-next/src/stores/check'

const checkMock = runCheck as ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('check: 触发机检', () => {
  it('run 成功 → report + hasRed 填充', async () => {
    checkMock.mockResolvedValue({
      ok: true,
      hasRed: true,
      report: {
        sections: [
          { name: '复读检测', items: [{ checkId: 'r1', level: 'red', message: '复读超标' }] },
          { name: '禁词检测', items: [{ checkId: 'w1', level: 'yellow', message: '发现禁词' }] },
        ],
      },
    })
    const s = useCheckStore()
    await s.run('book1', 'doc_1')
    expect(s.report).not.toBeNull()
    expect(s.hasRed).toBe(true)
    expect(s.lastDocId).toBe('doc_1')
    expect(s.loading).toBe(false)
    expect(s.error).toBeNull()
  })

  it('run 失败 → error 设置 + report 清空', async () => {
    checkMock.mockRejectedValue(new Error('读取失败'))
    const s = useCheckStore()
    await s.run('book1', 'doc_1')
    expect(s.error).not.toBeNull()
    expect(s.report).toBeNull()
    expect(s.hasRed).toBe(false)
    expect(s.loading).toBe(false)
  })
})

describe('check: 红/黄项分组', () => {
  it('redItems / yellowItems 正确过滤', async () => {
    checkMock.mockResolvedValue({
      ok: true, hasRed: true,
      report: {
        sections: [
          { name: 'S1', items: [
            { checkId: 'a', level: 'red', message: '红1' },
            { checkId: 'b', level: 'yellow', message: '黄1' },
          ]},
          { name: 'S2', items: [
            { checkId: 'c', level: 'red', message: '红2' },
          ]},
        ],
      },
    })
    const s = useCheckStore()
    await s.run('book1', 'doc_1')
    expect(s.redItems).toHaveLength(2)
    expect(s.yellowItems).toHaveLength(1)
    expect(s.redItems[0]!.message).toBe('红1')
  })

  it('无 report 时 redItems / yellowItems 为空数组', () => {
    const s = useCheckStore()
    expect(s.redItems).toHaveLength(0)
    expect(s.yellowItems).toHaveLength(0)
  })
})

describe('check: clear', () => {
  it('clear → 全部重置', async () => {
    checkMock.mockResolvedValue({ ok: true, hasRed: true, report: { sections: [] } })
    const s = useCheckStore()
    await s.run('book1', 'doc_1')

    s.clear()
    expect(s.report).toBeNull()
    expect(s.error).toBeNull()
    expect(s.hasRed).toBe(false)
    expect(s.lastDocId).toBeNull()
  })
})
