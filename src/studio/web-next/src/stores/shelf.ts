import { defineStore } from 'pinia'
import { ref } from 'vue'
import { listBooks, type BookEntry } from '../api/shelf'
import { friendlyError } from '../shared/error'

export const useShelfStore = defineStore('shelf', () => {
  const books = ref<BookEntry[]>([])
  const workDirMissing = ref(false)
  const hint = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** 操作代（N-12，第五十四轮，与 check store 同款）：并发 load 慢响应迟到不回填旧数据 */
  let opGen = 0

  async function load(): Promise<void> {
    const gen = ++opGen
    loading.value = true
    error.value = null
    try {
      const r = await listBooks()
      if (gen !== opGen) return // 后发 load 已生效：旧响应不回填
      books.value = r.books
      workDirMissing.value = !r.workDir
      hint.value = r.hint ?? null
    } catch (e) {
      if (gen !== opGen) return
      error.value = friendlyError(e)
    } finally {
      if (gen === opGen) loading.value = false
    }
  }

  return { books, workDirMissing, hint, loading, error, load }
})
