import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { runCheck, type CheckReport, type CheckItem } from '../api/check'

/**
 * 机检 store（M12 块3）：当前文档的机检报告。
 * run 触发即算即显（不落信封）；红/黄项 computed 分组供面板渲染。
 * 文档切换时由调用方 clear（报告与 docId 绑定，不跨文档残留）。
 */
export const useCheckStore = defineStore('check', () => {
  const report = ref<CheckReport | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const lastDocId = ref<string | null>(null)
  const hasRed = ref(false)

  const redItems = computed<CheckItem[]>(() =>
    report.value ? report.value.sections.flatMap((s) => s.items.filter((i) => i.level === 'red')) : [],
  )
  const yellowItems = computed<CheckItem[]>(() =>
    report.value ? report.value.sections.flatMap((s) => s.items.filter((i) => i.level === 'yellow')) : [],
  )

  async function run(name: string, docId: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const r = await runCheck(name, docId)
      report.value = r.report
      hasRed.value = r.hasRed
      lastDocId.value = docId
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      report.value = null
      hasRed.value = false
    } finally {
      loading.value = false
    }
  }

  function clear(): void {
    report.value = null
    error.value = null
    hasRed.value = false
    lastDocId.value = null
  }

  return { report, loading, error, lastDocId, hasRed, redItems, yellowItems, run, clear }
})
