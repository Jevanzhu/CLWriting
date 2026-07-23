import { defineStore } from 'pinia'
import { ref } from 'vue'
import { listBooks, type BookEntry } from '../api/shelf'

export const useShelfStore = defineStore('shelf', () => {
  const books = ref<BookEntry[]>([])
  const workDirMissing = ref(false)
  const hint = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const r = await listBooks()
      books.value = r.books
      workDirMissing.value = !r.workDir
      hint.value = r.hint ?? null
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  return { books, workDirMissing, hint, loading, error, load }
})
