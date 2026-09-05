import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getWordsDiary, postBaseline } from '../api/books'
import { useTreeStore } from './tree'

/** 本地日期 YYYY-MM-DD（与服务端 todayDate 同格式：本地时区逐段拼，非 toISOString 的 UTC）。 */
function localToday(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

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
  // R46-33（四十六轮）：同书在途合并台账（手法对齐 doc.ts inflightOpens）——批量落盘 N 文档
  // 并发 save settle 各调一次 ensureBaseline(同书)，原样发 N 次 GET /words-diary 而 N-1 次
  // 纯浪费；合并后同书并发调用共享同一请求。settle 后 identity 删键，reset 清台账。
  const inflightBaselines = new Map<string, Promise<void>>()
  function ensureBaseline(name: string): Promise<void> {
    const running = inflightBaselines.get(name)
    if (running) return running
    const p = doEnsureBaseline(name).finally(() => {
      // identity 删键：reset 清台账后同书二次调用已登记新 promise，旧 settled 不得误删新条目
      if (inflightBaselines.get(name) === p) inflightBaselines.delete(name)
    })
    inflightBaselines.set(name, p)
    return p
  }
  async function doEnsureBaseline(name: string): Promise<void> {
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
    // R35-10：属主校验——新书 load 失败时 tree.raw 滞留旧书（ownerBook ≠ 目标书），
    // 旧书总字数不得充当目标书基线源：置 null，落基线分支整体跳过（今日字数显示 0），
    // 等树加载成功后的下一次 ensureBaseline（ChapterTreePanel 侧 R35-10 短路为主）。
    const bookTotalWords = tree.ownerBook === name ? tree.totalWords : null
    try {
      const r = await getWordsDiary(name)
      if (gen !== reqGen) return
      // E-6（二十九轮）：跨零点守卫——响应的 date 由服务端在响应生成时刻打（今日），
      // 若它已 ≠ 前端当前本地日期，说明响应生成于零点前（慢响应跨日竞态）：baseline/delta
      // 属昨日，不能拿来当「今日」。以当前已写重记今日基线，再重取一次对齐服务端新日记录。
      //（重记基线取 R33-76（三十三轮 win 线）的首个 await 前快照 bookTotalWords——
      // await 后读活源 tree.totalWords 会拿进「B 树已落定、B 的 ensureBaseline 尚未
      // 推代」间隙的别书总字数。）
      if (r.date !== localToday()) {
        // R35-10：属主不匹配（bookTotalWords=null）时无基线源可重记——跳过重记/重取，
        // 不落基线（今日 0），等树就绪后的下一次 ensureBaseline
        if (bookTotalWords !== null) {
          baseline.value = bookTotalWords
          await postBaseline(name, baseline.value)
          if (gen !== reqGen) return
          const r2 = await getWordsDiary(name)
          if (gen !== reqGen) return
          date.value = r2.date
          todayDelta.value = r2.delta
          baseline.value = r2.baseline ?? baseline.value
        }
      } else {
        date.value = r.date
        todayDelta.value = r.delta
        if (r.baseline === null && bookTotalWords !== null) {
          baseline.value = bookTotalWords
          // R-23（第十六轮）：postBaseline 后查代——await 期间切书（旧书 ensureBaseline
          // 被 reqGen++ 作废）时旧书迟到响应不落盘（对齐同库其他 store 的 gen 模式）
          await postBaseline(name, baseline.value)
          if (gen !== reqGen) return
        } else if (r.baseline !== null) {
          baseline.value = r.baseline
        }
      }
    } catch {
      if (gen !== reqGen) return
      // R65-49（E-1）：失败降级须一并清 delta——否则旧书/上次成功的 delta 残留且
      // 优先级高于 baseline 回退，今日字数显示的是别人（旧书）的增量
      todayDelta.value = null
      date.value = null
      // R35-10：降级基线同过属主校验——树滞留旧书时不取旧总值（今日 0 展示）
      baseline.value = bookTotalWords
    } finally {
      if (gen === reqGen) ready.value = true
    }
  }

  /** E-7（二十九轮）：清今日字数展示态（脏路由 name='' 离开书时由 ChapterTreePanel 调）——
   *  前书的 date/baseline/delta 不再参与展示；loadedFor 复位 + reqGen 推代，在途旧书
   *  响应落定不回填，下次进书按新书重取。 */
  function reset(): void {
    reqGen++
    loadedFor = null
    // R46-33（四十六轮）：在途台账一并清——reset 已推代，在途共享 promise 落定时被 gen 守卫
    // 丢弃（不回填数据）；不清则 reset 后同书首调会搭上这条「死」promise，今日字数永不落定
    inflightBaselines.clear()
    date.value = null
    baseline.value = null
    todayDelta.value = null
    ready.value = false
  }

  return { date, baseline, todayDelta, todayWords, ready, ensureBaseline, reset }
})
