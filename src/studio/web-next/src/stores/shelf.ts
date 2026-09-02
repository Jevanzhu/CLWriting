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

  // win 平台专项（2026-09-02）：书架快照缓存——列表要等 GET /api/books（win 慢盘/网络盘扫
  // 可达数百 ms）返回才渲染。写侧在每次成功拉取后落一份非敏感快照（书名/章数/字数/时间，
  // 屏幕上本就可见），load 起始先同步灌入再后台刷新——「加载中…」不再卡整屏，感知延迟降到
  // 近零。失败降级（隐私模式/配额满静默）。
  //
  // 2026-09-02 二审修正：sessionStorage → localStorage。sessionStorage 只在同标签内刷新
  // （Ctrl+R）保留，**关窗/重启进程即清空**——「以 dev app 方式启动」是全新窗口冷启动，
  // 缓存读不到等于没效果，书架仍要等首轮 API。localStorage 跨窗口存活，冷启动同样先同步
  // 灌入快照再后台刷新；后台刷新永远覆盖快照，展示态不会比刷新场景更陈旧（同一 tradeoff）。
  const CACHE_KEY = 'clw.shelf.cache.v1'

  interface ShelfCache {
    books: BookEntry[]
    workDirMissing: boolean
    hint: string | null
  }

  function readCache(): ShelfCache | null {
    if (typeof localStorage === 'undefined') return null
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as ShelfCache
      if (!Array.isArray(parsed['books'])) return null
      return parsed
    } catch {
      return null
    }
  }

  function writeCache(v: ShelfCache): void {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(v))
    } catch {
      /* 配额满/隐私模式：静默降级 */
    }
  }

  async function load(): Promise<void> {
    const gen = ++opGen
    // 起始先同步灌入快照（若上次成功拉过）：有缓存则书架立即渲染，loading 保持 false，
    // 后台再拉最新；无缓存（首屏/浏览器全新会话）维持原「加载中…」语义。
    const cached = readCache()
    if (cached) {
      books.value = cached.books
      workDirMissing.value = cached.workDirMissing
      hint.value = cached.hint
    } else {
      loading.value = true
    }
    error.value = null
    try {
      const r = await listBooks()
      if (gen !== opGen) return // 后发 load 已生效：旧响应不回填
      books.value = r.books
      workDirMissing.value = !r.workDir
      hint.value = r.hint ?? null
      writeCache({ books: r.books, workDirMissing: !r.workDir, hint: r.hint ?? null })
    } catch (e) {
      if (gen !== opGen) return
      // 有快照时刷新失败不整屏报错（列表仍展示旧数据，控制台留痕）；无快照（首屏）照旧上抛
      if (cached) console.warn('[shelf] 刷新书架失败，沿用缓存快照', e)
      else error.value = friendlyError(e)
    } finally {
      if (gen === opGen) loading.value = false
    }
  }

  return { books, workDirMissing, hint, loading, error, load }
})
