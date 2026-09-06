// @vitest-environment happy-dom
/**
 * R54-G-1（五十四轮）回归：章节树渲染上限（RENDER_CAP）。
 *
 * 修复前：展开目录子项全量递归渲染——默认展开「写作/正文」下 2000 章口径书开书即
 * 渲染 2000 行组件实例（max-height 滚动只裁视觉不减节点）。修复后：对齐 CommandPalette
 * RENDER_CAP=100 先例（M-P3-13 内存核查口径）——只渲染前 100 行 + 尾部省略提示行，
 * 数据不动（children 全量在 store），只裁渲染面。
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
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
    props: {
      node: root,
      depth: 0,
      expanded: new Set(['写作/正文']),
      activePath: null,
      creatingDirPath: null,
      creatingKind: null,
      creatingSeed: '',
      renamePath: null,
      draggedPath: null,
    },
  })
}

describe('R54-G-1: 章节树渲染上限', () => {
  it('150 章目录展开 → 只渲染前 100 行 + 省略提示行点名 50', () => {
    const wrapper = mountTree(Array.from({ length: 150 }, (_, i) => chapterNode(i + 1)))
    // 子实例只渲染 RENDER_CAP=100 个（父自身不计入 findAllComponents 后代查询）
    const items = wrapper.findAllComponents(ChapterTreeItem)
    expect(items.length).toBe(100)
    // 省略提示行：点名未渲染数
    const hint = wrapper.find('.tree-cap-hint')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('其余 50 项未渲染')
  })

  it('恰 100 章不截断零提示；101 章截断点名 1', () => {
    const exact = mountTree(Array.from({ length: 100 }, (_, i) => chapterNode(i + 1)))
    expect(exact.findAllComponents(ChapterTreeItem).length).toBe(100)
    expect(exact.find('.tree-cap-hint').exists()).toBe(false)

    const over = mountTree(Array.from({ length: 101 }, (_, i) => chapterNode(i + 1)))
    expect(over.findAllComponents(ChapterTreeItem).length).toBe(100)
    expect(over.find('.tree-cap-hint').text()).toContain('其余 1 项未渲染')
  })
})
