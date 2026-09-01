import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getWordsDiary, postBaseline } from '../api/books'
import { useTreeStore } from './tree'

/**
 * 字数日记 store（§5.4 今日基线 + E4 精确增量）。
 *
 * 今日字数优先取「当日 save settled 的字数 delta 累加」（精确，不受删章/合并影响）；
 * 当日无 settled 记录（delta=null，旧书或当天未保存）→ 回退「当前已写 - 基线」（§5.4）。
 * 跨零点 / 多端打开时 baseline 有偏差，delta 方案按 settle 时刻归日，更准。
 */
export const useWordsStore = defineStore('words', () => {
  const date = ref<string | null>(null)
  const baseline = ref<number | null>(null)
  /** 今日精确增量（E4：当日所有 save settled 的 delta 累加；null = 无记录回退 baseline）。 */
  const todayDelta = ref<number | null>(null)
  const ready = ref(false)

  const tree = useTreeStore()

  /** 今日字数：delta 优先（精确）；null 回退「当前已写 - 基线」（§5.4）；均未就绪 → 0。 */
  const todayWords = computed(() => {
    if (todayDelta.value !== null) return Math.max(0, todayDelta.value)
    return baseline.value === null ? 0 : Math.max(0, tree.totalWords - baseline.value)
  })

  /** 打开书 / save 后刷新：GET baseline + delta；baseline 缺 → 记当前已写为基线。需 tree.load 后调。 */
  let reqGen = 0
  let loadedFor: string | null = null
  async function ensureBaseline(name: string): Promise<void> {
    // RB-FE-P2-5：请求代守卫——切书后旧书慢响应不污染今日字数基线（后调者胜）
    const gen = ++reqGen
    // R65-49（E-1）：切书入口清态——tree.totalWords 已是新书而 baseline/delta 还是旧书时，
    // 回退式「当前已写 - 基线」拿两本书的数互减出脏值；同书 save 刷新不清，避免闪 0
    if (loadedFor !== name) {
      loadedFor = name
      date.value = null
      baseline.value = null
      todayDelta.value = null
      ready.value = false
    }
    // R33-76（三十三轮）：入参书的全书字数在首个 await 前快照——原在 await 后读活源
    // tree.totalWords，「B 树已落定、B 的 ensureBaseline 尚未推代」间隙内 A 书迟到响应
    // 会把 B 的总字数 POST 成 A 的当日基线（服务端 words-diary 污染，前端自愈但脏写）。
    const bookTotalWords = tree.totalWords
    try {
      const r = await getWordsDiary(name)
      if (gen !== reqGen) return
      date.value = r.date
      todayDelta.value = r.delta
      if (r.baseline === null) {
        baseline.value = bookTotalWords
        // R-23（第十六轮）：postBaseline 后查代——await 期间切书（旧书 ensureBaseline
        // 被 reqGen++ 作废）时旧书迟到响应不落盘（对齐同库其他 store 的 gen 模式）
        await postBaseline(name, baseline.value)
        if (gen !== reqGen) return
      } else {
        baseline.value = r.baseline
      }
    } catch {
      if (gen !== reqGen) return
      // R65-49（E-1）：失败降级须一并清 delta——否则旧书/上次成功的 delta 残留且
      // 优先级高于 baseline 回退，今日字数显示的是别人（旧书）的增量
      todayDelta.value = null
      date.value = null
      baseline.value = tree.totalWords // 失败降级：今日 0
    } finally {
      if (gen === reqGen) ready.value = true
    }
  }

  return { date, baseline, todayDelta, todayWords, ready, ensureBaseline }
})
