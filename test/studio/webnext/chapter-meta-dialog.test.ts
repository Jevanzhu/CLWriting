// @vitest-environment happy-dom
/**
 * 低-3（第十轮）：ChapterMetaDialog 章号整数校验。
 *
 * 旧口径只查 Number.isFinite + n>=1，3.5 这类小数放行后文件名落成 03.5-…，
 * 从「章号 = 整数编号」特性中脱落（服务端 documents.ts 同点位 fail-closed 兜底）。
 * 弹窗体经 <teleport to="body"> 渲染，元素从 document.body 取（DOMWrapper 复用
 * VTU 的 setValue/trigger）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import ChapterMetaDialog from '../../../src/studio/web-next/src/components/panels/ChapterMetaDialog.vue'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  wrapper = mount(ChapterMetaDialog, {
    props: { modelValue: true, num: 3, 标题: '开篇' },
  })
})

afterEach(() => {
  wrapper?.unmount() // teleport 内容随组件卸载移除
  wrapper = null
})

/** 弹窗渲染在 body 下（teleport），用 DOMWrapper 包一层拿 VTU 的交互 API */
function dialog(): DOMWrapper<Element> {
  const el = document.body.querySelector('.meta-dialog')
  if (!el) throw new Error('弹窗未渲染（teleport 内容缺失）')
  return new DOMWrapper(el)
}

describe('低-3（第十轮）：章号必须为正整数', () => {
  it('小数 3.5 → 不 emit save、弹窗不关闭（文件名不得落成 03.5-…）', async () => {
    await dialog().find('input[type="number"]').setValue('3.5')
    await dialog().findAll('button').find((b) => b.text() === '保存')!.trigger('click')
    await flushPromises()

    expect(wrapper!.emitted('save')).toBeUndefined()
    expect(wrapper!.emitted('update:modelValue')).toBeUndefined()
  })

  it('0 / 负数同样拒收 → 不 emit save', async () => {
    const num = dialog().find('input[type="number"]')
    await num.setValue('0')
    await dialog().findAll('button').find((b) => b.text() === '保存')!.trigger('click')
    await num.setValue('-2')
    await dialog().findAll('button').find((b) => b.text() === '保存')!.trigger('click')
    await flushPromises()

    expect(wrapper!.emitted('save')).toBeUndefined()
  })

  it('整数 4 → 守卫不误伤：emit save {标题, num:4} 并关闭弹窗', async () => {
    await dialog().find('input[type="number"]').setValue('4')
    await dialog().findAll('button').find((b) => b.text() === '保存')!.trigger('click')
    await flushPromises()

    expect(wrapper!.emitted('save')).toEqual([[{ 标题: '开篇', num: 4 }]])
    expect(wrapper!.emitted('update:modelValue')).toEqual([[false]])
  })
})

// R49-29（四十九轮）：容器级 @keydown.enter 吞掉按钮上的 Enter——焦点在「取消」钮
// 上按 Enter 会先触发容器保存再触发按钮 click（先保存后取消）。修复：onKeySave 对
// target 命中 button 的让渡（按钮走原生 click 激活）。
describe('R49-29：Enter 落点在按钮上让渡，不在输入框上照常保存', () => {
  it('keydown 目标是「取消」按钮 → 不触发 save（按钮语义归原生 click）', async () => {
    const cancelBtn = dialog().findAll('button').find((b) => b.text() === '取消')!
    cancelBtn.element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await flushPromises()

    expect(wrapper!.emitted('save')).toBeUndefined()
    expect(wrapper!.emitted('update:modelValue')).toBeUndefined()
  })

  it('keydown 目标是「保存」按钮 → 同样不重复触发 save（原生 click 才是唯一入口）', async () => {
    await dialog().find('input[type="number"]').setValue('4')
    const saveBtn = dialog().findAll('button').find((b) => b.text() === '保存')!
    saveBtn.element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await flushPromises()

    // 容器守卫让渡后，此 keydown 本身不产生 save（无原生激活的测试环境下零 emit）
    expect(wrapper!.emitted('save')).toBeUndefined()
    // 对照：同一状态下按钮原生 click 仍正常保存（守卫不误伤按钮点击链）
    await saveBtn.trigger('click')
    await flushPromises()
    expect(wrapper!.emitted('save')).toEqual([[{ 标题: '开篇', num: 4 }]])
  })

  it('对照：Enter 在输入框上（target 非 button）→ 照常保存', async () => {
    const num = dialog().find('input[type="number"]')
    await num.setValue('4')
    num.element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await flushPromises()

    expect(wrapper!.emitted('save')).toEqual([[{ 标题: '开篇', num: 4 }]])
    expect(wrapper!.emitted('update:modelValue')).toEqual([[false]])
  })
})
