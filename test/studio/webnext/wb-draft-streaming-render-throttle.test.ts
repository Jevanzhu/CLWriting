// @vitest-environment happy-dom
/**
 * 四轮-E401 回归：流式正文 <pre> 渲染 150ms trailing 节流。
 *
 * 机理（全量源码独立重评四轮 E401）：workbench store 每 SSE text 事件整体拼接 textOut
 * （stores/workbench.ts），WbDraftCard 的 <pre> 此前全量插值直连 wb.textOut——每事件
 * 一次全文 DOM 排版，一章流式长到 N 字累计 O(N²/chunk)；R46-4 只给字数统计加了 150ms
 * 防抖（useDebouncedWordCount），渲染本体未做同款节流。修复：组件内 rendered ref 对
 * textOut 做 150ms trailing 节流（R46-4 同档位），<pre> 渲染 rendered；trailing 保证
 * 最终一致（最后一次追加必被渲染）。
 *
 * 挂载形态对齐 f4-textout-incomplete（WbDraftCard 零 API 依赖可独立挂载）；fake timers
 * 驱动真实 dispatch text 事件流。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import WbDraftCard from '../../../src/studio/web-next/src/components/workbench/WbDraftCard.vue'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'

function previewText(w: ReturnType<typeof mount>): string {
  return w.get('.draft-preview').text()
}

describe('四轮-E401: 流式正文 <pre> 150ms trailing 节流', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('textOut 静默未满 150ms → 不重渲染；满 150ms → 按批次上屏', async () => {
    const wb = useWorkbenchStore()
    const w = mount(WbDraftCard, { props: { draftSaved: null } })
    expect(previewText(w)).toBe('（无正文，点「生成」开始）')

    await wb.dispatch({ type: 'role_spawn', role: 'writer' })
    await vi.advanceTimersByTimeAsync(0)
    wb.dispatch({ type: 'text', text: '第一段' })
    await vi.advanceTimersByTimeAsync(100) // 距追加仅 100ms：< 150ms 档位
    expect(previewText(w)).toBe('（无正文，点「生成」开始）') // 修复点：事件当下不上屏

    wb.dispatch({ type: 'text', text: '第二段' }) // t=100 追加重置计时
    await vi.advanceTimersByTimeAsync(40) // t=140：距末次追加 40ms
    expect(previewText(w)).toBe('（无正文，点「生成」开始）')
    await vi.advanceTimersByTimeAsync(110) // t=250：末次追加（t=100）后满 150ms
    expect(previewText(w)).toBe('第一段第二段') // 150ms 批次一次性上屏
    w.unmount()
  })

  it('token 级高频追加（每 50ms 一段）→ 窗口内零重排，静默后一次到位', async () => {
    const wb = useWorkbenchStore()
    const w = mount(WbDraftCard, { props: { draftSaved: null } })
    wb.dispatch({ type: 'role_spawn', role: 'writer' })
    await vi.advanceTimersByTimeAsync(0)

    const chunks = ['甲', '乙', '丙', '丁', '戊']
    for (const c of chunks) {
      wb.dispatch({ type: 'text', text: c })
      await vi.advanceTimersByTimeAsync(50) // 每次都重置 150ms 窗：突发期不上屏
      expect(previewText(w)).toBe('（无正文，点「生成」开始）')
    }
    await vi.advanceTimersByTimeAsync(150) // 静默满档
    expect(previewText(w)).toBe('甲乙丙丁戊') // 单批次渲染，最终值与 store 一致
    expect(previewText(w)).toBe(wb.textOut)
    w.unmount()
  })

  it('trailing 保证最终一致：流收尾（done）前的最后一次追加必被渲染；卸载清定时器', async () => {
    const wb = useWorkbenchStore()
    const w = mount(WbDraftCard, { props: { draftSaved: null } })
    wb.dispatch({ type: 'role_spawn', role: 'writer' })
    await vi.advanceTimersByTimeAsync(0)
    wb.dispatch({ type: 'text', text: '开篇' })
    await vi.advanceTimersByTimeAsync(150)
    expect(previewText(w)).toBe('开篇')

    wb.dispatch({ type: 'text', text: '收尾' })
    wb.dispatch({ type: 'done' }) // 流收尾不再追加；最后一拍 trailing 仍须上屏
    await vi.advanceTimersByTimeAsync(150)
    expect(previewText(w)).toBe('开篇收尾')
    expect(previewText(w)).toBe(wb.textOut) // 最终一致

    w.unmount() // 卸载清定时器：不再有挂起回调（渲染面随组件销毁，无泄漏面）
    await vi.advanceTimersByTimeAsync(300)
    expect(previewText(w)).toBe('开篇收尾') // unmount 后快照不再变化（无挂起定时器触发的更新）
  })

  it('挂载初值取当拍 textOut：重挂即见既有草稿，不等防抖窗', () => {
    const wb = useWorkbenchStore()
    wb.textOut = '上次生成的草稿'
    const w = mount(WbDraftCard, { props: { draftSaved: null } })
    expect(previewText(w)).toBe('上次生成的草稿')
    w.unmount()
  })
})
