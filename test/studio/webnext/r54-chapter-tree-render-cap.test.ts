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

function mountTree(children: TreeNode[], activePath: string | null = null) {
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
      activePath,
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

// R55-G-2（五十五轮）：cap 窗口改为含 active 项的滑窗——R54-G-1 固定取前 100，
// >100 章平铺目录经命令面板/搜索打开第 150 章时选中行在树上不可见。口径：无 active
// 或 active 在前 RENDER_CAP 内保持现状（前 100）；active 超出时窗口取 active 贴尾段
//（start = activeIdx - CAP + 1），实现最简且测试可钉。
describe('R55-G-2: cap 窗口含 active 项的滑窗', () => {
  it('150 章 + active=第 150 章 → 窗口跟随 active（含第 150 章，窗口仍 100 行）', () => {
    const children = Array.from({ length: 150 }, (_, i) => chapterNode(i + 1))
    const wrapper = mountTree(children, '写作/正文/0150-第150章.md')
    const items = wrapper.findAllComponents(ChapterTreeItem)
    expect(items.length).toBe(100) // 窗口大小不变
    const paths = items.map((w) => w.props('node').path as string)
    expect(paths).toContain('写作/正文/0150-第150章.md') // 修复前窗口 [1..100] 不含
    expect(paths).not.toContain('写作/正文/0001-第1章.md') // 滑出窗口首项
    // 尾部省略提示行语义保持（窗口外总数 = 150 - 100 = 50）
    expect(wrapper.find('.tree-cap-hint').text()).toContain('其余 50 项未渲染')
  })

  it('150 章 + active=第 3 章 → 保持现状前 100（第 150 章不在窗口）', () => {
    const children = Array.from({ length: 150 }, (_, i) => chapterNode(i + 1))
    const wrapper = mountTree(children, '写作/正文/0003-第3章.md')
    const paths = wrapper
      .findAllComponents(ChapterTreeItem)
      .map((w) => w.props('node').path as string)
    expect(paths).toContain('写作/正文/0003-第3章.md')
    expect(paths).toContain('写作/正文/0001-第1章.md') // 前 100 不变
    expect(paths).not.toContain('写作/正文/0150-第150章.md')
  })
})
