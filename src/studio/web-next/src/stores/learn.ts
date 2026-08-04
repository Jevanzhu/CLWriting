import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { runLearn, runLearnCommit, type SampleCandidateFE, type QuoteCandidateFE } from '../api/learn'
import { friendlyError } from '../shared/error'

/**
 * 文风收割 store（M12 后置）：收割候选（规则打分不涉大模型）+ 作者勾选入库。
 *
 * 候选制红线（#38）：作者勾选才入库——commit 只发勾选项，不自动入库。
 * 勾选用正文文本作 key（候选正文唯一），Set 重赋值触发响应（Vue 对 Set.add/delete 不响应）。
 */
export const useLearnStore = defineStore('learn', () => {
  const samples = ref<SampleCandidateFE[]>([])
  const quotes = ref<QuoteCandidateFE[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const committing = ref(false)
  /** 入库结果提示（成功/失败文本，null=未入库） */
  const commitMessage = ref<string | null>(null)

  const pickedSamples = ref<Set<string>>(new Set())
  const pickedQuotes = ref<Set<string>>(new Set())

  const hasResult = computed(() => samples.value.length > 0 || quotes.value.length > 0)
  const pickedCount = computed(() => pickedSamples.value.size + pickedQuotes.value.size)

  /** 扫定稿正文收割候选（规则打分，不涉大模型） */
  async function harvest(name: string): Promise<void> {
    loading.value = true
    error.value = null
    commitMessage.value = null
    try {
      const r = await runLearn(name)
      samples.value = r.samples
      quotes.value = r.quotes
      pickedSamples.value = new Set()
      pickedQuotes.value = new Set()
    } catch (e) {
      error.value = friendlyError(e)
      samples.value = []
      quotes.value = []
    } finally {
      loading.value = false
    }
  }

  function toggleSample(body: string): void {
    const s = new Set(pickedSamples.value)
    if (s.has(body)) s.delete(body)
    else s.add(body)
    pickedSamples.value = s
  }
  function toggleQuote(body: string): void {
    const s = new Set(pickedQuotes.value)
    if (s.has(body)) s.delete(body)
    else s.add(body)
    pickedQuotes.value = s
  }
  function isSamplePicked(body: string): boolean {
    return pickedSamples.value.has(body)
  }
  function isQuotePicked(body: string): boolean {
    return pickedQuotes.value.has(body)
  }

  /** 入库勾选项（样章入 文风/样章库；金句入 文风/样章库/金句） */
  async function commit(name: string): Promise<void> {
    const sPicks = samples.value.filter((s) => pickedSamples.value.has(s.正文))
    const qPicks = quotes.value.filter((q) => pickedQuotes.value.has(q.正文))
    if (!sPicks.length && !qPicks.length) return
    committing.value = true
    commitMessage.value = null
    try {
      const r = await runLearnCommit(name, { samples: sPicks, quotes: qPicks })
      commitMessage.value = `已收录 ${r.sampleFiles.length} 篇样章、${r.quoteFiles.length} 条金句 → 文风/样章库。`
      // 入库项从候选列表移除（已落库，不再重复入库）
      const sSet = new Set(sPicks.map((s) => s.正文))
      const qSet = new Set(qPicks.map((q) => q.正文))
      samples.value = samples.value.filter((s) => !sSet.has(s.正文))
      quotes.value = quotes.value.filter((q) => !qSet.has(q.正文))
      pickedSamples.value = new Set()
      pickedQuotes.value = new Set()
    } catch (e) {
      commitMessage.value = '收录失败：' + friendlyError(e)
    } finally {
      committing.value = false
    }
  }

  /** 清空所有勾选（不影响候选列表） */
  function clearPicks(): void {
    pickedSamples.value = new Set()
    pickedQuotes.value = new Set()
  }

  function clear(): void {
    samples.value = []
    quotes.value = []
    pickedSamples.value = new Set()
    pickedQuotes.value = new Set()
    error.value = null
    commitMessage.value = null
  }

  return {
    samples,
    quotes,
    loading,
    error,
    committing,
    commitMessage,
    hasResult,
    pickedCount,
    harvest,
    toggleSample,
    toggleQuote,
    isSamplePicked,
    isQuotePicked,
    clearPicks,
    commit,
    clear,
  }
})
