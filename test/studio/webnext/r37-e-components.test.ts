// @vitest-environment happy-dom
/**
 * 三十七轮批E 组件域回归（R37-31/33/34/35/36）：
 *
 * R37-31：树行原生拖拽补 dataTransfer.setData（Firefox 无 data 不启动拖拽），命中区
 *         从 caret/dot 扩到整行；重命名态（行内有 input）不受影响。
 * R37-33：ConfirmDeleteModal 接 useFocusTrap——打开时焦点落取消按钮（危险操作默认
 *         安全项），Tab 循环不出弹窗。
 * R37-34：ModelListEditor 外部 modelValue 变更重建行列表；自身 emit 回流不重建。
 * R37-35：ContextMenu 平台探测三级兜底（userAgentData → navigator.platform → UA 串）。
 * R37-36：ModelPicker Esc 关闭自身且 stopPropagation，不外溢到外层 Esc 链。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

import ChapterTreeItem from '../../../src/studio/web-next/src/components/panels/ChapterTreeItem.vue'
import ConfirmDeleteModal from '../../../src/studio/web-next/src/components/ui/ConfirmDeleteModal.vue'
import ModelListEditor from '../../../src/studio/web-next/src/components/ui/ModelListEditor.vue'
import ModelRow from '../../../src/studio/web-next/src/components/ui/ModelRow.vue'
import ContextMenu from '../../../src/studio/web-next/src/components/ui/ContextMenu.vue'
import ModelPicker from '../../../src/studio/web-next/src/components/ui/ModelPicker.vue'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'
import type { ModelRowDraft } from '../../../src/studio/web-next/src/shared/provider-format'

beforeEach(() => {
  setActivePinia(createPinia())
})

// ── R37-31：拖拽 setData + 行级命中区 ────────────────────────

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

// ── R37-33：ConfirmDeleteModal 焦点圈 ────────────────────────

describe('R37-33: ConfirmDeleteModal 焦点圈 + 默认聚焦取消', () => {
  it('挂载后焦点在取消按钮（危险操作默认安全项），Tab 循环不出弹窗', async () => {
    const w = mount(ConfirmDeleteModal, {
      props: { names: ['书A'], deleting: false, error: null },
      attachTo: document.body,
    })
    await nextTick()

    const dialog = document.querySelector('.confirm-dialog') as HTMLElement
    expect(dialog.getAttribute('role')).toBe('dialog')
    const btns = document.querySelectorAll('.confirm-actions .btn')
    expect(btns.length).toBe(2)
    // 修复点：trap 落焦第一个可交互元素 = 取消按钮（修复前无 focus trap，焦点留背景）
    expect(document.activeElement).toBe(btns[0])

    // Shift+Tab 从取消（first）→ 包裹到确认删除（last）：Tab 循环不出弹窗
    btns[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    )
    await nextTick()
    expect(document.activeElement).toBe(btns[1])

    w.unmount()
  })
})

// ── R37-34：ModelListEditor 外部变更同步 ────────────────────────

describe('R37-34: ModelListEditor 外部 modelValue 变更重建行列表', () => {
  const baseProps = {
    probe: { protocol: 'openai' as const, baseUrl: '', apiKey: '' },
    disabled: false,
  }
  const rowA = { id: 'model-a', name: '', contextWindowText: '', maxTokensText: '' }

  it('挂载后改 props.modelValue（如恢复默认）→ 行列表跟随重建', async () => {
    const w = mount(ModelListEditor, { props: { modelValue: [rowA], ...baseProps } })
    expect(w.findAllComponents(ModelRow)).toHaveLength(1)

    const rowB = { id: 'model-b', name: '', contextWindowText: '', maxTokensText: '' }
    await w.setProps({ modelValue: [rowB], ...baseProps })
    // 修复点：外部变更重建（修复前行列表纹丝不动，一直显示旧值）
    const rows = w.findAllComponents(ModelRow)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.props('row').id).toBe('model-b')
  })

  it('组件内编辑 emit → 同值回流不重建（行实例保持，编辑态不被打断）', async () => {
    const w = mount(ModelListEditor, { props: { modelValue: [rowA], ...baseProps } })
    const before = w.findAllComponents(ModelRow)[0]!
    const beforeEl = before.element // DOM 节点身份（wrapper 每次查询新建，不可比）

    // 行内编辑：rowChanged → emit('update:modelValue', [...])；父层 v-model 把同值写回
    const edited = { id: 'model-a2', name: '', contextWindowText: '32K', maxTokensText: '' }
    before.vm.$emit('change', edited)
    const emittedValue = w.emitted('update:modelValue')!.at(-1)![0] as ModelRowDraft[]
    expect(emittedValue[0]!.id).toBe('model-a2') // emit 契约（对照组）

    await w.setProps({ modelValue: emittedValue, ...baseProps }) // v-model 回流同值
    await nextTick()
    // 修复点：自身 emit 的回流不触发重建（DOM 节点保持；重建会因 _key 全换而换节点）
    const after = w.findAllComponents(ModelRow)[0]!
    expect(after.element).toBe(beforeEl)
    expect(after.props('row').id).toBe('model-a2')
  })
})

// ── R37-35：ContextMenu 平台探测兜底 ────────────────────────

describe('R37-35: 平台探测三级兜底（userAgentData → navigator.platform → UA）', () => {
  function stubNavigator(opts: { userAgentData?: string; platform?: string; userAgent?: string }): void {
    const nav = window.navigator as Navigator & { userAgentData?: { platform?: string } }
    if ('userAgentData' in nav) delete nav.userAgentData
    if (opts.userAgentData !== undefined) {
      Object.defineProperty(nav, 'userAgentData', {
        value: { platform: opts.userAgentData },
        configurable: true,
      })
    }
    Object.defineProperty(nav, 'platform', { value: opts.platform ?? '', configurable: true })
    Object.defineProperty(nav, 'userAgent', { value: opts.userAgent ?? '', configurable: true })
  }

  function mountMenu(): void {
    mount(ContextMenu, {
      props: {
        visible: true,
        x: 10,
        y: 10,
        items: [{ key: 'a', label: '动作', accelerator: 'CmdOrCtrl+S' }],
      },
      attachTo: document.body,
    })
  }

  afterEach(() => {
    document.body.innerHTML = ''
    stubNavigator({}) // 还原探测源（避免污染后续用例）
  })

  it('无 userAgentData（老 WebView/非 Chromium）+ navigator.platform=MacIntel → ⌘ 兜底命中', async () => {
    stubNavigator({ platform: 'MacIntel', userAgent: '' })
    mountMenu()
    await nextTick()
    expect(document.querySelector('.cm-shortcut')!.textContent).toContain('⌘')
  })

  it('无 userAgentData 且 platform 为空 → userAgent 字符串嗅探兜底（Mac → ⌘）', async () => {
    stubNavigator({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' })
    mountMenu()
    await nextTick()
    // 修复点：探测不再单源落空（修复前只读一个源，空值即误判非 mac）
    expect(document.querySelector('.cm-shortcut')!.textContent).toContain('⌘')
  })

  it('无 userAgentData + platform/userAgent 均 Windows → Ctrl+', async () => {
    stubNavigator({ platform: '', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' })
    mountMenu()
    await nextTick()
    expect(document.querySelector('.cm-shortcut')!.textContent).toContain('Ctrl+')
  })

  it('有 userAgentData 时以其为准（新 API 优先于 navigator.platform）', async () => {
    stubNavigator({ userAgentData: 'Windows', platform: 'MacIntel', userAgent: '' })
    mountMenu()
    await nextTick()
    expect(document.querySelector('.cm-shortcut')!.textContent).toContain('Ctrl+')
  })
})

// ── R37-36：ModelPicker Esc 关闭且不外溢 ────────────────────────

describe('R37-36: ModelPicker Esc 关闭自身且阻断外层 Esc 链', () => {
  it('show 时按 Esc → close 上抛且外层（window 冒泡监听）不触发', async () => {
    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    const w = mount(ModelPicker, {
      props: { show: true, candidates: ['m1'], picked: new Set(['m1']) },
      attachTo: document.body,
    })

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()

    // 修复点：内层消费 Esc（close 上抛）且 stopPropagation——外层 useHotkeys/
    // SettingsModal 等同键链不同时触发（修复前 ModelPicker 无 Esc 处理，按键直穿）
    expect(w.emitted('close')).toHaveLength(1)
    expect(outer).not.toHaveBeenCalled()

    window.removeEventListener('keydown', outer)
    w.unmount()
  })

  it('show=false 时 Esc 不消费（未开的弹层不拦截外层按键）', async () => {
    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    const w = mount(ModelPicker, {
      props: { show: false, candidates: [], picked: new Set<string>() },
      attachTo: document.body,
    })

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()

    expect(w.emitted('close')).toBeUndefined()
    expect(outer).toHaveBeenCalledTimes(1) // 让渡给外层

    window.removeEventListener('keydown', outer)
    w.unmount()
  })

  it('卸载后监听随之移除（不残留全局 keydown）', async () => {
    const w = mount(ModelPicker, {
      props: { show: true, candidates: [], picked: new Set<string>() },
      attachTo: document.body,
    })
    w.unmount()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(w.emitted('close')).toBeUndefined()
  })
})
