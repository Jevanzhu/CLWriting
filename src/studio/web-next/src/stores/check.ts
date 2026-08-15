import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { runCheck, type CheckReport, type CheckItem } from '../api/check'
import { friendlyError } from '../shared/error'

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

  /** 操作代（X-P2-15，与 review store 同款）：run/clear 共用——切文档后旧请求结果不落 */
  let opGen = 0

  async function run(name: string, docId: string): Promise<void> {
    const gen = ++opGen
    loading.value = true
    error.value = null
    try {
      const r = await runCheck(name, docId)
      if (gen !== opGen) return // 机检数秒：期间切文档/清空，旧结果不落（防张冠李戴）
      report.value = r.report
      hasRed.value = r.hasRed
      lastDocId.value = docId
    } catch (e) {
      if (gen !== opGen) return
      error.value = friendlyError(e)
      report.value = null
      hasRed.value = false
    } finally {
      if (gen === opGen) loading.value = false
    }
  }

  function clear(): void {
    opGen++
    report.value = null
    error.value = null
    hasRed.value = false
    lastDocId.value = null
  }

  return { report, loading, error, lastDocId, hasRed, redItems, yellowItems, run, clear }
})
