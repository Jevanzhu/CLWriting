/**
 * 章节树右键菜单构建（Z-P2-10 自 ChapterTreePanel 拆出）。
 *
 * 五类菜单（正文区/大纲区/设定区/卷目录/文件）按节点 path 判定；菜单项构建为
 * 纯函数（传入树数据访问器），桌面版「打开所在文件夹」按能力探测附加。
 * 菜单弹出/原生分派仍走 useNativeMenu（本 composable 只负责「给什么项」）。
 */
import { computed } from 'vue'
import type { MenuItem } from '../components/ui/ContextMenu.vue'
import type { TreeNode } from '../types/tree'
import { isVolumeDir, moveToTargetsFor, pendingChaptersUpToIn } from '../shared/chapter-tree'

/** 正文区新建选项（卷/章节）—— label 带「新建」自解释，直接摊开不分层 */
const NEW_BODY: MenuItem[] = [
  { key: 'new-volume', label: '新建卷' },
  { key: 'new-chapter-root', label: '新建章节' },
]
/** 大纲区新建选项（章纲/卷纲/总纲） */
const NEW_OUTLINE: MenuItem[] = [
  { key: 'new-chapter-outline', label: '新建章纲' },
  { key: 'new-volume-outline', label: '新建卷纲' },
  { key: 'new-synopsis', label: '新建总纲' },
]
/** 设定区新建选项（角色/物品/世界观/伏笔） */
const NEW_SETTINGS: MenuItem[] = [
  { key: 'new-character', label: '新建角色' },
  { key: 'new-item', label: '新建物品' },
  { key: 'new-worldview', label: '新建世界观' },
  { key: 'new-foreshadow', label: '新建伏笔' },
]
/** 空白处全量新建选项（正文/大纲/设定三组用分隔线隔开，不搞子菜单嵌套） */
const NEW_BLANK: MenuItem[] = [
  ...NEW_BODY,
  { key: 'sep-1', label: '', separator: true },
  ...NEW_OUTLINE,
  { key: 'sep-2', label: '', separator: true },
  ...NEW_SETTINGS,
]

export function useTreeMenu(treeData: () => { grouped: TreeNode[]; raw: TreeNode[] }) {
  /** 桌面版才有「打开所在文件夹」（Electron shell.showItemInFolder 跨平台；浏览器版隐藏） */
  const hasShowInFolder = computed(
    () => typeof window !== 'undefined' && !!window.clwritingDesktop?.showInFolder,
  )

  /** 目录右键菜单：新建项在前，文件操作（打开所在文件夹）分隔线隔开在后（桌面版）。 */
  function dirMenu(items: MenuItem[]): MenuItem[] {
    if (!hasShowInFolder.value) return items
    return [...items, { key: 'sep-reveal', label: '', separator: true }, { key: 'reveal-in-folder', label: '打开所在文件夹' }]
  }

  function buildMenuItems(node: TreeNode): MenuItem[] {
    const p = node.path
    const { grouped, raw } = treeData()
    // 正文区/大纲区/设定区：新建项直接摊开在顶层（不包「新建 ▸」子菜单——选项少，多一级是噪音）
    if (node.isDirectory && isVolumeDir(p)) {
      return dirMenu([{ key: 'new-chapter', label: '新建章节' }])
    }
    if (p === '写作/正文' || p === '写作') {
      return dirMenu(NEW_BODY)
    }
    // 大纲根：章纲/卷纲/总纲（单例总纲只在根/空白处提供，不进具体子目录）
    if (node.isDirectory && p === '大纲') {
      return dirMenu(NEW_OUTLINE)
    }
    if (node.isDirectory && p === '大纲/章纲') {
      return dirMenu([{ key: 'new-chapter-outline', label: '新建章纲' }])
    }
    if (node.isDirectory && p === '大纲/卷纲') {
      return dirMenu([{ key: 'new-volume-outline', label: '新建卷纲' }])
    }
    // 设定根：角色/物品/世界观/伏笔（单例世界观只在根/空白处提供）
    if (node.isDirectory && p === '设定') {
      return dirMenu(NEW_SETTINGS)
    }
    if (node.isDirectory && p === '设定/角色') {
      return dirMenu([{ key: 'new-character', label: '新建角色' }])
    }
    if (node.isDirectory && p === '设定/物品') {
      return dirMenu([{ key: 'new-item', label: '新建物品' }])
    }
    if (node.isDirectory && p === '设定/伏笔') {
      return dirMenu([{ key: 'new-foreshadow', label: '新建伏笔' }])
    }
    if (node.isDirectory && (p.startsWith('大纲/') || p.startsWith('设定/'))) {
      return dirMenu([{ key: 'new-doc', label: '新建文档' }])
    }
    if (!node.isDirectory) return buildLeafMenu(node, grouped, raw)
    return []
  }

  function buildLeafMenu(node: TreeNode, grouped: TreeNode[], raw: TreeNode[]): MenuItem[] {
    const items: MenuItem[] = [{ key: 'rename', label: '重命名' }]
    if (node.role === 'piece-body') {
      // 短篇正文：标题/篇号编辑（联动文件名）；无跨卷移动（短篇集扁平；path 与长篇同为 写作/正文/）
      items.push({ key: 'meta', label: '篇章信息…' })
      // 定稿：正文区 draft（首次）/ revision（改动后）可定稿；final 已定稿不显
      if (node.status === 'draft' || node.status === 'revision') {
        items.push({ key: 'finalize', label: '定稿' })
      }
    } else if (node.path.startsWith('写作/正文/')) {
      items.push({ key: 'meta', label: '章节信息…' })
      // 定稿：正文区 draft（首次）/ revision（改动后）可定稿；final 已定稿不显
      if (node.status === 'draft' || node.status === 'revision') {
        items.push({ key: 'finalize', label: '定稿' })
        // 批量定稿到此章：仅当存在更早的待定稿章（自己 + 之前的所有 draft/revision）才有意义
        if (pendingChaptersUpToIn(node, raw).length > 1) {
          items.push({ key: 'batch-finalize', label: '批量定稿到此章' })
        }
      }
      const targets = moveToTargetsFor(node, grouped)
      if (targets.length) {
        items.push({
          key: 'move',
          label: '移动到…',
          submenu: targets.map((t) => ({ key: `move:${t.dir}`, label: t.label })),
        })
      }
      items.push({ key: 'copy', label: '创建副本' })
    }
    items.push({ key: 'sep-a', label: '', separator: true })
    // 桌面版在系统文件管理器中显示文件所在文件夹（浏览器版无此 API 隐藏）
    if (hasShowInFolder.value) {
      items.push({ key: 'reveal-in-folder', label: '打开所在文件夹' })
    }
    items.push({ key: 'copy-path', label: '复制路径' })
    items.push({ key: 'sep-b', label: '', separator: true })
    items.push({ key: 'delete', label: '删除', danger: true })
    return items
  }

  return { hasShowInFolder, buildMenuItems, blankItems: NEW_BLANK }
}
