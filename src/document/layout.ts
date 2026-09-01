/**
 * LayoutPolicy 子集（W0-1 §9）—— 按文档路径判 role + 计算 capabilities。
 *
 * W1 只在保存链路用 write capability（CAPABILITY_DENIED 拒绝写只读文档）；
 * 全字段 capabilities 为 W2A 结构性操作铺路，W1 仅校验 write。
 *
 * 目录角色表（v2 结构）：
 * - 写作/正文 → chapter（长短篇统一，不再按 kind 覆盖）
 * - 大纲/卷纲 → volume-outline；大纲/章纲 → chapter-outline；大纲/ 其他 → outline
 * - 布线/<线索> → ledger；设定/ → setting
 * - 文风 → style；简介.md → introduction；工作区/ → note（运行时资产，不进树）
 * - 素材 → material；笔记 → note；废稿 → discard；未匹配 → note（自由文档，全开）
 *
 * 系统文档（账本 ledger / 章纲 chapter-outline）trash=false（W0-1 §2）。
 * 工作区内部目录（.trash/.journal/.版本/待定稿/.confirm.json/.ai-calls.json）
 * 不进文档树（§9），由扫描层 skip，本模块不判 role。
 */
import { LEAD_TYPES } from '../format/leads.js'

/** 文档角色（W0-1 §2 DocumentRole）。
 *  P5-数据层（第七轮）注释澄清：roleOf 对 写作/正文/ 恒返 'chapter'，从不产出
 *  'piece-body'——短篇由消费方读 book.yaml(kind) 判定。该枚举位是历史 wire 兼容
 *  保留（前端仍有判定分支），勿在新代码依赖它。 */
export type DocumentRole =
  | 'chapter' | 'piece-body' | 'chapter-outline'
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

/** 账本六类目录名集合（大纲/<六类>/，#3 第 2 节；伏笔已独立为设定伏笔系统）。 */
const LEDGER_DIRS = new Set<string>(LEAD_TYPES)

/** P-1（第十四轮）：工作区内部簿记子路径前缀（头注「工作区内部目录」清单的机器可读版，
 *  另收 .snapshots 迁移前旧名）。这些是崩溃恢复账本 / 回收站清单 / 版本库 / 批量暂存 /
 *  spill 外置介质，只能由各自模块的专用写通道维护。
 *  R36-10（三十六轮）：补 工作区/导出/（导出产物目录，src/export/index.ts 落盘面）——
 *  文档 CRUD 此前可按路径直达写/删导出产物（产物可再生危害低，但属内部簿记——导出
 *  专用通道维护，拒绝外部 CRUD 直达）。 */
const WORKSPACE_INTERNAL_DIR_PREFIXES = [
  '工作区/.journal/', '工作区/.trash/', '工作区/.版本/', '工作区/.snapshots/',
  '工作区/.账本推进暂存/', '工作区/spills/', '工作区/待定稿/', '工作区/导出/',
]

/** P-1（第十四轮）：书根系统文件/目录——文档清单、book 元数据、确认位、AI 记账、
 *  git/clwriting 内部目录。tree.ts SKIP_DIRS 同族（能力层只挡顶层段命中）。 */
const BOOK_SYSTEM_TOP_DIRS = new Set(['.git', '.cache', '.clwriting', 'node_modules', '项目'])
const BOOK_SYSTEM_FILES = new Set(['.confirm.json', 'book.yaml'])

/** 内部簿记/系统路径判定（P-1）：文档 CRUD 通道对其拒绝全部结构性与写能力。
 *  工作区/ 下的作者确认位（细纲.md / 账本推进.md）不在清单内——编辑白名单走
 *  files.ts WORKDIR_EDITABLE，文档通道未登记路径维持既有 legacy 语义，均不受影响。 */
export function isInternalBookPath(relPath: string): boolean {
  const p = norm(relPath)
  if (WORKSPACE_INTERNAL_DIR_PREFIXES.some((pre) => p.startsWith(pre))) return true
  if (BOOK_SYSTEM_FILES.has(p)) return true
  return BOOK_SYSTEM_TOP_DIRS.has(p.split('/')[0] ?? '')
}

/** 规整路径：去前导 ./、反斜杠转正斜杠。 */
function norm(p: string): string {
  return p.replace(/^\.\//, '').replace(/\\/g, '/')
}

/** 按路径判 role（v2 目录结构）。relPath 是书仓库相对路径。
 *  正文统一：写作/正文/ → chapter（长短篇同构，不再按 kind 覆盖）。 */
export function roleOf(relPath: string): DocumentRole {
  const p = norm(relPath)
  // 正文（长篇章 / 短篇章，路径统一）
  if (p.startsWith('写作/正文/')) return 'chapter'
  // 章纲（规划性质，放大纲区）
  if (p.startsWith('大纲/章纲/')) return 'chapter-outline'
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
  // 工作区：运行时资产区（.trash/.journal/.版本，不进树）
  if (p.startsWith('工作区/')) return 'note'
  if (p.startsWith('素材/')) return 'material'
  if (p.startsWith('笔记/')) return 'note'
  if (p.startsWith('废稿/')) return 'discard'
  return 'note' // 未匹配 → 自由文档（全开）
}

/** 按 role + 路径上下文算 capabilities（W0-1 §2 + §9）。 */
export function capabilitiesOf(role: DocumentRole, relPath?: string): Capabilities {
  // P-1（第十四轮）：内部簿记/系统路径 fail-closed——save 预校验与本函数各能力消费点
  // （create/move/copy/trash）统一被拒，杜绝以 工作区/.journal/<docId>.jsonl 或
  // 项目/文档清单.jsonl 为 relPath 的 CRUD 请求覆写崩溃恢复账本/登记清单
  // （resolveSafePath 只挡越根不挡内部簿记；files API 编辑白名单不经此层）。
  if (relPath && isInternalBookPath(relPath)) {
    return { ...ALL_TRUE, write: false, rename: false, move: false, copy: false, trash: false }
  }
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
    case 'chapter-outline':
      // 章纲（系统文档）不可删
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
