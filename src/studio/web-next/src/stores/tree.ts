import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getTree } from '../api/books'
import { getTreeIssues, type TreeIssue } from '../api/tree-issues'
import { useDocStore } from './doc'
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

  /** 全书已写字数（chapter+piece-body）。 */
  const totalWords = computed(() => sumWords(raw.value, WORD_ALL))

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
  let issuesGen = 0
  async function loadIssues(name: string): Promise<void> {
    const gen = ++issuesGen
    try {
      const r = await getTreeIssues(name)
      if (gen !== issuesGen) return // 旧书慢响应后到：防覆盖新书红点
      issues.value = r.issues ?? {}
      issuesWarning.value = r.warning ?? null
    } catch {
      /* 网络抖动等：保留旧值，不惊扰作者 */
    }
  }

  /** R35-10：raw 当前属主书名（load 成功时置，clear 清）——新书 load 失败时 raw 滞留
   *  旧书树，words.ensureBaseline 等聚合消费方据此确认字数口径归属，不误用旧树总值。 */
  const ownerBook = ref('')

  /** 拉树。refresh=true 让服务端重扫盘（切书 / 手动刷新 / 窗口回前台）；
   *  结构性操作后不必传——后端 mutation 已 invalidate 缓存。 */
  let loadGen = 0
  // R46-35（四十六轮）：同书在途 load 台账（手法对齐 doc.ts inflightOpens）——同书并发
  // 调用（切书链 + 结构性 mutation 后重载 + 窗口回前台重扫）合并为一次 GET /tree。
  // 值带 refresh 标志做合并判定：在途是重扫（refresh=1）时任何后来者都可搭车（重扫响应
  // 至少与缓存一样新）；在途是缓存读（refresh=0）而本次要求重扫时不合并——缓存响应满足
  // 不了重扫语义，照旧发新请求，loadGen 后发者胜把旧响应丢弃（refresh=1 优先，与既有
  // 并发竞态口径一致）。
  const inflightLoads = new Map<string, { p: Promise<void>; refresh: boolean }>()
  function load(name: string, refresh = false): Promise<void> {
    const running = inflightLoads.get(name)
    if (running && (running.refresh || !refresh)) return running.p
    const p = doLoad(name, refresh).finally(() => {
      // identity 删键：clear 清台账 / refresh=1 顶位后，旧 settled 不得误删新登记条目
      if (inflightLoads.get(name)?.p === p) inflightLoads.delete(name)
    })
    inflightLoads.set(name, { p, refresh })
    return p
  }
  async function doLoad(name: string, refresh: boolean): Promise<void> {
    const gen = ++loadGen
    loading.value = true
    error.value = null
    try {
      const r = await getTree(name, refresh)
      if (gen !== loadGen) return // 连切/并发刷新：慢响应后到，防旧树覆盖新树
      raw.value = r.nodes ?? []
      revision.value = r.revision ?? ''
      ownerBook.value = name // R35-10：raw 与属主同窗更新（失败路径不清，见 load catch）
      // E-4（二十九轮）：树刷新成功即对账 doc 缓存新鲜度——树版本推进（重扫盘/结构性
      // mutation 重建）后，打开时记录旧版本的 clean 缓存项可能已过期（外部改动），
      // 静默重拉对齐（fire-and-forget，不阻塞树渲染）
      void useDocStore().syncCleanWithTree(name, r.revision ?? '')
      // T9b：树就绪后 fire-and-forget 拉红点（聚合接口较重，不阻塞树渲染）
      void loadIssues(name)
    } catch (e) {
      if (gen !== loadGen) return
      error.value = friendlyError(e)
    } finally {
      if (gen === loadGen) loading.value = false
    }
  }

  /** E-7（二十九轮）：清树展示态（脏路由 name='' 时由 ChapterTreePanel 调）——
   *  前书 raw/红点/错误提示不滞留展示；loadGen/issuesGen 推代，在途旧书 load/红点
   *  响应落定不回填（同库 opGen 纪律）。 */
  function clear(): void {
    loadGen++
    issuesGen++
    // R46-35（四十六轮）：在途台账一并清——clear 已推代，在途共享 promise 落定时被 gen 守卫
    // 丢弃（不回填树）；不清则 clear 后同书首调会搭上这条「死」promise，树渲染永远空
    inflightLoads.clear()
    raw.value = []
    revision.value = ''
    loading.value = false
    error.value = null
    issues.value = {}
    issuesWarning.value = null
    ownerBook.value = '' // R35-10：树清空即无属主
  }

  return {
    raw,
    grouped,
    byPath,
    byDocId,
    totalWords,
    updateWordCount,
    revision,
    loading,
    error,
    ownerBook,
    load,
    clear,
    issues,
    issuesWarning,
    issuePaths,
    loadIssues,
  }
})

/**
 * 分组 transform：v2 后端已返回最终目录树，直接透传（过滤根级散文件 + 设定/名册.md）。
 * - 保留真实目录：写作 / 大纲 / 设定 / 布线（均为根级真实目录，groupTree 不再虚拟重组）
 * - 根级散文件（book.yaml/.gitignore/简介.md）过滤：非文档资产，不进写作树
 * - 设定/名册.md（机检「新专名候选」比对源，check/count.ts 直读路径，作者无编辑面）
 *   撤出写作树（对标文风：幕后资产不暴露给作者）——后端未过滤，此处继续过滤
 * - 工作区/文风/定稿 已由后端 SKIP_DIRS 排除，不进树
 */
/** 根级散文件（非文档资产，后端未过滤，前端剔除）。 */
const ROOT_TRASH = new Set(['book.yaml', '.gitignore', '简介.md'])
function groupTree(rawNodes: TreeNode[]): TreeNode[] {
  // 根级散文件（后端未过滤）：剔除 book.yaml/.gitignore/简介.md
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
