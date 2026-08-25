// @vitest-environment happy-dom
/**
 * M-P3-13（内存核查 2026-08-25）：命令面板渲染上限。
 * 空查询时全书每章一条原全量渲染为 DOM（max-height 只是视觉滚动裁剪不减节点）→
 * 改为每节渲染 ≤100 条 + 尾部「已省略 N 项」提示行；有查询词（过滤）时同样
 * 上限防长匹配。数据源（cmds 生成 / filtered 扁平索引）不动，只裁渲染。
 * 面板经 <teleport to="body"> 渲染，元素从 document.body 取（同 ChapterMetaDialog 口径）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, DOMWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'

// R61-20：mock 裸名——解析由 vitest.config alias 钉位（布局变化不再打断 mock）
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('../../../src/studio/web-next/src/api/documents', () => ({
  getDoc: vi.fn(),
  createDoc: vi.fn(),
  renameDoc: vi.fn(),
  moveDoc: vi.fn(),
  copyDoc: vi.fn(),
  deleteDoc: vi.fn(),
}))

import CommandPalette from '../../../src/studio/web-next/src/components/ui/CommandPalette.vue'
import { useUiStore } from '../../../src/studio/web-next/src/stores/ui'
import { useTreeStore } from '../../../src/studio/web-next/src/stores/tree'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

/** 千章级章节树（叶子名 0001-北境…：编号拆分走真实正则，标签全部含「北境」便于过滤测试） */
function chapterTree(n: number): TreeNode[] {
  const children: TreeNode[] = []
  for (let i = 1; i <= n; i++) {
    const no = String(i).padStart(4, '0')
    children.push({
      path: `写作/${no}-北境第${i}节`,
      name: `${no}-北境第${i}节`,
      isDirectory: false,
      role: 'chapter',
      children: [],
      docId: `doc-${i}`,
    })
  }
  return [{ path: '写作', name: '写作', isDirectory: true, role: 'dir', children }]
}

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = '' // 清掉上个用例残留的 teleport 内容
})

afterEach(() => {
  wrapper?.unmount() // teleport 内容随组件卸载移除
  wrapper = null
})

/** 挂千章树并打开面板 */
function mountPalette(n = 1000): void {
  const ui = useUiStore()
  const tree = useTreeStore()
  tree.raw = chapterTree(n)
  ui.openPalette()
  wrapper = mount(CommandPalette)
}

/** 面板渲染在 body 下（teleport），用 DOMWrapper 包一层拿 VTU 的交互 API */
function palette(): DOMWrapper<Element> {
  const el = document.body.querySelector('.palette')
  if (!el) throw new Error('面板未渲染（teleport 内容缺失）')
  return new DOMWrapper(el)
}

describe('M-P3-13: 命令面板渲染上限（每节 ≤100 + 省略提示行）', () => {
  it('空查询：千章树只渲染 100 条章节 + 全量动作，章节节尾出现「已省略 900 项」提示', () => {
    mountPalette(1000)
    // 章节节被裁到上限 100（数据 filtered 仍是全量 1000，只裁渲染）
    const groups = palette().findAll('.palette-group')
    expect(groups.length).toBe(2) // 章节 + 动作
    const chapterItems = groups[0]!.findAll('.palette-item')
    expect(chapterItems.length).toBe(100)
    // 全部渲染行数有硬上界（千章级不得千行 DOM）
    expect(palette().findAll('.palette-item').length).toBeLessThanOrEqual(200)
    // 省略提示行出现且计数正确
    const more = groups[0]!.find('.pg-more')
    expect(more.exists()).toBe(true)
    expect(more.text()).toContain('已省略 900 项')
    expect(more.text()).toContain('继续输入以缩小范围')
    // 动作节未超限 → 无提示行
    expect(groups[1]!.find('.pg-more').exists()).toBe(false)
  })

  it('过滤（有查询词）同样上限：命中全部千章 → 仍 100 条 + 提示', async () => {
    mountPalette(1000)
    await palette().find('input.palette-input').setValue('北境')
    const groups = palette().findAll('.palette-group')
    expect(groups.length).toBe(1) // 动作不匹配「北境」→ 动作节隐藏
    expect(groups[0]!.findAll('.palette-item').length).toBe(100)
    expect(groups[0]!.find('.pg-more').text()).toContain('已省略 900 项')
  })

  it('少量匹配不裁：命中 1 条 → 全渲染且无省略提示', async () => {
    mountPalette(1000)
    // 过滤匹配的是拆编号后的标题（label=「北境第N节」），不含前导章号
    await palette().find('input.palette-input').setValue('北境第1节')
    expect(palette().findAll('.palette-item').length).toBe(1)
    expect(palette().find('.pg-more').exists()).toBe(false)
  })

  it('百章以内（未达上限）不裁、无提示——修法不误伤常规规模', () => {
    mountPalette(60)
    expect(palette().findAll('.palette-item').length).toBeGreaterThan(60) // 60 章 + 动作全渲染
    expect(palette().find('.pg-more').exists()).toBe(false)
  })
})

describe('R61-3/R61-16: IME 组合期让渡与键盘导航渲染上限', () => {
  /** 真实 KeyboardEvent 直派（VTU trigger 对 isComposing 类 init 键的透传不可靠） */
  function press(input: HTMLInputElement, init: KeyboardEventInit): void {
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  }

  it('R61-3: 组合期 Enter/方向键让渡——不执行命令、面板不关', async () => {
    mountPalette(10)
    const ui = useUiStore()
    const docStore = useDocStore()
    const openSpy = vi.spyOn(docStore, 'open').mockResolvedValue(undefined)
    const input = palette().find<HTMLInputElement>('input.palette-input').element
    press(input, { key: 'Enter', isComposing: true })
    press(input, { key: 'ArrowDown', isComposing: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(ui.paletteOpen).toBe(true) // 面板未关（修复前：组合确认候选的 Enter 会执行选中命令并关闭）
    expect(openSpy).not.toHaveBeenCalled()
    openSpy.mockRestore()
  })

  it('R61-16: 千章树 ↓ 按到底 → sel 停在已渲染区间（.sel 有对应 DOM），Enter 执行可见命令', async () => {
    mountPalette(1000)
    const ui = useUiStore()
    const docStore = useDocStore()
    const openSpy = vi.spyOn(docStore, 'open').mockResolvedValue(undefined)
    const input = palette().find<HTMLInputElement>('input.palette-input').element
    // 过滤到只剩章节节（千章命中，渲染仍裁 100）——Enter 走 doc.open 可断言执行对象
    input.value = '北境'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    // 按过章节节渲染上限（100）再继续——修复前 sel 走进未渲染区（.sel 无 DOM）
    for (let i = 0; i < 1500; i++) press(input, { key: 'ArrowDown' })
    await new Promise((r) => setTimeout(r, 0))
    const selItems = palette().findAll('.palette-item.sel')
    expect(selItems.length).toBe(1) // 高亮项恰一个且真实渲染在 DOM（未渲染区不可达）
    press(input, { key: 'Enter' })
    await new Promise((r) => setTimeout(r, 0))
    expect(ui.paletteOpen).toBe(false) // 执行命令并正常关闭
    // 执行对象是章节节最后一个已渲染项（第 100 章）——不是被省略渲染的千章深处
    expect(openSpy).toHaveBeenCalledWith(expect.objectContaining({ docId: 'doc-100' }))
    openSpy.mockRestore()
  })
})
