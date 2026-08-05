import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getTree } from '../api/books'
import { getTreeIssues, type TreeIssue } from '../api/tree-issues'
import type { TreeNode } from '../types/tree'
import { friendlyError } from '../shared/error'

// 章节树 store：原始磁盘 nodes + groupTree 虚拟分组（写作/大纲/设定/文风）+ byPath 索引。
// groupTree 规则照旧 web FileTree.groupTree（平价基准）。
export const useTreeStore = defineStore('tree', () => {
  const raw = ref<TreeNode[]>([])
  const revision = ref('')
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** 虚拟分组：写作（正文卷章+短篇篇+草稿）/ 大纲 / 设定（提升根级）/ 文风。 */
  const grouped = computed(() => groupTree(raw.value))

  /** path → node 索引（在 grouped 上建，含虚拟组）。 */
  const byPath = computed(() => {
    const m = new Map<string, TreeNode>()
    const walk = (ns: TreeNode[]) => {
      for (const n of ns) {
        m.set(n.path, n)
        if (n.children.length) walk(n.children)
      }
    }
    walk(grouped.value)
    return m
  })

  /** docId → node 索引（tab 标题/持久化恢复校验用）。 */
  const byDocId = computed(() => {
    const m = new Map<string, TreeNode>()
    const walk = (ns: TreeNode[]) => {
      for (const n of ns) {
        if (n.docId) m.set(n.docId, n)
        if (n.children.length) walk(n.children)
      }
    }
    walk(grouped.value)
    return m
  })

  /** 字数聚合：遍历 raw 叶子，按 role 过滤求和 wordCount。 */
  function sumWords(nodes: TreeNode[], roles: Set<string>): number {
    let sum = 0
    const walk = (ns: TreeNode[]) => {
      for (const n of ns) {
        if (!n.isDirectory && roles.has(n.role)) sum += n.wordCount ?? 0
        if (n.children.length) walk(n.children)
      }
    }
    walk(nodes)
    return sum
  }

  const WORD_ALL = new Set(['chapter', 'piece-body', 'draft'])
  const WORD_FINAL = new Set(['chapter', 'piece-body'])

  /** 全书已写字数（chapter+piece-body+draft，含草稿）。 */
  const totalWords = computed(() => sumWords(raw.value, WORD_ALL))
  /** 全书已定稿字数（chapter+piece-body，不含草稿）。 */
  const finalizedWords = computed(() => sumWords(raw.value, WORD_FINAL))

  /** save 后局部更新某叶子字数（避免重拉整树）。 */
  function updateWordCount(path: string, count: number): void {
    const walk = (ns: TreeNode[]): boolean => {
      for (const n of ns) {
        if (n.path === path) {
          n.wordCount = count
          return true
        }
        if (n.children.length && walk(n.children)) return true
      }
      return false
    }
    walk(raw.value)
  }

  // T9b 树红点：docId → { hasRed, verdictRejected }（仅含有 issue 的 docId）。
  // 触发刷新：load 后拉一次；CheckPanel 跑完机检 / ReviewPanel verdict 后各拉一次。
  const issues = ref<Record<string, TreeIssue>>({})
  /** rebuild 失败等降级提示（非阻塞，仅展示用）；null = 正常。 */
  const issuesWarning = ref<string | null>(null)

  /**
   * 冒泡后的「有 issue」path 集合（叶子自身命中 + 目录子树命中均纳入）。
   * 后序 DFS：任一子树命中 → 父 path 入集合，供 ChapterTreeItem 行尾红点渲染。
   * 定稿态（final/published）已被后端 tree-issues 跳过，前端无需再过滤。
   */
  const issuePaths = computed<Set<string>>(() => {
    const map = issues.value
    const set = new Set<string>()
    const walk = (ns: TreeNode[]): boolean => {
      let sub = false
      for (const n of ns) {
        const selfHas = !n.isDirectory && !!n.docId && !!map[n.docId]
        const childHas = n.children.length ? walk(n.children) : false
        if (selfHas || childHas) {
          set.add(n.path)
          sub = true
        }
      }
      return sub
    }
    walk(grouped.value)
    return set
  })

  /** 拉取树红点聚合（best-effort：失败静默，不阻塞树渲染）。 */
  async function loadIssues(name: string): Promise<void> {
    try {
      const r = await getTreeIssues(name)
      issues.value = r.issues ?? {}
      issuesWarning.value = r.warning ?? null
    } catch {
      /* 网络抖动等：保留旧值，不惊扰作者 */
    }
  }

  /** 拉树。refresh=true 让服务端重扫盘（切书 / 手动刷新 / 窗口回前台）；
   *  结构性操作后不必传——后端 mutation 已 invalidate 缓存。 */
  async function load(name: string, refresh = false): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const r = await getTree(name, refresh)
      raw.value = r.nodes ?? []
      revision.value = r.revision ?? ''
      // T9b：树就绪后 fire-and-forget 拉红点（聚合接口较重，不阻塞树渲染）
      void loadIssues(name)
    } catch (e) {
      error.value = friendlyError(e)
    } finally {
      loading.value = false
    }
  }

  return {
    raw,
    grouped,
    byPath,
    byDocId,
    totalWords,
    finalizedWords,
    updateWordCount,
    revision,
    loading,
    error,
    load,
    issues,
    issuesWarning,
    issuePaths,
    loadIssues,
  }
})

