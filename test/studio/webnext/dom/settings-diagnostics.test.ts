/**
 * 设置 · 诊断页（SettingsDiagnostics.vue）DOM 行为：
 * 生成成功 → toast + 落点显示；生成失败 → 错误 toast（信封文案）且不留落点；
 * 「打开所在文件夹」仅在桌面通道存在时出现，点击转 IPC。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SettingsDiagnostics from '../../../../src/studio/web-next/src/components/ui/SettingsDiagnostics.vue'
import { useUiStore } from '../../../../src/studio/web-next/src/stores/ui'

const diagMocks = vi.hoisted(() => ({ buildDiagnostics: vi.fn() }))
vi.mock('../../../../src/studio/web-next/src/api/diagnostics', () => ({
  buildDiagnostics: diagMocks.buildDiagnostics,
}))

const OK = {
  ok: true as const,
  file: 'C:\\Users\\x\\AppData\\Roaming\\CLWriting\\诊断包\\诊断包-20261010-123040.zip',
  dir: 'C:\\Users\\x\\AppData\\Roaming\\CLWriting\\诊断包',
  entries: ['说明.txt', '环境.json', '配置.json', '日志/app-20261010.jsonl'],
  bytes: 2048,
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  delete (window as { clwritingDesktop?: unknown }).clwritingDesktop
})

describe('设置 · 诊断页', () => {
  it('生成成功 → 成功 toast + 落点与条目/体积显示', async () => {
    diagMocks.buildDiagnostics.mockResolvedValue(OK)
    const ui = useUiStore()
    const wrapper = mount(SettingsDiagnostics)
    await wrapper.find('[data-testid="diagnostics-build"]').trigger('click')
    await flushPromises()

    expect(diagMocks.buildDiagnostics).toHaveBeenCalledTimes(1)
    expect(ui.toasts.some((t) => t.msg.includes('诊断包已生成') && t.msg.includes('4 个条目'))).toBe(true)
    expect(wrapper.find('[data-testid="diagnostics-path"]').text()).toContain('诊断包-20261010-123040.zip')
    expect(wrapper.text()).toContain('4 个条目 · 2 KB')
  })

  it('收集告警 → 补 warning toast（包仍可用）', async () => {
    diagMocks.buildDiagnostics.mockResolvedValue({ ...OK, warnings: ['日志 app-20261009.jsonl 读取失败：EBUSY'] })
    const ui = useUiStore()
    const wrapper = mount(SettingsDiagnostics)
    await wrapper.find('[data-testid="diagnostics-build"]').trigger('click')
    await flushPromises()

    expect(ui.toasts.some((t) => t.kind === 'warning' && t.msg.includes('1 条收集告警'))).toBe(true)
    expect(wrapper.find('[data-testid="diagnostics-path"]').exists()).toBe(true) // 告警不掩成功结果
  })

  it('生成失败 → 错误 toast（信封文案）且不显示落点', async () => {
    diagMocks.buildDiagnostics.mockRejectedValue(new Error('未定位到应用数据目录，无法生成诊断包'))
    const ui = useUiStore()
    const wrapper = mount(SettingsDiagnostics)
    await wrapper.find('[data-testid="diagnostics-build"]').trigger('click')
    await flushPromises()

    expect(ui.toasts.some((t) => t.kind === 'error' && t.msg.includes('未定位到应用数据目录'))).toBe(true)
    expect(wrapper.find('[data-testid="diagnostics-path"]').exists()).toBe(false)
  })

  it('桌面通道缺失 → 不显示「打开所在文件夹」；通道在则点击转 IPC', async () => {
    diagMocks.buildDiagnostics.mockResolvedValue(OK)
    const browser = mount(SettingsDiagnostics)
    await browser.find('[data-testid="diagnostics-build"]').trigger('click')
    await flushPromises()
    expect(browser.find('[data-testid="diagnostics-reveal"]').exists()).toBe(false)

    const reveal = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    ;(window as { clwritingDesktop?: unknown }).clwritingDesktop = { revealDiagnostics: reveal }
    const desktop = mount(SettingsDiagnostics)
    await desktop.find('[data-testid="diagnostics-build"]').trigger('click')
    await flushPromises()
    await desktop.find('[data-testid="diagnostics-reveal"]').trigger('click')
    expect(reveal).toHaveBeenCalledTimes(1)
  })
})
