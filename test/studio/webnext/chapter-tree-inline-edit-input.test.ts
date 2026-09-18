// @vitest-environment happy-dom
/**
 * 0918二轮修复批（F103）：章节树内联编辑态只触目标项回归。
 *
 * 修复前 ChapterTreeItem 的编辑态 watch 源是 [creatingDirPath, renamePath]（全树
 * 共享 props）——一次进入重命名在每个已渲染实例扇出回调（非目标项空跑判据比较，
 * O(已渲染节点)）；修复后 watch 源改为本实例「命中态」布尔（isCreatingHere/
 * isRenaming），回调只在编辑态进出本项时触发。本文件锚行为面：进入重命名/新建
 * 只在目标位置挂一个输入框（种子初始化 + 聚焦），目标迁移时旧行还原、新行接管，
 * 退出编辑态零输入框——DOM 结构与交互行为与修复前逐位一致。
 */
import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import ChapterTreeItem from '../../../src/studio/web-next/src/components/panels/ChapterTreeItem.vue'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: () => ({ issuePaths: new Set<string>() }),
}))

function chapterNode(n: number): TreeNode {
  const padded = String(n).padStart(4, '0')
  return {
    path: `写作/正文/${padded}-第${n}章.md`,
    name: `${padded}-第${n}章.md`,
    isDirectory: false,
    role: 'chapter',
    children: [],
    status: 'draft',
  }
}

function mountTree(children: TreeNode[]) {
  const root: TreeNode = {
    path: '写作/正文',
    name: '正文',
    isDirectory: true,
    role: 'group',
    children,
  }
  return mount(ChapterTreeItem, {
    // attachTo：happy-dom 对游离元素 focus() 不落 document.activeElement，聚焦断言需真挂载
    attachTo: document.body,
    props: {
      node: root,
      depth: 0,
      expanded: new Set(['写作/正文']),
      activePath: null,
      tabstopPath: null,
      creatingDirPath: null,
      creatingKind: null,
      creatingSeed: '',
      renamePath: null,
      draggedPath: null,
    },
  })
}

const P1 = '写作/正文/0001-第1章.md'
const P2 = '写作/正文/0002-第2章.md'

/** 全树恰一个内联输入框（断言并入），返回它——noUncheckedIndexedAccess 下集中收窄 */
function soleInput(wrapper: ReturnType<typeof mountTree>) {
  const inputs = wrapper.findAll('.inline-input')
  expect(inputs).toHaveLength(1)
  return inputs[0]!
}

describe('F103：内联重命名只触目标项', () => {
  it('进入重命名态 → 全树恰一个输入框，种子 = 目标节点名，且聚焦在它', async () => {
    const wrapper = mountTree([chapterNode(1), chapterNode(2)])
    await wrapper.setProps({ renamePath: P1 })
    await flushPromises()

    const input = soleInput(wrapper)
    expect((input.element as HTMLInputElement).value).toBe('0001-第1章.md')
    expect(document.activeElement).toBe(input.element)
    // 目标行被输入框替代（不再渲染常规 treeitem），他行不受影响
    expect(wrapper.find('[data-path="0001-第1章.md"]').exists()).toBe(false)
    expect(wrapper.find(`[data-path="${P2}"]`).exists()).toBe(true)
    wrapper.unmount()
  })

  it('重命名目标迁移 → 旧行还原、新行接管（仍恰一个输入框 + 新种子）', async () => {
    const wrapper = mountTree([chapterNode(1), chapterNode(2)])
    await wrapper.setProps({ renamePath: P1 })
    await flushPromises()
    await wrapper.setProps({ renamePath: P2 })
    await flushPromises()

    const input = soleInput(wrapper)
    expect((input.element as HTMLInputElement).value).toBe('0002-第2章.md')
    // 旧目标回到常规行形态
    expect(wrapper.find(`[data-path="${P1}"]`).exists()).toBe(true)
    expect(wrapper.find(`[data-path="${P2}"]`).exists()).toBe(false)
    wrapper.unmount()
  })

  it('退出重命名（renamePath 置空）→ 零输入框，行还原', async () => {
    const wrapper = mountTree([chapterNode(1), chapterNode(2)])
    await wrapper.setProps({ renamePath: P2 })
    await flushPromises()
    await wrapper.setProps({ renamePath: null })
    await nextTick()

    expect(wrapper.findAll('.inline-input')).toHaveLength(0)
    expect(wrapper.find(`[data-path="${P2}"]`).exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('F103：内联新建只触目标目录', () => {
  it('进入新建态 → 目录子列表顶部恰一个输入框，种子 = creatingSeed', async () => {
    const wrapper = mountTree([chapterNode(1), chapterNode(2)])
    await wrapper.setProps({ creatingDirPath: '写作/正文', creatingKind: 'chapter', creatingSeed: '0003-未命名' })
    await flushPromises()

    const input = soleInput(wrapper)
    expect((input.element as HTMLInputElement).value).toBe('0003-未命名')
    expect(document.activeElement).toBe(input.element)
    wrapper.unmount()
  })

  it('目录折叠时置新建态再展开 → 命中态翻转照样初始化（种子 + 聚焦不丢）', async () => {
    const wrapper = mountTree([chapterNode(1)])
    await wrapper.setProps({ expanded: new Set<string>() }) // 折叠
    await wrapper.setProps({ creatingDirPath: '写作/正文', creatingKind: 'doc', creatingSeed: '笔记' })
    expect(wrapper.findAll('.inline-input')).toHaveLength(0) // 折叠期不可见
    await wrapper.setProps({ expanded: new Set(['写作/正文']) }) // 展开
    await flushPromises()

    const input = soleInput(wrapper)
    expect((input.element as HTMLInputElement).value).toBe('笔记')
    expect(document.activeElement).toBe(input.element)
    wrapper.unmount()
  })
})
