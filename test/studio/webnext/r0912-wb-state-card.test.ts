// @vitest-environment happy-dom
/**
 * R0912-FE 修复批 · WbStateCard 直测：
 * - P2-2：state 5 action='volume-review' 按钮语义错位——按钮原叫「卷复盘」实际 emit
 *   spawn 走 writer 链写下一章。修法只对齐文案（产品语义待拍板不动）：按钮改
 *   「继续写作（下一章）」+ title 注明 + 卡内兜底说明行；emit spawn 语义不变。
 * - P2-3：崩溃 pending「忽略此提醒」按钮——state 1 且服务端透出 crashedPendingOpIds
 *   时渲染（字段缺省不渲染，/state 透出位见 BookState 契约注），点击 emit acknowledge
 *   由父层调用（api 封装另有直测）。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import WbStateCard from '../../../src/studio/web-next/src/components/workbench/WbStateCard.vue'
import type { BookState } from '../../../src/studio/web-next/src/api/stream'

function stateOf(partial: Partial<BookState>): BookState {
  return { state: 7, stateName: '起草新章', humanMsg: '', action: '', ...partial }
}

function mountCard(state: BookState | null) {
  setActivePinia(createPinia())
  return mount(WbStateCard, { props: { state } })
}

describe('WbStateCard · R0912-FE-P2-2：volume-review 文案对齐', () => {
  it('state 5 → 按钮不再叫「卷复盘」，改「继续写作（下一章）」+ title 注明规划中', () => {
    const w = mountCard(stateOf({ state: 5, stateName: '卷末', action: 'volume-review', humanMsg: '第 2 卷写完了，建议做卷复盘（节奏/线收束/伏笔回收）再开下一卷。' }))
    const btn = w.findAll('button').find((b) => b.text().includes('下一章'))
    expect(btn).toBeDefined()
    expect(btn!.text()).toBe('继续写作（下一章）')
    expect(btn!.attributes('title')).toContain('卷复盘功能规划中')
    // 按钮文案不再出现「卷复盘」字样（humanMsg 为服务端原文不在按钮面，兜底说明行另断言）
    expect(w.findAll('button').some((b) => b.text().includes('卷复盘'))).toBe(false)
    // humanMsg 呈现侧兜底：服务端 humanMsg 仍写「卷复盘」，卡内补一行对齐说明
    expect(w.text()).toContain('卷复盘功能规划中——当前按钮直接开写下一章')
    w.unmount()
  })

  it('state 5 点击按钮 → 仍 emit spawn（产品语义待拍板不动，只改文案）', async () => {
    const w = mountCard(stateOf({ state: 5, action: 'volume-review' }))
    const btn = w.findAll('button').find((b) => b.text().includes('下一章'))!
    await btn.trigger('click')
    expect(w.emitted('spawn')).toHaveLength(1)
    expect(w.emitted('acknowledge')).toBeUndefined()
    w.unmount()
  })

  it('state 7「开写新章」文案不受影响', () => {
    const w = mountCard(stateOf({ state: 7, action: 'write-new-chapter' }))
    expect(w.text()).toContain('开写新章')
    w.unmount()
  })
})

describe('WbStateCard · R0912-FE-P2-3：崩溃 pending 忽略按钮', () => {
  const crashed: BookState = stateOf({
    state: 1,
    stateName: '体检异常',
    action: '',
    humanMsg: '进门体检发现问题，先处理再开写：\n· 上次写作时「正文/第1章.md」的保存没完成，可能丢字。（…）',
    crashedPendingOpIds: ['op-1', 'op-2'],
  })

  it('state 1 且有 opId → 「忽略此提醒」按钮渲染', () => {
    const w = mountCard(crashed)
    const btn = w.find('[data-testid="ack-crashed"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toBe('忽略此提醒')
    w.unmount()
  })

  it('点击 → emit acknowledge（调用与刷新归父层，卡片纯出口）', async () => {
    const w = mountCard(crashed)
    await w.find('[data-testid="ack-crashed"]').trigger('click')
    expect(w.emitted('acknowledge')).toHaveLength(1)
    w.unmount()
  })

  it('无 opId（服务端未透出/已清账）→ 按钮不渲染', () => {
    const w = mountCard(stateOf({ state: 1, stateName: '体检异常' }))
    expect(w.find('[data-testid="ack-crashed"]').exists()).toBe(false)
    w.unmount()
  })

  it('非态 1（即使字段残留）→ 按钮不渲染', () => {
    const w = mountCard(stateOf({ state: 7, action: 'write-new-chapter', crashedPendingOpIds: ['op-1'] }))
    expect(w.find('[data-testid="ack-crashed"]').exists()).toBe(false)
    w.unmount()
  })
})
