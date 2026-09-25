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

// ── 七轮重评-5（2026-09-19 源码独立重评七轮修复批）：摘要截断改码位 ──
// 码元 slice 在截断点恰为代理对（emoji/扩展平面字符）时劈出孤立代理项，摘要尾字符
// 渲染乱码。三处消费点：message 摘要 / goal 摘要 / JSON 详情预览，均收编
// clipByCodePoints（shared/text 单源）。

function expectNoLoneSurrogate(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      expect(d >= 0xdc00 && d <= 0xdfff).toBe(true)
    }
  }
}

describe('七轮重评-5：摘要码位截断不劈代理对', () => {
  it('message 摘要：增补平面字符在第 60 码元边界完整保留', () => {
    // 59 个 BMP 字符 + 𠮷（两码元）+ 尾字：旧 slice(0,60) 劈出孤立高代理
    const w = mount(AuditEventList, {
      props: {
        events: [ev({ data: { message: '甲'.repeat(59) + '𠮷' + '乙' } })],
        total: 1,
        loadingMore: false,
        hasMore: false,
        capHit: false,
        renderCap: 2000,
        expanded: new Set<number>(),
        emptyText: '暂无事件',
      },
    })
    const summary = w.find('.ev-summary').text()
    expect(summary).toContain('𠮷')
    expectNoLoneSurrogate(summary)
  })

  it('goal 摘要：拼接后截断点落代理对不劈半', () => {
    // '动词 '(3 码元) + 56 BMP = 59 码元，𠮷 恰跨第 60/61 码元——旧 slice 劈半
    const w = mount(AuditEventList, {
      props: {
        events: [ev({ type: 'goal/change', data: { operation: '动词', goal: { title: '甲'.repeat(56) + '𠮷' + '乙', state: 'open' } } })],
        total: 1,
        loadingMore: false,
        hasMore: false,
        capHit: false,
        renderCap: 2000,
        expanded: new Set<number>(),
        emptyText: '暂无事件',
      },
    })
    const summary = w.find('.ev-summary').text()
    expect(summary).toContain('𠮷')
    expectNoLoneSurrogate(summary)
  })

  it('JSON 详情预览：4KB 截断点落代理对不劈半', () => {
    // stringify(indent 2) 前缀 '{\\n  "k": "' 10 码元 + 4085 BMP = 4095 码元，
    // 𠮷 恰跨第 4096/4097 码元——旧 slice(0,4096) 劈半
    const w = mount(AuditEventList, {
      props: {
        events: [ev({ data: { k: '甲'.repeat(4085) + '𠮷' } })],
        total: 1,
        loadingMore: false,
        hasMore: false,
        capHit: false,
        renderCap: 2000,
        expanded: new Set([1]),
        emptyText: '暂无事件',
      },
    })
    const detail = w.find('.ev-detail pre').text()
    expect(detail).toContain('𠮷')
    expectNoLoneSurrogate(detail)
  })
})

// ── H503（七轮修复复核批）：JSON 详情截断/阈值/计数三处统一码位口径 ──
// 修复批只换 clip 一处为码位，触发阈值与「已截断」计数仍按码元——4097 码元/4096
// 码位形态（10 前缀 + 4082 BMP + 𠮷 + 3 收尾）clip 一字未删却宣称「已截断」。
// 修复后阈值判定走码位（withinDetailLimit），该形态原样完整渲染、无截断尾注。
describe('H503：JSON 详情量纲统一码位口径', () => {
  it('4097 码元/4096 码位形态：不截断、无「已截断」尾注', () => {
    const w = mount(AuditEventList, {
      props: {
        events: [ev({ data: { k: '甲'.repeat(4082) + '𠮷' } })],
        total: 1,
        loadingMore: false,
        hasMore: false,
        capHit: false,
        renderCap: 2000,
        expanded: new Set([1]),
        emptyText: '暂无事件',
      },
    })
    const detail = w.find('.ev-detail pre').text()
    expect(detail).toContain('𠮷')
    expect(detail).not.toContain('已截断')
    expectNoLoneSurrogate(detail)
  })
})
