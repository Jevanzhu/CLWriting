// @vitest-environment happy-dom
/**
 * 重评2-P3-2（2026-09-09 全量重评 GLM-5.3）回归：ContextMenu 浏览器回退菜单键盘导航。
 *
 * 原 role="menu" 面仅 Esc 可用、无方向键导航——纯键盘用户进不了任何菜单项（桌面端走
 * Electron 原生 Menu 不渲染本组件，不受影响）。修复照 FontPicker 重评-P2-2 的 roving
 * tabindex 搭法：开启焦点入首项、↑/↓ 循环（跳过分隔线）、Home/End 首尾、Enter/Space
 * 激活（keydown preventDefault 截停原生按钮激活防双触发）、Tab 自然走焦关闭、Esc 关闭
 * 还焦右键来源；容器挂 aria-activedescendant；disabled 可聚焦不可激活。挂法/press 形态
 * 仿 font-picker.test.ts 重评-P2-2 段。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import ContextMenu from '../../../src/studio/web-next/src/components/ui/ContextMenu.vue'

const ITEMS = [
  { key: 'cut', label: '剪切' },
  { key: 'copy', label: '复制' },
  { key: '', label: '', separator: true },
  { key: 'del', label: '删除', danger: true },
  { key: 'dis', label: '禁用项', disabled: true },
  { key: 'sub', label: '导出', submenu: [{ key: 'md', label: 'Markdown' }] },
]

let wrapper: ReturnType<typeof mount> | null = null

/** 右键来源锚（打开前焦点持有者；真实场景是页内被右键的元素） */
function anchor(): HTMLElement {
  return document.body.querySelector('.anchor') as HTMLElement
}

function menuEl(): HTMLElement {
  const el = document.body.querySelector('.cm-menu')
  if (!el) throw new Error('菜单未渲染（teleport 内容缺失）')
  return el as HTMLElement
}

/** 顶层可导航项（跳过分隔线；与组件 navItems/顶层 .cm-item DOM 序一一对应） */
function items(): HTMLElement[] {
  return Array.from(menuEl().querySelectorAll(':scope > .cm-item, :scope > .cm-sub-wrap > .cm-item')) as HTMLElement[]
}

/** 从当前焦点元素派发 keydown（真实键盘事件 target = 焦点元素，冒泡到 window 被组件消费） */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  ;(document.activeElement ?? document.body).dispatchEvent(e)
  return e
}

/** 常驻挂载（父层 useNativeMenu 形态：v-if="!isNative" 常驻 + :visible 切换）后打开。
 *  重复打开先卸旧实例：window keydown 监听随卸载摘除，防多实例同收按键串扰断言。 */
async function openMenu(): Promise<void> {
  wrapper?.unmount()
  wrapper = mount(ContextMenu, {
    props: { visible: false, x: 10, y: 10, items: ITEMS },
    attachTo: document.body, // 焦点断言需元素真实连接到 document（游离子树 focus() 静默不生效）
  })
  anchor().focus()
  await wrapper.setProps({ visible: true })
  await nextTick() // watch 内部 await nextTick 后才 focusActive
}

