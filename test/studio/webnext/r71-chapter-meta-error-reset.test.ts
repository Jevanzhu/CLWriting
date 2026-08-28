// @vitest-environment happy-dom
/**
 * R71-31（七十一轮）回归：ChapterMetaDialog 打开时只重置 titleInput/noInput 不重置
 * numError（R70-28 引入面）——置错后取消关闭再开，错误提示残留。
 *
 * 修复：watch 的 v === true 分支补 numError.value = ''。弹窗体经 teleport 渲染在
 * body 下，从 document.body 取（对齐既有 chapter-meta-dialog.test 惯例）。
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
  wrapper?.unmount()
  wrapper = null
})

/** 弹窗渲染在 body 下（teleport），用 DOMWrapper 包一层拿 VTU 的交互 API */
function dialog(): DOMWrapper<Element> {
  const el = document.body.querySelector('.meta-dialog')
  if (!el) throw new Error('弹窗未渲染（teleport 内容缺失）')
  return new DOMWrapper(el)
}

describe('R71-31: 重开弹窗 numError 复位', () => {
  it('打开→置错→取消关闭→再开 → 错误提示不残留', async () => {
    // 置错：小数章号触发 R70-28 字段级反馈
    await dialog().find('input[type="number"]').setValue('3.5')
    await dialog().findAll('button').find((b) => b.text() === '保存')!.trigger('click')
    await flushPromises()
    expect(document.body.querySelector('.num-error')).not.toBeNull() // 错误提示已展示

    // 取消关闭
    await wrapper!.setProps({ modelValue: false })
    expect(document.body.querySelector('.meta-dialog')).toBeNull() // 弹窗已卸载

    // 再开（同组件实例，watch 重开分支）
    await wrapper!.setProps({ modelValue: true })
    expect(document.body.querySelector('.meta-dialog')).not.toBeNull()
    // 修复点：错误提示随重开复位（修复前 .num-error 残留，且章号已回填合法值 3）
    expect(document.body.querySelector('.num-error')).toBeNull()

    // 直接保存合法：无残留错误阻挡（章号回填 3）
    await dialog().findAll('button').find((b) => b.text() === '保存')!.trigger('click')
    await flushPromises()
    expect(wrapper!.emitted('save')).toEqual([[{ 标题: '开篇', num: 3 }]])
  })

  it('打开→置错→esc 关闭→再开 → 同样复位（关闭路径无关）', async () => {
    // 注：值取 -2——v-model 对 type=number 自动转数字，0 会因 falsy 触发按钮 disabled
    await dialog().find('input[type="number"]').setValue('-2')
    await dialog().findAll('button').find((b) => b.text() === '保存')!.trigger('click')
    await flushPromises()
    expect(document.body.querySelector('.num-error')).not.toBeNull()

    await wrapper!.setProps({ modelValue: false })
    await wrapper!.setProps({ modelValue: true })
    expect(document.body.querySelector('.num-error')).toBeNull()
  })
})
