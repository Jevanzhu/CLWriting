import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { runLearn, runLearnCommit, type SampleCandidateFE, type QuoteCandidateFE } from '../api/learn'
import { friendlyError } from '../shared/error'
import { useStaleGuard } from '../composables/useStaleGuard'

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

  /** 本次收割已跑判据——harvest 成功置位（零候选也算跑过），clear 复位。
   *  hasResult 布尔区分不了「未收割」与「收割了但零候选」，视图空态三态化靠它 */
  const lastHarvestRan = ref(false)

  /** 请求代守卫：收割是全书扫描（大书数秒）——切书后 A 书在途 harvest
   *  回填会让 B 书收割视图显示 A 书正文候选，作者勾选入库即跨书污染条目库。后调者胜。
   *  ：裸计数器换装 useStaleGuard。 */
  const reqGen = useStaleGuard()

  /** commit 独立请求代——原 commit 只快照 reqGen 不推代，同代双 commit（并发/
   *  重入）守卫互相穿透，且全靠 harvest 推代兜底；未来任何旁路清列表不复位 committing
   *  即穿透。commit 自己推代后：后一笔使前一笔迟到回填/finally 解锁全部作废（对齐
   *  words/learn reqGen 代守卫惯例） */
  const commitGen = useStaleGuard()

  /** 扫定稿正文收割候选（规则打分，不涉大模型） */
  async function harvest(name: string): Promise<void> {
    // #16：函数级在途锁——同帧双击只跑一次（harvest 是全书扫描，双发=双跑，
    // 家族；reqGen 代守卫只防串书回填，在途第二笔在此直接返回）
    if (loading.value) return
    const gen = reqGen.begin()
    loading.value = true
    error.value = null
    commitMessage.value = null
    try {
      const r = await runLearn(name)
      if (reqGen.stale(gen)) return
      samples.value = r.samples
      quotes.value = r.quotes
      pickedSamples.value = new Set()
      pickedQuotes.value = new Set()
      lastHarvestRan.value = true // 收割成功置位（随新收割刷新）
    } catch (e) {
      if (reqGen.stale(gen)) return
      error.value = friendlyError(e)
      samples.value = []
      quotes.value = []
    } finally {
      if (reqGen.fresh(gen)) loading.value = false
    }
  }

  /** 样章身份 = 出处+正文（对齐金句）——同文不同出处
   *  候选此前共用正文身份（duplicate key + 勾选联动 + 入库误并）。\u0000 分隔防拼接歧义。 */
  function sampleKey(s: Pick<SampleCandidateFE, '出处' | '正文'>): string {
    return `${s.出处}\u0000${s.正文}`
  }

  function toggleSample(sample: SampleCandidateFE): void {
    const set = new Set(pickedSamples.value)
    const k = sampleKey(sample)
    if (set.has(k)) set.delete(k)
    else set.add(k)
    pickedSamples.value = set
  }
  function isSamplePicked(sample: SampleCandidateFE): boolean {
    return pickedSamples.value.has(sampleKey(sample))
  }
  /** 金句身份 = 出处+正文——同文不同出处此前共用正文作 v-for key
   *  与勾选身份（duplicate key + 勾选联动 + 入库误并）。\u0000 分隔防字段拼接歧义。 */
  function quoteKey(q: Pick<QuoteCandidateFE, '出处' | '正文'>): string {
    return `${q.出处}\u0000${q.正文}`
  }

  function toggleQuote(q: QuoteCandidateFE): void {
    const s = new Set(pickedQuotes.value)
    const k = quoteKey(q)
    if (s.has(k)) s.delete(k)
    else s.add(k)
    pickedQuotes.value = s
  }
  function isQuotePicked(q: QuoteCandidateFE): boolean {
    return pickedQuotes.value.has(quoteKey(q))
  }

  /** 入库勾选项（样章入 文风/样章库；金句入 文风/样章库/金句）。
   *  ：commit 代守卫——入库在服务端按调用时的书落盘（无串），但回填提示/列表
   *  过滤前查代，防 A 书的「已收录 N 条」提示落到已切到 B 的视图。
   *  ：改查独立 commitGen（自己推代）；在途遇 harvest 推代（reqGen 变）仍作废
   *  本笔回填——原语义保留。 */
  async function commit(name: string): Promise<void> {
    // #16：函数级在途锁（同 harvest）——在途第二笔直接返回，防同批勾选重复入库
    if (committing.value) return
    // 样章勾选按 出处+正文 身份取
    const sPicks = samples.value.filter((s) => pickedSamples.value.has(sampleKey(s)))
    // 金句勾选按 出处+正文 身份取（同文不同出处各自独立勾选）
    const qPicks = quotes.value.filter((q) => pickedQuotes.value.has(quoteKey(q)))
    if (!sPicks.length && !qPicks.length) return
    const gen = commitGen.begin() // commit 自己推代（原 const gen = reqGen 不推代）
    const harvestGen = reqGen.current()
    committing.value = true
    commitMessage.value = null
    try {
      const r = await runLearnCommit(name, { samples: sPicks, quotes: qPicks })
      if (commitGen.stale(gen) || reqGen.stale(harvestGen)) return
      commitMessage.value = `已收录 ${r.sampleFiles.length} 章样章、${r.quoteFiles.length} 条金句 → 文风/样章库。`
      // 入库项从候选列表移除（已落库，不再重复入库）
      const sSet = new Set(sPicks.map((s) => sampleKey(s)))
      const qSet = new Set(qPicks.map((q) => quoteKey(q)))
      samples.value = samples.value.filter((s) => !sSet.has(sampleKey(s)))
      quotes.value = quotes.value.filter((q) => !qSet.has(quoteKey(q)))
      pickedSamples.value = new Set()
      pickedQuotes.value = new Set()
    } catch (e) {
      if (commitGen.stale(gen) || reqGen.stale(harvestGen)) return
      commitMessage.value = '收录失败：' + friendlyError(e)
    } finally {
      // finally 查代——在途 commit 被作废后（起查独立
      // commitGen），迟到的 finally 不得解锁新一笔 commit 的按钮（可重复提交同批勾选）；
      // clear 复位缺项同补
      if (commitGen.fresh(gen)) committing.value = false
    }
  }

  /** 清空所有勾选（不影响候选列表） */
  function clearPicks(): void {
    pickedSamples.value = new Set()
    pickedQuotes.value = new Set()
  }

  function clear(): void {
    reqGen.invalidate() // 旧书在途 harvest 全部作废
    commitGen.invalidate() // 在途 commit 同作废（迟到回填不落、finally 不解锁新 commit）
    // clear 推代后在途 harvest 的 finally 查代不过 → loading 永久卡 true；
    // 此处直接复位，按钮可再触发（迟到回填仍被查代挡住，不落数据）
    loading.value = false
    // committing 同复位（修复族漏网项——否则切书后按钮卡禁用到旧 finally）
    committing.value = false
    samples.value = []
    quotes.value = []
    pickedSamples.value = new Set()
    pickedQuotes.value = new Set()
    error.value = null
    commitMessage.value = null
    lastHarvestRan.value = false // 切书复位（新书未收割）
  }

  return {
    samples,
    quotes,
    loading,
    error,
    committing,
    commitMessage,
    hasResult,
    lastHarvestRan,
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
