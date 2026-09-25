// @vitest-environment happy-dom
/**
 * ChapterTreeItem 拖拽行为族（happy-dom）。
 * （原 r37-e-components 的 R37-31 节，按行为单拆。）
 *
 * R37-31（三十七轮批 E）：树行原生拖拽补 dataTransfer.setData（Firefox 无 data 不启动
 * 拖拽），命中区从 caret/dot 扩到整行；重命名态（行内有 input）不受影响。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ChapterTreeItem from '../../../src/studio/web-next/src/components/panels/ChapterTreeItem.vue'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('R37-31: ChapterTreeItem 拖拽 dragstart 写 dataTransfer', () => {
  const fileNode: TreeNode = {
    path: '写作/正文/0001-北境.md',
    name: '0001-北境.md',
    isDirectory: false,
    role: 'chapter',
    docId: 'd1',
    children: [],
  } as TreeNode

  function mountItem(node: TreeNode = fileNode, renamePath: string | null = null) {
    return mount(ChapterTreeItem, {
      props: {
        node,
        depth: 1,
        expanded: new Set<string>(),
        activePath: null,
        tabstopPath: null, // R1010-P3 G6-③：roving 停靠行（本文件不测焦点，null 即可）
        creatingDirPath: null,
        creatingKind: null,
        creatingSeed: '',
        renamePath,
        draggedPath: null,
      },
    })
  }

  it('常规行整行 draggable，dragstart 同步 setData(text/plain, path) 并上抛 dragstart', async () => {
    const w = mountItem()
    const row = w.find('.tree-item')
    expect(row.attributes('draggable')).toBe('true') // 命中区扩到行级（原仅 8px dot）

    const setData = vi.fn()
    await row.trigger('dragstart', { dataTransfer: { setData } })
    // 修复点：无 data 的拖拽在 Firefox 等环境不启动
    expect(setData).toHaveBeenCalledWith('text/plain', '写作/正文/0001-北境.md')
    expect(w.emitted('dragstart')).toEqual([['写作/正文/0001-北境.md']])
  })

  it('目录行同样可拖（caret 扩到整行，emit 语义不变）', async () => {
    const dirNode: TreeNode = {
      path: '写作/正文',
      name: '正文',
      isDirectory: true,
      role: 'dir',
      children: [],
    } as TreeNode
    const w = mountItem(dirNode)
    const row = w.find('.tree-item')
    expect(row.attributes('draggable')).toBe('true')
    const setData = vi.fn()
    await row.trigger('dragstart', { dataTransfer: { setData } })
    expect(setData).toHaveBeenCalledWith('text/plain', '写作/正文')
    expect(w.emitted('dragstart')).toEqual([['写作/正文']])
  })

  it('重命名态（行内有 input）不进入拖拽——inline-input 不被 draggable 波及', () => {
    const w = mountItem(fileNode, fileNode.path)
    expect(w.find('input').exists()).toBe(true)
    expect(w.find('.tree-item').attributes('draggable')).toBeUndefined()
  })
})
