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
