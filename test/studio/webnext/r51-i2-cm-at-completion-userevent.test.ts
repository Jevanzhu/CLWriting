// @vitest-environment happy-dom
/**
 * R51-I-2（五十一轮）回归：`@` 补全触发的 userEvent 判别（真实 CM6 行为级）。
 *
 * `@` 触发角色名补全的 updateListener 此前对所有 docChanged 事务生效——外部全量替换
 * （SSE sync / doc.refresh / 切文档，程序事务无 userEvent）把 '@' 送到光标位时，
 * 后台同步也会自动弹补全浮层（无输入意图的 UI 打扰）。修复后仅用户输入事务
 * （input.* 家族：键入/IME 组合/粘贴/拖放）触发。
 *
 * 断言锚 completionStatus（触发 = 激活态 pending/active）：happy-dom 无 CM6 tooltip
 * 渲染管线（ResizeObserver 等），DOM 浮层断言只用于负向（不弹 = 无激活 + 无节点）。
 * @codemirror/autocomplete 根目录解析不到（web-next 嵌套安装），按 cm-history-reset
 * 先例从嵌套路径取真实实例（与组件同模块，状态可互读）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { EditorView } from '@codemirror/view'
import { Transaction } from '@codemirror/state'
import { completionStatus } from '../../../src/studio/web-next/node_modules/@codemirror/autocomplete'

vi.mock('../../../src/studio/web-next/src/api/settings', () => ({
  getCompletionNames: vi.fn(async () => ({ characters: ['张三'], items: [] })),
}))

import CmHost from '../../../src/studio/web-next/src/editor/CmHost.vue'
import { getCompletionNames } from '../../../src/studio/web-next/src/api/settings'
import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'

beforeEach(() => {
  setActivePinia(createPinia())
  // 补全名称列表按 ws.bookName 加载（CmHost 内 watch immediate）——置非空才能有 entries
  useWorkspaceStore().bookName = '书A'
})

function mountHost(modelValue = '正文'): ReturnType<typeof mount> {
  return mount(
    CmHost,
    { props: { modelValue, mode: 'text', historyKey: 'd1' }, attachTo: document.body },
  )
}

function viewOf(w: ReturnType<typeof mount>): EditorView {
  const el = w.element.querySelector('.cm-content')
  expect(el).not.toBeNull()
  const view = EditorView.findFromDOM(el as HTMLElement)
  expect(view).not.toBeNull()
  return view!
}

/** 等补全名称列表加载 + 视图事务链冲排 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10))
}

describe('R51-I-2: @ 补全触发的 userEvent 判别', () => {
  it('外部全量替换把 @ 送到光标位 → 补全不激活（修复前：后台同步也自动弹浮层）', async () => {
    // 长文阅读至章末：外部同步后的正文以 @ 结尾且短于旧文——R62-18 光标归位把 head
    // clamp 到新文末，'@' 恰落 head 前一位（评审场景：后台同步自动弹补全浮层）
    const w = mountHost('正文很长很长')
    const view = viewOf(w)
    view.dispatch({ selection: { anchor: 6 } })
    await settle()
    await w.setProps({ modelValue: '正文@' }) // SSE sync / refresh 的外部全量替换
    expect(view.state.selection.main.head).toBe(3) // R62-18 clamp：head 落在 @ 后一位
    expect(completionStatus(view.state)).toBeNull() // 修复点：程序事务不触发
    await settle()
    expect(completionStatus(view.state)).toBeNull() // 持续不激活
    expect(w.element.querySelector('.cm-tooltip-autocomplete')).toBeNull()
    w.unmount()
  })

  it('切文档全量替换（含 @）→ 同样不激活', async () => {
    const w = mountHost()
    await settle()
    await w.setProps({ modelValue: '新章@', historyKey: 'd2' })
    expect(completionStatus(viewOf(w).state)).toBeNull()
    await settle()
    expect(completionStatus(viewOf(w).state)).toBeNull()
    expect(w.element.querySelector('.cm-tooltip-autocomplete')).toBeNull()
    w.unmount()
  })

  it('用户键入 @ → 照常触发补全（守卫不误伤输入路径）', async () => {
    const w = mountHost()
    await settle() // 等补全名称列表异步加载（watch bookName → getCompletionNames）
    const view = viewOf(w)
    // 模拟真实键入事务：CM6 给用户输入标注 userEvent 'input.type'；显式 selection 随
    // 插入前移（真实键入的光标落点），触发判据是 head 前一位为 '@'
    view.dispatch({
      changes: { from: 2, to: 2, insert: '@' },
      selection: { anchor: 3 },
      annotations: Transaction.userEvent.of('input.type'),
    })
    // 触发 = 补全激活（happy-dom 渲染不出浮层 DOM，激活态即触发语义锚点）
    expect(completionStatus(view.state)).not.toBeNull()
    await settle()
    expect(completionStatus(view.state)).not.toBeNull()
    w.unmount()
  })
})

// 重评-P3-14（2026-09-09 全量代码重评）：@ 补全的 CJK 区间从 BMP 硬编码 [一-鿿] 升
// \p{Script=Han}/u 全 Han 脚本——扩展平面字（Ext-B「𠀀」等）此前 matchBefore 不认、
// validFor 失配，@ 后续打扩展平面字补全浮层直接关闭。
describe('重评-P3-14: @ 补全 CJK 区间升全 Han 脚本（扩展平面可续配）', () => {
  it('键入 @ 后续打扩展平面字（𠀀）→ 补全保持激活不关闭', async () => {
    // 补全名称含扩展平面字的角色：续打后 query='𠀀' 仍能过滤出候选
    vi.mocked(getCompletionNames).mockResolvedValueOnce({ characters: ['𠀀测试角色'], items: [] })
    const w = mountHost()
    await settle() // 等补全名称列表异步加载（本例的 mockResolvedValueOnce 消费于挂载 watch）
    const view = viewOf(w)
    // 键入 '@'：matchBefore 识别 → 补全激活（前置确认既有触发路径）
    view.dispatch({
      changes: { from: 2, to: 2, insert: '@' },
      selection: { anchor: 3 },
      annotations: Transaction.userEvent.of('input.type'),
    })
    expect(completionStatus(view.state)).not.toBeNull()
    // 续打扩展平面字（U+20000，代理对占 2 个 UTF-16 码元）：validFor 须认全 Han 脚本，
    // 否则修复前 validFor 失配 → 重查源 → matchBefore 也不认 → 浮层关闭
    view.dispatch({
      changes: { from: 3, to: 3, insert: '𠀀' },
      selection: { anchor: 5 },
      annotations: Transaction.userEvent.of('input.type'),
    })
    expect(completionStatus(view.state)).not.toBeNull() // 修复点：不关闭
    await settle()
    expect(completionStatus(view.state)).not.toBeNull() // 持续激活
    w.unmount()
  })
})
