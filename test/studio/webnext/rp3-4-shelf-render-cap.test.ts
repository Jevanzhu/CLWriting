// @vitest-environment happy-dom
/**
 * R-P3-4（评审修复批）：书架浮层大书架渲染上限回归。
 *
 * ShelfModal 经 `:render-cap="SHELF_RENDER_CAP(=100)"` 让 ShelfGrid 逐组只渲染前
 * 100 张书卡 + 尾部「已省略 N 部，搜索书名可缩小范围」提示行（对齐 CommandPalette
 * RENDER_CAP 先例）。数据面不动：分组头「N 部」计数、批量全选、头部总数仍面向全量。
 *
 * 本文件锚定：ShelfGrid 裁剪 + 提示行如实计数 + 分组计数不虚减（grid/list 双视图、
 * 多组各自独立裁剪）；不传 renderCap 时全量渲染零提示（整页书架 Shelf.vue 行为不变）；
 * ShelfModal 接线用源码文本断言（j5-overlay-dim 先例，浮层挂载依赖重、文本锚定足够）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ShelfGrid from '../../../src/studio/web-next/src/components/ui/ShelfGrid.vue'
import type { BookEntry } from '../../../src/studio/web-next/src/api/shelf'

function book(name: string): BookEntry {
  return {
    name,
    title: name,
    kind: 'long',
    chapters: 1,
    words: 1000,
    lastEdited: '2026-09-01T00:00:00Z',
    latestChapter: '第1章',
  }
}

function mountGrid(groups: { title: string; books: BookEntry[] }[], renderCap?: number) {
  return mount(ShelfGrid, {
    props: { groups, viewMode: 'grid' as const, batchMode: false, selected: new Set<string>(), renderCap },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('R-P3-4：ShelfGrid 渲染上限（renderCap 裁剪 + 尾部提示行）', () => {
  it('grid 视图：超上限只渲染前 N 张，提示行如实计数，分组头仍显全量「N 部」', () => {
    const wrapper = mountGrid([{ title: '长篇', books: Array.from({ length: 5 }, (_, i) => book(`书${i}`)) }], 3)
    expect(wrapper.findAll('.book-card')).toHaveLength(3)
    const hint = wrapper.find('.cap-hint')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('已省略 2 部')
    expect(hint.text()).toContain('搜索书名可缩小范围')
    expect(wrapper.find('.section-count').text()).toContain('5 部') // 计数不虚减
    wrapper.unmount()
  })

  it('list 视图：同样裁剪 + 提示行', () => {
    const wrapper = mount(ShelfGrid, {
      props: {
        groups: [{ title: '长篇', books: Array.from({ length: 4 }, (_, i) => book(`书${i}`)) }],
        viewMode: 'list' as const,
        batchMode: false,
        selected: new Set<string>(),
        renderCap: 2,
      },
    })
    expect(wrapper.findAll('.list-row')).toHaveLength(2)
    expect(wrapper.find('.cap-hint').text()).toContain('已省略 2 部')
    wrapper.unmount()
  })

  it('不超上限 / 不传 renderCap：全量渲染零提示（整页书架 Shelf.vue 行为不变）', () => {
    const books = Array.from({ length: 3 }, (_, i) => book(`书${i}`))
    const underCap = mountGrid([{ title: '长篇', books }], 100)
    expect(underCap.findAll('.book-card')).toHaveLength(3)
    expect(underCap.find('.cap-hint').exists()).toBe(false)
    underCap.unmount()

    const noCap = mountGrid([{ title: '长篇', books: Array.from({ length: 5 }, (_, i) => book(`书${i}`)) }])
    expect(noCap.findAll('.book-card')).toHaveLength(5)
    expect(noCap.find('.cap-hint').exists()).toBe(false)
    noCap.unmount()
  })

  it('多组各自独立裁剪（长篇/短篇并排各带自己的省略计数）', () => {
    const mk = (n: number, kind: 'long' | 'short') =>
      Array.from({ length: n }, (_, i) => ({ ...book(`${kind}-${i}`), kind }))
    const wrapper = mountGrid([
      { title: '长篇', books: mk(3, 'long') },
      { title: '短篇', books: mk(4, 'short') },
    ], 2)
    expect(wrapper.findAll('.book-card')).toHaveLength(4)
    const hints = wrapper.findAll('.cap-hint').map((h) => h.text())
    expect(hints).toHaveLength(2)
    expect(hints[0]).toContain('已省略 1 部')
    expect(hints[1]).toContain('已省略 2 部')
    wrapper.unmount()
  })
})

describe('R-P3-4：ShelfModal 接线（源码文本锚定，j5-overlay-dim 先例）', () => {
  const src = readFileSync(
    resolve(__dirname, '../../../src/studio/web-next/src/components/ui/ShelfModal.vue'),
    'utf-8',
  )
  it('浮层壳定义 RENDER_CAP=100 并经 :render-cap 传入 ShelfGrid', () => {
    expect(src).toContain('const SHELF_RENDER_CAP = 100')
    expect(src).toContain(':render-cap="SHELF_RENDER_CAP"')
  })
  it('数据面不动：分组/批量全选/头部计数仍来自 useShelf 全量 groups', () => {
    expect(src).toContain(':groups="groups"')
  })
})
