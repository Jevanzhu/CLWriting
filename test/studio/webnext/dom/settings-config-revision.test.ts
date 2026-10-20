/**
 * R34D-25（三十四轮）：SettingsModal saveConfig 乐观锁穿线回归。
 *
 * 锁定链路：saveConfig 队列内经 getConfigWithRevision 读 {config, revision}（内容
 * 指纹）→ mutate → putConfig(name, cfg, revision) 上送 expectedRevision；PUT 失配
 * 409 抛 ApiError 时 toast 服务端文案（friendlyError 透传中文消息）。服务端比对/409
 * 契约由 test/studio/api-integration.test.ts 锁定，本文件只锁前端穿线激活。
 *
 * 手法：stub 全部 tab 子组件（各自有专属测试文件），从组件内部 provides 取
 * SAVE_CONFIG_KEY 驱动（saveConfig 由 SettingsModal provide，无 prop 入口）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { BookConfig } from '../../../../src/studio/web-next/src/api/books'

const mocks = vi.hoisted(() => ({
  getConfigWithRevision: vi.fn(),
  putConfig: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('../../../../src/studio/web-next/src/api/books', () => ({
  getConfigWithRevision: mocks.getConfigWithRevision,
  putConfig: mocks.putConfig,
}))

vi.mock('../../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({
    toast: mocks.toast,
    settingsOpen: true,
    closeSettings: vi.fn(),
    confirmState: null,
    // R0916-7-P3-22：SettingsModal 遮罩走 ModalMask，挂载/卸载即登记
    setMaskOpen: vi.fn(),
  })),
  // ModalMask 渲染面从此表读浓度（模块级导出）——mock 面补齐最小形状
  MASK_ALPHA: {
    palette: 0.25,
    settings: 0.45,
    export: 0.35,
    shelf: 0.35,
    confirm: 0.35,
    chapterMeta: 0.35,
    splitChapter: 0.35,
  },
}))

vi.mock('../../../../src/studio/web-next/src/stores/workspace', () => ({
  // 桩面照 workspace store 对外形补齐（写入成功即失效本窗配置缓存 + 广播他窗）
  useWorkspaceStore: vi.fn(() => ({
    bookName: '书A',
    invalidateBookConfig: vi.fn(),
  })),
}))

vi.mock('lucide-vue-next', () => new Proxy({}, { get: () => ({ template: '<i/>' }) }))

import SettingsModal from '../../../../src/studio/web-next/src/components/ui/SettingsModal.vue'
import {
  SAVE_CONFIG_KEY,
  SAVE_FAILURES_KEY,
  type SaveConfig,
} from '../../../../src/studio/web-next/src/components/ui/settings-context'
import type { Ref } from 'vue'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/** 挂壳（tab 子组件全 stub——测试点在 provide 的 saveConfig，不在任何 tab 内容）。 */
function mountModal(): {
  save: SaveConfig
  unmount: () => void
  failures: Ref<Map<string, string>>
} {
  const w = mount(SettingsModal, {
    global: {
      stubs: {
        SettingsAppearance: true,
        SettingsEditor: true,
        SettingsWriting: true,
        SettingsAi: true,
        SettingsAnalysis: true,
        SettingsRetention: true,
        SettingsBook: true,
        AiServicePanel: true,
        BetaBadge: true,
      },
    },
  })
  const provides = (w.vm.$ as unknown as { provides: Record<symbol, unknown> }).provides
  const save = provides[SAVE_CONFIG_KEY as unknown as symbol] as SaveConfig
  const failures = provides[SAVE_FAILURES_KEY as unknown as symbol] as Ref<Map<string, string>>
  expect(typeof save).toBe('function')
  expect(failures).toBeDefined()
  return { save, unmount: () => w.unmount(), failures }
}

