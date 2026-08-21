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

/** 低级项（第六轮）：accelerator 白名单——Electron 对非法 accelerator 会在
 *  Menu.buildFromTemplate 直接抛错（主进程崩溃）。渲染层合法输入只有修饰键组合 +
 *  单键/F 键/具名键；白名单外的一律剥掉（菜单项保留，仅不显示快捷键——安全降级）。 */
const ACCELERATOR_RE =
  /^(?:(?:Command|Cmd|Super|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|AltGr|Shift)\+)*(?:[0-9A-Z]|F(?:[1-9]|1[0-9]|2[0-4])|Plus|Space|Tab|Capslock|Numlock|Scrolllock|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|VolumeUp|VolumeDown|VolumeMute|MediaNextTrack|MediaPreviousTrack|MediaStop|MediaPlayPause|PrintScreen)$/

/** SV-1（第七轮）：submenu 净化深度上限——被攻陷/异常渲染进程可经结构化克隆构造
 *  数万层嵌套数组（不受 JSON.parse 深度限制），无上限递归净化自身先栈溢出崩主进程，
 *  恰是本文件头宣称要防的威胁模型。超限剥 submenu（菜单项保留，对齐 accelerator
 *  白名单的安全降级思路）。 */
const MAX_SUBMENU_DEPTH = 5

/** 净化载荷：合法返回净化后的菜单项数组（可为空数组，调用方空数组不弹菜单）；非数组返回 null。 */
export function parseContextMenuSpecs(raw: unknown, depth = 0): ContextMenuSpec[] | null {
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
    if (typeof r['accelerator'] === 'string' && ACCELERATOR_RE.test(r['accelerator'])) item.accelerator = r['accelerator']
    if (Array.isArray(r['submenu']) && depth < MAX_SUBMENU_DEPTH) {
      const sub = parseContextMenuSpecs(r['submenu'], depth + 1)
      if (sub && sub.length > 0) item.submenu = sub
    }
    items.push(item)
  }
  return items
}
