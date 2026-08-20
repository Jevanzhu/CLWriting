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

  /** B1（批 6）：标误报（幂等——已标过不重复请求）；错误置 flagError 供面板提示 */
  async function flagFalsePositive(name: string, docId: string, checkId: string): Promise<void> {
    if (flagging.value || flagged.value.has(checkId)) return
    flagging.value = checkId
    flagError.value = null
    try {
      await markFalsePositive(name, docId, checkId)
      flagged.value = new Set([...flagged.value, checkId])
      saveFlagged(name, docId) // M-1：刷新后灰显态可回填
    } catch (e) {
      flagError.value = friendlyError(e)
    } finally {
      flagging.value = null
    }
  }

  return {
    report, loading, error, lastDocId, hasRed, redItems, yellowItems, run, clear,
    flagging, flagged, flagError, flagFalsePositive,
  }
})
