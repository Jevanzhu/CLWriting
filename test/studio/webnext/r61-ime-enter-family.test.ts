// @vitest-environment happy-dom
/**
 * R61-3/R61-17（第六十一轮）回归：IME 组合期 Enter 让渡家族。
 * - shared/ime.ts 单源判据（isComposing || keyCode 229）；
 * - ChapterTreeItem 重命名/新建输入框：组合期 Enter 不提交、Esc 不取消（收候选框）；
 * - ChapterMetaDialog：组合期 Enter 不保存（防缺字标题落 fm + rename）；
 * - CreateBookModal：组合期 Enter 不建书；
 * - SearchPanel：组合期 Enter 不触发全书搜索（R61-17 同族补遗）。
 * 组件键盘入口统一改 keydown + 守卫（keyup 在 compositionend 后触发不可区分）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import { isImeComposing } from '../../../src/studio/web-next/src/shared/ime'
import ChapterTreeItem from '../../../src/studio/web-next/src/components/panels/ChapterTreeItem.vue'
import ChapterMetaDialog from '../../../src/studio/web-next/src/components/panels/ChapterMetaDialog.vue'
import CreateBookModal from '../../../src/studio/web-next/src/components/ui/CreateBookModal.vue'
import SearchPanel from '../../../src/studio/web-next/src/components/panels/SearchPanel.vue'
import { search } from '../../../src/studio/web-next/src/api/search'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

vi.mock('../../../src/studio/web-next/src/api/search', () => ({
  search: vi.fn(async () => ({ results: [], truncated: false })),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
})

/** 真实 KeyboardEvent 直派（VTU trigger 对 isComposing init 键透传不可靠） */
function press(el: Element, init: KeyboardEventInit): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

const composingEnter = { key: 'Enter', isComposing: true } satisfies KeyboardEventInit
const realEnter = { key: 'Enter' } satisfies KeyboardEventInit

describe('R61-3: isImeComposing 单源判据', () => {
  it('isComposing / keyCode 229 双判据', () => {
    expect(isImeComposing(new KeyboardEvent('keydown', { isComposing: true }))).toBe(true)
    expect(isImeComposing({ keyCode: 229 } as KeyboardEvent)).toBe(true)
    expect(isImeComposing(new KeyboardEvent('keydown', {}))).toBe(false)
    expect(isImeComposing(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false)
  })
})

function leafNode(path: string): TreeNode {
  return {
    path,
    name: path.split('/').pop() ?? path,
    isDirectory: false,
    role: 'chapter',
    children: [],
    docId: 'doc-x',
  }
}

describe('R61-17: ChapterTreeItem 重命名/新建输入框组合期让渡', () => {
  const node = leafNode('写作/正文/0001-开篇.md')
  function mountRename(renamePath: string) {
    return mount(ChapterTreeItem, {
      props: {
        node,
        depth: 0,
        expanded: new Set<string>(),
        activePath: null,
        creatingDirPath: null,
        creatingKind: null,
        creatingSeed: '',
        renamePath,
        draggedPath: null,
      },
    })
  }

  it('重命名：组合期 Enter 不提交；组合期 Esc 不取消（收候选框）；真实 Enter 正常提交', async () => {
    const w = mountRename(node.path)
    const input = w.find('input.inline-input')
    await input.setValue('新标题半')
    press(input.element, composingEnter)
    press(input.element, { key: 'Escape', isComposing: true })
    expect(w.emitted('rename-commit')).toBeUndefined()
    expect(w.emitted('rename-cancel')).toBeUndefined()
    press(input.element, realEnter)
    expect(w.emitted('rename-commit')).toEqual([[node.path, '新标题半']])
    w.unmount()
  })

  it('新建：组合期 Enter 不提交；真实 Enter 正常提交', async () => {
    const w = mount(ChapterTreeItem, {
      props: {
        node: { path: '设定', name: '设定', isDirectory: true, role: 'dir', children: [] },
        depth: 0,
        expanded: new Set(['设定']),
        activePath: null,
        creatingDirPath: '设定',
        creatingKind: 'character',
        creatingSeed: '',
        renamePath: null,
        draggedPath: null,
      },
    })
    const input = w.find('input.inline-input')
    await input.setValue('林')
    press(input.element, composingEnter)
    expect(w.emitted('create-commit')).toBeUndefined()
    press(input.element, realEnter)
    expect(w.emitted('create-commit')).toEqual([['林']])
    w.unmount()
  })
})

describe('R61-3: ChapterMetaDialog 组合期 Enter 不保存', () => {
  it('组合期 Enter 让渡；真实 Enter 保存（标题/章号）', async () => {
    const w = mount(ChapterMetaDialog, {
      props: { modelValue: true, num: 3, 标题: '原题' },
      attachTo: document.body,
    })
    const dlg = document.body.querySelector('.meta-dialog')
    expect(dlg).not.toBeNull()
    // teleport to body：input 从 body 取（同 palette 测试口径），[1] = 标题输入框
    const inputs = document.body.querySelectorAll('.meta-dialog input')
    expect(inputs.length).toBeGreaterThanOrEqual(2)
    const titleInput = inputs[1] as HTMLInputElement
    titleInput.value = '新题半'
    titleInput.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 0))
    press(dlg!, composingEnter)
    expect(w.emitted('save')).toBeUndefined()
    press(dlg!, realEnter)
    const save = w.emitted('save')
    expect(save).toEqual([[{ 标题: '新题半', num: 3 }]])
    w.unmount()
  })
})

describe('R61-17: CreateBookModal 组合期 Enter 不建书', () => {
  it('组合期 Enter 让渡；真实 Enter 触发 create', async () => {
    const w = mount(CreateBookModal, {
      props: { name: '雪中', kind: 'long', creating: false, error: null },
    })
    const input = w.find('input.input')
    press(input.element, composingEnter)
    expect(w.emitted('create')).toBeUndefined()
    press(input.element, realEnter)
    expect(w.emitted('create')).toHaveLength(1)
    w.unmount()
  })
})

describe('R61-17 同族: SearchPanel 组合期 Enter 不搜索', () => {
  it('组合期 Enter 让渡；真实 Enter 触发搜索', async () => {
    const searchSpy = vi.mocked(search)
    searchSpy.mockClear()
    const w = mount(SearchPanel, { props: { bookName: '书甲' } })
    const input = w.find('.search-input input')
    await input.setValue('林')
    press(input.element, composingEnter)
    await new Promise((r) => setTimeout(r, 0))
    expect(searchSpy).not.toHaveBeenCalled()
    press(input.element, realEnter)
    await new Promise((r) => setTimeout(r, 0))
    expect(searchSpy).toHaveBeenCalledWith('书甲', '林', 'all')
    w.unmount()
  })
})
