/**
 * RB-SV-P2-5 + 低级项（第六轮）：desktop:context-menu IPC 载荷净化单元测试。
 *
 * 形状校验（非数组 → null、无 label 跳过）与 accelerator 白名单——
 * 非法 accelerator 会在 Electron Menu.buildFromTemplate 抛错崩主进程，须在此剥掉。
 */
import { describe, it, expect } from 'vitest'
import { parseContextMenuSpecs } from '../../src/desktop/context-menu.js'

describe('parseContextMenuSpecs', () => {
  it('非数组 → null（整体忽略不弹菜单）', () => {
    expect(parseContextMenuSpecs('不是数组')).toBeNull()
    expect(parseContextMenuSpecs(null)).toBeNull()
    expect(parseContextMenuSpecs({})).toBeNull()
  })

  it('合法项保留：label/key/disabled/submenu', () => {
    const r = parseContextMenuSpecs([
      { separator: true },
      { label: '复制', key: 'copy', disabled: false },
      { label: '父级', submenu: [{ label: '子项', key: 'sub' }] },
      42, // 非对象元素跳过
      { noLabel: true }, // 无 label 跳过
    ])
    expect(r).toEqual([
      { label: '', separator: true },
      { label: '复制', key: 'copy', disabled: false },
      { label: '父级', disabled: false, submenu: [{ label: '子项', key: 'sub', disabled: false }] },
    ])
  })

  it('低级项（第六轮）：accelerator 白名单——合法组合保留，非法剥掉（菜单项仍在）', () => {
    const r = parseContextMenuSpecs([
      { label: '复制', accelerator: 'CmdOrCtrl+C' },
      { label: '多修饰', accelerator: 'Shift+Alt+F5' },
      { label: '裸功能键', accelerator: 'F2' },
      { label: '尾空', accelerator: 'Ctrl+' },
      { label: '怪字符', accelerator: 'ណ+Q' },
      { label: '超长串', accelerator: 'Control+PrintScreen123' },
    ])
    expect(r![0]!.accelerator).toBe('CmdOrCtrl+C')
    expect(r![1]!.accelerator).toBe('Shift+Alt+F5')
    expect(r![2]!.accelerator).toBe('F2')
    // 非法 accelerator：项保留、字段剥掉（Electron 收到非法串会在 buildFromTemplate 抛错崩主进程）
    expect(r![3]!.accelerator).toBeUndefined()
    expect(r![4]!.accelerator).toBeUndefined()
    expect(r![5]!.accelerator).toBeUndefined()
    expect(r!.every((i) => i.label !== '')).toBe(true)
  })
})
