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

  it('SV-1（第七轮）：submenu 深度上限——数万层嵌套不栈溢出，超 5 层剥 submenu', () => {
    // 被攻陷渲染进程可经结构化克隆构造任意深度（不受 JSON.parse 限制）——
    // 无上限递归净化自身先 RangeError 崩主进程
    let deep: unknown = { label: '底层' }
    for (let i = 0; i < 50_000; i++) deep = { label: `层${i}`, submenu: [deep] }
    let r: ReturnType<typeof parseContextMenuSpecs>
    expect(() => { r = parseContextMenuSpecs([deep]) }).not.toThrow()
    let edges = 0
    let cur = r![0]!
    while (cur.submenu && cur.submenu.length > 0) {
      edges++
      cur = cur.submenu[0]!
    }
    expect(edges).toBe(5) // 恰好 5 层 submenu 后截断，深层被剥（菜单项保留）
    expect(cur.label).toBe('层49994') // 最外层 层49999，下钻 5 层
  })
})

describe('L-S3（第八轮）：菜单平面项数上限', () => {
  it('201 项 → null（不弹菜单）；200 项 → 正常净化', () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ label: `项${i}` }))
    expect(parseContextMenuSpecs(many)).toBeNull()
    const ok = parseContextMenuSpecs(many.slice(0, 200))
    expect(ok).toHaveLength(200)
  })
})

describe('R27-95（二十七轮）：跨层扁平项预算', () => {
  it('嵌套载荷总量钳在 200：每层各 200 项 × 5 层深不再是指数积', () => {
    // 修复前：每层独立 200 上限，恶意 5 层嵌套每层合规、总量 200^5 无界
    const leaf = Array.from({ length: 200 }, (_, i) => ({ label: `底${i}` }))
    let node: unknown = leaf
    for (let d = 0; d < 4; d++) {
      node = Array.from({ length: 200 }, (_, i) => ({ label: `层${d}-${i}`, submenu: node }))
    }
    const top = parseContextMenuSpecs(node)
    expect(top).not.toBeNull()
    // 顶层 200 项全收后预算耗尽：深层 submenu 被 SV-1 口径剥掉（保留顶层项，总数 ≤200）
    expect(top).toHaveLength(200)
    const flat = (spec: { submenu?: unknown[] }): number => {
      let n = 0
      for (const s of spec.submenu ?? []) n += 1 + flat(s as { submenu?: unknown[] })
      return n
    }
    let total = 0
    for (const item of top!) total += 1 + flat(item as { submenu?: unknown[] })
    expect(total).toBeLessThanOrEqual(200)
  })
})
