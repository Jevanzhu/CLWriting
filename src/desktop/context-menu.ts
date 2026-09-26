/**
 * desktop:context-menu IPC 载荷净化。
 *
 * 渲染层传入任意形状（被攻陷/异常的渲染进程可发非数组或 null 元素），主进程直接
 * specs.map 会抛 TypeError 崩 app。此处做形状校验：非数组 → null（整体忽略不弹
 * 菜单）；元素非对象 / 无 label 且非分隔项 → 跳过该元素。
 */
import { log } from '../log/index.js'

export interface ContextMenuSpec {
  label: string
  key?: string
  accelerator?: string
  disabled?: boolean
  separator?: boolean
  submenu?: ContextMenuSpec[]
}

/** 低级项：accelerator 白名单——Electron 对非法 accelerator 会在
 *  Menu.buildFromTemplate 直接抛错（主进程崩溃）。渲染层合法输入只有修饰键组合 +
 *  单键/F 键/具名键；白名单外的一律剥掉（菜单项保留，仅不显示快捷键——安全降级）。 */
const ACCELERATOR_RE =
  /^(?:(?:Command|Cmd|Super|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|AltGr|Shift)\+)*(?:[0-9A-Z]|F(?:[1-9]|1[0-9]|2[0-4])|Plus|Space|Tab|Capslock|Numlock|Scrolllock|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|VolumeUp|VolumeDown|VolumeMute|MediaNextTrack|MediaPreviousTrack|MediaStop|MediaPlayPause|PrintScreen)$/

/** SV-1submenu 净化深度上限——被攻陷/异常渲染进程可经结构化克隆构造
 *  数万层嵌套数组（不受 JSON.parse 深度限制），无上限递归净化自身先栈溢出崩主进程，
 *  恰是本文件头宣称要防的威胁模型。超限剥 submenu（菜单项保留，对齐 accelerator
 *  白名单的安全降级思路）。 */
const MAX_SUBMENU_DEPTH = 5

/** L-平面项数上限——SV-1 修了深度未修宽度：被攻陷渲染进程可发数十万级
 *  平面菜单项，净化线性建对象 + Menu.buildFromTemplate 构建原生菜单，主进程 CPU/内存
 *  暴涨。超限整体拒收（null → 不弹菜单），对齐深度方向的 fail-closed 思路 */
const MAX_MENU_ITEMS = 200

/**
 * 0918二轮修复批（C103）：单条字节上限——载荷限项数不限字节时，超长 label/key 直达
 * Menu.buildFromTemplate 的原生构建（长串逐条拷进原生菜单结构），200 条 × 每条超长串
 * 照样阻塞主进程。超限剥除该项（非拒收整个载荷——其余正常项照弹，保可用性）+ warn
 * 留痕；accelerator 已由白名单正则天然限长，不在本限面。
 */
const MAX_ITEM_BYTES = 200

/**
 * 0918二轮修复批（C103）：总载荷字节上限——单条 200B × 200 条 = 40KB 仍可无谓占原生
 * 构建面；累计超限整体拒收（null → 不弹菜单，对齐 L- 顶层超限 fail-closed 口径）。
 * 与项数预算同对象跨层共享。
 */
const MAX_TOTAL_BYTES = 20_000

/**
 * 净化载荷：合法返回净化后的菜单项数组（可为空数组，调用方空数组不弹菜单）；非数组返回 null。
 *
 * 预算跨层共享——原 MAX_MENU_ITEMS 按层独立生效，200 项/层 ×
 * MAX_SUBMENU_DEPTH=5 层是指数积（200^5），恶意嵌套载荷每层都合规、总量却无界，
 * 净化+建原生菜单照样阻塞主进程。改为所有层共用一个扁平项预算：每层先 O(1) 长度
 * 预筛（raw.length > 剩余额度直接拒），逐项扣减；顶层超限整体 null（L- 口径），
 * 深层超限剥该 submenu（SV-1 口径），总净化工作量被钳在 200 项以内。
 */
export function parseContextMenuSpecs(
  raw: unknown,
  depth = 0,
  budget: { left: number; bytes: number } = { left: MAX_MENU_ITEMS, bytes: MAX_TOTAL_BYTES },
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
    // 0918二轮修复批（C103）：单条字节上限——label/key 超限剥除该项（其余正常项照弹，
    // 保可用性）+ warn 留痕；对齐 accelerator 白名单「安全降级」但粒度为整项（label 是
    // 菜单项主体，截断会产生语义错位的假条目）
    if (Buffer.byteLength(r['label'], 'utf8') > MAX_ITEM_BYTES) {
      log.warn('desktop', `context-menu 载荷 label 超过单条字节上限（${MAX_ITEM_BYTES} 字节），已剥除该项`)
      continue
    }
    const rawKey = typeof r['key'] === 'string' && r['key'] ? r['key'] : null
    if (rawKey !== null && Buffer.byteLength(rawKey, 'utf8') > MAX_ITEM_BYTES) {
      log.warn('desktop', `context-menu 载荷 key 超过单条字节上限（${MAX_ITEM_BYTES} 字节），已剥除该项`)
      continue
    }
    const item: ContextMenuSpec = { label: r['label'], disabled: r['disabled'] === true }
    if (rawKey !== null) item.key = rawKey
    if (typeof r['accelerator'] === 'string' && ACCELERATOR_RE.test(r['accelerator'])) item.accelerator = r['accelerator']
    // 先扣本项额度再下钻——递归进门时才能看到已扣的真实余量（后扣会让每层嵌套
    // 都按满预算准入、层层各自吃满 200，总量闸失效）
    budget.left--
    // 0918二轮修复批（C103）：总载荷字节预算（label+key 计入，跨层共享同款先扣后下钻）
    budget.bytes -= Buffer.byteLength(r['label'], 'utf8') + (rawKey !== null ? Buffer.byteLength(rawKey, 'utf8') : 0)
    if (Array.isArray(r['submenu']) && depth < MAX_SUBMENU_DEPTH) {
      const sub = parseContextMenuSpecs(r['submenu'], depth + 1, budget)
      if (sub && sub.length > 0) item.submenu = sub
    }
    items.push(item)
  }
  // 0918二轮修复批（C103）：总载荷字节上限在顶层判定（超限整体拒收 null，对齐 L-
  // fail-closed）——深层不即时中断：净化工作量已被项数预算钳在 ≤200 项，超限后的
  // 继续净化成本有界；若在深层即时 return null 会被调用方按 SV-1 口径当「剥 submenu」
  // 吞掉整体拒收语义。
  if (depth === 0 && budget.bytes < 0) return null
  return items
}
