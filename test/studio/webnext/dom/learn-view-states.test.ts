/**
 * LearnView 文风收割工作台形态族（happy-dom）：未收割空态三态分流 / 收割在途 / 有结果
 * 概览 / 零候选与仅金句 / 失败条 / 勾选入库与反馈条生命周期。
 *
 * 样章与金句候选区为真子组件（勾选态经 learn store 单实例贯通），故「勾选 → 收录」
 * 链路在本档直达 DOM；store 侧的 API 边界（runLearn / runLearnCommit）以桩驱动，
 * 不发真实 HTTP。断言锚渲染文本与调用载荷（含只发勾选项的候选制红线），不锚源码。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({ runLearn: vi.fn(), runLearnCommit: vi.fn() }))

vi.mock('../../../../src/studio/web-next/src/api/learn', () => ({
  runLearn: mocks.runLearn,
  runLearnCommit: mocks.runLearnCommit,
}))

import LearnView from '../../../../src/studio/web-next/src/views/LearnView.vue'
import { useTreeStore } from '../../../../src/studio/web-next/src/stores/tree'
import type { SampleCandidateFE, QuoteCandidateFE } from '../../../../src/studio/web-next/src/api/learn'
import type { TreeNode } from '../../../../src/studio/web-next/src/types/tree'
import { makeChapterNode, makeChapterNodeAt } from '../helpers/tree-node'

enableAutoUnmount(afterEach)

/** 收割结果信封（镜像 api/learn 的两字段返回） */
interface LearnResult {
  samples: SampleCandidateFE[]
  quotes: QuoteCandidateFE[]
}
/** 入库结果信封（镜像 api/learn 的三字段返回） */
interface CommitResult {
  ok: true
  sampleFiles: string[]
  quoteFiles: string[]
}

function pending<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function sample(场景: string, 打分: number, 正文: string): SampleCandidateFE {
  return { 场景, 正文, 出处: '《书》第1章', 章号: 1, 打分 }
}
function quote(正文: string): QuoteCandidateFE {
  return { 场景: '景物', 正文, 出处: '《书》第1章', 章号: 1 }
}

function seedTree(nodes: TreeNode[]): void {
  useTreeStore().raw = nodes
}

function mountLearn(): ReturnType<typeof mount> {
  return mount(LearnView, { props: { bookName: '书A' } })
}

/** 工作台主按钮 / 收录按钮（模板里两枚同族 .btn，收录侧 non-primary） */
const harvestBtn = (w: ReturnType<typeof mount>) => w.find('.head-actions .btn.primary')
const commitBtn = (w: ReturnType<typeof mount>) => w.find('.head-actions .btn:not(.primary)')

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  seedTree([])
  mocks.runLearn.mockResolvedValue({ samples: [], quotes: [] })
  mocks.runLearnCommit.mockResolvedValue({
    ok: true,
    sampleFiles: ['文风/样章库/第1章.md'],
    quoteFiles: ['文风/样章库/金句.md'],
  })
})

