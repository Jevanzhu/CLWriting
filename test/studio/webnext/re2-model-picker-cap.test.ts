// @vitest-environment happy-dom
/**
 * 重评2-P3-3（2026-09-09 全量重评 GLM-5.3）回归：ModelPicker 候选清单渲染上限。
 *
 * 探测返回的模型清单无条数约束，原全量 v-for 挂 DOM 随清单线性膨胀（域内已有 FontPicker
 * content-visibility / CommandPalette RENDER_CAP=100 先例，本组件缺失同款）。修复：渲染截断
 * RENDER_CAP=100 + 尾部省略计数提示行；数据面不动（candidates 原样、picked 集与
 * 「添加 N 个」计数仍按全量）。
 *
 * 挂法仿 r37-e-components.test.ts 的 ModelPicker 段（mount + attachTo + Teleport 到
 * body 的选择器断言）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import ModelPicker from '../../../src/studio/web-next/src/components/ui/ModelPicker.vue'

let wrapper: ReturnType<typeof mount> | null = null

function items(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll('.picker-item')) as HTMLElement[]
}

function capHint(): HTMLElement | null {
  return document.body.querySelector('.cap-hint')
}

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('重评2-P3-3: ModelPicker 候选清单渲染上限（RENDER_CAP=100）', () => {
  it('150 候选 → 仅渲染前 100 项 + 尾部省略计数提示行', () => {
    wrapper = mount(ModelPicker, {
      props: {
        show: true,
        candidates: Array.from({ length: 150 }, (_, i) => `model-${i}`),
        picked: new Set<string>(),
      },
      attachTo: document.body,
    })
    expect(items()).toHaveLength(100)
    expect(items()[0]!.textContent).toContain('model-0')
    expect(items()[99]!.textContent).toContain('model-99')
    expect(items().some((el) => el.textContent?.includes('model-100'))).toBe(false)
    // 修复点：截断有提示——尾部省略计数行（ChapterTreeItem/CommandPalette 同口径文案）
    expect(capHint()).not.toBeNull()
    expect(capHint()!.textContent).toContain('其余 50 项未渲染')
  })

  it('恰 100 候选 → 不截断、无提示行（上限边界不误报）', () => {
    wrapper = mount(ModelPicker, {
      props: {
        show: true,
        candidates: Array.from({ length: 100 }, (_, i) => `model-${i}`),
        picked: new Set<string>(),
      },
      attachTo: document.body,
    })
    expect(items()).toHaveLength(100)
    expect(capHint()).toBeNull()
  })

  it('99 候选 → 全量渲染、无提示行', () => {
    wrapper = mount(ModelPicker, {
      props: {
        show: true,
        candidates: Array.from({ length: 99 }, (_, i) => `model-${i}`),
        picked: new Set<string>(),
      },
      attachTo: document.body,
    })
    expect(items()).toHaveLength(99)
    expect(capHint()).toBeNull()
  })

  it('截断面交互语义不变：已渲染项 toggle 照常上抛；「添加 N 个」计数按全量 picked（含未渲染项）', async () => {
    wrapper = mount(ModelPicker, {
      props: {
        show: true,
        candidates: Array.from({ length: 150 }, (_, i) => `model-${i}`),
        // picked 含截断窗外的一项（model-149 未渲染）——数据面不动的契约
        picked: new Set(['model-149']),
      },
      attachTo: document.body,
    })
    // 已渲染的第 100 项（model-99）勾选交互不受截断影响
    const cb = items()[99]!.querySelector('input[type="checkbox"]') as HTMLInputElement
    await cb.dispatchEvent(new Event('change'))
    expect(wrapper.emitted('toggle')).toEqual([['model-99']])
    // 未渲染项不出现在 DOM（无 toggle 入口），但全量计数按钮按 picked.size 计
    expect(document.body.querySelector('.save-btn')!.textContent).toContain('添加 1 个')
  })
})
