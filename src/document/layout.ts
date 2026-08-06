/**
 * LayoutPolicy 子集（W0-1 §9）—— 按文档路径判 role + 计算 capabilities。
 *
 * W1 只在保存链路用 write capability（CAPABILITY_DENIED 拒绝写只读文档）；
 * 全字段 capabilities 为 W2A 结构性操作铺路，W1 仅校验 write。
 *
 * 目录角色表（v2 结构）：
 * - 写作/正文 → chapter（短篇书由 tree.ts 按 kind 覆盖为 piece-body）
 * - 大纲/卷纲 → volume-outline；大纲/清单 → piece-manifest；大纲/ 其他 → outline
 * - 布线/<线索> → ledger；设定/ → setting
 * - 文风 → style；简介.md → introduction；工作区/ → note（运行时资产，不进树）
 * - 素材 → material；笔记 → note；废稿 → discard；未匹配 → note（自由文档，全开）
 *
 * 系统文档（账本 ledger / 篇清单 piece-manifest）trash=false（W0-1 §2）。
 * 工作区内部目录（.trash/.journal/.snapshots/待定稿/.confirm.json/.ai-calls.json）
 * 不进文档树（§9），由扫描层 skip，本模块不判 role。
 */
import { LEAD_TYPES } from '../format/leads.js'

/** 文档角色（W0-1 §2 DocumentRole）。 */
export type DocumentRole =
  | 'chapter' | 'piece-body' | 'piece-manifest'
  | 'outline' | 'volume-outline'
  | 'setting' | 'ledger' | 'style' | 'introduction'
  | 'draft' | 'material' | 'note' | 'discard'

/** 文档能力（W0-1 §2 capabilities）。aiPropose 冻结期恒 false。 */
export interface Capabilities {
  read: boolean
  write: boolean
  rename: boolean
  move: boolean
  copy: boolean
  trash: boolean
  aiRead: boolean
  aiPropose: boolean
}

export interface LayoutInfo {
  role: DocumentRole
  capabilities: Capabilities
}

/** 全开能力（aiPropose 冻结期 false）。 */
const ALL_TRUE: Capabilities = {
  read: true,
  write: true,
  rename: true,
  move: true,
  copy: true,
  trash: true,
  aiRead: true,
  aiPropose: false, // AI 线冻结期恒 false（W0-1 §2）
}

/** 账本七类目录名集合（大纲/<七类>/，#3 第 2 节）。 */
const LEDGER_DIRS = new Set<string>(LEAD_TYPES)

/** 规整路径：去前导 ./、反斜杠转正斜杠。 */
function norm(p: string): string {
  return p.replace(/^\.\//, '').replace(/\\/g, '/')
}

/** 按路径判 role（v2 目录结构）。relPath 是书仓库相对路径。
 *  正文统一：写作/正文/ → chapter（短篇书的正文由 tree.ts 按书级 kind 覆盖为 piece-body）。 */
export function roleOf(relPath: string): DocumentRole {
  const p = norm(relPath)
  // 正文（长篇章 / 短篇章，路径统一；tree.ts 按 kind 覆盖 piece-body）
  if (p.startsWith('写作/正文/')) return 'chapter'
  // 短篇清单（规划性质，放大纲区）
  if (p.startsWith('大纲/清单/')) return 'piece-manifest'
  // 设定（从 定稿/设定 提升根级）
  if (p.startsWith('设定/')) return 'setting'
  // 布线（线索，从大纲拆出）
  if (p.startsWith('布线/')) return 'ledger'
  // 大纲
  if (p.startsWith('大纲/卷纲/')) return 'volume-outline'
  if (p.startsWith('大纲/')) {
    const top = p.slice('大纲/'.length).split('/')[0] ?? ''
    if (LEDGER_DIRS.has(top)) return 'ledger' // 关系线保留在大纲（派生数据）
    return 'outline'
  }
  // 摘要（脚本产物，保留原位）
  if (p.startsWith('定稿/摘要/')) return 'note'
  if (p.startsWith('文风/')) return 'style'
  if (p === '简介.md') return 'introduction'
  // 工作区：运行时资产区（.trash/.journal/.snapshots，不进树）
  if (p.startsWith('工作区/')) return 'note'
  if (p.startsWith('素材/')) return 'material'
  if (p.startsWith('笔记/')) return 'note'
  if (p.startsWith('废稿/')) return 'discard'
  return 'note' // 未匹配 → 自由文档（全开）
}

/** 按 role + 路径上下文算 capabilities（W0-1 §2 + §9）。 */
export function capabilitiesOf(role: DocumentRole, relPath?: string): Capabilities {
  switch (role) {
    case 'note':
      // 定稿/摘要（脚本产物）只读呈现；其他 note（笔记/自由区/未匹配）全开
      if (relPath && norm(relPath).startsWith('定稿/摘要/')) {
        return { ...ALL_TRUE, write: false, trash: false, rename: false, move: false }
      }
      return { ...ALL_TRUE }
    case 'ledger':
      // 账本：作者可写（推进剧情），但系统资产不可删（W0-1 §2 系统文档 trash=false）
      return { ...ALL_TRUE, trash: false }
    case 'piece-manifest':
      // 篇清单（系统文档）不可删
      return { ...ALL_TRUE, trash: false }
    default:
      return { ...ALL_TRUE }
  }
}

/** 路径 → { role, capabilities }（保存链路用 capabilities.write 校验）。 */
export function layoutOf(relPath: string): LayoutInfo {
  const role = roleOf(relPath)
  return { role, capabilities: capabilitiesOf(role, relPath) }
}
