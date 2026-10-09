/**
 * 重评2-P3-2（2026-09-09 全量重评 GLM-5.3）回归：ContextMenu 浏览器回退菜单键盘导航。
 *
 * 原 role="menu" 面仅 Esc 可用、无方向键导航——纯键盘用户进不了任何菜单项（桌面端走
 * Electron 原生 Menu 不渲染本组件，不受影响）。修复照 FontPicker 重评-P2-2 的 roving
 * tabindex 搭法：开启焦点入首项、↑/↓ 循环（跳过分隔线）、Home/End 首尾、Enter/Space
 * 激活（keydown preventDefault 截停原生按钮激活防双触发）、Tab 自然走焦关闭、Esc 关闭
 * 还焦右键来源；容器挂 aria-activedescendant；disabled 可聚焦不可激活。挂法/press 形态
 * 仿 font-picker.test.ts 重评-P2-2 段。
 *
 * 本档同时锚定飞出层（子菜单）键盘可达（原「hover 唯一可达」登记的闭合）：→ 进层并聚焦
 * 层内首项、层内 ← 收层还焦父项、层内 ↑/↓ 循环（层界 = 键盘是否在层内）、层内 Enter
 * 激活子项、顶层位移离父项即收层、hover 与键盘两路径让位（hover 开层可被 → 接管；键盘
 * 入层后指针离场收层但焦点还父项）。进层落焦须过 v-if 渲染一拍，故进层后 `await nextTick()`。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import ContextMenu from '../../../../src/studio/web-next/src/components/ui/ContextMenu.vue'

const ITEMS = [
  { key: 'cut', label: '剪切' },
  { key: 'copy', label: '复制' },
  { key: '', label: '', separator: true },
  { key: 'del', label: '删除', danger: true },
  { key: 'dis', label: '禁用项', disabled: true },
  {
    key: 'sub',
    label: '导出',
    // 三项 = md / html / 末项 disabled：层内 ↑/↓ 循环与「disabled 可聚焦不可激活」共用一具
    submenu: [
      { key: 'md', label: 'Markdown' },
      { key: 'html', label: 'HTML' },
      { key: 'pdf', label: 'PDF', disabled: true },
    ],
  },
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

/** 当前展开飞出层的项（层内 DOM 序与组件 subNavItems 一一对应＝分隔线不渲染 .cm-item） */
function subItems(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll('.cm-submenu .cm-item')) as HTMLElement[]
}

/** 子菜单父项按钮（本档 ITEMS 仅末项 sub 带 submenu） */
function subParent(): HTMLElement {
  const el = document.body.querySelector('.cm-sub-wrap > .cm-item')
  if (!el) throw new Error('子菜单父项未渲染')
  return el as HTMLElement
}

/** 父项 hover 开/关飞出层（组件鼠标路径的驱动事件；真离开＝pointer 出 wrap 热区） */
async function hoverWrap(kind: 'enter' | 'leave'): Promise<void> {
  const wrap = document.body.querySelector('.cm-sub-wrap')
  if (!(wrap instanceof HTMLElement)) throw new Error('子菜单父项缺失')
  wrap.dispatchEvent(new MouseEvent(`mouse${kind}`, { bubbles: true }))
  await nextTick()
}

/** 顶层高亮落到父项（End 直达末项）后按 → 进层；进层落焦待 v-if 渲染一拍，故过 nextTick */
async function enterSub(): Promise<void> {
  press('End')
  await Promise.resolve()
  press('ArrowRight')
  await nextTick()
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

  it('未打开：方向键/Home/End/→/← 不消费（落到页面既有键盘面）', () => {
    wrapper = mount(ContextMenu, {
      props: { visible: false, x: 0, y: 0, items: ITEMS },
      attachTo: document.body,
    })
    anchor().focus()
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      const e = press(key)
      expect(e.defaultPrevented).toBe(false)
    }
  })
})

