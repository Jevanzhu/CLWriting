// @vitest-environment happy-dom
/**
 * R51-I-5（五十一轮）回归：OnboardView 重新生成确认弹窗滞留切书后不再发计费请求。
 *
 * 「重新生成」脏检查确认弹窗（ui.ask）是全局 ui store 态：滞留期间切书（本实例已随
 * :key=bookName 重建而死亡）后点确认，死续体照旧走到 onboardAi 发出旧书的计费请求。
 * 修复后 ask 确认后复检 stillOn（M-4 既有口径：不以「已确认」豁免活体复检）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  onboardAi: vi.fn(),
  onboardSave: vi.fn(),
  getConfig: vi.fn(),
  getTree: vi.fn(),
  getTreeIssues: vi.fn(),
  routeMock: { params: { name: '书A' } } as { params: { name: string } },
}))

vi.mock('vue-router', () => ({
  useRoute: () => mocks.routeMock,
}))
vi.mock('../../../src/studio/web-next/src/api/onboard', () => ({
  onboardAi: mocks.onboardAi,
  onboardSave: mocks.onboardSave,
  STEP_LABEL: { synopsis: '总纲' },
  STEP_PATH: { synopsis: '大纲/总纲.md' },
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
  getTree: mocks.getTree,
}))
vi.mock('../../../src/studio/web-next/src/api/tree-issues', () => ({
  getTreeIssues: mocks.getTreeIssues,
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getContent: vi.fn(),
  saveContent: vi.fn(),
  finalizeDoc: vi.fn(),
  updateDocMeta: vi.fn(),
}))

import OnboardView from '../../../src/studio/web-next/src/views/OnboardView.vue'
import OnboardStepPanel from '../../../src/studio/web-next/src/components/onboard/OnboardStepPanel.vue'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.routeMock.params.name = '书A'
  mocks.getConfig.mockResolvedValue({ kind: 'long', leads: { enabled: ['成长线'] } })
  mocks.getTree.mockResolvedValue([])
  mocks.getTreeIssues.mockResolvedValue({ issues: [] })
})

function mountView(): ReturnType<typeof mount> {
  return mount(OnboardView, {
    props: { bookName: '书A' },
    global: {
      stubs: { OnboardStepPanel: true, OnboardStepRail: true, OnboardPremise: true, BetaBadge: true },
    },
  })
}

describe('R51-I-5: 重新生成确认弹窗滞留切书', () => {
  it('ask 滞留期间切书后点「确认」→ 不再向旧书发 onboardAi 计费请求（修复前照发）', async () => {
    const w = mountView()
    await flushPromises() // onMounted：getConfig + tree.load → 首个未生成步选中
    mocks.onboardAi.mockResolvedValueOnce({ content: '总纲初稿', words: 4 })
    const panel = w.findComponent(OnboardStepPanel)

    // 首次生成置出 result 相位内容（content === lastGenerated）
    panel.vm.$emit('gen')
    await flushPromises()

    // 手改内容（v-model 回写）→ 触发重新生成的脏检查确认
    panel.vm.$emit('update:modelValue', '总纲初稿（手改）')
    await nextTick()

    let resolveAsk!: (v: boolean) => void
    vi.spyOn(useUiStore(), 'ask').mockImplementationOnce(
      () => new Promise<boolean>((r) => { resolveAsk = r }),
    )
    panel.vm.$emit('gen') // 走 doGen → 脏检查 → ui.ask 挂起
    await flushPromises()
    expect(useUiStore().ask).toHaveBeenCalledTimes(1)
    expect(mocks.onboardAi).toHaveBeenCalledTimes(1) // 仍只有首生成那一笔

    // 弹窗滞留期间切书（路由活书名变化；实例虽随 :key 重建，死续体仍挂在 ask 上）
    mocks.routeMock.params.name = '书B'
    resolveAsk(true) // 作者点「重新生成」确认
    await flushPromises()
    expect(mocks.onboardAi).toHaveBeenCalledTimes(1) // 修复点：死续体不发旧书计费请求
    w.unmount()
  })

  it('ask 确认且未切书 → 照常重新生成（守卫不误伤正常确认路径）', async () => {
    const w = mountView()
    await flushPromises()
    mocks.onboardAi.mockResolvedValueOnce({ content: '总纲初稿', words: 4 })
    const panel = w.findComponent(OnboardStepPanel)
    panel.vm.$emit('gen')
    await flushPromises()
    panel.vm.$emit('update:modelValue', '总纲初稿（手改）')
    await nextTick()

    vi.spyOn(useUiStore(), 'ask').mockResolvedValueOnce(true)
    mocks.onboardAi.mockResolvedValueOnce({ content: '重生成稿', words: 5 })
    panel.vm.$emit('gen')
    await flushPromises()
    expect(mocks.onboardAi).toHaveBeenCalledTimes(2)
    expect(mocks.onboardAi).toHaveBeenLastCalledWith('书A', { step: 'synopsis', premise: '' })
    w.unmount()
  })
})
