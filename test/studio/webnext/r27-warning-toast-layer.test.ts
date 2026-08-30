// @vitest-environment happy-dom
/**
 * R27-77（二十七轮 D 域）回归：wb.warning 消费面提升到常驻层（WorkspaceShell）。
 *
 * 根因：唯一消费 watch 挂在 WorkbenchView——生成/写章进行中切到编辑器、总览等视图时
 * 视图未挂载，警告（max_tokens 截断 / 连接中断）静默滞留 store；watch 无 immediate，
 * 回工作台也不补 toast → 截断类提示失效。
 *
 * 语义：外壳随书常驻（Book.vue 全程挂载），warning 置位即 toast 并置空消费；
 * 本测试只挂外壳不挂工作台视图，正是修复前消费不到的形态。
 *
 * 测法：shallow 挂 WorkspaceShell（watch 在外壳自身 setup，子件 stub 不影响），
 * 直改 store warning 断言 ui.toasts。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import WorkspaceShell from '../../../src/studio/web-next/src/components/shell/WorkspaceShell.vue'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('R27-77: wb.warning 常驻层消费', () => {
  it('工作台视图未挂载（仅常驻外壳）期间 warning 置位 → error toast 且消费置空', async () => {
    const w = mount(WorkspaceShell, { props: { bookName: '书甲' }, shallow: true })
    const wb = useWorkbenchStore()
    const ui = useUiStore()
    expect(ui.toasts).toHaveLength(0)

    wb.warning = '生成被截断：max_tokens 到顶'
    await nextTick()
    const last = ui.toasts.at(-1)
    expect(last?.kind).toBe('error')
    expect(last?.msg).toContain('max_tokens')
    expect(wb.warning).toBeNull() // 消费即置空（原 B-3 契约不变）
    w.unmount()
  })

  it('消费后 watch 存活（再次置位仍提示）；置回 null 不 toast', async () => {
    const w = mount(WorkspaceShell, { props: { bookName: '书甲' }, shallow: true })
    const wb = useWorkbenchStore()
    const ui = useUiStore()

    wb.warning = '第一条警告'
    await nextTick()
    wb.warning = '第二条警告'
    await nextTick()
    expect(ui.toasts).toHaveLength(2)
    expect(ui.toasts.at(-1)?.msg).toBe('第二条警告')

    wb.warning = null // 切书 workbench.clear() 等路径——不产生 toast
    await nextTick()
    expect(ui.toasts).toHaveLength(2)
    w.unmount()
  })
})
