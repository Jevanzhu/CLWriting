import { apiJson } from './client'

export interface BookEntry {
  name: string
  title?: string
  kind?: string
  /** 章数（长篇）/ 篇数（短篇），书架卡进度展示 */
  chapters?: number
  /** 定稿字数（长篇；短篇缺省 0） */
  words?: number
  /** 最近编辑 ISO（定稿文件最新 mtime） */
  lastEdited?: string | null
}

// GET /api/books → {books[], workDir, hint?}（workDir=false 时书架显示「打开书库」引导）
export async function listBooks(): Promise<{
  books: BookEntry[]
  workDir: boolean
  hint?: string
}> {
  return apiJson('/api/books')
}
