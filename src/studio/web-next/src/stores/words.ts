import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getWordsDiary, postBaseline } from '../api/books'
import { useTreeStore } from './tree'

/**
 * 字数日记 store（§5.4 今日基线）。
 *
 * 今日字数 = 当前已写 − 今日基线。当前已写取自 tree.totalWords；
 * baseline 走 GET /api/books/:name/words-diary，首次打开（null）记当前已写为基线。
 * 精度限制：跨零点 / 多端打开基线有偏差（§5.4 可接受）。
 */
export const useWordsStore = defineStore('words', () => {
  const date = ref<string | null>(null)
  const baseline = ref<number | null>(null)
  const ready = ref(false)

  const tree = useTreeStore()

  /** 今日字数 = 当前已写 − 今日基线（baseline 未就绪 → 0）。 */
  const todayWords = computed(() =>
    baseline.value === null ? 0 : Math.max(0, tree.totalWords - baseline.value),
  )

  /** 打开书时调：GET baseline；无 → 记当前已写为基线。需在 tree.load 后调（totalWords 已就绪）。 */
  async function ensureBaseline(name: string): Promise<void> {
    try {
      const r = await getWordsDiary(name)
      date.value = r.date
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

  return { date, baseline, todayWords, ready, ensureBaseline }
})
