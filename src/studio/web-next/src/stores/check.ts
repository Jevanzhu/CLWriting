import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { runCheck, markFalsePositive, type CheckReport, type CheckItem } from '../api/check'
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

  // B1（批 6）：误报标记态——按 checkId（同检查器一次标记即覆盖该检查器的全部同类命中）
  const flagging = ref<string | null>(null)
  const flagged = ref(new Set<string>())
  const flagError = ref<string | null>(null)

  // M-1（二轮复审）：误报标记按 书+文档 存 localStorage——服务端无查询端点，前端灰显态
  // 刷新即失；in-memory Set 只在 run→clear 生命周期内存活（checkId 是检查器级 id、跨文档
  // 同名，不随 clear 清会把 A 文档的标记灰显到 B 文档同名命中上、误报按钮被禁用）
  function fpKey(name: string, docId: string): string {
    return `clw-fp:${name}:${docId}`
  }
  function loadFlagged(name: string, docId: string): Set<string> {
    try {
      const raw = localStorage.getItem(fpKey(name, docId))
      const arr = raw ? (JSON.parse(raw) as unknown) : []
      return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [])
    } catch {
      return new Set()
    }
  }
  function saveFlagged(name: string, docId: string): void {
    try {
      localStorage.setItem(fpKey(name, docId), JSON.stringify([...flagged.value]))
    } catch {
      /* 配额/隐私模式：灰显态降级为不持久（标记本身已落服务端事件库） */
    }
  }

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
      // M-1：灰显态从 localStorage 按书+文档回填（刷新后已标误报仍灰显）
      flagged.value = loadFlagged(name, docId)
      flagError.value = null
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
    // R-1（第十六轮）：clear 推代后在途 run 的 finally 查代不过 → loading 永久卡 true；
    // 此处直接复位，按钮可再触发（迟到回填仍被查代挡住，不落数据）
    loading.value = false
    report.value = null
    error.value = null
    hasRed.value = false
    lastDocId.value = null
    // M-1：checkId 是检查器级 id（跨文档/跨书同名）——不清会让旧文档的标记灰显到
    // 新文档同名命中上、误报按钮被禁用（标记的真相在服务端，这里只清展示态）
    flagging.value = null
    flagged.value = new Set()
    flagError.value = null
  }

  /** B1（批 6）：标误报（幂等——已标过不重复请求）；错误置 flagError 供面板提示。
   *  P-9（第十四轮）：入口捕获 opGen、落态前查代——与同文件 run/clear 的既有纪律
   *  对齐：标记在途时切文档/切书（clear→新报告 run 回填），迟到的成功响应不再把
   *  A 文档的 checkId 追加进 B 文档灰显集（checkId 跨文档同名），也不再污染 localStorage 键。 */
  async function flagFalsePositive(name: string, docId: string, checkId: string): Promise<void> {
    if (flagging.value || flagged.value.has(checkId)) return
    // 只快照不推进：flag 不废在途的 run（run 结果仍应落地）；clear/新 run 会推进 opGen，
    // 迟到回填由此被挡
    const gen = opGen
    flagging.value = checkId
    flagError.value = null
    try {
      await markFalsePositive(name, docId, checkId)
      if (gen !== opGen) return // 在途期间已 clear/切文档：结果不落新文档
      flagged.value = new Set([...flagged.value, checkId])
      saveFlagged(name, docId) // M-1：刷新后灰显态可回填
    } catch (e) {
      if (gen !== opGen) return
      flagError.value = friendlyError(e)
    } finally {
      if (gen === opGen) flagging.value = null
    }
  }

  return {
    report, loading, error, lastDocId, hasRed, redItems, yellowItems, run, clear,
    flagging, flagged, flagError, flagFalsePositive,
  }
})

/** R-5（十五轮登记销账）：删书成功后清该书全部误报灰显键（`clw-fp:<书>:<文档>`）。
 *  模块级导出（不依赖 store 实例）——useShelf 删除流程直接调用；同名重建书不继承
 *  旧灰显态（checkId 是检查器级 id 跨书同名，残留会让新书的误报按钮被禁用）。 */
export function clearFalsePositiveMarks(bookName: string): void {
  const prefix = `clw-fp:${bookName}:`
  try {
    // 倒序扫描：removeItem 不影响未访问下标
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k !== null && k.startsWith(prefix)) localStorage.removeItem(k)
    }
  } catch {
    /* 配额/隐私模式：清不到就算了（灰显态本就是 best-effort 展示层） */
  }
}
