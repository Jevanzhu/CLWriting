// @vitest-environment happy-dom
/**
 * R0911b-C2-P3-1（2026-09-11 全量重评 GLM-5.3 修复批）：AuditEventList 抽件行为锚。
 * AuditView 对话/工作流两段事件列表模板原为近复制，抽本组件两处以 props/事件消费——
 * 本测试钉抽取的等价性契约：
 * - detailed（对话段专有）：遮蔽标记 / surfaceOp / 血缘引用列 + 展开态血缘注记 + 截断
 *   提示尾注（capHintSuffix）；
 * - 非 detailed（工作流段）：同字段即便存在也不渲染这些列（DOM 产物与原模板一致），
 *   空态/尾注文案由 props 区分；
 * - 交互面：toggle / load-more 事件上行、在途禁用（状态仍父持有，本组件纯渲染）。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AuditEventList from '../../../src/studio/web-next/src/components/audit/AuditEventList.vue'
import type { AuditEventFE } from '../../../src/studio/web-next/src/api/audit'

function ev(over: Partial<AuditEventFE> = {}): AuditEventFE {
  return {
    seq: 1,
    type: 'user/message',
    data: { message: '你好' },
    shadowed: false,
    ...over,
  } as AuditEventFE
}

describe('R0911b-C2-P3-1：AuditEventList 抽件等价性契约', () => {
  it('detailed=对话段：渲染遮蔽/血缘列，展开含血缘注记，截断提示带尾注', () => {
    const w = mount(AuditEventList, {
      props: {
        events: [ev({ shadowed: true, sourceSeqs: [3, 7] })],
        total: 9,
        loadingMore: false,
        hasMore: false,
        capHit: true,
        renderCap: 2000,
        expanded: new Set([1]),
        emptyText: '暂无事件',
        detailed: true,
        capHintSuffix: '——更早日志仍在事件库',
      },
    })
    expect(w.find('.ev-seq').classes()).toContain('shadowed')
    expect(w.find('.ev-shadow').exists()).toBe(true)
    expect(w.find('.ev-lineage').text()).toContain('3,7')
    expect(w.find('.lineage-note').text()).toContain('#3 #7')
    // hasMore=false 且 capHit=true → 渲染上限截断行 + 对话段尾注
    expect(w.find('.pager-hint').text()).toContain('渲染上限 2000')
    expect(w.find('.pager-hint').text()).toContain('更早日志仍在事件库')
    expect(w.find('.load-more').exists()).toBe(false)
  })

  it('非 detailed=工作流段：同字段不渲染专有列，空态/无尾注按 props', () => {
    const w = mount(AuditEventList, {
      props: {
        events: [ev({ shadowed: true, sourceSeqs: [3] })],
        total: 1,
        loadingMore: false,
        hasMore: false,
        capHit: true,
        renderCap: 2000,
        expanded: new Set([1]),
        emptyText: '暂无工作流事件（运行一次 AI 写作后可见）',
      },
    })
    // 原工作流模板无这些列——字段即便存在也不渲染（detailed 缺省 false）
    expect(w.find('.ev-shadow').exists()).toBe(false)
    expect(w.find('.ev-lineage').exists()).toBe(false)
    expect(w.find('.ev-op').exists()).toBe(false)
    expect(w.find('.lineage-note').exists()).toBe(false)
    expect(w.find('.ev-seq').classes()).not.toContain('shadowed')
    // 工作流段截断提示无尾注
    expect(w.find('.pager-hint').text()).not.toContain('更早日志')
    // events 空时按 emptyText 渲染（另挂一次验证 props 区分文案）
    const empty = mount(AuditEventList, {
      props: {
        events: [],
        total: 0,
        loadingMore: false,
        hasMore: false,
        capHit: false,
        renderCap: 2000,
        expanded: new Set<number>(),
        emptyText: '暂无工作流事件（运行一次 AI 写作后可见）',
      },
    })
    expect(empty.find('.empty').text()).toBe('暂无工作流事件（运行一次 AI 写作后可见）')
  })

  it('交互上行：行点击发 toggle(seq)，续页点击发 load-more 且在途禁用', async () => {
    const w = mount(AuditEventList, {
      props: {
        events: [ev({ seq: 42 }), ev({ seq: 43 })],
        total: 99,
        loadingMore: true,
        hasMore: true,
        capHit: false,
        renderCap: 2000,
        expanded: new Set<number>(),
        emptyText: '暂无事件',
      },
    })
    await w.find('.ev-toggle').trigger('click')
    expect(w.emitted('toggle')?.[0]).toEqual([42])
    const btn = w.find('.load-more')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    expect(btn.text()).toContain('加载中…')
    // 在途禁用下不误发（原生 disabled 按钮不触发 click；直接断言零 emit）
    expect(w.emitted('load-more')).toBeUndefined()
    await w.setProps({ loadingMore: false })
    await w.find('.load-more').trigger('click')
    expect(w.emitted('load-more')).toHaveLength(1)
  })
})
