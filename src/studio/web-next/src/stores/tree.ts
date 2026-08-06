import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getTree } from '../api/books'
import { getTreeIssues, type TreeIssue } from '../api/tree-issues'
import type { TreeNode } from '../types/tree'
import { friendlyError } from '../shared/error'

// 章节树 store：原始磁盘 nodes + groupTree 分组（写作/大纲/设定/布线）+ byPath 索引。
// v2 后端 buildTree 已返回最终目录结构（写作/大纲/设定/布线 均为真实根目录），
// groupTree 仅直透（过滤根级散文件 + 设定/名册.md 幕后资产）。
export const useTreeStore = defineStore('tree', () => {
  const raw = ref<TreeNode[]>([])
  const revision = ref('')
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** 虚拟分组：写作（正文卷章+短篇篇）/ 大纲 / 设定（提升根级）/ 文风。 */
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

  const WORD_ALL = new Set(['chapter', 'piece-body'])
  const WORD_FINAL = new Set(['chapter', 'piece-body'])

  /** 全书已写字数（chapter+piece-body）。 */
  const totalWords = computed(() => sumWords(raw.value, WORD_ALL))
  /** 全书已定稿字数（chapter+piece-body）。 */
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

/**
 * 分组 transform：v2 后端已返回最终目录树，直接透传（过滤根级散文件 + 设定/名册.md）。
 * - 保留真实目录：写作 / 大纲 / 设定 / 布线（均为根级真实目录，groupTree 不再虚拟重组）
 * - 根级散文件（book.yaml/AGENTS.md/.gitignore/简介.md）过滤：非文档资产，不进写作树
 * - 设定/名册.md（机检「新专名候选」比对源，check/count.ts 直读路径，作者无编辑面）
 *   撤出写作树（对标文风：幕后资产不暴露给作者）——后端未过滤，此处继续过滤
 * - 工作区/文风/定稿 已由后端 SKIP_DIRS 排除，不进树
 */
/** 根级散文件（非文档资产，后端未过滤，前端剔除）。 */
const ROOT_TRASH = new Set(['book.yaml', 'AGENTS.md', '.gitignore', '简介.md'])
function groupTree(rawNodes: TreeNode[]): TreeNode[] {
  // 根级散文件（后端未过滤）：剔除 book.yaml/AGENTS.md/.gitignore/简介.md
  const nodes = rawNodes.filter((n) => n.isDirectory || !ROOT_TRASH.has(n.path))
  const stripLedger = (ns: TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = []
    for (const n of ns) {
      if (!n.isDirectory && n.path === '设定/名册.md') continue
      if (n.children.length) out.push({ ...n, children: stripLedger(n.children) })
      else out.push(n)
    }
    return out
  }
  return stripLedger(nodes)
}
