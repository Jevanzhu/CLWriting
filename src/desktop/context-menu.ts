/**
 * RB-SV-P2-5：desktop:context-menu IPC 载荷净化。
 *
 * 渲染层传入任意形状（被攻陷/异常的渲染进程可发非数组或 null 元素），主进程直接
 * specs.map 会抛 TypeError 崩 app。此处做形状校验：非数组 → null（整体忽略不弹
 * 菜单）；元素非对象 / 无 label 且非分隔项 → 跳过该元素。
 */
export interface ContextMenuSpec {
  label: string
  key?: string
  accelerator?: string
  disabled?: boolean
  separator?: boolean
  submenu?: ContextMenuSpec[]
}

/** 净化载荷：合法返回净化后的菜单项数组（可为空数组，调用方空数组不弹菜单）；非数组返回 null。 */
export function parseContextMenuSpecs(raw: unknown): ContextMenuSpec[] | null {
  if (!Array.isArray(raw)) return null
  const items: ContextMenuSpec[] = []
  for (const s of raw) {
    if (typeof s !== 'object' || s === null) continue
    const r = s as Record<string, unknown>
    if (r['separator'] === true) {
      items.push({ label: '', separator: true })
      continue
    }
    // 非分隔项必须有 label（Menu.buildFromTemplate 的必填字段）
    if (typeof r['label'] !== 'string' || r['label'] === '') continue
    const item: ContextMenuSpec = { label: r['label'], disabled: r['disabled'] === true }
    if (typeof r['key'] === 'string' && r['key']) item.key = r['key']
    if (typeof r['accelerator'] === 'string' && r['accelerator']) item.accelerator = r['accelerator']
    if (Array.isArray(r['submenu'])) {
      const sub = parseContextMenuSpecs(r['submenu'])
      if (sub && sub.length > 0) item.submenu = sub
    }
    items.push(item)
  }
  return items
}
