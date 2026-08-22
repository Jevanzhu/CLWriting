/**
 * check store 单测（第十一轮 P1-TST-1）：
 * 机检触发 / 红/黄项分组 / 清空 / 误报标记持久化与跨文档隔离（M-1 二轮复审）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/check', () => ({
  runCheck: vi.fn(),
  markFalsePositive: vi.fn(),
}))

import { runCheck, markFalsePositive } from '../../../src/studio/web-next/src/api/check'
import { useCheckStore } from '../../../src/studio/web-next/src/stores/check'

const checkMock = runCheck as ReturnType<typeof vi.fn>
const fpMock = markFalsePositive as ReturnType<typeof vi.fn>

/** node 环境无 localStorage——Map 桩顶上（M-1 持久化路径可测） */
function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  return store
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
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

describe('check: 误报标记（M-1 持久化 + 跨文档隔离）', () => {
  it('flagFalsePositive 成功 → flagged 更新 + 写 localStorage（刷新可回填）', async () => {
    const store = stubLocalStorage()
    checkMock.mockResolvedValue({ ok: true, hasRed: true, report: { sections: [] } })
    fpMock.mockResolvedValue({ ok: true })
    const s = useCheckStore()
    await s.run('book1', 'doc_1')

    await s.flagFalsePositive('book1', 'doc_1', 'r1')
    expect(s.flagged.has('r1')).toBe(true)
    expect(s.flagging).toBeNull()
    expect(JSON.parse(store.get('clw-fp:book1:doc_1')!)).toEqual(['r1'])
  })

  it('run 时 localStorage 已有标记 → 灰显态回填', async () => {
    const store = stubLocalStorage()
    store.set('clw-fp:book1:doc_1', JSON.stringify(['r1', 'w2']))
    checkMock.mockResolvedValue({ ok: true, hasRed: false, report: { sections: [] } })
    const s = useCheckStore()

    await s.run('book1', 'doc_1')
    expect(s.flagged.has('r1')).toBe(true)
    expect(s.flagged.has('w2')).toBe(true)
    expect(s.flagError).toBeNull()
  })

  it('clear → flagged 清空；同文档再 run → 持久化标记回填（服务端真相不丢）', async () => {
    stubLocalStorage()
    checkMock.mockResolvedValue({ ok: true, hasRed: true, report: { sections: [] } })
    fpMock.mockResolvedValue({ ok: true })
    const s = useCheckStore()
    await s.run('book1', 'doc_1')
    await s.flagFalsePositive('book1', 'doc_1', 'r1')

    s.clear()
    expect(s.flagged.size).toBe(0)
    expect(s.flagging).toBeNull()
    expect(s.flagError).toBeNull()

    await s.run('book1', 'doc_1')
    expect(s.flagged.has('r1')).toBe(true)
  })

  it('跨文档隔离：doc_1 的标记不灰显到 doc_2 同名命中上', async () => {
    stubLocalStorage()
    checkMock.mockResolvedValue({ ok: true, hasRed: true, report: { sections: [] } })
    fpMock.mockResolvedValue({ ok: true })
    const s = useCheckStore()
    await s.run('book1', 'doc_1')
    await s.flagFalsePositive('book1', 'doc_1', 'r1')

    await s.run('book1', 'doc_2')
    expect(s.flagged.size).toBe(0)
  })

  it('P-9（第十四轮）标记在途时切文档（clear→新 run）→ 迟到响应不污染新文档灰显集与 localStorage', async () => {
    const store = stubLocalStorage()
    checkMock.mockResolvedValue({ ok: true, hasRed: true, report: { sections: [] } })
    // markFalsePositive 挂起：给竞态留窗口
    let release!: (v: { ok: boolean }) => void
    fpMock.mockReturnValue(new Promise<{ ok: boolean }>((r) => { release = r }))
    const s = useCheckStore()
    await s.run('book1', 'doc_1')

    const flagP = s.flagFalsePositive('book1', 'doc_1', 'r1') // A 文档标记在途
    s.clear() // 切文档：opGen 推进
    await s.run('book1', 'doc_2') // B 报告回填（flagged 空）
    expect(s.flagged.size).toBe(0)

    release({ ok: true }) // A 的迟到成功响应
    await flagP
    // 修复前：checkId 'r1' 被追加进 B 的灰显集，且 B 场景下把污染集写进 A 的 localStorage 键
    expect(s.flagged.size).toBe(0)
    expect(s.flagged.has('r1')).toBe(false)
    expect(store.get('clw-fp:book1:doc_1')).toBeUndefined()
    expect(s.flagging).toBeNull()
    expect(s.flagError).toBeNull()
  })

  it('P-9 对照：无切换时标记正常落地（守卫不误伤常规路径）', async () => {
    const store = stubLocalStorage()
    checkMock.mockResolvedValue({ ok: true, hasRed: true, report: { sections: [] } })
    fpMock.mockResolvedValue({ ok: true })
    const s = useCheckStore()
    await s.run('book1', 'doc_1')
    await s.flagFalsePositive('book1', 'doc_1', 'r1')
    expect(s.flagged.has('r1')).toBe(true)
    expect(JSON.parse(store.get('clw-fp:book1:doc_1')!)).toEqual(['r1'])
  })
})
