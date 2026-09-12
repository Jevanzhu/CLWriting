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
  // 重评-0912-2 P3：prop 名「标题」→ title（改前口径：props 传 `标题: '开篇'`）；
  // emit save 载荷仍用 fm 键「标题」（弹窗 emit 边界转换），下方断言不变。
  wrapper = mount(ChapterMetaDialog, {
    props: { modelValue: true, num: 3, title: '开篇' },
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

// 重评-0912-2 P3（2026-09-12 全量重评修复批）：模态可及性——全库 8 模态唯一漏的
// role="dialog"/aria-modal 补齐，aria-label 用现有标题态（isPiece 缺省 = 章节信息）。
// 改前口径：.meta-dialog 容器无任何 role/aria-* 属性。
describe('重评-0912-2 P3: 模态可及性（role/aria-modal/aria-label）', () => {
  it('弹窗容器带 role=dialog + aria-modal=true + aria-label（章节信息）', () => {
    const dlg = dialog()
    expect(dlg.attributes('role')).toBe('dialog')
    expect(dlg.attributes('aria-modal')).toBe('true')
    expect(dlg.attributes('aria-label')).toBe('章节信息')
  })

  it('短篇（isPiece）→ aria-label 随标题态为「篇章信息」', async () => {
    await wrapper!.setProps({ isPiece: true })
    expect(dialog().attributes('aria-label')).toBe('篇章信息')
  })
})
