// @vitest-environment happy-dom
/**
 * R35-34（三十五轮批 E）回归：OnboardView gen/save 函数级在途锁。
 * OnboardStepPanel 的按钮 disabled 在子组件内（loading 相位按钮置换）——双击在下一拍
 * 渲染前仍可双触发：双生成双计费、双保存双写盘。修复后 gen/save 入口本地锁收口
 * （R69-29/R73-63 家族同款）。子面板 stub 后 $emit 直发，可精确打进渲染前窗口。
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
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { name: '书A' } }),
}))
vi.mock('../../../src/studio/web-next/src/api/onboard', () => ({
  onboardAi: mocks.onboardAi,
  onboardSave: mocks.onboardSave,
  STEP_LABEL: {
    synopsis: '总纲',
    characters: '人物名册',
    world: '世界观',
    realm: '境界体系',
    volume: '卷纲',
    'leads-seed': '线索种子',
    'style-sample': '样章库',
    'style-rules': '文风铁律',
    'style-quotes': '金句库',
    'first-outline': '首章细纲',
  },
  STEP_PATH: {
    synopsis: '大纲/总纲.md',
    characters: '设定/名册.md',
    world: '设定/世界观.md',
    realm: '设定/境界体系.md',
    volume: '大纲/卷纲/卷纲_第1卷.md',
    'leads-seed': '大纲/账本种子.md',
    'style-sample': '文风/样章库.md',
    'style-rules': '文风/文风铁律.md',
    'style-quotes': '文风/金句库.md',
    'first-outline': '写作/正文/0001-第一章.md',
  },
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
import OnboardStepRail from '../../../src/studio/web-next/src/components/onboard/OnboardStepRail.vue'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
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

describe('R35-34: OnboardView gen/save 在途锁', () => {
  it('gen 在途双触发 → onboardAi 只调一次；完成后 toast 成功', async () => {
    const w = mountView()
    await flushPromises() // onMounted：getConfig + tree.load → 首个未生成步（synopsis）选中
    let resolveAi!: (v: { content: string; words: number }) => void
    mocks.onboardAi.mockImplementationOnce(() => new Promise((r) => { resolveAi = r }))

    const panel = w.findComponent(OnboardStepPanel)
    panel.vm.$emit('gen')
    await nextTick()
    panel.vm.$emit('gen') // 在途窗口第二拍：函数锁拦截
    expect(mocks.onboardAi).toHaveBeenCalledTimes(1)
    expect(mocks.onboardAi).toHaveBeenCalledWith('书A', { step: 'synopsis', premise: '' })

    resolveAi({ content: '总纲内容', words: 4 })
    await flushPromises()
    const kinds = useUiStore().toasts.map((t) => t.kind)
    expect(kinds.filter((k) => k === 'success')).toHaveLength(1)
    w.unmount()
  })

  it('save 在途双触发 → onboardSave 只调一次；成功后 toast「已保存」', async () => {
    const w = mountView()
    await flushPromises()
    // 先走一次 gen（同步 resolve）置出 result 相位内容
    mocks.onboardAi.mockResolvedValueOnce({ content: '总纲内容', words: 4 })
    const panel = w.findComponent(OnboardStepPanel)
    panel.vm.$emit('gen')
    await flushPromises()

    let resolveSave!: () => void
    mocks.onboardSave.mockImplementationOnce(() => new Promise<void>((r) => { resolveSave = r }))
    panel.vm.$emit('save')
    await nextTick()
    panel.vm.$emit('save') // 在途窗口第二拍：函数锁拦截
    expect(mocks.onboardSave).toHaveBeenCalledTimes(1)
    expect(mocks.onboardSave).toHaveBeenCalledWith('书A', { step: 'synopsis', content: '总纲内容' })

    resolveSave()
    await flushPromises()
    expect(useUiStore().toasts.some((t) => t.msg === '已保存' && t.kind === 'success')).toBe(true)
    w.unmount()
  })
})

// R8a-P2-2（2026-09-09 修复批）：result 相位手改未保存 → 切步先确认（对齐 doGen 的
// R70-27 重新生成脏检查口径——regenerate 路径有确认、切步路径此前漏配，手改直接
// 被 applyStep 清空丢稿）。取消则停留原步骤零改动；内容与最近生成快照一致时
// 不弹确认直接切换（守卫不误伤常规路径）。复用本文件 mountView 夹具：
// stub 子面板上 $emit 直发（gen/update:modelValue/rail select），真实 pinia ui store
// 观察 confirmState 流转；切步结果经「切后点生成 → onboardAi 收到新步名」实读。 
describe('R8a-P2-2: OnboardView 切步脏守卫', () => {
  it('result 相位手改未保存 → 切步先确认；取消停留、确认后切换并清空内容', async () => {
    const w = mountView()
    await flushPromises() // onMounted：选中首个未生成步（synopsis）
    const panel = w.findComponent(OnboardStepPanel)
    const rail = w.findComponent(OnboardStepRail)
    mocks.onboardAi.mockResolvedValueOnce({ content: '总纲内容', words: 4 })
    panel.vm.$emit('gen')
    await flushPromises() // phase=result，lastGenerated='总纲内容'

    panel.vm.$emit('update:modelValue', '手改后内容') // 手改 ≠ 最近生成快照
    await nextTick()
    rail.vm.$emit('select', 'world')
    await nextTick()
    const ui = useUiStore()
    expect(ui.confirmState).not.toBeNull() // 脏守卫弹确认——修复前此处直接清空切换丢稿
    expect(ui.confirmState!.title).toContain('切换步骤')

    ui.resolveConfirm(false) // 取消：停留原步骤、内容保留
    await flushPromises()
    expect(ui.confirmState).toBeNull()

    rail.vm.$emit('select', 'world') // 再切 + 确认
    await nextTick()
    expect(ui.confirmState).not.toBeNull()
    ui.resolveConfirm(true)
    await flushPromises()
    expect(ui.confirmState).toBeNull()

    mocks.onboardAi.mockResolvedValueOnce({ content: '世界内容', words: 2 })
    panel.vm.$emit('gen') // 切步生效实读：gen 走到新步
    await flushPromises()
    expect(mocks.onboardAi).toHaveBeenCalledWith('书A', { step: 'world', premise: '' })
    w.unmount()
  })

  it('生成后未手改（内容 == 最近生成快照）→ 切步无确认直接切换', async () => {
    const w = mountView()
    await flushPromises()
    const panel = w.findComponent(OnboardStepPanel)
    const rail = w.findComponent(OnboardStepRail)
    mocks.onboardAi.mockResolvedValueOnce({ content: '总纲内容', words: 4 })
    panel.vm.$emit('gen')
    await flushPromises()

    rail.vm.$emit('select', 'world')
    await nextTick()
    expect(useUiStore().confirmState).toBeNull() // 不弹确认

    mocks.onboardAi.mockResolvedValueOnce({ content: '世界内容', words: 2 })
    panel.vm.$emit('gen')
    await flushPromises()
    expect(mocks.onboardAi).toHaveBeenCalledWith('书A', { step: 'world', premise: '' })
    w.unmount()
  })
})
