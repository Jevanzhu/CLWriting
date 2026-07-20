// @vitest-environment happy-dom
/**
 * DiffView 组件测(横切 P1 前端组件测):验证 diff 渲染 + 接受/拒绝 emit。
 *
 * @vue/test-utils mount + happy-dom DOM 环境(per-file 注释,不破坏现有 node 环境测)。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import DiffView from '../../src/studio/web/src/components/DiffView.vue'

interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
}

describe('DiffView 组件', () => {
  it('渲染 same/add/del 三类行 + 正确 class', () => {
    const wrapper = mount(DiffView, {
      props: {
        diff: [
          { type: 'same', text: '旧句' },
          { type: 'add', text: '新句' },
          { type: 'del', text: '删句' },
        ] satisfies DiffLine[],
      },
    })
    expect(wrapper.findAll('.diff-line')).toHaveLength(3)
    expect(wrapper.findAll('.diff-line.same')).toHaveLength(1)
    expect(wrapper.findAll('.diff-line.add')).toHaveLength(1)
    expect(wrapper.findAll('.diff-line.del')).toHaveLength(1)
  })

  it('点击接受按钮 → emit accept', async () => {
    const wrapper = mount(DiffView, { props: { diff: [] } })
    await wrapper.find('.btn.primary').trigger('click')
    expect(wrapper.emitted('accept')).toHaveLength(1)
  })

  it('点击拒绝按钮 → emit reject', async () => {
    const wrapper = mount(DiffView, { props: { diff: [] } })
    await wrapper.find('.btn:not(.primary)').trigger('click')
    expect(wrapper.emitted('reject')).toHaveLength(1)
  })

  it('applying=true → 接受按钮禁用 + 文案变「应用中」', () => {
    const wrapper = mount(DiffView, { props: { diff: [], applying: true } })
    const btn = wrapper.find('.btn.primary')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.text()).toContain('应用中')
  })

  it('空 diff → 渲染空 body(无行)', () => {
    const wrapper = mount(DiffView, { props: { diff: [] } })
    expect(wrapper.findAll('.diff-line')).toHaveLength(0)
  })
})
