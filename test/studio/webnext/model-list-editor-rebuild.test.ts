// @vitest-environment happy-dom
/**
 * ModelListEditor 外部变更同步行为族（happy-dom）。
 * （原 r37-e-components 的 R37-34 节，按行为单拆。）
 *
 * R37-34（三十七轮批 E）：ModelListEditor 外部 modelValue 变更重建行列表；自身 emit
 * 回流不重建（行实例保持，编辑态不被打断）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import ModelListEditor from '../../../src/studio/web-next/src/components/ui/ModelListEditor.vue'
import ModelRow from '../../../src/studio/web-next/src/components/ui/ModelRow.vue'
import type { ModelRowDraft } from '../../../src/studio/web-next/src/shared/provider-format'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('R37-34: ModelListEditor 外部 modelValue 变更重建行列表', () => {
  const baseProps = {
    probe: { protocol: 'openai' as const, baseUrl: '', apiKey: '' },
    disabled: false,
  }
  const rowA = { id: 'model-a', name: '', contextWindowText: '', maxTokensText: '' }

  it('挂载后改 props.modelValue（如恢复默认）→ 行列表跟随重建', async () => {
    const w = mount(ModelListEditor, { props: { modelValue: [rowA], ...baseProps } })
    expect(w.findAllComponents(ModelRow)).toHaveLength(1)

    const rowB = { id: 'model-b', name: '', contextWindowText: '', maxTokensText: '' }
    await w.setProps({ modelValue: [rowB], ...baseProps })
    // 修复点：外部变更重建（修复前行列表纹丝不动，一直显示旧值）
    const rows = w.findAllComponents(ModelRow)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.props('row').id).toBe('model-b')
  })

  it('组件内编辑 emit → 同值回流不重建（行实例保持，编辑态不被打断）', async () => {
    const w = mount(ModelListEditor, { props: { modelValue: [rowA], ...baseProps } })
    const before = w.findAllComponents(ModelRow)[0]!
    const beforeEl = before.element // DOM 节点身份（wrapper 每次查询新建，不可比）

    // 行内编辑：rowChanged → emit('update:modelValue', [...])；父层 v-model 把同值写回
    const edited = { id: 'model-a2', name: '', contextWindowText: '32K', maxTokensText: '' }
    before.vm.$emit('change', edited)
    const emittedValue = w.emitted('update:modelValue')!.at(-1)![0] as ModelRowDraft[]
    expect(emittedValue[0]!.id).toBe('model-a2') // emit 契约（对照组）

    await w.setProps({ modelValue: emittedValue, ...baseProps }) // v-model 回流同值
    await nextTick()
    // 修复点：自身 emit 的回流不触发重建（DOM 节点保持；重建会因 _key 全换而换节点）
    const after = w.findAllComponents(ModelRow)[0]!
    expect(after.element).toBe(beforeEl)
    expect(after.props('row').id).toBe('model-a2')
  })
})