describe('R34D-25: SettingsModal saveConfig 乐观锁穿线', () => {
  it('saveConfig → getConfigWithRevision 读指纹，putConfig 携 revision 上送', async () => {
    // config revision 是 book.yaml 内容指纹（sha256 全 hex 字符串）
    const rev = 'c'.repeat(64)
    mocks.getConfigWithRevision.mockResolvedValue({
      config: { book: { title: '原标题' } } as BookConfig,
      revision: rev,
    })
    mocks.putConfig.mockResolvedValue(undefined)
    const { save, unmount } = mountModal()

    await save((cfg) => {
      cfg.book = { ...(cfg.book ?? {}), title: '新标题' }
    })
    await flushPromises()

    // 穿线点：读侧用 revision 信封视图，写侧把指纹作为 expectedRevision 第 3 参上送
    expect(mocks.getConfigWithRevision).toHaveBeenCalledWith('书A')
    expect(mocks.putConfig).toHaveBeenCalledWith(
      '书A',
      expect.objectContaining({ book: expect.objectContaining({ title: '新标题' }) }),
      rev,
    )
    expect(mocks.toast).toHaveBeenCalledWith('已保存', 'success')
    unmount()
  })

  it('PUT 409（他窗口先写）→ toast 服务端冲突文案，不再静默', async () => {
    mocks.getConfigWithRevision.mockResolvedValue({
      config: { book: { title: '原标题' } } as BookConfig,
      revision: 7,
    })
    // ApiError 形态（apiJson 对非 2xx 抛 Error 子类，message = 服务端 error 文案）
    mocks.putConfig.mockRejectedValue(Object.assign(new Error('书籍配置已在其他窗口被修改，请刷新'), { status: 409 }))
    const { save, unmount } = mountModal()

    await save((cfg) => {
      cfg.book = { ...(cfg.book ?? {}), title: '后写者' }
    })
    await flushPromises()

    expect(mocks.putConfig).toHaveBeenCalledWith('书A', expect.anything(), 7)
    expect(mocks.toast).toHaveBeenCalledWith('书籍配置已在其他窗口被修改，请刷新', 'error')
    unmount()
  })

  // 写失败后 UI 已置位而 book.yaml 未变——不标记的话作者眼里「已生效」与「没存上」
  // 长得一模一样。不做自动回滚（多窗口下回滚会覆盖他窗刚写的值），只如实登记。
  it('写失败 → 该设置项进未保存清单并带项名；同一项重存成功即销账', async () => {
    mocks.getConfigWithRevision.mockResolvedValue({
      config: { book: { title: '原标题' } } as BookConfig,
      revision: 7,
    })
    mocks.putConfig.mockRejectedValueOnce(Object.assign(new Error('磁盘只读'), { status: 500 }))
    const { save, unmount, failures } = mountModal()

    const ok = await save(
      (cfg) => {
        cfg.book = { ...(cfg.book ?? {}), genre: '玄幻' }
      },
      { label: '题材' },
    )
    expect(ok).toBe(false)
    expect(failures.value.get('题材')).toBe('磁盘只读')

    // 重做一次并成功 → 该项自动销账（不留「已修好但仍显示未保存」的假警告）
    mocks.putConfig.mockResolvedValue(undefined)
    const ok2 = await save(
      (cfg) => {
        cfg.book = { ...(cfg.book ?? {}), genre: '玄幻' }
      },
      { label: '题材' },
    )
    expect(ok2).toBe(true)
    expect(failures.value.has('题材')).toBe(false)
    unmount()
  })

  it('未给 label 的失败归入 book.yaml（不丢进无名桶）', async () => {
    mocks.getConfigWithRevision.mockResolvedValue({ config: {} as BookConfig, revision: 1 })
    mocks.putConfig.mockRejectedValue(new Error('写盘失败'))
    const { save, unmount, failures } = mountModal()

    await save(() => {})
    expect(failures.value.get('book.yaml')).toBe('写盘失败')
    unmount()
  })
})
