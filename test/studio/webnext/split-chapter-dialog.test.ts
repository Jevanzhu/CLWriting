// @vitest-environment happy-dom
/**
 * 阶段 24（S4）：拆分弹窗 SplitChapterDialog mount 回归。
 *
 * 干跑视图（SplitPlanView）渲染 + 新章标题必填守卫 + Esc/取消/Enter/IME 键盘动线。
 * 形态仿 ChapterMetaDialog：弹窗体经 <teleport to="body"> 渲染，元素从 document.body
 * 取（DOMWrapper 复用 VTU 的 setValue/trigger），手法照 chapter-meta-dialog.test.ts /
 * r35-chapter-meta-esc-ime.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SplitChapterDialog from '../../../src/studio/web-next/src/components/panels/SplitChapterDialog.vue'
import type { SplitPlanView } from '../../../src/studio/web-next/src/api/documents'

let wrapper: ReturnType<typeof mount> | null = null

const basePlan: SplitPlanView = {
  ok: true,
  op: 'split',
  path: '正文/第3章.md',
  docId: 'd1',
  chapterNo: 3,
  title: '第3章',
  newChapterNo: 9,
  order: 3.5,
  headWords: 100,
  tailWords: 200,
  tailPreview: '预览文…',
  publishedWarning: false,
  planHash: 'h',
}

beforeEach(() => {
  setActivePinia(createPinia()) // 遮罩走 ModalMask → ui store（挂载即登记），mount 需 pinia
  wrapper = mount(SplitChapterDialog, {
    props: { modelValue: true, plan: basePlan },
  })
})

afterEach(() => {
  wrapper?.unmount() // teleport 内容随组件卸载移除
  wrapper = null
})

/** 弹窗渲染在 body 下（teleport），用 DOMWrapper 包一层拿 VTU 的交互 API */
function dialog(): DOMWrapper<Element> {
  const el = document.body.querySelector('.split-dialog')
  if (!el) throw new Error('弹窗未渲染（teleport 内容缺失）')
  return new DOMWrapper(el)
}

/** 确认按钮（文案「拆分」——标题必填守卫的落点） */
function confirmBtn(): DOMWrapper<Element> {
  const b = dialog().findAll('button').find((x) => x.text() === '拆分')
  if (!b) throw new Error('确认按钮缺失')
  return b
}

describe('阶段 24（S4）：plan 干跑载荷渲染', () => {
  it('原章/新章章号、前后字数、迁出内容预览齐全；无已发布警示行', () => {
    const text = dialog().text()
    expect(text).toContain('第 3 章')
    expect(text).toContain('第3章') // 原章标题
    expect(text).toContain('第 9 章')
    expect(text).toContain('100')
    expect(text).toContain('200')
    expect(text).toContain('迁出内容预览')
    expect(text).toContain('预览文…')
    expect(dialog().find('.warn').exists()).toBe(false)
    expect(text).not.toContain('已发布')
  })

  it('publishedWarning: true → 「已发布」警示行出现（平台连载无插入机制）', async () => {
    await wrapper!.setProps({ plan: { ...basePlan, publishedWarning: true } })
    expect(dialog().find('.warn').exists()).toBe(true)
    expect(dialog().text()).toContain('已发布')
  })
})

describe('阶段 24（S4）：新章标题必填', () => {
  it('空标题 → 确认禁用；纯空格仍禁用；「 新章 」trim 后放行并 emit confirm', async () => {
    expect(confirmBtn().attributes('disabled')).toBeDefined()

    await dialog().find('input').setValue('   ')
    expect(confirmBtn().attributes('disabled')).toBeDefined()

    await dialog().find('input').setValue(' 新章 ')
    expect(confirmBtn().attributes('disabled')).toBeUndefined()
    await confirmBtn().trigger('click')
    await flushPromises()
    expect(wrapper!.emitted('confirm')).toEqual([['新章']])
  })
})

describe('阶段 24（S4）：关闭动线（Esc / 取消）', () => {
  it('Esc → emit update:modelValue false', async () => {
    await dialog().trigger('keydown', { key: 'Escape', isComposing: false })
    await flushPromises()
    expect(wrapper!.emitted('update:modelValue')).toEqual([[false]])
  })

  it('取消按钮 → 同样 emit update:modelValue false', async () => {
    const cancel = dialog().findAll('button').find((b) => b.text() === '取消')!
    await cancel.trigger('click')
    await flushPromises()
    expect(wrapper!.emitted('update:modelValue')).toEqual([[false]])
  })
})

describe('阶段 24（S4）：Enter 提交 / IME 让渡（R61-3 / R49-29 同款）', () => {
  it('Enter 落在输入框上（target 非 button）→ 提交，title trim 生效', async () => {
    const input = dialog().find('input')
    await input.setValue(' 新章 ')
    input.element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await flushPromises()
    expect(wrapper!.emitted('confirm')).toEqual([['新章']])
  })

  it('IME 组合期 Enter（isComposing / keyCode 229）→ 让渡不提交（组合期 v-model 是旧值）', async () => {
    const input = dialog().find('input')
    await input.setValue('新章')
    input.element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }),
    )
    input.element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }),
    )
    await flushPromises()
    expect(wrapper!.emitted('confirm')).toBeUndefined()
  })

  it('Enter 落在按钮上（target 命中 button）→ 让渡原生激活，不重复提交', async () => {
    await dialog().find('input').setValue(' 新章 ')
    const cancel = dialog().findAll('button').find((b) => b.text() === '取消')!
    cancel.element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await flushPromises()
    // 容器守卫让渡后，此 keydown 不产生 confirm / 关闭（原生 click 才是按钮唯一入口）
    expect(wrapper!.emitted('confirm')).toBeUndefined()
    expect(wrapper!.emitted('update:modelValue')).toBeUndefined()
  })
})
