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
  async function ensureBaseline(name: string): Promise<void> {
    try {
      const r = await getWordsDiary(name)
      date.value = r.date
      todayDelta.value = r.delta
      if (r.baseline === null) {
        baseline.value = tree.totalWords
        await postBaseline(name, baseline.value)
      } else {
        baseline.value = r.baseline
      }
    } catch {
      baseline.value = tree.totalWords // 失败降级：今日 0
    } finally {
      ready.value = true
    }
  }

  return { date, baseline, todayDelta, todayWords, ready, ensureBaseline }
})
