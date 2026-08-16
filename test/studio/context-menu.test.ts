/**
 * RB-SV-P2-5 回归：desktop:context-menu IPC 载荷净化（src/desktop/context-menu.ts）。
 *
 * 主进程最后的未设防入口：渲染层传非数组 / null 元素 / 无 label 项，
 * 净化函数必须不抛异常并给出安全结果（null / 过滤非法项）。
 */
import { describe, it, expect } from 'vitest'
import { parseContextMenuSpecs } from '../../src/desktop/context-menu.js'

describe('RB-SV-P2-5 parseContextMenuSpecs 形状校验', () => {
  it('非数组载荷（null/对象/字符串/数字）→ null，不抛异常', () => {
    expect(parseContextMenuSpecs(null)).toBeNull()
    expect(parseContextMenuSpecs(undefined)).toBeNull()
    expect(parseContextMenuSpecs({ label: 'x' })).toBeNull()
    expect(parseContextMenuSpecs('not-array')).toBeNull()
    expect(parseContextMenuSpecs(42)).toBeNull()
  })

  it('null/非对象元素跳过，合法项保留', () => {
    const out = parseContextMenuSpecs([
      null,
      123,
      'str',
      { label: '复制', key: 'copy', accelerator: 'CmdOrCtrl+C' },
      { separator: true },
    ])
    expect(out).not.toBeNull()
    expect(out).toHaveLength(2)
    expect(out![0]).toMatchObject({ label: '复制', key: 'copy', accelerator: 'CmdOrCtrl+C', disabled: false })
    expect(out![1]!.separator).toBe(true)
  })

  it('无 label 且非分隔项 → 跳过（Menu.buildFromTemplate 必填 label）', () => {
    const out = parseContextMenuSpecs([{ key: 'k' }, { label: '' }, { label: '正常' }])
    expect(out).toEqual([{ label: '正常', disabled: false }])
  })

  it('非法字段类型不透传（key/accelerator 非 string 丢弃，disabled 只认严格 true）', () => {
    const out = parseContextMenuSpecs([{ label: '菜单', key: 1, accelerator: null, disabled: 'yes' }])
    expect(out).toEqual([{ label: '菜单', disabled: false }])
    const off = parseContextMenuSpecs([{ label: '置灰项', disabled: true }])
    expect(off).toEqual([{ label: '置灰项', disabled: true }])
  })

  it('submenu 非法元素同样过滤；空数组载荷 → 空数组（不弹菜单）', () => {
    const out = parseContextMenuSpecs([
      { label: '父级', submenu: [null, { label: '子项', key: 'child' }, { nope: 1 }] },
    ])
    expect(out![0]!.submenu).toEqual([{ label: '子项', disabled: false, key: 'child' }])
    expect(parseContextMenuSpecs([])).toEqual([])
  })
})
