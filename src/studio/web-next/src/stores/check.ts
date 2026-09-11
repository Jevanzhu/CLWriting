import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { runCheck, markFalsePositive, type CheckReport, type CheckItem } from '../api/check'
import { friendlyError } from '../shared/error'

/**
 * 机检 store（M12 块3）：当前文档的机检报告。
 * run 触发即算即显（不落信封）；红/黄项 computed 分组供面板渲染。
 * 文档切换时由调用方 clear（报告与 docId 绑定，不跨文档残留）。
 */
/** 误报灰显 localStorage 键单一事实源（模块级：store 内与清理接口共用同源拼法）。
 *  R49-27（四十九轮）：分隔符用 \u0000（learn.ts sampleKey 同款手法）——冒号拼接在
 *  书名自身含冒号时前缀歧义：clearFalsePositiveMarks('A') 的 `clw-fp:A:` 前缀会连带
 *  命中书 'A:B' 的键。存量冒号旧键不迁移（展示态 best-effort，自然失配即弃），
 *  删书清理处顺手清旧键。 */
/** R50-D2-1（五十轮）：书名前缀单源导出——useShelf.migrateBookKeyedState 的改名迁移
 *  分支此前仍拼旧冒号前缀（R49-27 改 \u0000 时的连带漏改），现行键永不匹配、改名迁移
 *  整链空转。迁移/清理统一从本处取前缀，防两侧再漂移。 */
export function fpBookPrefix(name: string): string {
  return `clw-fp:${name}\u0000`
}

function fpKey(name: string, docId: string): string {
  return fpBookPrefix(name) + docId
}

export const useCheckStore = defineStore('check', () => {
  const report = ref<CheckReport | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  // R0912-C1-P3-1（2026-09-12 全量重评修复批）：原 lastDocId ref 删除——赋值后全仓零消费
  // （文档归属职责由调用方 clear 时机与报告/docId 绑定承担），死字段不再维护。
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
      // R71-5（七十一轮）：新报告落位即在途标记态复位——flag 在途时 run 推代（flag 只
      // 快照不推进），迟到的 finally 查代不过会让 flagging 停留旧报告的 checkId，误报
      // 按钮永久禁用直到切文档；此处直接复位（对齐 R-1 修 loading 的思路，双保险）
      flagging.value = null
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
      // R71-5（七十一轮）：归属制清除（不依赖代数）——查代制在「flag 在途 + run 推代」
      // 时永不清（gen 是 flag 入口快照，run 已推代必不等），flagging 卡死禁用误报按钮
      if (flagging.value === checkId) flagging.value = null
    }
  }

  return {
    report, loading, error, hasRed, redItems, yellowItems, run, clear,
    flagging, flagged, flagError, flagFalsePositive,
  }
})

/** R-5（十五轮登记销账）：删书成功后清该书全部误报灰显键（`clw-fp:<书>\u0000<文档>`）。
 *  模块级导出（不依赖 store 实例）——useShelf 删除流程直接调用；同名重建书不继承
 *  旧灰显态（checkId 是检查器级 id 跨书同名，残留会让新书的误报按钮被禁用）。
 *  R49-27：前缀带 \u0000 分隔符——书名含冒号时旧式 `clw-fp:A:` 前缀会连带命中
 *  书 'A:B' 的键（\u0000 后书名段无法被更长书名前缀匹配）。存量冒号旧键不做清理：
 *  旧前缀 `clw-fp:A:` 本身就是新书 'A:B' 键的前缀，顺手清会重蹈覆辙；展示态
 *  best-effort，旧键自然失配即弃。 */
export function clearFalsePositiveMarks(bookName: string): void {
  // R51-H-4（五十一轮）：前缀改取 fpBookPrefix 单源（R50-D2-1 口径）——原处内联重拼
  // `clw-fp:<书>\u0000`，与 fpKey/fpBookPrefix 构成双源，键格式再演化（如分隔符调整）时
  // 此处必成漏改点（R50-D2-1 修的正是 useShelf 侧同款漏改）。行为不变：同串前缀。
  const prefix = fpBookPrefix(bookName)
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

/** E-10（二十九轮）：删章成功后清该章误报灰显键——legacy docId 由路径派生
 *  （legacyId(path)），同路径重建新章会复用同一 docId，残留键会把旧章的灰显态/
 *  禁用误报按钮带给新章。只清属于该书该文档的键，不动他章。
 *  R60-D-3（六十轮）：删键由前缀匹配改精确归属——docId 恰为另一 docId 的字符串
 *  前缀时（如 `a.md`/`a.md2`），原 `startsWith(fpKey(...))` 会连带误删兄弟文档的
 *  键；改为书前缀（\u0000 边界）命中后取 docId 段精确等值比较。 */
export function clearFalsePositiveMarksForDoc(bookName: string, docId: string): void {
  // R60-D-3：键形 `clw-fp:<书>\u0000<docId>`——书前缀带 \u0000 分隔（更长书名不误吞，
  // R49-27 口径），其余段即 docId 段，精确等值才删（前缀兄弟键如 `a.md2` 存活）
  const bookPrefix = fpBookPrefix(bookName)
  try {
    // 倒序扫描：removeItem 不影响未访问下标
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k !== null && k.startsWith(bookPrefix) && k.slice(bookPrefix.length) === docId) {
        localStorage.removeItem(k)
      }
    }
  } catch {
    /* 配额/隐私模式：清不到就算了（灰显态本就是 best-effort 展示层） */
  }
}