describe('浏览器回退菜单飞出层（子菜单）键盘可达', () => {
  it('顶层父项 →：展开飞出层且焦点落层内首项（roving/aria-expanded/activedescendant 同步）；无子菜单项不响应不消费', async () => {
    await openMenu()
    // 无子菜单项（cut）：→ 不响应不消费、焦点不动、无层可开
    const none = press('ArrowRight')
    await Promise.resolve()
    expect(none.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(items()[0])
    expect(document.body.querySelector('.cm-submenu')).toBeNull()
    // 父项（sub）上 →：展开 + 焦点入层内首项
    press('End')
    await Promise.resolve()
    expect(document.activeElement).toBe(items()[4])
    const opened = press('ArrowRight')
    await nextTick() // 进层落焦待 v-if 渲染一拍
    expect(opened.defaultPrevented).toBe(true)
    expect(subItems()).toHaveLength(3)
    expect(document.activeElement).toBe(subItems()[0])
    expect(subItems()[0]!.getAttribute('tabindex')).toBe('0')
    expect(subItems()[1]!.getAttribute('tabindex')).toBe('-1')
    expect(subItems()[0]!.classList.contains('hl')).toBe(true)
    expect(menuEl().getAttribute('aria-activedescendant')).toBe('cm-s-0')
    expect(subParent().getAttribute('aria-haspopup')).toBe('menu')
    expect(subParent().getAttribute('aria-expanded')).toBe('true')
  })

  it('层内 ↑/↓ 循环（末项 disabled 仍可聚焦）与 Home/End 首尾；顶层高亮不被层内位移改写', async () => {
    await openMenu()
    await enterSub()
    // ↓：md → html → pdf(disabled) → 循环回 md
    press('ArrowDown')
    await Promise.resolve()
    expect(document.activeElement).toBe(subItems()[1])
    press('ArrowDown')
    await Promise.resolve()
    expect(document.activeElement).toBe(subItems()[2])
    expect(subItems()[2]!.getAttribute('aria-disabled')).toBe('true') // 可聚焦不可激活
    press('ArrowDown')
    await Promise.resolve()
    expect(document.activeElement).toBe(subItems()[0])
    // ↑：首项循环回末项；Home/End 层内直达
    press('ArrowUp')
    await Promise.resolve()
    expect(document.activeElement).toBe(subItems()[2])
    press('Home')
    await Promise.resolve()
    expect(document.activeElement).toBe(subItems()[0])
    press('End')
    await Promise.resolve()
    expect(document.activeElement).toBe(subItems()[2])
    // 键盘在层内：顶层 hl 始终留在父项（层内位移不越层改写顶层序）
    expect(items()[4]!.classList.contains('hl')).toBe(true)
    expect(menuEl().getAttribute('aria-activedescendant')).toBe('cm-s-2')
  })

  it('层内 ← 收层并还焦父项；顶层/未入层 ← 不消费不响应', async () => {
    await openMenu()
    await enterSub()
    const left = press('ArrowLeft')
    await nextTick()
    expect(left.defaultPrevented).toBe(true)
    expect(document.body.querySelector('.cm-submenu')).toBeNull() // 层收（菜单本身不关）
    expect(document.activeElement).toBe(items()[4]) // 还焦父项
    expect(menuEl().getAttribute('aria-activedescendant')).toBe('cm-i-5') // 顶层高亮仍在父项
    expect(subParent().getAttribute('aria-expanded')).toBe('false')
    expect(wrapper!.emitted('close')).toBeUndefined()
    // 顶层（无层可收）：← 不响应不消费
    const plain = press('ArrowLeft')
    await Promise.resolve()
    expect(plain.defaultPrevented).toBe(false)
  })

  it('层内 Enter/Space 激活子项：emit select + close；disabled 子项不激活', async () => {
    await openMenu()
    await enterSub()
    press('ArrowDown') // → html
    await Promise.resolve()
    const e = press('Enter')
    await Promise.resolve()
    expect(wrapper!.emitted('select')).toEqual([['html']])
    expect(wrapper!.emitted('close')).toHaveLength(1)
    expect(e.defaultPrevented).toBe(true) // 原生按钮激活被截停（单源 activateActive）
    // Space 同语义
    await openMenu()
    await enterSub()
    const e2 = press(' ')
    await Promise.resolve()
    expect(wrapper!.emitted('select')).toEqual([['md']])
    expect(e2.defaultPrevented).toBe(true)
    // 末项 disabled：可聚焦、Enter 不上抛不关闭
    await openMenu()
    await enterSub()
    press('End')
    await Promise.resolve()
    expect(document.activeElement).toBe(subItems()[2])
    press('Enter')
    await Promise.resolve()
    expect(wrapper!.emitted('select')).toBeUndefined()
    expect(wrapper!.emitted('close')).toBeUndefined()
  })

  it('层内 Esc 只收层（还焦父项、不关整菜单）；收层后顶层 Esc 关整菜单', async () => {
    await openMenu()
    await enterSub()
    const esc = press('Escape')
    await nextTick()
    expect(esc.defaultPrevented).toBe(true)
    expect(document.body.querySelector('.cm-submenu')).toBeNull()
    expect(document.activeElement).toBe(items()[4])
    expect(wrapper!.emitted('close')).toBeUndefined() // 菜单仍开（层内 Esc 不越层关菜单）
    press('Escape')
    await Promise.resolve()
    expect(wrapper!.emitted('close')).toHaveLength(1)
  })

  it('顶层位移离开父项即收层（hl 不留在别项而旧层仍挂）；hover 开层可被 → 接管、键盘入层后指针离场焦点还父项', async () => {
    await openMenu()
    press('End')
    await Promise.resolve()
    press('Enter') // Enter 开层（既有语义：不入层、不上抛）
    await nextTick()
    expect(document.body.querySelector('.cm-submenu')).not.toBeNull()
    expect(document.activeElement).toBe(items()[4])
    press('ArrowDown') // 顶层位移离开父项 → 层随收（避免 hl 与展开层错位）
    await nextTick()
    expect(document.body.querySelector('.cm-submenu')).toBeNull()
    expect(document.activeElement).toBe(items()[0])
    // hover 开层（高亮随指针落到父项，键盘态仍在顶层）→ → 接管入层
    await hoverWrap('enter')
    expect(document.body.querySelector('.cm-submenu')).not.toBeNull()
    expect(document.activeElement).toBe(items()[4])
    press('ArrowRight')
    await nextTick()
    expect(document.activeElement).toBe(subItems()[0])
    // 键盘已入层：指针离场收层且焦点还父项——不得丢给已卸载的层（body）
    await hoverWrap('leave')
    expect(document.body.querySelector('.cm-submenu')).toBeNull()
    expect(document.activeElement).toBe(items()[4])
  })
})
