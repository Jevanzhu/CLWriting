// @vitest-environment happy-dom
/**
 * 低-5（第十轮）：TierSection 超时分钟输入的校验时机。
 *
 * 旧实现绑 @input 逐键校验：输入小数值的中间态（"0." / "0"）当场被判非法清空，
 * 小数分钟几乎无法直接输入。修法：改 @change（失焦/回车才校验提交），中间态
 * 不触发校验。档位草稿对象与父层共享引用，直接断言 slot.timeoutMs 的变化。
 *
 * 注：VTU setValue 会连发 input+change（v-model.lazy 兼容），模拟「只敲未失焦」
 * 须手工派发 input 事件（不发 change）。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import TierSection from '../../../src/studio/web-next/src/components/ui/TierSection.vue'
import type { TierSlot } from '../../../src/studio/web-next/src/api/providers'

/** 创作档超时输入（三张档位卡第一张） */
function creativeInput(wrapper: ReturnType<typeof mount>) {
  return wrapper.find('.tier-card.primary .tier-timeout-input')
}

/** 模拟逐键输入（只发 input，不发 change = 未失焦） */
async function typeValue(el: HTMLInputElement, v: string): Promise<void> {
  el.value = v
  el.dispatchEvent(new Event('input'))
  await nextTick()
}

function mountWith(creative: TierSlot) {
  const tierForm = { creative, assistant: null, chat: null }
  const wrapper = mount(TierSection, {
    props: {
      tierForm,
      assistantEnabled: false,
      chatTierEnabled: false,
      currentModels: [],
      tierSaving: false,
    },
  })
  return { wrapper, tierForm }
}

describe('低-5（第十轮）：超时分钟输入 @change 失焦校验', () => {
  it('输入中间态（0. / 0.5）不触发校验：timeoutMs 不被当场清空/改写', async () => {
    const { wrapper, tierForm } = mountWith({ model: 'm', effort: 'high', timeoutMs: 60000 })
    const input = creativeInput(wrapper)
    const el = input.element as HTMLInputElement
    expect(el.value).toBe('1') // 60000ms → 显示 1 分

    // 敲小数的中间态：'0.'（Number('0.')=0 非法）、'0.5'——旧 @input 实现当场清空/改写
    await typeValue(el, '0.')
    expect(tierForm.creative.timeoutMs).toBe(60000) // 未被清空
    expect(el.value).toBe('0.') // 输入框不被程序回擦
    await typeValue(el, '0.5')
    expect(tierForm.creative.timeoutMs).toBe(60000) // 合法中间值也等失焦才提交
  })

  it('失焦（change）才校验提交：0.5 分 → 30000ms；非法终值 → 清空回落默认', async () => {
    const { wrapper, tierForm } = mountWith({ model: 'm', effort: 'high', timeoutMs: 60000 })
    const input = creativeInput(wrapper)
    const el = input.element as HTMLInputElement

    await typeValue(el, '0.5')
    expect(tierForm.creative.timeoutMs).toBe(60000) // 未失焦：仍等提交
    await input.trigger('change')
    expect(tierForm.creative.timeoutMs).toBe(30000) // 失焦提交：0.5 分 = 30000ms

    // 非法终值失焦 → 清空回落全局默认（删除该档超时 + 输入框回擦）
    await typeValue(el, 'abc')
    expect(tierForm.creative.timeoutMs).toBe(30000) // 失焦前不清
    await input.trigger('change')
    expect(tierForm.creative.timeoutMs).toBeUndefined()
    expect(el.value).toBe('')
  })

  it('清空失焦 → 删除该档超时（原语义不变）', async () => {
    const { wrapper, tierForm } = mountWith({ model: 'm', effort: 'high', timeoutMs: 60000 })
    const input = creativeInput(wrapper)
    const el = input.element as HTMLInputElement
    await typeValue(el, '')
    await input.trigger('change')
    expect(tierForm.creative.timeoutMs).toBeUndefined()
  })
})
