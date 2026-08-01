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
  /** 目标字数（book.yaml target_words，hero 卡进度条用） */
  targetWords?: number
  /** 最近章节/篇标题（hero 卡"继续写作"用） */
  latestChapter?: string
}

// GET /api/books → {books[], workDir, hint?}（workDir=false 时书架显示「打开书库」引导）
export async function listBooks(): Promise<{
  books: BookEntry[]
  workDir: boolean
  hint?: string
}> {
  return apiJson('/api/books')
}

// DELETE /api/books/:name → 物理删除（目录 + 登记 + active 指针）
export async function deleteBook(name: string): Promise<void> {
  await apiJson(`/api/books/${encodeURIComponent(name)}`, { method: 'DELETE' })
}
