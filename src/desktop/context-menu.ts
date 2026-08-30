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

/** L-S3（第八轮）：平面项数上限——SV-1 修了深度未修宽度：被攻陷渲染进程可发数十万级
 *  平面菜单项，净化线性建对象 + Menu.buildFromTemplate 构建原生菜单，主进程 CPU/内存
 *  暴涨。超限整体拒收（null → 不弹菜单），对齐深度方向的 fail-closed 思路 */
const MAX_MENU_ITEMS = 200

/**
 * 净化载荷：合法返回净化后的菜单项数组（可为空数组，调用方空数组不弹菜单）；非数组返回 null。
 *
 * R27-95（二十七轮）：预算跨层共享——原 MAX_MENU_ITEMS 按层独立生效，200 项/层 ×
 * MAX_SUBMENU_DEPTH=5 层是指数积（200^5），恶意嵌套载荷每层都合规、总量却无界，
 * 净化+建原生菜单照样阻塞主进程。改为所有层共用一个扁平项预算：每层先 O(1) 长度
 * 预筛（raw.length > 剩余额度直接拒），逐项扣减；顶层超限整体 null（L-S3 口径），
 * 深层超限剥该 submenu（SV-1 口径），总净化工作量被钳在 200 项以内。
 */
export function parseContextMenuSpecs(
  raw: unknown,
  depth = 0,
  budget: { left: number } = { left: MAX_MENU_ITEMS },
): ContextMenuSpec[] | null {
  if (!Array.isArray(raw)) return null
  if (raw.length > budget.left) return null
  const items: ContextMenuSpec[] = []
  for (const s of raw) {
    if (typeof s !== 'object' || s === null) continue
    const r = s as Record<string, unknown>
    if (r['separator'] === true) {
      items.push({ label: '', separator: true })
      budget.left--
      continue
    }
    // 非分隔项必须有 label（Menu.buildFromTemplate 的必填字段）
    if (typeof r['label'] !== 'string' || r['label'] === '') continue
    const item: ContextMenuSpec = { label: r['label'], disabled: r['disabled'] === true }
    if (typeof r['key'] === 'string' && r['key']) item.key = r['key']
    if (typeof r['accelerator'] === 'string' && ACCELERATOR_RE.test(r['accelerator'])) item.accelerator = r['accelerator']
    // 先扣本项额度再下钻——递归进门时才能看到已扣的真实余量（后扣会让每层嵌套
    // 都按满预算准入、层层各自吃满 200，总量闸失效）
    budget.left--
    if (Array.isArray(r['submenu']) && depth < MAX_SUBMENU_DEPTH) {
      const sub = parseContextMenuSpecs(r['submenu'], depth + 1, budget)
      if (sub && sub.length > 0) item.submenu = sub
    }
    items.push(item)
  }
  return items
}