describe('LearnView：空态三态分流', () => {
  it('未收割且无定稿正文 → 引导先写正文；收割可用、收录禁用', async () => {
    const w = mountLearn()
    await flushPromises()

    expect(w.find('.learn-title').text()).toBe('文风收割')
    expect(w.find('.chap-hint').exists()).toBe(false)
    expect(w.find('.es-text').text()).toBe('当前没有定稿正文可收割——先写正文并定稿。')
    expect(w.find('.learn-body').exists()).toBe(false)
    expect(harvestBtn(w).text()).toContain('收割候选')
    expect(harvestBtn(w).attributes('disabled')).toBeUndefined()
    expect(commitBtn(w).attributes('disabled')).toBeDefined()
  })

  it('未收割但有定稿正文 → 章节数按正文节点计（非正文节点不计），引导开始收割', async () => {
    seedTree([makeChapterNode('d1'), makeChapterNode('d2'), makeChapterNodeAt('设定/人物.md', 'd9')])
    const w = mountLearn()
    await flushPromises()

    expect(w.find('.chap-hint').text()).toBe('2 章定稿可收割')
    expect(w.find('.es-text').text()).toBe('点击「收割候选」分析 2 章定稿正文。')
  })

  it('收割已跑但零候选 → 与「未收割」分流的另一条空态文案', async () => {
    mocks.runLearn.mockResolvedValueOnce({ samples: [], quotes: [] })
    const w = mountLearn()
    await flushPromises()
    await harvestBtn(w).trigger('click')
    await flushPromises()

    expect(w.find('.es-text').text()).toBe('这次没有合格候选——定稿正文得分普遍偏低，或缺少有特色的短句。')
    expect(w.find('.learn-body').exists()).toBe(false)
    expect(w.find('.banner.err').exists()).toBe(false)
  })
})

describe('LearnView：收割在途与结果概览', () => {
  it('收割在途 → 按钮禁转「收割中…」，空态与结果区同时让位；落定后有结果区', async () => {
    const req = pending<LearnResult>()
    mocks.runLearn.mockReturnValueOnce(req.promise)
    const w = mountLearn()
    await flushPromises()

    await harvestBtn(w).trigger('click')
    expect(mocks.runLearn).toHaveBeenCalledWith('书A')
    expect(harvestBtn(w).attributes('disabled')).toBeDefined()
    expect(harvestBtn(w).text()).toContain('收割中…')
    expect(w.find('.learn-empty').exists()).toBe(false)
    expect(w.find('.learn-body').exists()).toBe(false)

    req.resolve({ samples: [sample('战斗', 95, '战斗正文')], quotes: [] })
    await flushPromises()
    expect(w.find('.learn-body').exists()).toBe(true)
    expect(w.find('.learn-empty').exists()).toBe(false)
    expect(harvestBtn(w).text()).toContain('收割候选')
  })

  it('有候选 → 分布条按打分分档计数、统计取场景去重数', async () => {
    mocks.runLearn.mockResolvedValueOnce({
      samples: [sample('战斗', 95, '甲'), sample('战斗', 80, '乙'), sample('景物', 65, '丙')],
      quotes: [quote('金句一')],
    })
    const w = mountLearn()
    await flushPromises()
    await harvestBtn(w).trigger('click')
    await flushPromises()

    expect(w.findAll('.dist-num').map((n) => n.text())).toEqual(['1', '1', '1'])
    expect(w.find('.overview-meta').text()).toBe('样章 3 · 金句 1 · 2 场景')
    expect(w.findAll('.cand-card')).toHaveLength(3)
    expect(w.find('.quote-card').exists()).toBe(true)
  })

  it('只有金句无样章 → 结果区在场但分布概览不渲染', async () => {
    mocks.runLearn.mockResolvedValueOnce({ samples: [], quotes: [quote('金句一')] })
    const w = mountLearn()
    await flushPromises()
    await harvestBtn(w).trigger('click')
    await flushPromises()

    expect(w.find('.learn-body').exists()).toBe(true)
    expect(w.find('.overview').exists()).toBe(false)
    expect(w.findAll('.quote-card')).toHaveLength(1)
    expect(w.find('.learn-empty').exists()).toBe(false)
  })

  it('收割失败 → role="alert" 错误条，空态与结果区都不渲染，按钮复位可重试', async () => {
    mocks.runLearn.mockRejectedValueOnce(new Error('收割服务端挂了'))
    const w = mountLearn()
    await flushPromises()
    await harvestBtn(w).trigger('click')
    await flushPromises()

    const bar = w.find('.banner.err')
    expect(bar.attributes('role')).toBe('alert')
    expect(bar.text()).toContain('收割服务端挂了')
    expect(w.find('.learn-empty').exists()).toBe(false)
    expect(w.find('.learn-body').exists()).toBe(false)
    expect(harvestBtn(w).attributes('disabled')).toBeUndefined()
  })
})