/** 虚拟分组 transform：真实磁盘节点 → 写作功能分组（移植旧 FileTree.groupTree）。
 *  写作（虚拟 path='写作'）：定稿/正文 真实卷/章 + 短篇 篇/ + 工作区草稿(status=draft)
 *  大纲：真实根目录（总纲/卷纲/章纲）；总纲置顶
 *  设定：定稿/设定 提升根级
 *  文风撤出树（机检/收割幕后资产，见 SettingsModal「文风铁律」）；不在写作树暴露。
 *  工作区（除草稿）不进树；根级散文件（book.yaml/AGENTS.md/.gitignore）自动过滤。 */
function groupTree(rawNodes: TreeNode[]): TreeNode[] {
  const find = (ns: TreeNode[], path: string): TreeNode | undefined => ns.find((n) => n.path === path)
  const child = (parent: TreeNode | undefined, path: string): TreeNode | undefined =>
    parent?.children.find((c) => c.path === path)

  const dingao = find(rawNodes, '定稿')
  const dagang = find(rawNodes, '大纲')
  const work = find(rawNodes, '工作区')
  const pian = find(rawNodes, '篇') // 短篇集正文目录
  const zhengwen = child(dingao, '定稿/正文')
  const shezhi = child(dingao, '定稿/设定')

  // 草稿：工作区下 status=draft 的叶子，抽到「写作」区
  const drafts = (work?.children ?? []).filter((c) => !c.isDirectory && c.status === 'draft')

  const groups: TreeNode[] = []
  // 1. 写作（虚拟）：长篇正文卷章 + 短篇篇 + 草稿
  const writeChildren = [...(zhengwen?.children ?? []), ...(pian?.children ?? []), ...drafts]
  if (writeChildren.length) {
    groups.push({ path: '写作', name: '写作', isDirectory: true, role: 'note', children: writeChildren })
  }
  // 线索类（基础悬念/感情线 + 扩展布局线/设定线/成长线）拆出为独立「布线」根级大类；
  // 关系线为派生数据（角色卡关系派生），不进编辑树。
  const LEAD_NAMES = new Set(['悬念', '感情线', '布局线', '设定线', '成长线'])
  const LEAD_ORDER = ['悬念', '感情线', '布局线', '设定线', '成长线']
  // 2. 大纲：纲领类（总纲/卷纲/章纲）；线索类已拆到「布线」组
  if (dagang) {
    const kept = dagang.children.filter((c) => c.name !== '关系线' && !LEAD_NAMES.has(c.name))
    const outlineRank = (name: string): number => {
      const i = ['总纲', '卷纲', '章纲'].indexOf(name)
      return i === -1 ? 4 : i
    }
    kept.sort((a, b) => outlineRank(a.name) - outlineRank(b.name))
    if (kept.length) groups.push({ ...dagang, children: kept })
  }
  // 3. 布线（虚拟根级大类）：线索类从大纲目录提取，单独成组（与写作/大纲/设定同级）
  const leads = (dagang?.children ?? []).filter((c) => LEAD_NAMES.has(c.name))
  if (leads.length) {
    leads.sort((a, b) => LEAD_ORDER.indexOf(a.name) - LEAD_ORDER.indexOf(b.name))
    groups.push({ path: '布线', name: '布线', isDirectory: true, role: 'note', children: leads })
  }
  // 4. 设定（提升根级）：名册.md 仅作机检「新专名候选」比对源（check/count.ts 直读路径），
  //  作者无编辑面、与角色/ 目录分工重叠，撤出写作树（对标文风：幕后资产不暴露给作者）。
  if (shezhi) {
    const filtered = shezhi.children.filter((c) => c.path !== '定稿/设定/名册.md')
    groups.push({ ...shezhi, children: filtered })
  }
  // 文风撤出写作树（机检/收割幕后资产，编辑入口在 SettingsModal「文风铁律」）。
  return groups
}