beforeEach(() => {
  document.body.innerHTML = ''
  const btn = document.createElement('button')
  btn.className = 'anchor'
  document.body.appendChild(btn)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('重评2-P3-2: ContextMenu 浏览器回退菜单 roving 键盘导航', () => {
  it('打开即焦点入首项：hl + tabindex=0 + aria-activedescendant 指向首项', async () => {
    await openMenu()
    expect(document.activeElement).toBe(items()[0])
    expect(items()[0]!.classList.contains('hl')).toBe(true)
    expect(items()[0]!.getAttribute('tabindex')).toBe('0')
    expect(items()[1]!.getAttribute('tabindex')).toBe('-1')
    // 容器 aria-activedescendant 指向高亮项（cm-i-{items 下标}，分隔线计号）
    expect(menuEl().getAttribute('aria-activedescendant')).toBe(items()[0]!.id)
  })

  it('↓ 跳过分隔线步进、首尾循环；↑ 同；Home/End 直达；activedescendant 跟随', async () => {
    await openMenu()
    // 顶层项序：cut / copy / del / dis / sub（分隔线不进 roving 序）
    press('ArrowDown')
    await Promise.resolve()
    expect(document.activeElement).toBe(items()[1])
    press('ArrowDown') // copy → del（跨过分隔线）
    await Promise.resolve()
    expect(document.activeElement).toBe(items()[2])
    expect(items()[2]!.classList.contains('hl')).toBe(true)
    expect(menuEl().getAttribute('aria-activedescendant')).toBe('cm-i-3')
    press('ArrowDown')
    press('ArrowDown') // → sub（子菜单父项可聚焦）
    await Promise.resolve()
    expect(document.activeElement).toBe(items()[4])
    press('ArrowDown') // 末项 ↓ 循环回首项
    await Promise.resolve()
    expect(document.activeElement).toBe(items()[0])
    // ↑ 自首项循环回末项；Home/End 直达
    press('ArrowUp')
    await Promise.resolve()
    expect(document.activeElement).toBe(items()[4])
    press('Home')
    await Promise.resolve()
    expect(document.activeElement).toBe(items()[0])
    press('End')
    await Promise.resolve()
    expect(document.activeElement).toBe(items()[4])
  })

  it('Enter/Space 激活普通项：emit select + 上抛 close，keydown preventDefault 截停原生激活防双触发', async () => {
    await openMenu()
    press('ArrowDown')
    press('ArrowDown') // → del
    await Promise.resolve()
    const e = press('Enter')
    await Promise.resolve()
    expect(wrapper!.emitted('select')).toEqual([['del']])
    expect(wrapper!.emitted('close')).toHaveLength(1)
    expect(e.defaultPrevented).toBe(true) // 原生按钮激活被截停（激活只走 activateActive 单源）
    // Space 同语义
    await openMenu()
    const e2 = press(' ')
    await Promise.resolve()
    expect(wrapper!.emitted('select')).toEqual([['cut']])
    expect(e2.defaultPrevented).toBe(true)
  })

  it('disabled 项可聚焦不可激活：Enter 不上抛不关闭', async () => {
    await openMenu()
    press('ArrowDown')
    press('ArrowDown')
    press('ArrowDown') // → dis
    await Promise.resolve()
    expect(document.activeElement).toBe(items()[3])
    expect(items()[3]!.getAttribute('aria-disabled')).toBe('true')
    press('Enter')
    await Promise.resolve()
    expect(wrapper!.emitted('select')).toBeUndefined()
    expect(wrapper!.emitted('close')).toBeUndefined() // 菜单保持打开
  })

  it('Enter 于子菜单父项：开/收飞出层（不选中不关闭）', async () => {
    await openMenu()
    press('End') // → sub
    await Promise.resolve()
    press('Enter')
    await Promise.resolve()
    expect(document.body.querySelector('.cm-submenu')).not.toBeNull() // 飞出层展开
    expect(wrapper!.emitted('select')).toBeUndefined()
    press('Enter')
    await Promise.resolve()
    expect(document.body.querySelector('.cm-submenu')).toBeNull() // 再按收起
  })

  it('Esc 关闭且焦点还右键来源；未打开 Esc 不消费', async () => {
    await openMenu()
    expect(document.activeElement).not.toBe(anchor())
    press('Escape')
    await Promise.resolve()
    await wrapper!.setProps({ visible: false }) // 父层响应 close
    await nextTick()
    expect(document.activeElement).toBe(anchor()) // 还焦右键来源
    // 未打开：Esc 不消费（落到 useHotkeys 的原语义不变）
    const unconsumed = press('Escape')
    expect(unconsumed.defaultPrevented).toBe(false)
  })

  it('Tab 自然关闭且不消费；IME 组合期方向键让渡', async () => {
    await openMenu()
    const tab = press('Tab')
    await Promise.resolve()
    expect(wrapper!.emitted('close')).toHaveLength(1)
    expect(tab.defaultPrevented).toBe(false) // 不消费，焦点走自然次序
    // IME 组合期：方向键让渡输入法（焦点不动、不消费）
    await openMenu()
    const before = document.activeElement
    const ime = press('ArrowDown', { isComposing: true })
    await Promise.resolve()
    expect(document.activeElement).toBe(before)
    expect(ime.defaultPrevented).toBe(false)
  })

  it('未打开：方向键/Home/End 不消费（落到页面既有键盘面）', () => {
    wrapper = mount(ContextMenu, {
      props: { visible: false, x: 0, y: 0, items: ITEMS },
      attachTo: document.body,
    })
    anchor().focus()
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      const e = press(key)
      expect(e.defaultPrevented).toBe(false)
    }
  })
})
