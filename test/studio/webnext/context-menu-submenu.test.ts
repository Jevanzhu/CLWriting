// @vitest-environment happy-dom
/**
 * R8B-P2-1（2026-09-09 修复批）：子菜单悬停闪关回归。
 *
 * 根因：.cm-submenu 的 margin-left:4px 把子菜单推出 .cm-sub-wrap 边界之外——
 * 指针从父项滑向子菜单必经 4px 真空带 → mouseleave 触发 openSub=null（子菜单
 * 同拍卸载），再进入时已无处可悬。修复：margin-left 归零，4px 视觉间隙由 wrap
 * 的 padding-right 承载（仍在悬停热区内）。
 *
 * 本文件锚定：① margin 归零（真空带消除的结构证）；② 悬停开/真离开关/再悬停
 * 复开行为链不回归（子菜单生命周期仍由 mouseenter/mouseleave 正常驱动）；
 * ③ 既有 Esc 消费语义回归锚。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ContextMenu from '../../../src/studio/web-next/src/components/ui/ContextMenu.vue'

const ITEMS = [
  { key: 'open', label: '打开' },
  { key: 'share', label: '分享', submenu: [{ key: 'copy', label: '复制链接' }, { key: 'mail', label: '邮件' }] },
]

function mountMenu() {
  // 菜单 Teleport 到 body——断言面一律查 document（wrapper 内找不到 teleport 内容）
  return mount(ContextMenu, { props: { visible: true, x: 20, y: 20, items: ITEMS } })
}

async function hoverWrap(kind: 'enter' | 'leave'): Promise<void> {
  const wrap = document.body.querySelector('.cm-sub-wrap')
  if (!(wrap instanceof HTMLElement)) throw new Error('子菜单父项缺失')
  wrap.dispatchEvent(new MouseEvent(`mouse${kind}`, { bubbles: true }))
  await nextTick()
}

describe('R8B-P2-1: 子菜单悬停热区（真空带消除）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('子菜单贴父项右缘（margin-left 归零）——指针滑入路径无真空带', async () => {
    mountMenu()
    await hoverWrap('enter')
    const sub = document.body.querySelector('.cm-submenu') as HTMLElement
    expect(sub).not.toBeNull()
    // 修复前 '4px'（推出 wrap 边界）→ 归零后间隙由 wrap padding-right 承载
    expect(['0px', '']).toContain(getComputedStyle(sub).marginLeft)
  })

  it('悬停展开 / 真离开收起 / 再悬停复开——生命周期正常驱动（无闪关残留路径）', async () => {
    mountMenu()
    await hoverWrap('enter')
    expect(document.body.querySelector('.cm-submenu')).not.toBeNull()
    await hoverWrap('leave')
    expect(document.body.querySelector('.cm-submenu')).toBeNull()
    await hoverWrap('enter')
    expect(document.body.querySelector('.cm-submenu')).not.toBeNull()
  })

  it('Esc 关闭 + 本层消费（defaultPrevented）语义回归锚', async () => {
    const w = mountMenu()
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.body.dispatchEvent(e)
    await nextTick()
    expect(w.emitted('close')).toHaveLength(1)
    expect(e.defaultPrevented).toBe(true)
    w.unmount()
  })
})