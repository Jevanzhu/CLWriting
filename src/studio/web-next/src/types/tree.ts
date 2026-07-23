/** 语义树节点（GET /api/books/:name/tree）。对齐旧 web TreeNode + 细案 §3。*/
export interface TreeNode {
  path: string
  name: string
  isDirectory: boolean
  role: string
  children: TreeNode[]
  docId?: string
  status?: string
  volumeOutlinePath?: string
}
