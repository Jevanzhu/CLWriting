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
 * aiAvailable 由 ui store 管（按钮置灰）；verdict 联动已落地（B1.3 方案 A）；
 * 进度 SSE 未实现亦无排期（原「切片3」为过时前瞻宣称，R1010-P3 G6-⑤ 修账）。
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

  // R1010b-FE-P2-1（2026-09-10 内存专项重审修复批）：collected 归属键（`${书}::${docId}`）。
  // 成因（跨文档串显）：collected 只在 run 成功 / loadEnvelope 回填时写入，切文档从不清
  // ——文档 A（有采集）切到 B：B 有信封时 `!collected.value` 为假跳过回填、B 无信封时
  // env 为 null 同样保留 A 的 collected；ReviewPanel 的 blockers/warnings/passed 全派生自
  // collected，A 的三审意见串显在 B 的面板上（verdict 徽章却是 B 的）。同构 check store
  // 的契约由 CheckPanel 调用方 clear() 补齐，review 侧没有——修在 store 入口单源收口：
  // loadEnvelope 判定跨文档/跨书（键不同）先清再拉；run 成功落 collected 时同步推进键
  //（不推进则 run 后同文档 loadEnvelope 会按「键不同」误清新结果）；setVerdict 裁决后
  // 的 loadEnvelope(同参) 回读链键相同，同文档重入天然豁免不清。
  let lastLoadKey: string | null = null

  async function run(name: string, docId: string): Promise<void> {
    const gen = ++opGen
    loading.value = true
    error.value = null
    try {
      const r = await runReview(name, docId)
      if (gen !== opGen) return // 三审最长 2 分钟：期间切文档/清空，旧结果不落
      collected.value = r.collected
      lastDocId.value = docId
      // R1010b-FE-P2-1：同步推进归属键——否则紧随的同文档 loadEnvelope（ReviewPanel
      // watch / setVerdict 回读）按「键不同」误清新采集结果
      lastLoadKey = `${name}::${docId}`
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
    // R1010b-FE-P2-1：跨文档/跨书（键不同）先清上一份 collected 再拉信封——不清则
    // 旧文档三审意见串显到新文档面板（成因见 lastLoadKey 注）；同文档重入
    //（setVerdict → loadEnvelope 回读链）键相同不清，刚落的采集结果豁免
    const loadKey = `${name}::${docId}`
    if (lastLoadKey !== loadKey) collected.value = null
    const gen = ++opGen
    // dd-P2：getReviewEnvelope 现在只把 404 归 null、其余上抛——此处兜住进 error
    //（watch 调用方无 catch，不兜会变未处理拒绝）
    try {
      const env = await getReviewEnvelope(name, docId)
      if (gen !== opGen) return
      envelope.value = env?.envelope ?? null
      stale.value = env?.stale ?? false
      lastDocId.value = env ? docId : null
      if (env && !collected.value) {
        collected.value = env.envelope.payload.collected
      }
      lastLoadKey = loadKey
    } catch (e) {
      if (gen !== opGen) return
      error.value = friendlyError(e)
    }
  }

  function clear(): void {
    opGen++ // 在途 run/loadEnvelope 全部失效（切书清空后旧结果不得回流）
    // R-1（第十六轮）：clear 推代后在途 run 的 finally 查代不过 → loading 永久卡 true；
    // 此处直接复位，按钮可再触发（迟到回填仍被查代挡住，不落数据）
    loading.value = false
    collected.value = null
    envelope.value = null
    stale.value = false
    error.value = null
    lastDocId.value = null
    lastLoadKey = null // R1010b-FE-P2-1：归属键随清空复位（clear 后首次 loadEnvelope 视为跨文档，先清再拉）
  }

  /** 作者裁决（B1.3 方案 A）：从 review 信封 payload.verdict 读；通过/驳回 落信封。 */
  const verdict = computed<ReviewVerdict | null>(() => envelope.value?.payload.verdict ?? null)

  async function setVerdict(name: string, docId: string, approved: boolean): Promise<void> {
    // R71-27（七十一轮）：入口捕获 opGen——裁决在途切书（clear 推代 + 新文档
    // loadEnvelope 已回填）后，续体再 loadEnvelope(旧参) 会重新推代反超新书拉取，
    // 旧书信封串显；await 返回后查代不过直接弃（对齐同文件 run/loadEnvelope 守卫）
    const gen = opGen
    await runVerdictDoc(name, docId, approved)
    if (gen !== opGen) return // 在途期间已切书/清空：不再以旧书参数拉信封
    await loadEnvelope(name, docId)
  }

  return { collected, envelope, stale, loading, error, lastDocId, verdict, run, loadEnvelope, setVerdict, clear }
})
