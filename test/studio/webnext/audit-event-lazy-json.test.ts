// @vitest-environment happy-dom
/**
 * R0912-FE-P3-11（2026-09-11 重评-0911b 修复批）：AuditView 事件 data JSON 懒展开——
 * 超长 payload（>4KB）展开时只渲染截断摘要 +「查看完整 JSON」懒放行（点击才渲染全量，
 * 缓存复用零二次 stringify）；短 payload 直接全量、无按钮（rendered pre 样式不变）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AuditView from '../../../src/studio/web-next/src/views/AuditView.vue'
import type { AuditConversationFE } from '../../../src/studio/web-next/src/api/audit'

const mocks = vi.hoisted(() => ({
  getAudit: vi.fn(),
  clearAudit: vi.fn(),
}))

vi.mock('../../../src/studio/web-next/src/api/audit', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/studio/web-next/src/api/audit')>()
  return { ...mod, getAudit: mocks.getAudit, clearAudit: mocks.clearAudit }
})

const SMALL = { message: '一小条事件', task: 'outline' }
const BIG = {
  message: 'x'.repeat(6000), // 序列化后 > 4KB 上限
}
const BIG_TAIL = '尾部标记-完整渲染可达'

function conversationWith(events: unknown[]): Record<string, unknown> {
  return {
    conversation: {
      shadowedCount: 0,
      modelVisible: [],
      humanVisible: [],
      events,
      eventsTotal: events.length,
    } as unknown as AuditConversationFE,
    workflowEvents: [],
    workflowTotal: 0,
    goals: [],
    todos: [],
  }
}

function mountView() {
  return mount(AuditView, {
    props: { bookName: '测试书' },
    global: { stubs: { AuditDiffPanel: true, AuditGoalTodoPanel: true } },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // 每次调用产出全新事件对象（模拟真实重取——「放行全量」集合按 data 身份记账，
  // 刷新后必须对新对象失效复位）
  mocks.getAudit.mockImplementation(async () =>
    conversationWith([
      { seq: 1, sessionId: 's1', type: 'user/message', shadowed: false, data: { ...SMALL } },
      { seq: 2, sessionId: 's1', type: 'user/message', shadowed: false, data: { ...BIG, tail: BIG_TAIL } },
    ]),
  )
})

describe('AuditView 事件 JSON 懒展开（R0912-FE-P3-11）', () => {
  it('短 payload 展开 → 全量渲染，无「查看完整 JSON」按钮', async () => {
    const w = mountView()
    await flushPromises()
    await w.findAll('.ev-toggle')[0]!.trigger('click')
    const row = w.findAll('.ev-row')[0]!
    expect(row.find('pre').text()).toContain('一小条事件')
    expect(row.find('.ev-full-btn').exists()).toBe(false)
    w.unmount()
  })

  it('超长 payload 展开 → 截断摘要 +「查看完整 JSON」按钮（DOM 面有界）', async () => {
    const w = mountView()
    await flushPromises()
    await w.findAll('.ev-toggle')[1]!.trigger('click')
    const row = w.findAll('.ev-row')[1]!
    const pre = row.find('pre')
    expect(pre.text()).toContain('已截断')
    expect(pre.text().length).toBeLessThan(BIG.message.length) // 不再全量灌 DOM
    const btn = row.find('.ev-full-btn')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toBe('查看完整 JSON')
    w.unmount()
  })

  it('点「查看完整 JSON」→ 全量渲染（含尾部标记），按钮消失', async () => {
    const w = mountView()
    await flushPromises()
    await w.findAll('.ev-toggle')[1]!.trigger('click')
    const row = w.findAll('.ev-row')[1]!
    await row.find('.ev-full-btn').trigger('click')
    const pre = row.find('pre')
    expect(pre.text()).toContain(BIG_TAIL)
    expect(pre.text()).not.toContain('已截断')
    expect(row.find('.ev-full-btn').exists()).toBe(false)
    w.unmount()
  })

  it('刷新重取后新事件对象 → 截断态复位（WeakSet 按 data 身份自然失效）', async () => {
    const w = mountView()
    await flushPromises()
    await w.findAll('.ev-toggle')[1]!.trigger('click')
    await w.findAll('.ev-row')[1]!.find('.ev-full-btn').trigger('click')
    expect(w.findAll('.ev-row')[1]!.find('pre').text()).toContain(BIG_TAIL)
    // 刷新：getAudit 重新 resolve（新 data 对象）
    await w.findAll('button').find((b) => b.text().includes('刷新'))!.trigger('click')
    await flushPromises()
    await w.findAll('.ev-toggle')[1]!.trigger('click')
    const row = w.findAll('.ev-row')[1]!
    expect(row.find('pre').text()).toContain('已截断')
    expect(row.find('.ev-full-btn').exists()).toBe(true)
    w.unmount()
  })
})
