import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getTree } from '../api/books'
import type { TreeNode } from '../types/tree'

// 章节树 store：原始磁盘 nodes + groupTree 虚拟分组（写作/大纲/设定/文风）+ byPath 索引。
// groupTree 规则照旧 web FileTree.groupTree（平价基准）。
export const useTreeStore = defineStore('tree', () => {
  const raw = ref<TreeNode[]>([])
  const revision = ref('')
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** 虚拟分组：写作（正文卷章+草稿）/ 大纲（+摘要）/ 设定（提升根级）/ 文风。 */
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

  async function load(name: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const r = await getTree(name)
      raw.value = r.nodes ?? []
      revision.value = r.revision ?? ''
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  return { raw, grouped, byPath, byDocId, revision, loading, error, load }
})

/** 虚拟分组 transform：真实磁盘节点 → 写作功能分组（移植旧 FileTree.groupTree）。
 *  写作（虚拟 path='写作'）：定稿/正文 真实卷/章 + 工作区草稿(status=draft)
 *  大纲：真实根目录 + 摘要并入；总纲置顶
 *  设定：定稿/设定 提升根级
 *  文风：真实根目录原样
 *  工作区（除草稿）不进树；根级散文件（book.yaml/AGENTS.md/.gitignore）自动过滤。 */
function groupTree(rawNodes: TreeNode[]): TreeNode[] {
  const find = (ns: TreeNode[], path: string): TreeNode | undefined => ns.find((n) => n.path === path)
  const child = (parent: TreeNode | undefined, path: string): TreeNode | undefined =>
    parent?.children.find((c) => c.path === path)

  const dingao = find(rawNodes, '定稿')
  const dagang = find(rawNodes, '大纲')
  const work = find(rawNodes, '工作区')
  const style = find(rawNodes, '文风')
  const zhengwen = child(dingao, '定稿/正文')
  const shezhi = child(dingao, '定稿/设定')
  const zhaiyao = child(dingao, '定稿/摘要')

  // 草稿：工作区下 status=draft 的叶子，抽到「写作」区
  const drafts = (work?.children ?? []).filter((c) => !c.isDirectory && c.status === 'draft')

  const groups: TreeNode[] = []
  // 1. 写作（虚拟）：正文真实子树 + 草稿
  const writeChildren = [...(zhengwen?.children ?? []), ...drafts]
  if (writeChildren.length) {
    groups.push({ path: '写作', name: '写作', isDirectory: true, role: 'note', children: writeChildren })
  }
  // 2. 大纲（总纲置顶 + 摘要次之）
  if (dagang) {
    const zonggang = dagang.children.find((c) => !c.isDirectory && c.name === '总纲')
    const rest = dagang.children.filter((c) => c !== zonggang)
    groups.push({ ...dagang, children: [zonggang, zhaiyao, ...rest].filter(Boolean) as TreeNode[] })
  }
  // 3. 设定（提升根级）
  if (shezhi) groups.push(shezhi)
  // 4. 文风
  if (style) groups.push(style)
  return groups
}
