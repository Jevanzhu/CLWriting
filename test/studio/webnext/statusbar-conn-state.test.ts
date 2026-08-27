// @vitest-environment happy-dom
/**
 * R65-55（十三轮批 E-7）回归：StatusBar 连接三态（HTTP 心跳 × SSE 通道合成）。
 * 修复前只看 serverOnline——SSE 断连（fail-closed 退避/429）期间 AI 进度事件
 * 实际全丢，状态栏仍绿灯「就绪」误导作者。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

vi.mock('../../../src/studio/web-next/src/composables/useTheme', () => ({
  useTheme: () => ({ themeName: () => '跟随系统' }),
}))
vi.mock('lucide-vue-next', () => new Proxy({}, { get: () => ({ template: '<i/>' }) }))

import StatusBar from '../../../src/studio/web-next/src/components/shell/StatusBar.vue'
import { serverOnline } from '../../../src/studio/web-next/src/composables/useHeartbeat'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'

beforeEach(() => {
  setActivePinia(createPinia())
  serverOnline.value = true // 模块级响应式 ref（导入无副作用——轮询在 useHeartbeat() 里才起）
})

function connText(w: ReturnType<typeof mount>): string {
  return w.find('.status-left span:last-of-type').text()
}

describe('StatusBar: 连接三态（R65-55）', () => {
  it('心跳活 + SSE 通 → 绿灯「就绪」', async () => {
    const wb = useWorkbenchStore()
    wb.setConnected(true)
    const w = mount(StatusBar, { props: { bookName: '书A' } })
    expect(connText(w)).toBe('写作助手就绪')
    expect(w.find('.status-dot').classes()).not.toContain('degraded')
    w.unmount()
  })

  it('心跳活 + SSE 断 → 黄灯「实时通道中断」（修复前仍绿灯就绪）', async () => {
    const wb = useWorkbenchStore()
    wb.setConnected(false)
    const w = mount(StatusBar, { props: { bookName: '书A' } })
    expect(connText(w)).toBe('实时通道中断，重连中…')
    expect(w.find('.status-dot').classes()).toContain('degraded')
    // 恢复：SSE 重连成功 → 回绿（状态随 store 响应）
    wb.setConnected(true)
    await nextTick()
    expect(connText(w)).toBe('写作助手就绪')
    w.unmount()
  })

  it('心跳死 → 红灯「无法连接」（SSE 态不再掩盖服务不可达）', async () => {
    serverOnline.value = false
    const wb = useWorkbenchStore()
    wb.setConnected(true) // SSE 残留态 true 也不影响：心跳死优先
    const w = mount(StatusBar, { props: { bookName: '书A' } })
    expect(connText(w)).toBe('无法连接到写作助手')
    expect(w.find('.status-dot').classes()).toContain('off')
    w.unmount()
  })
})