describe('LearnView：勾选入库与反馈条', () => {
  it('勾选样章 → 收录按钮启用并显示勾选数；入库只发勾选项，成功条按结果计数', async () => {
    const picked = sample('战斗', 95, '被勾选的正文')
    mocks.runLearn.mockResolvedValueOnce({ samples: [picked, sample('战斗', 80, '未勾选的正文')], quotes: [] })
    const w = mountLearn()
    await flushPromises()
    await harvestBtn(w).trigger('click')
    await flushPromises()

    expect(commitBtn(w).attributes('disabled')).toBeDefined() // 零勾选 → 禁用
    await w.findAll('.cand-card input[type="checkbox"]')[0]!.setValue(true)
    expect(commitBtn(w).text()).toContain('收录（1）')
    expect(commitBtn(w).attributes('disabled')).toBeUndefined()

    const req = pending<CommitResult>()
    mocks.runLearnCommit.mockReturnValueOnce(req.promise)
    await commitBtn(w).trigger('click')
    expect(mocks.runLearnCommit).toHaveBeenCalledWith('书A', { samples: [picked], quotes: [] })
    expect(commitBtn(w).text()).toContain('收录中…')
    expect(commitBtn(w).attributes('disabled')).toBeDefined()

    req.resolve({ ok: true, sampleFiles: ['文风/样章库/第1章.md'], quoteFiles: [] })
    await flushPromises()
    expect(w.find('.banner.ok').text()).toContain('已收录 1 章样章、0 条金句')
    expect(commitBtn(w).text()).toContain('收录（0）')
  })

  it('反馈条可关闭；下一次入库结果自动恢复显形（关闭态不残留）', async () => {
    mocks.runLearn.mockResolvedValueOnce({
      samples: [sample('战斗', 95, '先入库'), sample('战斗', 80, '后入库')],
      quotes: [],
    })
    const w = mountLearn()
    await flushPromises()
    await harvestBtn(w).trigger('click')
    await flushPromises()

    await w.findAll('.cand-card input[type="checkbox"]')[0]!.setValue(true)
    await commitBtn(w).trigger('click')
    await flushPromises()
    expect(w.find('.banner.ok').text()).toContain('已收录 1 章样章、1 条金句')

    await w.find('.banner-close').trigger('click')
    expect(w.find('.banner.ok').exists()).toBe(false)

    // 入库后已收录项移出候选列表：剩下的即未入库那条
    mocks.runLearnCommit.mockResolvedValueOnce({ ok: true, sampleFiles: ['文风/样章库/第2章.md'], quoteFiles: [] })
    await w.findAll('.cand-card input[type="checkbox"]')[0]!.setValue(true)
    await commitBtn(w).trigger('click')
    await flushPromises()
    expect(w.find('.banner.ok').text()).toContain('已收录 1 章样章、0 条金句')
  })

  it('入库失败 → 同一条反馈条给失败文案，勾选保留可再提交', async () => {
    mocks.runLearn.mockResolvedValueOnce({ samples: [sample('战斗', 95, '待入库正文')], quotes: [] })
    const w = mountLearn()
    await flushPromises()
    await harvestBtn(w).trigger('click')
    await flushPromises()
    await w.findAll('.cand-card input[type="checkbox"]')[0]!.setValue(true)

    mocks.runLearnCommit.mockRejectedValueOnce(new Error('入库服务端挂了'))
    await commitBtn(w).trigger('click')
    await flushPromises()

    expect(w.find('.banner.ok').text()).toContain('收录失败：入库服务端挂了')
    expect(w.findAll('.cand-card')).toHaveLength(1)
    expect(commitBtn(w).text()).toContain('收录（1）')
    expect(commitBtn(w).attributes('disabled')).toBeUndefined()
  })
})
