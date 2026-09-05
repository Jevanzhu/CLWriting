/**
 * R47-1/R47-3/R47-14（四十七轮）：useDebouncedSource 防抖派生源组合式回归。
 *
 * 语义锚：① 同 key 源变化 150ms 防抖（期间多次变化只取末值）；② key 变化（切文档）
 * 即刻取新值并取消在途定时器（沿 R43-17 口径）；③ 卸载清定时器（无孤儿回调）；
 * ④ 初值同步取（首屏/挂载即正确）。
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, h, render, nextTick } from 'vue'
import { useDebouncedSource } from '../../../src/studio/web-next/src/composables/useDebouncedSource'

/** 组件作用域挂载（composable 内 onUnmounted 需组件实例）；返回捕获的输出 ref 与卸载函数。 */
function mountWith(setup: () => void): () => void {
  const el = document.createElement('div')
  const Comp = { setup } as unknown as Parameters<typeof h>[0]
  render(h(Comp), el)
  return () => render(null, el)
}

describe('R47-1：useDebouncedSource 防抖派生源', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('初值同步取（挂载即正确，无防抖窗口）', () => {
    const src = ref('a')
    let out: unknown
    mountWith(() => {
      out = useDebouncedSource(() => src.value)
    })
    expect(out).toBeDefined()
    expect((out as { value: unknown }).value).toBe('a')
  })

  it('同 key 源变化 150ms 防抖——窗口内多次变化只取末值', async () => {
    const src = ref('a')
    let out: { value: string } | undefined
    mountWith(() => {
      out = useDebouncedSource(() => src.value) as unknown as { value: string }
    })
    src.value = 'b'
    await nextTick()
    expect(out!.value).toBe('a') // 防抖窗口内不更新
    src.value = 'c'
    await nextTick()
    vi.advanceTimersByTime(149)
    expect(out!.value).toBe('a')
    vi.advanceTimersByTime(1)
    expect(out!.value).toBe('c') // 只取末值
  })

  it('key 变化（切文档）即刻取新值——在途防抖定时器作废', async () => {
    const src = ref('内容A')
    const key = ref('doc-a')
    let out: { value: string } | undefined
    mountWith(() => {
      out = useDebouncedSource(() => src.value, { key: () => key.value }) as unknown as { value: string }
    })
    src.value = '内容A改'
    await nextTick()
    // 未到 150ms 即切文档：key 变化当拍取新文档内容，不残留旧文档的一拍
    key.value = 'doc-b'
    src.value = '内容B'
    await nextTick()
    expect(out!.value).toBe('内容B')
    vi.advanceTimersByTime(300) // 旧定时器（携带 内容A改）已被取消
    expect(out!.value).toBe('内容B')
  })

  it('卸载清定时器——防抖回调不再触发（watcher 求值计入而定时器回调不再执行）', async () => {
    const src = ref('a')
    const spy = vi.fn()
    let out: { value: string } | undefined
    const unmount = mountWith(() => {
      out = useDebouncedSource(() => {
        spy()
        return src.value
      }) as unknown as { value: string }
    })
    spy.mockClear()
    src.value = 'b'
    await nextTick()
    // watch 触发会对源 getter 求值一次（Vue watcher 语义，非定时器回调）
    const afterTrigger = spy.mock.calls.length
    expect(afterTrigger).toBe(1)
    unmount()
    vi.advanceTimersByTime(500)
    // 卸载后：watcher 已停 + 在途定时器已清——spy 不再有新调用，输出不更新
    expect(spy.mock.calls.length).toBe(afterTrigger)
    expect(out!.value).toBe('a')
  })

  it('delayMs 0 → 同步直通（无防抖窗口）', async () => {
    const src = ref('a')
    let out: { value: string } | undefined
    mountWith(() => {
      out = useDebouncedSource(() => src.value, { delayMs: 0 }) as unknown as { value: string }
    })
    src.value = 'b'
    await nextTick()
    expect(out!.value).toBe('b')
  })
})
