// @vitest-environment happy-dom
/**
 * R30-27（三十轮）回归——workbench 事件日志按已知 type 白名单过滤。
 *
 * 缺陷：SSE onmessage 只校验 type 是 string，空串/未知名事件照进 workbench.log，
 * 事件流（WbAdvanced）渲染为裸 type 噪声。修复：dispatch 日志落库前按白名单
 * （dispatch 状态分支 ∪ 事件流渲染分支的全集）过滤——只丢日志不改分发，
 * 未知/空 type 事件照常走各自处理逻辑（无命中分支自然 no-op），丢弃计数经
 * console.debug 留 debug 通道。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref, nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  getToken: vi.fn<() => string | null>(() => 'T0'),
  rebootstrap: vi.fn<() => Promise<void>>(async () => {}),
}))

vi.mock('../../../src/studio/web-next/src/api/client', () => ({
  getToken: mocks.getToken,
  rebootstrap: mocks.rebootstrap,
}))

import { useSse } from '../../../src/studio/web-next/src/composables/useSse'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'

class MockES {
  static instances: MockES[] = []
  static readonly CONNECTING = 0
  static readonly CLOSED = 2
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  url = ''
  readyState = 0
  constructor(url: string) {
    this.url = url
    MockES.instances.push(this)
  }
  close(): void {
    this.readyState = 2
  }
  /** 模拟服务端推一条 SSE 消息（onmessage 收 raw JSON 串） */
  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent)
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  MockES.instances = []
  vi.stubGlobal('EventSource', MockES)
  // ticket 端点 404 → 回退 ?token= 旧通道（本文件聚焦日志过滤，不关心 ticket 形态）
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** 泵微任务链：让 doConnect 的「换票 → new EventSource」链走到位 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await nextTick()
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** 建连并返回活跃连接 */
async function connect(): Promise<MockES> {
  useSse(ref('书A'))
  await settle()
  return MockES.instances[0]!
}

describe('R30-27: 未知/空 type 事件不进 workbench.log', () => {
  it('空 type 事件 → 不入日志；console.debug 留痕（丢弃计数口径）', async () => {
    const es = await connect()
    const wb = useWorkbenchStore()
    const dbg = vi.spyOn(console, 'debug').mockImplementation(() => {})
    es.emit({ type: '', foo: 1 })
    expect(wb.log).toHaveLength(0)
    expect(dbg).toHaveBeenCalledTimes(1)
    expect(dbg.mock.calls[0]![0]).toContain('type=""')
    dbg.mockRestore()
  })

  it('无 type 字段（t 归空串）→ 不入日志', async () => {
    const es = await connect()
    const wb = useWorkbenchStore()
    const dbg = vi.spyOn(console, 'debug').mockImplementation(() => {})
    es.emit({ payload: 'no type at all' })
    expect(wb.log).toHaveLength(0)
    dbg.mockRestore()
  })

  it('未知名事件 → 不入日志；连发多次计数累计', async () => {
    const es = await connect()
    const wb = useWorkbenchStore()
    const dbg = vi.spyOn(console, 'debug').mockImplementation(() => {})
    es.emit({ type: 'mystery_event', foo: 1 })
    es.emit({ type: 'another_unknown', bar: 2 })
    expect(wb.log).toHaveLength(0)
    expect(dbg).toHaveBeenCalledTimes(2)
    // 计数是模块级累计口径（跨 store 实例共享，含前序用例的丢弃）——断言相对递增
    const countOf = (i: number) =>
      Number(String(dbg.mock.calls[i]![0]).match(/累计丢弃 (\d+) 条/)?.[1])
    expect(countOf(1)).toBe(countOf(0) + 1)
    dbg.mockRestore()
  })

  it('白名单外的 tool_use / usage / review-progress 照常入日志（事件流渲染分支依赖）', async () => {
    const es = await connect()
    const wb = useWorkbenchStore()
    es.emit({ type: 'tool_use', tool: 'read_file' })
    es.emit({ type: 'usage', tokens: 120 })
    es.emit({ type: 'review-progress', label: '初稿审读' })
    expect(wb.log.map((e) => e.type)).toEqual(['tool_use', 'usage', 'review-progress'])
  })
})

describe('R30-27: 已知 type 事件日志与分发行为不回归', () => {
  it('role_spawn/text/done：照常入日志 + running/textOut 状态机照常推进', async () => {
    const es = await connect()
    const wb = useWorkbenchStore()
    es.emit({ type: 'role_spawn', role: 'drafter' })
    expect(wb.running).toBe(true)
    es.emit({ type: 'text', text: '第一章' })
    es.emit({ type: 'text', text: '正文' })
    expect(wb.textOut).toBe('第一章正文')
    es.emit({ type: 'done' })
    expect(wb.running).toBe(false)
    expect(wb.log.map((e) => e.type)).toEqual(['role_spawn', 'text', 'text', 'done'])
  })

  it('sync 照常不入日志但校正 running（分发行为零改动）', async () => {
    const es = await connect()
    const wb = useWorkbenchStore()
    es.emit({ type: 'role_spawn' })
    expect(wb.running).toBe(true)
    es.emit({ type: 'sync', running: false })
    expect(wb.running).toBe(false)
    expect(wb.log.map((e) => e.type)).toEqual(['role_spawn']) // sync 不入日志（既有口径）
  })

  it('warning 照常入日志并置 warning 态（UI toast 依赖）', async () => {
    const es = await connect()
    const wb = useWorkbenchStore()
    es.emit({ type: 'warning', message: 'max_tokens 截断' })
    expect(wb.log).toHaveLength(1)
    expect(wb.warning).toBe('max_tokens 截断')
  })

  it('未知事件不扰动状态机：role_spawn 后混入未知事件，running 仍 true（只丢日志不丢事件）', async () => {
    const es = await connect()
    const wb = useWorkbenchStore()
    const dbg = vi.spyOn(console, 'debug').mockImplementation(() => {})
    es.emit({ type: 'role_spawn' })
    es.emit({ type: 'future_event_x' })
    expect(wb.running).toBe(true)
    expect(wb.log).toHaveLength(1)
    dbg.mockRestore()
  })
})
