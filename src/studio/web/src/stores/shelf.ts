/** 书架列表态（books/workDir/hint + 加载；对照 Bookshelf 页面数据来源） */
import { defineStore } from 'pinia'
import type { BookMeta } from '../types'
import { listBooks } from '../api/books'

interface ShelfState {
  books: BookMeta[]
  workDir: boolean
  hint: string
  loading: boolean
  error: string
}

export const useShelfStore = defineStore('shelf', {
  state: (): ShelfState => ({
    books: [],
    workDir: true,
    hint: '',
    loading: true,
    error: '',
  }),
  actions: {
    /** 拉书架列表（loading/error 自管） */
    async loadBooks() {
      this.loading = true
      this.error = ''
      try {
        const r = await listBooks()
        this.books = r.books ?? []
        this.workDir = r.workDir
        this.hint = r.hint ?? ''
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e)
      } finally {
        this.loading = false
      }
    },
  },
})
