import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  listStyleEntries,
  addStyleEntry,
  deleteStyleEntry,
  listStyleCandidates,
  confirmStyleCandidate,
  ignoreStyleCandidate,
  runStyleHarvest,
  getStyleConfig,
  freezeStyleBaseline,
  getStyleTrend,
  type StyleEntryFE,
  type StyleCandidateFE,
  type StyleConfigFE,
  type StyleTrendFE,
  type StyleMigrationFE,
  type EntryKindFE,
} from '../api/style'

/**
 * 文风系统状态（S7 StyleView 数据层）：条目库 / 候选箱 / 定标 / 机检趋势。
 * 错误统一上抛，toast 归视图层；load 返回迁移结果供首读提示。
 */
export const useStyleStore = defineStore('style', () => {
  const bookName = ref('')
  const entries = ref<StyleEntryFE[]>([])
  const entryErrors = ref(0)
  const candidates = ref<StyleCandidateFE[]>([])
  const config = ref<StyleConfigFE | null>(null)
  const trend = ref<StyleTrendFE | null>(null)
  const loading = ref(false)
  const loaded = ref(false)

  const pendingCount = computed(() => candidates.value.filter((c) => c.状态 === '待确认').length)
  const kindCounts = computed(() => {
    const m: Record<EntryKindFE, number> = { 样章: 0, 手法: 0, 反例: 0, 禁词: 0 }
    for (const e of entries.value) m[e.类型]++
    return m
  })

  /** 进入视图 / 切书加载；返回迁移结果（发生迁移时非 null，视图 toast） */
  async function load(name: string): Promise<StyleMigrationFE | null> {
    bookName.value = name
    loading.value = true
    try {
      const [er, cr, cfg] = await Promise.all([
        listStyleEntries(name),
        listStyleCandidates(name),
        getStyleConfig(name),
      ])
      entries.value = er.entries
      entryErrors.value = er.errors.length
      candidates.value = cr.candidates
      config.value = cfg
      loaded.value = true
      return er.migration
    } finally {
      loading.value = false
    }
  }

  async function reloadEntries(): Promise<void> {
    const r = await listStyleEntries(bookName.value)
    entries.value = r.entries
    entryErrors.value = r.errors.length
  }
  async function reloadCandidates(): Promise<void> {
    candidates.value = (await listStyleCandidates(bookName.value)).candidates
  }

  async function add(entry: Parameters<typeof addStyleEntry>[1]): Promise<void> {
    await addStyleEntry(bookName.value, entry)
    await reloadEntries()
  }
  async function remove(path: string): Promise<void> {
    await deleteStyleEntry(bookName.value, path)
    entries.value = entries.value.filter((e) => e._path !== path)
  }
  async function confirm(path: string): Promise<void> {
    await confirmStyleCandidate(bookName.value, path)
    candidates.value = candidates.value.filter((c) => c._path !== path)
    await reloadEntries()
  }
  async function ignore(path: string): Promise<void> {
    await ignoreStyleCandidate(bookName.value, path)
    const c = candidates.value.find((x) => x._path === path)
    if (c) c.状态 = '已忽略'
  }

  /** 收割（零 AI）：返回 created/skipped 供视图 toast */
  async function harvest(): Promise<{ created: number; skipped: number }> {
    const r = await runStyleHarvest(bookName.value)
    if (r.created > 0) await reloadCandidates()
    return r
  }

  async function freeze(): Promise<void> {
    const r = await freezeStyleBaseline(bookName.value)
    if (config.value) config.value.baseline = r.baseline
  }

  /** 机检重扫（零 AI，全量重算，章多时秒级） */
  async function rescan(): Promise<void> {
    trend.value = await getStyleTrend(bookName.value)
  }

  /** 切书清空（Book.vue watch(bookName) 调；缺此方法切书渲染崩溃） */
  function clear(): void {
    bookName.value = ''
    entries.value = []
    entryErrors.value = 0
    candidates.value = []
    config.value = null
    trend.value = null
    loading.value = false
    loaded.value = false
  }

  return {
    bookName,
    entries,
    entryErrors,
    candidates,
    config,
    trend,
    loading,
    loaded,
    pendingCount,
    kindCounts,
    load,
    add,
    remove,
    confirm,
    ignore,
    harvest,
    freeze,
    rescan,
    clear,
  }
})
