/**
 * style store 单测（第十轮 P1-TST-1）：文风条目库 / 候选箱 / 定标 / 收割 / 机检趋势。
 *
 * 覆盖重点：
 * - load 三路并行拉取（entries/candidates/config）+ migration 返回
 * - pendingCount / kindCounts 派生计算
 * - add/remove/confirm/ignore 本地状态同步
 * - harvest 有新增才 reloadCandidates
 * - freeze 更新 baseline / rescan 更新 trend
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/style', () => ({
  listStyleEntries: vi.fn(),
  addStyleEntry: vi.fn(),
  deleteStyleEntry: vi.fn(),
  listStyleCandidates: vi.fn(),
  confirmStyleCandidate: vi.fn(),
  ignoreStyleCandidate: vi.fn(),
  runStyleHarvest: vi.fn(),
  getStyleConfig: vi.fn(),
  freezeStyleBaseline: vi.fn(),
  getStyleTrend: vi.fn(),
}))

import {
  listStyleEntries,
  addStyleEntry,
  deleteStyleEntry,
  listStyleCandidates,
  confirmStyleCandidate,
  ignoreStyleCandidate,
  runStyleHarvest,
  getStyleConfig,
  freezeStyleBaseline,
  getStyleTrend,
} from '../../../src/studio/web-next/src/api/style'
import { useStyleStore } from '../../../src/studio/web-next/src/stores/style'
import type { StyleEntryFE, StyleCandidateFE, StyleConfigFE, StyleTrendFE } from '../../../src/studio/web-next/src/api/style'

const listEntriesMock = listStyleEntries as ReturnType<typeof vi.fn>
const listCandidatesMock = listStyleCandidates as ReturnType<typeof vi.fn>
const getConfigMock = getStyleConfig as ReturnType<typeof vi.fn>
const addEntryMock = addStyleEntry as ReturnType<typeof vi.fn>
const deleteEntryMock = deleteStyleEntry as ReturnType<typeof vi.fn>
const confirmCandidateMock = confirmStyleCandidate as ReturnType<typeof vi.fn>
const ignoreCandidateMock = ignoreStyleCandidate as ReturnType<typeof vi.fn>
const harvestMock = runStyleHarvest as ReturnType<typeof vi.fn>
const freezeMock = freezeStyleBaseline as ReturnType<typeof vi.fn>
const trendMock = getStyleTrend as ReturnType<typeof vi.fn>

const BOOK = 'test-book'

function entry(path: string, kind: string): StyleEntryFE {
  return { _path: path, 类型: kind, 场景: '', 说明: '', 标签: [], 创建: '', 来源: '作者标注', 正文: '' } as StyleEntryFE
}
function candidate(path: string, status: string): StyleCandidateFE {
  return { _path: path, 状态: status, 来源: '收割', 说明: '', 创建: '', 类型: '样章', 场景: '', 正文: '' } as StyleCandidateFE
}
function config(): StyleConfigFE {
  return { baseline: null, 条目标签: [], 候选源: [] } as unknown as StyleConfigFE
}

beforeEach(() => {
  setActivePinia(createPinia())
  listEntriesMock.mockReset()
  listCandidatesMock.mockReset()
  getConfigMock.mockReset()
  addEntryMock.mockReset()
  deleteEntryMock.mockReset()
  confirmCandidateMock.mockReset()
  ignoreCandidateMock.mockReset()
  harvestMock.mockReset()
  freezeMock.mockReset()
  trendMock.mockReset()
})

describe('style: load 并行加载', () => {
  it('三路拉取 → entries/candidates/config 就位 + 返回 migration', async () => {
    listEntriesMock.mockResolvedValue({ entries: [entry('a.md', '样章')], errors: [], migration: null })
    listCandidatesMock.mockResolvedValue({ candidates: [candidate('c1.md', '待确认')] })
    getConfigMock.mockResolvedValue(config())

    const style = useStyleStore()
    const migration = await style.load(BOOK)

    expect(migration).toBeNull()
    expect(style.bookName).toBe(BOOK)
    expect(style.entries).toHaveLength(1)
    expect(style.candidates).toHaveLength(1)
    expect(style.config).not.toBeNull()
    expect(style.loaded).toBe(true)
    expect(style.loading).toBe(false)
  })

  it('load 失败 → loading 复位（finally）', async () => {
    listEntriesMock.mockRejectedValue(new Error('down'))
    const style = useStyleStore()
    await expect(style.load(BOOK)).rejects.toThrow('down')
    expect(style.loading).toBe(false)
  })
})

describe('style: 派生计算', () => {
  it('pendingCount = 待确认候选数', async () => {
    listEntriesMock.mockResolvedValue({ entries: [], errors: [], migration: null })
    listCandidatesMock.mockResolvedValue({
      candidates: [candidate('a.md', '待确认'), candidate('b.md', '待确认'), candidate('c.md', '已忽略')],
    })
    getConfigMock.mockResolvedValue(config())
    const style = useStyleStore()
    await style.load(BOOK)
    expect(style.pendingCount).toBe(2)
  })

  it('kindCounts 按类型计数', async () => {
    listEntriesMock.mockResolvedValue({
      entries: [entry('a.md', '样章'), entry('b.md', '手法'), entry('c.md', '样章'), entry('d.md', '禁词')],
      errors: [],
      migration: null,
    })
    listCandidatesMock.mockResolvedValue({ candidates: [] })
    getConfigMock.mockResolvedValue(config())
    const style = useStyleStore()
    await style.load(BOOK)
    expect(style.kindCounts).toEqual({ 样章: 2, 手法: 1, 反例: 0, 禁词: 1 })
  })
})

describe('style: 条目增删', () => {
  it('add → 调 API + reloadEntries 刷新', async () => {
    listEntriesMock.mockResolvedValueOnce({ entries: [], errors: [], migration: null })
    listCandidatesMock.mockResolvedValueOnce({ candidates: [] })
    getConfigMock.mockResolvedValueOnce(config())
    const style = useStyleStore()
    await style.load(BOOK)

    addEntryMock.mockResolvedValue({ ok: true })
    listEntriesMock.mockResolvedValueOnce({ entries: [entry('new.md', '手法')], errors: [], migration: null })
    await style.add({ 类型: '手法', 场景: '打斗', 说明: '短句', 标签: [] } as never)

    expect(addEntryMock).toHaveBeenCalledWith(BOOK, expect.objectContaining({ 类型: '手法' }))
    expect(style.entries).toHaveLength(1)
  })

  it('remove → 本地过滤（不重拉）', async () => {
    listEntriesMock.mockResolvedValue({ entries: [entry('a.md', '样章')], errors: [], migration: null })
    listCandidatesMock.mockResolvedValue({ candidates: [] })
    getConfigMock.mockResolvedValue(config())
    const style = useStyleStore()
    await style.load(BOOK)

    deleteEntryMock.mockResolvedValue({ ok: true })
    await style.remove('a.md')
    expect(deleteEntryMock).toHaveBeenCalledWith(BOOK, 'a.md')
    expect(style.entries).toHaveLength(0)
  })
})

describe('style: 候选箱确认/忽略', () => {
  it('confirm → 移出候选 + 重拉条目', async () => {
    listEntriesMock.mockResolvedValueOnce({ entries: [], errors: [], migration: null })
    listCandidatesMock.mockResolvedValueOnce({ candidates: [candidate('c1.md', '待确认')] })
    getConfigMock.mockResolvedValueOnce(config())
    const style = useStyleStore()
    await style.load(BOOK)

    confirmCandidateMock.mockResolvedValue({ ok: true })
    listEntriesMock.mockResolvedValueOnce({ entries: [entry('from-candidate.md', '手法')], errors: [], migration: null })
    await style.confirm('c1.md')

    expect(confirmCandidateMock).toHaveBeenCalledWith(BOOK, 'c1.md')
    expect(style.candidates).toHaveLength(0)
    expect(style.entries).toHaveLength(1)
  })

  it('ignore → 状态标已忽略（保留在列表）', async () => {
    listEntriesMock.mockResolvedValue({ entries: [], errors: [], migration: null })
    listCandidatesMock.mockResolvedValue({ candidates: [candidate('c1.md', '待确认')] })
    getConfigMock.mockResolvedValue(config())
    const style = useStyleStore()
    await style.load(BOOK)

    ignoreCandidateMock.mockResolvedValue({ ok: true })
    await style.ignore('c1.md')
    expect(ignoreCandidateMock).toHaveBeenCalledWith(BOOK, 'c1.md')
    expect(style.candidates).toHaveLength(1)
    expect(style.candidates[0]!.状态).toBe('已忽略')
  })
})

describe('style: 收割 / 定标 / 趋势', () => {
  it('harvest 有新增 → reloadCandidates', async () => {
    listEntriesMock.mockResolvedValue({ entries: [], errors: [], migration: null })
    listCandidatesMock.mockResolvedValueOnce({ candidates: [] })
    getConfigMock.mockResolvedValue(config())
    const style = useStyleStore()
    await style.load(BOOK)

    harvestMock.mockResolvedValue({ created: 2, skipped: 1 })
    listCandidatesMock.mockResolvedValueOnce({ candidates: [candidate('new1.md', '待确认')] })
    const r = await style.harvest()
    expect(r).toEqual({ created: 2, skipped: 1 })
    expect(style.candidates).toHaveLength(1)
  })

  it('harvest 无新增 → 不重拉', async () => {
    listEntriesMock.mockResolvedValue({ entries: [], errors: [], migration: null })
    listCandidatesMock.mockResolvedValueOnce({ candidates: [] })
    getConfigMock.mockResolvedValue(config())
    const style = useStyleStore()
    await style.load(BOOK)

    harvestMock.mockResolvedValue({ created: 0, skipped: 0 })
    await style.harvest()
    expect(listCandidatesMock).toHaveBeenCalledTimes(1) // 仅 load 时一次
  })

  it('freeze → 更新 config.baseline', async () => {
    listEntriesMock.mockResolvedValue({ entries: [], errors: [], migration: null })
    listCandidatesMock.mockResolvedValue({ candidates: [] })
    getConfigMock.mockResolvedValue(config())
    const style = useStyleStore()
    await style.load(BOOK)

    freezeMock.mockResolvedValue({ baseline: { 创建: '2026-08-11', 版本: 2 } })
    await style.freeze()
    expect(style.config!.baseline).toEqual({ 创建: '2026-08-11', 版本: 2 })
  })

  it('rescan → 更新 trend', async () => {
    listEntriesMock.mockResolvedValue({ entries: [], errors: [], migration: null })
    listCandidatesMock.mockResolvedValue({ candidates: [] })
    getConfigMock.mockResolvedValue(config())
    const style = useStyleStore()
    await style.load(BOOK)

    const trend = { 漂移: [], 统计: {} } as unknown as StyleTrendFE
    trendMock.mockResolvedValue(trend)
    await style.rescan()
    expect(style.trend).toStrictEqual(trend)
  })
})
