// @vitest-environment happy-dom
/**
 * R35-36（三十五轮批 E）回归：ChapterMetaDialog 两项可及性/IME 修复。
 * ① IME 组合期 Esc 让渡（B-9 同族）——组合中按 Esc 是收输入法候选框，修复前
 *    @keydown.esc 直连关闭，放行会误关弹窗丢半截输入；
 * ② 焦点圈（useFocusTrap）——打开时焦点入弹窗内首个控件（原依赖裸 autofocus，
 *    Tab 可逃出弹窗落到被遮罩的背景页）。
 * 弹窗体经 <teleport to="body"> 渲染，DOMWrapper 取法照 chapter-meta-dialog.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
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

function dialog(): DOMWrapper<Element> {
  const el = document.body.querySelector('.meta-dialog')
  if (!el) throw new Error('弹窗未渲染（teleport 内容缺失）')
  return new DOMWrapper(el)
}

describe('R35-36: IME 组合期 Esc 让渡', () => {
  it('isComposing=true 的 Esc → 不关闭弹窗（收输入法候选框）', async () => {
    await dialog().trigger('keydown', { key: 'Escape', isComposing: true })
    await flushPromises()
    expect(wrapper!.emitted('update:modelValue')).toBeUndefined()
  })

  it('keyCode=229（IME 合成回退信号）的 Esc → 同样让渡', async () => {
    await dialog().trigger('keydown', { key: 'Escape', keyCode: 229 })
    await flushPromises()
    expect(wrapper!.emitted('update:modelValue')).toBeUndefined()
  })

  it('非组合期 Esc → 正常 emit update:modelValue false', async () => {
    await dialog().trigger('keydown', { key: 'Escape', isComposing: false })
    await flushPromises()
    expect(wrapper!.emitted('update:modelValue')).toEqual([[false]])
  })
})

describe('R35-36: 焦点圈', () => {
  it('打开后焦点落在弹窗内（首个可交互控件）', async () => {
    await nextTick()
    const dlg = document.body.querySelector('.meta-dialog')
    expect(dlg).not.toBeNull()
    expect(dlg!.contains(document.activeElement)).toBe(true)
  })
})
