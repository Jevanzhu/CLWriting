/**
 * LayoutPolicy 子集（W0-1 §9）—— 按文档路径判 role + 计算 capabilities。
 *
 * W1 只在保存链路用 write capability（CAPABILITY_DENIED 拒绝写只读文档）；
 * 全字段 capabilities 为 W2A 结构性操作铺路，W1 仅校验 write。
 *
 * 目录角色表见 W0-1 §9：
 * - 定稿/正文 → chapter；定稿/设定 → setting；定稿/摘要 → note（脚本产物，只读）
 * - 大纲/卷纲 → volume-outline；大纲/<七类账本> → ledger；大纲/ 其他 → outline
 * - 文风 → style；简介.md → introduction；工作区/草稿-N.md|细纲.md → draft
 * - 素材 → material；笔记 → note；废稿 → discard；未匹配 → note（自由文档，全开）
 * - 短篇：篇/<篇号>-<标题>/正文.md → piece-body；…/清单.md → piece-manifest
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

/** 按路径判 role（W0-1 §9）。relPath 是书仓库相对路径。 */
export function roleOf(relPath: string): DocumentRole {
  const p = norm(relPath)
  // 短篇篇包
  if (p.startsWith('篇/')) {
    if (p.endsWith('/正文.md')) return 'piece-body'
    if (p.endsWith('/清单.md')) return 'piece-manifest'
    return 'note'
  }
  // 长篇
  if (p.startsWith('定稿/正文/')) return 'chapter'
  if (p.startsWith('定稿/设定/')) return 'setting'
  if (p.startsWith('定稿/摘要/')) return 'note' // 脚本产物，只读呈现
  if (p.startsWith('大纲/卷纲/')) return 'volume-outline'
  if (p.startsWith('大纲/')) {
    const top = p.slice('大纲/'.length).split('/')[0] ?? ''
    if (LEDGER_DIRS.has(top)) return 'ledger'
    return 'outline'
  }
  if (p.startsWith('文风/')) return 'style'
  if (p === '简介.md') return 'introduction'
  if (p.startsWith('工作区/')) {
    const name = p.slice('工作区/'.length)
    if (name === '细纲.md' || /^草稿-\d+\.md$/.test(name)) return 'draft'
    return 'note'
  }
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
