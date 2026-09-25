// @vitest-environment happy-dom
/**
 * R0916-7-P3-24 回归：工作台警告（max_tokens 截断等非致命提示）经外壳常驻消费面
 * 以 'warning' 类型 toast——修复前误用 'error' 呈现，作者把可继续的警告当致命失败。
 * （消费面随书常驻、读完置 null 防重复 toast 的通道语义由本组一并锚定。）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

import WorkspaceShell from '../../../src/studio/web-next/src/components/shell/WorkspaceShell.vue'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

/** 外壳子组件全部桩化（本文件只钉 warning 消费面的 toast 类型与一次性语义） */
const SHELL_CHILDREN = [
  'Ribbon', 'SidebarLeft', 'SidebarRight', 'TabBar', 'ViewHeader', 'StatusBar',
  'ChatDock', 'FocusFormatBar', 'FocusStatsBar', 'CommandPalette', 'TooltipHost',
]
function mountShell() {
  return mount(WorkspaceShell, {
    props: { bookName: 'test-book' },
    global: { stubs: Object.fromEntries(SHELL_CHILDREN.map((n) => [n, { template: '<div />' }])) },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('WorkspaceShell · wb.warning 消费（R0916-7-P3-24）', () => {
  it('警告 → 以 warning 类型 toast（非 error）', async () => {
    const w = mountShell()
    const ui = useUiStore()
    const toastSpy = vi.spyOn(ui, 'toast')
    useWorkbenchStore().warning = 'max_tokens 截断：输出未完'
    await nextTick()
    await flushPromises()
    expect(toastSpy).toHaveBeenCalledWith('max_tokens 截断：输出未完', 'warning')
    expect(toastSpy).not.toHaveBeenCalledWith('max_tokens 截断：输出未完', 'error')
    w.unmount()
  })

  it('读完置 null：同一警告不重复 toast（一次性消费通道语义维持）', async () => {
    const w = mountShell()
    const wb = useWorkbenchStore()
    const ui = useUiStore()
    const toastSpy = vi.spyOn(ui, 'toast')
    wb.warning = '上下文超限，已截断'
    await nextTick()
    await flushPromises()
    expect(wb.warning).toBeNull()
    await nextTick()
    await flushPromises()
    expect(toastSpy).toHaveBeenCalledTimes(1)
    w.unmount()
  })
})
