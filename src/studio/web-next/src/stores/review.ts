import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  runReview,
  getReviewEnvelope,
  runVerdictDoc,
  type CollectedReviewFE,
  type ReviewEnvelope,
  type ReviewVerdict,
} from '../api/review'
import { friendlyError } from '../shared/error'

/**
 * 三审 store（M12 块1 B1.1）：发起三审 + 存量信封展示。
 * aiAvailable 由 ui store 管（按钮置灰）；进度 SSE / verdict 联动在切片3。
 * 文档切换时由 ReviewPanel watch 调 loadEnvelope（读存量）或 clear。
 */
export const useReviewStore = defineStore('review', () => {
  const collected = ref<CollectedReviewFE | null>(null)
  const envelope = ref<ReviewEnvelope | null>(null)
  const stale = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const lastDocId = ref<string | null>(null)

  /** 操作代：run/loadEnvelope/clear 共用——任何切换都让在途旧结果失效 */
  let opGen = 0

  async function run(name: string, docId: string): Promise<void> {
    const gen = ++opGen
    loading.value = true
    error.value = null
    try {
      const r = await runReview(name, docId)
      if (gen !== opGen) return // 三审最长 2 分钟：期间切文档/清空，旧结果不落
      collected.value = r.collected
      lastDocId.value = docId
      const env = await getReviewEnvelope(name, docId)
      if (gen !== opGen) return
      envelope.value = env?.envelope ?? null
      stale.value = env?.stale ?? false
    } catch (e) {
      if (gen !== opGen) return
      error.value = friendlyError(e)
      collected.value = null
    } finally {
      if (gen === opGen) loading.value = false
    }
  }

  /** 打开文档时读存量信封；无 recent collected 时用信封 payload 展示。 */
  async function loadEnvelope(name: string, docId: string): Promise<void> {
    const gen = ++opGen
    const env = await getReviewEnvelope(name, docId)
    if (gen !== opGen) return
    envelope.value = env?.envelope ?? null
    stale.value = env?.stale ?? false
    lastDocId.value = env ? docId : null
    if (env && !collected.value) {
      collected.value = env.envelope.payload.collected
    }
  }

  function clear(): void {
    opGen++ // 在途 run/loadEnvelope 全部失效（切书清空后旧结果不得回流）
    collected.value = null
    envelope.value = null
    stale.value = false
    error.value = null
    lastDocId.value = null
  }

  /** 作者裁决（B1.3 方案 A）：从 review 信封 payload.verdict 读；通过/驳回 落信封。 */
  const verdict = computed<ReviewVerdict | null>(() => envelope.value?.payload.verdict ?? null)

  async function setVerdict(name: string, docId: string, approved: boolean): Promise<void> {
    await runVerdictDoc(name, docId, approved)
    await loadEnvelope(name, docId)
  }

  return { collected, envelope, stale, loading, error, lastDocId, verdict, run, loadEnvelope, setVerdict, clear }
})
