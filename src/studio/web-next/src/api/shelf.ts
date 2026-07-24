import { apiJson } from './client'

export interface BookEntry {
  name: string
  title?: string
  kind?: string
}

// GET /api/books → {books[], workDir, hint?}（workDir=false 时书架显示「打开书库」引导）
export async function listBooks(): Promise<{
  books: BookEntry[]
  workDir: boolean
  hint?: string
}> {
  return apiJson('/api/books')
}
