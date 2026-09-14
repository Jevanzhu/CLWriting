import { defineStore } from 'pinia'
import { ref, computed, type Ref } from 'vue'
import { getGlobalPrefs, putGlobalPrefs, type GlobalPrefs } from '../api/prefs'
import { ApiError } from '../api/client'
import { buildFontFamily, buildProseFontStack } from '../composables/useSystemFonts'
import { useStaleGuard } from '../composables/useStaleGuard'
import { useUiStore } from './ui'
import type { ThemeId } from '../types/theme'

/**
 * 全局编辑器偏好 store（主题 + 排版 + 字体 + 书架视图 + 版本保留全局默认）。
 *
 * 存储：userData/global.json（APP 级，跨书库共享；对齐 Obsidian 全局配置）。
 * 替代旧 localStorage（LevelDB 黑盒，不可编辑不可备份）。
 *
 * 书级覆盖：pageWidth / autosaveInterval 可被 .clwriting/prefs.json 覆盖。
 * effectivePageWidth = 书级 > 全局；apply() 用有效值。
 * 书级覆盖的持久化由 workspace store 统一写入 prefs.json（避免双写冲突）。
 *
 * 版本保留全局默认（snapDays/snapCount → 持久化为 global.json 的 snapMaxDays/snapMaxCount）：
 * 生效链 global.json → 硬编码 14 天 / 30 个（服务端 prune 同链）；所有书统一，
 * book.yaml snapshots 书级覆盖已于 2026-08-19 砍掉。
 *
 * 书级设定全局托底（同 snapMax* 模式，2026-08-19 修正口径）：题材/每卷章数/目标字数/
 * 每章字数/短篇严格/自动梳理/增量阈值/启用检索/检索提供方 可被书覆盖；文风注入/自动
 * 确认细纲/批量章数/单章上限（AI 写作组）与版本保留已砍书级，所有书统一。
 * 生效链 book.yaml 对应键 → 此处 → 硬编码回落（ref 初值即回落，服务端合并同链）；
 * 书级覆盖存 book.yaml（「本书」页各领域的「本书使用独立设定」组开关写），不进本 store。
 *
 * 初始化：main.ts 在 mount 前 await init() → API 读取 → apply CSS 变量。
 * 首次为空时从旧 localStorage 自动迁移。
 */
const DEFAULTS = {
  theme: 'light' as ThemeId,
  proseSize: 17,
  proseLh: 1.5,
  pageWidth: 1020,
  autosaveInterval: 30,
  shelfView: 'grid' as 'grid' | 'list',
  chatEnabled: false,
  compact: false,
  snapDays: 14,
  snapCount: 30,
  // ── 书级设定全局托底（书级未设时的展示/生效回落；与服务端合并链末端一致）──
  defaultGenre: '',
  defaultVolumeSize: 50,
  defaultTargetWords: 0,
  defaultChapterTargetWords: 0,
  defaultShortStrict: false,
  styleInjection: 'light' as 'light' | 'heavy',
  autoConfirmOutline: false,
  autoBatchSize: 8,
  callsPerChapter: 8,
  relationAutoMine: false,
  relationMineThreshold: 3,
  ragEnabled: false,
  ragProvider: '',
}

/** 旧 localStorage 键（仅迁移用，迁移后停用） */
const OLD_LS = {
  theme: 'clw-theme',
  size: 'clw.proseSize',
  lh: 'clw.proseLh',
  uiFontCn: 'clw.uiFontCn',
  uiFontEn: 'clw.uiFontEn',
  proseFontCn: 'clw.proseFontCn',
  proseFontEn: 'clw.proseFontEn',
  pageWidth: 'clw.pageWidth',
  autosaveInterval: 'clw.autosaveInterval',
  shelfView: 'clw-shelf-view',
}

export const usePrefsStore = defineStore('prefs', () => {
  // ── 全局偏好（global.json）──
  const theme = ref<ThemeId>(DEFAULTS.theme)
  const proseSize = ref(DEFAULTS.proseSize)
  const proseLh = ref(DEFAULTS.proseLh)
  const uiFontCn = ref('')
  const uiFontEn = ref('')
  /** UI 字号档（外观设置；-1 小 / 0 标准 / 1 大 / 2 特大）——整条字号刻度随
   *  --font-size-step 平移，平台基准（win +1px）之上叠加。两平台通用。 */
  const uiFontSizeStep = ref(0)
  const proseFontCn = ref('')
  const proseFontEn = ref('')
  const pageWidth = ref(DEFAULTS.pageWidth)
  const autosaveInterval = ref(DEFAULTS.autosaveInterval)
  const shelfView = ref<'grid' | 'list'>(DEFAULTS.shelfView)
  /** 对话助手开关（默认关闭） */
  const chatEnabled = ref(DEFAULTS.chatEnabled)
  /** 紧凑模式：收窄侧栏间距 / 减小列表行高（默认关闭） */
  const compact = ref(DEFAULTS.compact)
  /** 版本保留全局默认（天数/数量；持久化为 snapMaxDays/snapMaxCount，所有书统一） */
  const snapDays = ref(DEFAULTS.snapDays)
  const snapCount = ref(DEFAULTS.snapCount)

  // ── 书级设定全局托底（书级 book.yaml 未设时的展示/生效值；持久化为 global.json 13 键）──
  // ref 初值即硬编码回落：前端消费者直接读 ref，书级未设时自然落到这里（服务端合并链末端一致），
  // 无需再写一遍魔法数字。书级覆盖由「本书」页各领域的「本书使用独立设定」组开关写 book.yaml，不进本 store。
  /** 题材默认（'' = 未设；书级 book.genre） */
  const defaultGenre = ref(DEFAULTS.defaultGenre)
  /** 每卷章数默认（仅长篇使用；书级 book.volume_size） */
  const defaultVolumeSize = ref(DEFAULTS.defaultVolumeSize)
  /** 目标字数默认（0 = 未设；书级 book.target_words） */
  const defaultTargetWords = ref(DEFAULTS.defaultTargetWords)
  /** 每章字数默认（0 = 未设；书级 book.chapter_target_words） */
  const defaultChapterTargetWords = ref(DEFAULTS.defaultChapterTargetWords)
  /** 短篇严格模式默认（仅短篇书生效；书级 short.strict） */
  const defaultShortStrict = ref(DEFAULTS.defaultShortStrict)
  /** 文风注入强度默认（2026-08-19 起唯一生效源：全局，已取消书级覆盖） */
  const styleInjection = ref(DEFAULTS.styleInjection)
  /** 自动确认细纲默认（书级 auto.confirm_outline） */
  const autoConfirmOutline = ref(DEFAULTS.autoConfirmOutline)
  /** 批量写作章数默认（书级 auto.batch_size；注意 ref 名与 JSON 键 autoBatchSize 不同，避免与语义混淆） */
  const aiBatchSize = ref(DEFAULTS.autoBatchSize)
  /** 单章调用上限默认（书级 budget.calls_per_chapter） */
  const callsPerChapter = ref(DEFAULTS.callsPerChapter)
  /** 关系图自动梳理默认（书级 auto.relation_auto_mine） */
  const relationAutoMine = ref(DEFAULTS.relationAutoMine)
  /** 关系图章节增量阈值默认（书级 auto.relation_mine_threshold） */
  const relationMineThreshold = ref(DEFAULTS.relationMineThreshold)
  /** 知识检索启用默认（书级 rag.enabled） */
  const ragEnabled = ref(DEFAULTS.ragEnabled)
  /** 知识检索提供方默认（'' = 未设；书级 rag.provider，引用应用级 RAG 提供方 id） */
  const ragProvider = ref(DEFAULTS.ragProvider)
  // ── R52-E-2：机检阈值全局托底五键（undefined = 未设 = 走引擎默认；刻意不进 DEFAULTS、
  // 无硬编码托底值——引擎默认参数即最终回落，与 defaultTargetWords 的「0 = 未设」不同源）──
  /** 复读占比阈值默认（0-1 小数；书级 checks.repeat_threshold） */
  const checkRepeatThreshold = ref<number | undefined>(undefined)
  /** 复读最小连续字数默认（正整数；书级 checks.repeat_chars_threshold） */
  const checkRepeatCharsThreshold = ref<number | undefined>(undefined)
  /** 超长句判定长度默认（正整数；书级 checks.max_sentence_len） */
  const checkMaxSentenceLen = ref<number | undefined>(undefined)
  /** 高频意象报黄次数阈值默认（正整数；书级 checks.imagery_threshold） */
  const checkImageryThreshold = ref<number | undefined>(undefined)
  /** 字数容差百分比默认（正数；书级 checks.word_count_tolerance） */
  const checkWordCountTolerance = ref<number | undefined>(undefined)

  // ── 书级覆盖（prefs.json；null = 用全局）──
  const bookPageWidth = ref<number | null>(null)
  const bookAutosaveInterval = ref<number | null>(null)

  // ── 有效值（书级 > 全局）──
  const effectivePageWidth = computed(() => bookPageWidth.value ?? pageWidth.value)
  const effectiveAutosaveInterval = computed(() => bookAutosaveInterval.value ?? autosaveInterval.value)

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  /** R32-27：在途写回句柄（单飞排队判据；finally 复位） */
  let putInFlight: Promise<void> | null = null
  /** R35-8：最近一次成功落盘的服务端快照（PUT 的入参快照）——409 恢复时判定
   *  「本窗已改未落盘字段」的基线（当前 refs ≠ 此快照的字段即本窗脏字段）。 */
  let lastPersisted: GlobalPrefs | null = null

  /** 并发修订号（GG-P2-7）：PUT /api/library/prefs 的 expectedRevision 依据。
   *  GET/写成功响应回传时同步（照 provider store P4 的维护方式），非响应式——仅供写路径用。
   *  R32-26（三十二轮）：配对未知态标记——init 失败（API 不可达）时 revision=0 是「未知」
   *  而非「服务端确为 0」，原样参与 PUT 会让首保存必 409（误报「已在其他窗口被修改」）。 */
  let revision = 0
  let revisionKnown = false

  /** R55-F-7（五十五轮）：非 409 持久化失败的一次性提示去重标记——对齐 useSse 的
   *  busy429Notified 惯例：同一失败窗只 warning 一次（离线改主题/排版此前全静默，
   *  重启回退无提示），成功落盘后复位，恢复后再败可再提示。 */
  let persistFailNotified = false

  /** 异步初始化：从 global.json 加载（替代 localStorage）。
   *  首次为空时从旧 localStorage 自动迁移。main.ts 在 mount 前调一次。 */
  async function init(): Promise<void> {
    let prefs: GlobalPrefs = {}
    let apiOk = false
    try {
      const r = await getGlobalPrefs()
      // R51-H-2（五十一轮）：200 但缺 prefs 字段（信封异常/旧网关代理截断）时 r.prefs 为
      // undefined——赋值后 Object.keys(undefined) 抛 TypeError，沿 main.ts mount 前的
      // top-level await 冒出，应用整体不挂载（白屏死）。`?? {}` 兜底为「空偏好」：走
      // applyPrefs 逐键守卫全跳过 = 全默认值，与 catch 的「API 不可达用默认」同口径降级。
      prefs = r.prefs ?? {}
      revision = r.revision
      revisionKnown = true
      apiOk = true
    } catch {
      /* API 不可达用默认——revision 维持未知态（R32-26：写回前重 GET 对齐） */
    }

    // 迁移：API 可达且 prefs 为空（真·首次）时才从旧 localStorage 读取。
    // R72-11（二十轮 F-3）：API 不可达不再误判「首次」——旧 localStorage 残值会覆盖
    // 展示态（服务端配置实际存在，重连后展示跳变）。迁移成功后清理旧键（对齐
    // workspace 侧已修口径），防旧残值在后续 API 不可达时再度触发伪迁移。
    if (apiOk && Object.keys(prefs).length === 0 && migrateFromLocalStorage()) {
      prefs = buildCache()
      // R35-8：迁移写内容即基线（迁移 PUT 失败时脏字段判定仍成立）。
      // R1010-P3（2026-09-10 全量重评 GLM-5.3 修复批）注记：评审曾建议「移到 PUT 落定
      // 后置位」，二阶分析后维持先行——①迁移 PUT 是裸调用不占 putInFlight 单飞槽，
      // 在途窗口内用户编辑可并发 schedulePersist → 撞 409 → recoverFromConflict 的
      // 本窗重放依赖 dirtyKeysOf 对比基线；移后 lastPersisted=null 走 R61-F-3 零脏口径
      // 会静默丢该次编辑（现行为可重放）。②先行置位保住 R61-F-3 头注「init 各完成
      // 路径均置基线」不变量。③迁移 PUT 失败的服务端缺口由 revisionKnown=false 的
      // R32-26 写前重 GET 链在下一次保存时对齐补写，无需基线参与。偏离评审建议按
      // 「证伪维持」口径在报告收口记记档。
      lastPersisted = prefs
      clearLegacyLocalStorage()
      // GG-P2-7：迁移写会 bump 服务端 revision——同步回存，否则首个用户保存带陈旧号 409
      void putGlobalPrefs(prefs).then((r) => { revision = r.revision; revisionKnown = true }).catch(() => {})
    } else {
      applyPrefs(prefs)
      lastPersisted = buildCache() // R35-8：初始服务端态即基线
    }

    applyTheme()
    applyCompact()
    apply()
  }

  /** 从旧 localStorage 迁移到 ref（仅首次 cache 为空时调）。返回是否有迁移数据。 */
  function migrateFromLocalStorage(): boolean {
    let has = false
    try {
      const t = localStorage.getItem(OLD_LS.theme)
      if (t === 'dark' || t === 'light') { theme.value = t; has = true }
      const num = (k: string): number | null => {
        const v = Number(localStorage.getItem(k))
        return Number.isFinite(v) && v > 0 ? v : null
      }
      const str = (k: string): string => localStorage.getItem(k) ?? ''
      // R1010b-FE-P3-3（2026-09-10 内存专项重审修复批）：循环变量原命名 ref 遮蔽 Vue
      // 的 ref 导入（同文件内 ref(...) 语义漂移的可读性陷阱），改名 entry——零语义变更
      for (const [k, entry, kind] of [
        [OLD_LS.size, proseSize, 'num'], [OLD_LS.lh, proseLh, 'num'],
        [OLD_LS.pageWidth, pageWidth, 'num'],
        [OLD_LS.autosaveInterval, autosaveInterval, 'num'],
        [OLD_LS.uiFontCn, uiFontCn, 'str'], [OLD_LS.uiFontEn, uiFontEn, 'str'],
        [OLD_LS.proseFontCn, proseFontCn, 'str'], [OLD_LS.proseFontEn, proseFontEn, 'str'],
      ] as const) {
        if (kind === 'num') {
          const v = num(k)
          if (v !== null) { (entry as typeof proseSize).value = v; has = true }
        } else {
          const v = str(k)
          if (v) { (entry as typeof uiFontCn).value = v; has = true }
        }
      }
      const sv = localStorage.getItem(OLD_LS.shelfView)
      if (sv === 'grid' || sv === 'list') { shelfView.value = sv; has = true }
    } catch { /* localStorage 损坏降级 */ }
    return has
  }

  /** R72-11（二十轮 F-3）：迁移完成后清理旧 localStorage 键——旧值残留会让后续
   *  「API 不可达」场景反复误判出伪迁移数据源 */
  function clearLegacyLocalStorage(): void {
    try {
      for (const key of Object.values(OLD_LS)) localStorage.removeItem(key)
    } catch { /* localStorage 不可用降级 */ }
  }

  /** 将 API 读到的 prefs 应用到各 ref。
   *  E2（复审-0914-优化修复批）：33 键手写 if 链收敛为 PREF_ROWS 表驱动逐键守卫——
   *  typeof 守卫/边界（gt/gte/lte）/round/trim/枚举白名单逐键照抄原实现，行为等价。 */
  function applyPrefs(p: GlobalPrefs): void {
    //（satisfies 保构造期逐键检查；值联合收敛回行类型供守卫循环统一读写）
    for (const row of Object.values(PREF_ROWS) as PrefRow[]) {
      const v = p[row.key]
      if (row.kind === 'num') {
        if (typeof v !== 'number') continue
        // 下界二选一（照抄原键口径）：gt = 严格大于 / gte = 含等于；缺省不设界
        if (row.gt !== undefined) {
          if (!(v > row.gt)) continue
        } else if (row.gte !== undefined) {
          if (!(v >= row.gte)) continue
        }
        if (row.lte !== undefined && !(v <= row.lte)) continue
        const r = row.r as Ref<number>
        r.value = row.round ? Math.round(v) : v
      } else if (row.kind === 'bool') {
        if (typeof v === 'boolean') {
          const r = row.r as Ref<boolean>
          r.value = v
        }
      } else if (row.kind === 'str') {
        if (typeof v === 'string') {
          const r = row.r as Ref<string>
          r.value = row.trim ? v.trim() : v
        }
      } else {
        if (typeof v === 'string' && row.values?.includes(v)) {
          const r = row.r as Ref<string>
          r.value = v
        }
      }
    }
  }

  // ── E2（复审-0914-优化修复批）：偏好键描述表（三面单源）──
  // 一张表吃三面：applyPrefs 逐键守卫 / buildCache 全量组装 / setter clamp+副作用参数。
  // 键序 = 原 buildCache 键序——JSON.stringify 按插入序序列化，PUT body 字节逐位不变
  //（「整文件重写，漏键 = 丢配置」的全量不变式由表完整性承担：行即全键）。
  // persist 键名（key）与 ref 名不同源两键：snapMaxDays→snapDays、autoBatchSize→aiBatchSize。
  // 逐键行为等价是红线：守卫边界/round/trim/白名单/setter clamp/默认值全部照抄原手写，
  // prefs 测试群（r0911-prefs-setter-table 等）回归兜底。
  interface PrefRow {
    /** global.json 持久化键名（buildCache 落 JSON 的键；applyPrefs 读信封的键） */
    key: keyof GlobalPrefs
    /** 承载 ref（名可与 key 不同源，见上注） */
    r: Ref<unknown>
    kind: 'num' | 'bool' | 'str' | 'enum'
    /** apply 数字守卫下界：v > gt（严格大于）或 v >= gte（含等于），照抄原键口径 */
    gt?: number
    gte?: number
    /** apply 数字守卫上界：v <= lte（uiFontSizeStep / checkRepeatThreshold 两键） */
    lte?: number
    /** apply 取整（Math.round；defaultVolumeSize/字数族/机检计数族） */
    round?: boolean
    /** apply/setter 首尾去空（defaultGenre/ragProvider） */
    trim?: boolean
    /** enum 白名单（theme/shelfView/styleInjection） */
    values?: readonly string[]
    /** setter 副作用族：写后 apply（排版 CSS 变量）/ applyTheme（主题+win 窗控）/
     *  applyCompact（紧凑 class）。缺省 = 纯写 + persist */
    side?: 'apply' | 'applyTheme' | 'applyCompact'
    /** setter clamp：Math.min(max, Math.max(min, Math.round(v)))（原 numSetter 同款）；
     *  缺省 = 原样赋值（setSize/setLh 字号族原口径，全部 bool/str/enum 键同） */
    set?: { min: number; max?: number }
  }

  const PREF_ROWS = {
    theme: { key: 'theme', r: theme, kind: 'enum', values: ['dark', 'light'], side: 'applyTheme' },
    proseSize: { key: 'proseSize', r: proseSize, kind: 'num', gt: 0, side: 'apply' },
    proseLh: { key: 'proseLh', r: proseLh, kind: 'num', gt: 0, side: 'apply' },
    uiFontCn: { key: 'uiFontCn', r: uiFontCn, kind: 'str', side: 'apply' },
    uiFontEn: { key: 'uiFontEn', r: uiFontEn, kind: 'str', side: 'apply' },
    // UI 字号档（外观设置；-1 小 / 0 标准 / 1 大 / 2 特大）——整条字号刻度随
    // --font-size-step 平移（apply 里写合计值）
    uiFontSizeStep: { key: 'uiFontSizeStep', r: uiFontSizeStep, kind: 'num', gte: -1, lte: 2, side: 'apply', set: { min: -1, max: 2 } },
    proseFontCn: { key: 'proseFontCn', r: proseFontCn, kind: 'str', side: 'apply' },
    proseFontEn: { key: 'proseFontEn', r: proseFontEn, kind: 'str', side: 'apply' },
    pageWidth: { key: 'pageWidth', r: pageWidth, kind: 'num', gt: 0, side: 'apply' }, // setter 手写（bookOnly 双分支）
    autosaveInterval: { key: 'autosaveInterval', r: autosaveInterval, kind: 'num', gt: 0 }, // setter 手写（同上；无 apply）
    shelfView: { key: 'shelfView', r: shelfView, kind: 'enum', values: ['grid', 'list'] },
    chatEnabled: { key: 'chatEnabled', r: chatEnabled, kind: 'bool' },
    compact: { key: 'compact', r: compact, kind: 'bool', side: 'applyCompact' },
    // 版本保留全局默认（持久化为 snapMaxDays/snapMaxCount；clamp 见 set）
    snapMaxDays: { key: 'snapMaxDays', r: snapDays, kind: 'num', gt: 0, set: { min: 1, max: 365 } },
    snapMaxCount: { key: 'snapMaxCount', r: snapCount, kind: 'num', gt: 0, set: { min: 1, max: 200 } },
    // ── 书级设定全局托底 13 键：逐键类型/范围守卫（global.json 手改脏值不进 UI，保持回落）──
    defaultGenre: { key: 'defaultGenre', r: defaultGenre, kind: 'str', trim: true },
    defaultVolumeSize: { key: 'defaultVolumeSize', r: defaultVolumeSize, kind: 'num', gte: 5, round: true, set: { min: 5, max: 500 } },
    // 目标字数/每章字数：JSON 层只存正整数（0 = 未设由 ref 初值表达），非法值保持现值
    defaultTargetWords: { key: 'defaultTargetWords', r: defaultTargetWords, kind: 'num', gt: 0, round: true, set: { min: 0 } },
    defaultChapterTargetWords: { key: 'defaultChapterTargetWords', r: defaultChapterTargetWords, kind: 'num', gt: 0, round: true, set: { min: 0 } },
    defaultShortStrict: { key: 'defaultShortStrict', r: defaultShortStrict, kind: 'bool' },
    styleInjection: { key: 'styleInjection', r: styleInjection, kind: 'enum', values: ['light', 'heavy'] },
    autoConfirmOutline: { key: 'autoConfirmOutline', r: autoConfirmOutline, kind: 'bool' },
    // ref 名与 JSON 键 autoBatchSize 不同源（避免与语义混淆）
    autoBatchSize: { key: 'autoBatchSize', r: aiBatchSize, kind: 'num', gte: 1, round: true, set: { min: 1, max: 20 } },
    callsPerChapter: { key: 'callsPerChapter', r: callsPerChapter, kind: 'num', gte: 1, round: true, set: { min: 1, max: 50 } },
    relationAutoMine: { key: 'relationAutoMine', r: relationAutoMine, kind: 'bool' },
    relationMineThreshold: { key: 'relationMineThreshold', r: relationMineThreshold, kind: 'num', gte: 1, round: true, set: { min: 1, max: 20 } },
    ragEnabled: { key: 'ragEnabled', r: ragEnabled, kind: 'bool' },
    ragProvider: { key: 'ragProvider', r: ragProvider, kind: 'str', trim: true },
    // ── R52-E-2：机检阈值五键（undefined = 未设 = 走引擎默认；apply 守卫非法值保持现值）──
    // 复读占比守 (0,1]（>1 会把全书章节判复读）；setter 浮点两位截断异形手写（见 setCheckRepeatThreshold）
    checkRepeatThreshold: { key: 'checkRepeatThreshold', r: checkRepeatThreshold, kind: 'num', gt: 0, lte: 1 },
    checkRepeatCharsThreshold: { key: 'checkRepeatCharsThreshold', r: checkRepeatCharsThreshold, kind: 'num', gt: 0, round: true, set: { min: 2, max: 1000 } },
    checkMaxSentenceLen: { key: 'checkMaxSentenceLen', r: checkMaxSentenceLen, kind: 'num', gt: 0, round: true, set: { min: 10, max: 500 } },
    checkImageryThreshold: { key: 'checkImageryThreshold', r: checkImageryThreshold, kind: 'num', gt: 0, round: true, set: { min: 1, max: 100 } },
    checkWordCountTolerance: { key: 'checkWordCountTolerance', r: checkWordCountTolerance, kind: 'num', gt: 0, set: { min: 1, max: 500 } },
  } satisfies Record<string, PrefRow>

  /** 从当前全局 ref 构建 GlobalPrefs 对象（不含书级覆盖）。
   *  E2：表驱动全量组装——键序即 JSON 键序（PUT body 字节不变），undefined 序列化时被
   *  JSON.stringify 丢弃 = 未设不覆盖盘上已有值（机检五键，与服务端合并写语义一致）。 */
  function buildCache(): GlobalPrefs {
    const out = {} as Record<keyof GlobalPrefs, unknown>
    for (const row of Object.values(PREF_ROWS) as PrefRow[]) out[row.key] = row.r.value
    return out as GlobalPrefs
  }

  /** R60-D-1（六十轮）：PUT 链占位单源——body 起跑即同步占位（R33D-24 单飞不变式：
   *  赋值先于任何宏任务可观察点，后续防抖回落只见非空重排队），链尾守卫清位（只清
   *  自己占据的占位——多路关窗冲刷/在途交叠时防误清对方的占位）。返回真链 Promise
   *  （在途/冲刷两链的 finally 不再用已 resolve 的占位符——原占位 await 即穿透，
   *  等不到 PUT 落定，flushPendingPersist 无从续链）。 */
  function runPutChain(body: () => Promise<void>): Promise<void> {
    const p = body().finally(() => {
      if (putInFlight === p) putInFlight = null
    })
    putInFlight = p
    return p
  }

  /** P3（复审-0914-优化修复批）：revision 未知态写前对齐单源——R32-26 的重 GET 块原在
   *  schedulePersist / flushPendingPersist 两处逐行双写，收敛本函数防漂移（语义零变化：
   *  已知即跳过；GET 失败照旧发 PUT，走既有 409/静默口径自愈）。 */
  async function ensureRevisionKnown(): Promise<void> {
    if (revisionKnown) return
    try {
      revision = (await getGlobalPrefs()).revision
      revisionKnown = true
    } catch { /* 网络不可达：照旧 PUT */ }
  }

  /** debounce 写回 global.json（500ms）。
   *  R32-27（三十二轮）：快照移入定时器回调（此前防抖注册即捕快照，PUT 晚 500ms 发出，
   *  与在途 PUT 交叠时旧快照后到可丢改动）+ 在途单飞（在途时重走防抖排队，完成后以
   *  届时最新快照发出）。 */
  function schedulePersist(): void {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      if (putInFlight) {
        schedulePersist() // 在途挂起排队：完成后重拍 500ms，快照届时重取
        return
      }
      runPutChain(async () => {
        // R32-26：revision 未知态（init 失败离线）首次 PUT 前重 GET 对齐——不再以 0
        // 自伤 409（ensureRevisionKnown 单源，P3 收敛）
        await ensureRevisionKnown()
        await doPersistPut()
      })
    }, 500)
  }

  /** R33D-24：实际 PUT 段抽直（占位逻辑外提）；409 恢复见 recoverFromConflict（R35-8 改写
   *  R33-73 的「整体采纳远端」口径）。 */
  async function doPersistPut(): Promise<void> {
    // 快照先于 PUT：await 窗口内的新 setter 不属于本次落盘内容，成功后按快照记基线
    const cache = buildCache()
    try {
      // GG-P2-7：带 expectedRevision 乐观并发——两面板同时保存时后写收 409 而非静默覆盖先写
      const r = await putGlobalPrefs(cache, revision)
      revision = r.revision
      revisionKnown = true
      lastPersisted = cache
      persistFailNotified = false // R55-F-7：成功落盘复位——恢复后再失败可再提示
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409) {
        // R55-F-7（五十五轮）：非 409 失败（离线/网络/5xx）不再全静默——原口径直接
        // return，离线改主题/排版不落盘、重启回退且无提示。补一次性 warning（去重
        // 见 persistFailNotified 注）；refs 已生效（展示不受影响），仅落盘滞后。
        if (!persistFailNotified) {
          persistFailNotified = true
          useUiStore().toast('全局偏好暂时未能保存（网络/服务异常），恢复后将随下次改动自动重试', 'warning')
        }
        return /* 其他错误维持既有静默口径（提示去重后不打断） */
      }
      await recoverFromConflict(cache)
    }
  }

  /** R58-B-2（五十八轮）：关窗/退出前的立即冲刷——清 500ms 防抖窗直发一次 PUT
   *  （主进程 flushRendererBeforeClose 经 window.__clwFlushPrefs 调用；revision 对齐与
   *  409 自愈口径与 schedulePersist 相同）。
   *  R60-D-1（六十轮）：在途 PUT 时原实现 `if (putInFlight) return` 空返回——关窗钩子
   *  的返回值被主进程 executeJavaScript await，视为冲刷完成即放行销毁窗口，在途 PUT
   *  快照之后的偏好改动（<500ms 防抖窗内）随定时器与窗口一同死亡。改为：等在途真链
   *  落定（其失败已由 doPersistPut/恢复链内部消化，catch 兜底防御）后清防抖定时器、
   *  按届时最新快照补一笔直发；整链作为返回 Promise 交主进程预算内等待
   *  （flushRendererWithBudget 的 FLUSH_BUDGET_TIMEOUT 兜底，超时同权放行关窗）。 */
  async function flushPendingPersist(): Promise<void> {
    if (putInFlight) {
      await putInFlight.catch(() => { /* 在途失败已消化，此处不重试 */ })
    }
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    return runPutChain(async () => {
      // R32-26：同 schedulePersist——写前重 GET 对齐未知 revision（ensureRevisionKnown 单源）
      await ensureRevisionKnown()
      await doPersistPut()
    })
  }

  /** 本窗脏字段键集：当前值与最近成功落盘快照不一致的键（R35-8 脏字段判定源）。 */
  function dirtyKeysOf(local: GlobalPrefs): string[] {
    // R61-F-3：无已持久化基线（lastPersisted 尚为 null——init 未完成/未调用态；
    // 已核对 init 各完成路径——迁移分支/else 分支含 GET 失败降级——均置基线且此后
    // 不再回 null，正常态此处不可达）时无从判定「本窗脏」，视为零脏字段：409 恢复
    // 整体采纳远端。原 Object.keys(local) 会把全量本地值（含未改动的默认值）当本窗
    // 修改回放、覆盖他窗配置 + toast「已保留本窗修改」与事实不符。409 恢复其余分支
    // 语义不变。
    if (!lastPersisted) return []
    const out: string[] = []
    for (const k of Object.keys(local)) {
      if (local[k] !== lastPersisted[k]) out.push(k)
    }
    return out
  }

  /** R35-8：409 恢复——远端值垫底 + 本窗未落盘修改重放（原 R33-73 口径 applyPrefs 整体
   *  采纳远端，本窗未落盘的修改被静默丢弃）。重试 PUT 经 await 并入调用方的 putInFlight
   *  单飞：恢复窗口内的新保存排队到重试完成后发出，不再带陈旧 revision 再吃 409。 */
  async function recoverFromConflict(localCache: GlobalPrefs): Promise<void> {
    let remote: Awaited<ReturnType<typeof getGlobalPrefs>>
    try {
      remote = await getGlobalPrefs()
    } catch {
      return /* 网络不可达保持现值，等下次 schedulePersist */
    }
    revision = remote.revision
    revisionKnown = true
    // 远端值垫底，本窗脏字段重放本地值（合并经 applyPrefs 的逐键类型/范围守卫落 refs）
    const merged: GlobalPrefs = { ...remote.prefs }
    for (const k of dirtyKeysOf(localCache)) merged[k] = localCache[k]
    applyPrefs(merged)
    // R37-27（三十七轮批E）：合并结果只写 refs 不落样式——非本窗脏的字段采纳远端新值后，
    // 排版 CSS 变量/主题 dataset/紧凑 class 仍停留在冲突前旧值，「已保留本窗修改并合并
    // 最新值」的提示弹出但样式不生效。对齐 init() 的恢复链：applyPrefs 后接三连 apply
    applyTheme()
    applyCompact()
    apply()
    const retryCache = buildCache()
    try {
      const r = await putGlobalPrefs(retryCache, revision)
      revision = r.revision
      revisionKnown = true
      lastPersisted = retryCache
      persistFailNotified = false // R55-F-7：成功落盘复位（与 doPersistPut 成功分支同口径）
      // R40-41（四十轮）：三态告知之「成功」——合并 + 重试落盘都成功才按现行口径提示
      useUiStore().toast('全局偏好已在其他窗口被修改，已保留本窗修改并合并最新值', 'warning')
    } catch {
      /* R40-41：三态告知之「已刷新+重试失败」——refs 已合并保留（本窗脏修改仍在，
       * lastPersisted 未推进 → 下次 schedulePersist 自动重试），但不得再按成功口径
       * 提示「已合并」误导作者（原实现 catch 静默 + 无条件成功 toast）。第三态
       * （GET 失败）维持上方静默：本窗值未动、无成功假象，等下次保存自动再走恢复链。 */
      useUiStore().toast('全局偏好已在其他窗口被修改，已合并最新值，但重试保存失败——本窗修改已保留，将随下次改动自动重试', 'error')
    }
  }

  // ── apply（直写 :root CSS 变量）──
  // 正文排版三件（字体/字号/行距）为全局正文偏好：设置「编辑器 → 排版」写 --prose-*，
  // 编辑区与开书对话/草稿卡等所有正文编辑框同步（2026-09-05 作者确认全局一致，
  // 不设编辑器专属作用域）。

  function apply(): void {
    const r = document.documentElement
    r.style.setProperty('--prose-size', `${proseSize.value}px`)
    r.style.setProperty('--prose-lh', String(proseLh.value))
    r.style.setProperty('--page-width', `${effectivePageWidth.value}px`)
    // J5→F0（2026-09-05）：UI 字号档（外观「字号」设置，两平台通用）——win 隐藏基准
    // 原 +1px 系 ClearType hinting 补偿（灰度时代），F0 找回原生子像素渲染后撤销归零，
    // 与 tokens 平台块同步；用户步进直接叠 0 基（内联值覆盖 CSS，此处始终写合计值）
    const baseStep = 0
    r.style.setProperty('--font-size-step', `${baseStep + uiFontSizeStep.value}px`)
    if (uiFontCn.value || uiFontEn.value) {
      r.style.setProperty('--font-ui', buildFontFamily(uiFontEn.value, uiFontCn.value, 'system-ui, sans-serif'))
    } else {
      r.style.removeProperty('--font-ui')
    }
    if (proseFontCn.value || proseFontEn.value) {
      // J5→F0c②（2026-09-05）：回退尾按中文字体族归边——衬线/书卷（宋·仿宋·楷·思源宋·
      // 文楷…）挂衬线基座带宋体，其余（雅黑/等线/黑体/思源黑…）挂无衬线基座——
      // 修「选思源黑体预设但未装 Noto 时正文静默落宋体」的跨族翻转；CN 槽空维持
      // 衬线基座（出厂空槽口径不变）。串值单源于 useSystemFonts 的 proseFallbackTail。
      r.style.setProperty('--prose-font', buildProseFontStack(proseFontCn.value, proseFontEn.value))
    } else {
      r.style.removeProperty('--prose-font')
    }
  }

  // ── 窗控 overlay 色（win）──
  // WCO 能力上限 = 实色 + 主题跟随（'transparent' 不被 Chromium 接受、按钮底色也不跟
  // nativeTheme，2026-08-31 实测）。基础色 = 两档 --background-secondary（= 顶栏底，
  // light 0xF6 / dark 0x26，灰通道三值同）。遮罩压暗期间的色 = 顶栏底被遮罩吸收后的
  // 等效色：round(bg × (1-α))，α = 当前有效遮罩浓度——各弹窗遮罩浓度不同（设置 .45、
  // 书架/导出/确认 .35、命令面板 .25，名单在 ui store MASK_ALPHA 与组件 CSS 镜像、
  // j5-overlay-dim.test.ts 锁死；多层叠开按 1-Π(1-α) 复合）。此前只有 .45 一档标定值
  // （light #878787 / dark #151515），书架等 .35 遮罩下窗控深一档即「颜色不统一」。
  /** 当前有效遮罩浓度（0 = 无遮罩，窗控还原基础色）。 */
  let overlayAlpha = 0

  function overlayColorsFor(alpha: number): { color: string; symbolColor: string; dark: boolean } {
    const dark = theme.value === 'dark'
    const bg = dark ? 0x26 : 0xf6
    const ch = Math.round(bg * (1 - alpha)).toString(16).padStart(2, '0')
    return { color: `#${ch}${ch}${ch}`, symbolColor: dark ? '#c8c8c8' : '#666666', dark }
  }
  /** 下发窗控色。非 win32 短路（测试/浏览器态）。 */
  function applyOverlayAlpha(alpha: number): void {
    const d = typeof window === 'undefined' ? undefined : window.clwritingDesktop
    if (d?.platform !== 'win32') return
    void d.setTitleBarOverlay(overlayColorsFor(alpha))
  }
  /** 瞬切到当前应有色（遮罩开关 / 主题落定）。为什么不做过渡：WCO 色是 DWM
   *  窗口属性（实色、无 alpha），不在网页合成器里——CSS/View Transition 的
   *  时间线管不到它，「跟随渐变」只能逐帧 IPC 改属性拼（2026-09-04 试过 8 帧 ×
   *  25ms：帧距被 IPC/主进程时延拉散即闪烁，整体拖过遮罩自身淡入即延迟，作者
   *  实测打回）。mac hiddenInset 交通灯没有这个问题：按钮是透明底浮在网页上方，
   *  底下像素随遮罩/主题特效逐帧自然变，无需联动——win 的等价能力只有放弃原生
   *  窗控自绘 HTML 一条路，此处维持原生 + 单拍瞬切；主题切换同理（win 不做
   *  扩散特效，见 useTheme.withThemeTransition，applyTheme 与页面同拍落定）。 */
  function syncOverlayNow(): void {
    if (typeof window === 'undefined') return
    applyOverlayAlpha(overlayAlpha)
  }

  /**
   * 弹窗遮罩联动窗控色（win）：全屏遮罩压暗页面时，系统绘制的窗控条不会被压暗——
   * 暗页面顶着一列亮块即作者反馈的「窗控突兀」。alpha = 有效遮罩浓度（0 = 还原）。
   * 与遮罩起始同刻单拍落终值（不做逐帧过渡，缘由见 syncOverlayNow）。
   */
  function setOverlayDimmed(open: boolean, alpha = 0): void {
    overlayAlpha = open ? alpha : 0
    syncOverlayNow()
  }

  /** R48-86（四十八轮）：theme-instant 压制代数——applyTheme 每次自增，rAF 回调据
   *  此判最新性（快速连切防旧回调提前摘新回调的压制 class，详见 applyTheme 注）。
   *  E6（复审-0914-优化修复批）：裸计数器换装 useStaleGuard。 */
  const themeInstantGen = useStaleGuard()

  function applyTheme(): void {
    document.documentElement.dataset.theme = theme.value
    // 窗控色与主题同一（同步）拍落定即「一起变」——win 已不做扩散特效
    //（useTheme.withThemeTransition 瞬切），原「特效期间挂起、前沿到达再切」的
    // overlaySweep 编排随 2026-09-04 拍板删除（其唯一有效平台就是 win）。
    // win 翻转拍压制全局过渡：按钮/链接基线 hover transition（--dur-fast）会在
    // 主题翻转时让全页面颜色渐变 120ms+，与瞬切的窗控条错位（作者反馈「切换
    // 配色不同步」）；翻转帧绘制完成后摘除，日常 hover 过渡不受影响。mac/浏览器
    // 走 VT 新旧快照翻转（base.css ::view-transition-*），页面本就单帧换血。
    const d = typeof window === 'undefined' ? undefined : window.clwritingDesktop
    if (d?.platform === 'win32') {
      const rootEl = document.documentElement
      rootEl.classList.add('theme-instant')
      // R48-86（四十八轮）：快速连切时两次 applyTheme 叠加——第一次的 rAF 回调会把第二
      // 次刚挂上的 theme-instant 提前摘掉（第二拍 restyle 退回渐变、与窗控错位）。回调
      // 带序号守卫：非最新代不摘 class（摘除权归最新回调），只 syncOverlayNow 让窗控
      // 色即时跟随当前主题（幂等重发无害）
      const gen = themeInstantGen.begin()
      // 窗控色延到页面新色扫描输出之后再落（双 rAF = 下一帧帧首，翻转帧已
      // present）：144Hz 帧预算 6.9ms，整页 restyle 必超预算——pre-flush 发送会让
      // 窗控恒定领先页面 1-2 帧（角落先变 = 「抢跑」，作者反馈「切换配色不同
      // 步」）。改为页面先变、窗控随即跟上（落后 ≤1 帧），跟随方向与直觉一致。
      // 遮罩路径（setOverlayDimmed）不照抄：遮罩帧已轻量化到单帧预算内
      // （ShelfModal/SettingsModal contentReady 分帧），pre-flush 发送即与遮罩
      // 同帧扫描输出，才是真同步。
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (themeInstantGen.stale(gen)) {
            syncOverlayNow()
            return
          }
          rootEl.classList.remove('theme-instant')
          syncOverlayNow()
        }),
      )
      return
    }
    syncOverlayNow()
  }

  /** 紧凑模式：给 <html> 挂 .compact，全局 CSS 用该选择器收窄间距 */
  function applyCompact(): void {
    document.documentElement.classList.toggle('compact', compact.value)
  }

  // ── setter ──
  // 表驱动（E2，复审-0914-优化修复批）：「写 ref →（side 副作用）→ schedulePersist」
  // 三段式收拢行工厂，clamp 参数（set）与副作用族（side）从 PREF_TABLE 行取——与
  // applyPrefs 守卫、buildCache 组装三面单源。2026-09-11 专项精简批的 numSetter/
  // boolSetter/strSetter/setter 四工厂由行版工厂接管（公开名/签名/边界逐键零变化，
  // 消费面含函数引用传递不动）。
  // 异形手写保留：setPageWidth / setAutosaveInterval（bookOnly 双分支双 ref 写，
  // 双 ref 无法进单行表）、setCheckRepeatThreshold（浮点两位截断）。

  /** 行 setter 的收尾两段：按行 side 挂副作用 → schedulePersist 防抖落 global.json。 */
  function finishRow(row: PrefRow): void {
    if (row.side === 'apply') apply()
    else if (row.side === 'applyTheme') applyTheme()
    else if (row.side === 'applyCompact') applyCompact()
    schedulePersist()
  }
  /** 数值行 setter：行带 set 参数时 clamp [min, max] 取整（原 numSetter 同款公式），
   *  否则原样赋值（原 setSize/setLh 字号族口径）。ref 形参联合宽型：机检四键为
   *  Ref<number|undefined>（undefined = 未设），纯 number ref 同传。 */
  const numRow = (row: PrefRow) => (v: number): void => {
    const r = row.r as Ref<number>
    r.value = row.set ? Math.min(row.set.max ?? Infinity, Math.max(row.set.min, Math.round(v))) : v
    finishRow(row)
  }
  /** 布尔行 setter：纯赋值 */
  const boolRow = (row: PrefRow) => (v: boolean): void => {
    const r = row.r as Ref<boolean>
    r.value = v
    finishRow(row)
  }
  /** 字符串行 setter：行带 trim 时首尾去空（原 { trim } 口径——setDefaultGenre/
   *  setRagProvider 写入即去空），否则纯赋值 */
  const strRow = (row: PrefRow) => (v: string): void => {
    const r = row.r as Ref<string>
    r.value = row.trim ? v.trim() : v
    finishRow(row)
  }
  /** 联合枚举行 setter：纯赋值（'grid'|'list'、'light'|'heavy'、ThemeId） */
  const enumRow = <T extends string>(row: PrefRow) => (v: T): void => {
    const r = row.r as Ref<T>
    r.value = v
    finishRow(row)
  }

  const setThemeValue = enumRow<ThemeId>(PREF_ROWS.theme)
  const setSize = numRow(PREF_ROWS.proseSize)
  const setLh = numRow(PREF_ROWS.proseLh)
  const setUiFontCn = strRow(PREF_ROWS.uiFontCn)
  const setUiFontEn = strRow(PREF_ROWS.uiFontEn)
  /** UI 字号档（-1 小 / 0 标准 / 1 大 / 2 特大）：整条字号刻度随 --font-size-step 平移 */
  const setUiFontSizeStep = numRow(PREF_ROWS.uiFontSizeStep)
  const setProseFontCn = strRow(PREF_ROWS.proseFontCn)
  const setProseFontEn = strRow(PREF_ROWS.proseFontEn)
  /** 纸张宽度：bookOnly=true 写书级覆盖，false 写全局默认（清除覆盖） */
  function setPageWidth(v: number, bookOnly = false): void {
    if (bookOnly) {
      bookPageWidth.value = v
      apply()
      // R71-29（七十一轮）：书级持久化由 workspace watch 写 prefs.json 承担——书级键
      // 不在 buildCache 内，再 schedulePersist 是纯冗余 PUT global.json（服务端无条件
      // bump revision → 双窗伪 409）
      return
    }
    pageWidth.value = v
    bookPageWidth.value = null
    apply()
    schedulePersist()
  }
  /** 自动保存间隔：bookOnly=true 写书级覆盖，false 写全局默认（清除覆盖） */
  function setAutosaveInterval(v: number, bookOnly = false): void {
    if (bookOnly) {
      bookAutosaveInterval.value = v
      // R71-29：同 setPageWidth——书级持久化归 workspace watch，跳过全局 PUT
      return
    }
    autosaveInterval.value = v
    bookAutosaveInterval.value = null
    schedulePersist()
  }
  const setShelfView = enumRow<'grid' | 'list'>(PREF_ROWS.shelfView)
  const setChatEnabled = boolRow(PREF_ROWS.chatEnabled)
  const setCompact = boolRow(PREF_ROWS.compact)
  /** 版本保留全局默认 · 保留天数（clamp 1-365；所有书统一） */
  const setSnapDays = numRow(PREF_ROWS.snapMaxDays)
  /** 版本保留全局默认 · 保留数量（clamp 1-200；所有书统一） */
  const setSnapCount = numRow(PREF_ROWS.snapMaxCount)

  // ── 书级设定全局托底 setter（clamp/trim 参数在 PREF_TABLE 行上，E2 表驱动）──

  /** 写作默认 · 题材（apply 守卫 trim；'' = 未设） */
  const setDefaultGenre = strRow(PREF_ROWS.defaultGenre)
  /** 写作默认 · 每卷章数（clamp 5-500 取整；仅长篇使用） */
  const setDefaultVolumeSize = numRow(PREF_ROWS.defaultVolumeSize)
  /** 写作默认 · 目标字数（0 = 未设，否则正整数） */
  const setDefaultTargetWords = numRow(PREF_ROWS.defaultTargetWords)
  /** 写作默认 · 每章字数（0 = 未设，否则正整数） */
  const setDefaultChapterTargetWords = numRow(PREF_ROWS.defaultChapterTargetWords)
  /** AI 机检 · 短篇严格模式（仅短篇书生效） */
  const setDefaultShortStrict = boolRow(PREF_ROWS.defaultShortStrict)
  /** AI 写作 · 文风注入强度 */
  const setStyleInjection = enumRow<'light' | 'heavy'>(PREF_ROWS.styleInjection)
  /** AI 写作 · 自动确认细纲 */
  const setAutoConfirmOutline = boolRow(PREF_ROWS.autoConfirmOutline)
  /** AI 写作 · 批量写作章数（clamp 1-20 取整） */
  const setAiBatchSize = numRow(PREF_ROWS.autoBatchSize)
  /** AI 写作 · 单章调用上限（clamp 1-50 取整） */
  const setCallsPerChapter = numRow(PREF_ROWS.callsPerChapter)
  /** 关系图 · 自动梳理 */
  const setRelationAutoMine = boolRow(PREF_ROWS.relationAutoMine)
  /** 关系图 · 章节增量阈值（clamp 1-20 取整） */
  const setRelationMineThreshold = numRow(PREF_ROWS.relationMineThreshold)
  /** 知识检索 · 启用 */
  const setRagEnabled = boolRow(PREF_ROWS.ragEnabled)
  /** 知识检索 · 提供方（apply 守卫 trim；'' = 未设） */
  const setRagProvider = strRow(PREF_ROWS.ragProvider)
  // ── R52-E-2：机检阈值五键 setter（clamp 参数在行上 → schedulePersist 防抖落 global.json）──
  /** AI 机检 · 复读占比阈值（clamp (0,1]，两位小数截断防浮点尾差入盘）——浮点截断异形，手写不进表 */
  function setCheckRepeatThreshold(v: number): void {
    checkRepeatThreshold.value = Math.min(1, Math.max(0.01, Math.round(v * 100) / 100))
    schedulePersist()
  }
  /** AI 机检 · 复读最小连续字数（clamp 2-1000 取整） */
  const setCheckRepeatCharsThreshold = numRow(PREF_ROWS.checkRepeatCharsThreshold)
  /** AI 机检 · 超长句判定长度（clamp 10-500 取整） */
  const setCheckMaxSentenceLen = numRow(PREF_ROWS.checkMaxSentenceLen)
  /** AI 机检 · 高频意象次数阈值（clamp 1-100 取整） */
  const setCheckImageryThreshold = numRow(PREF_ROWS.checkImageryThreshold)
  /** AI 机检 · 字数容差百分比（clamp 1-500 取整） */
  const setCheckWordCountTolerance = numRow(PREF_ROWS.checkWordCountTolerance)

  return {
    theme,
    proseSize,
    proseLh,
    uiFontCn,
    uiFontEn,
    uiFontSizeStep,
    proseFontCn,
    proseFontEn,
    pageWidth,
    autosaveInterval,
    shelfView,
    chatEnabled,
    compact,
    snapDays,
    snapCount,
    defaultGenre,
    defaultVolumeSize,
    defaultTargetWords,
    defaultChapterTargetWords,
    defaultShortStrict,
    styleInjection,
    autoConfirmOutline,
    aiBatchSize,
    callsPerChapter,
    relationAutoMine,
    relationMineThreshold,
    ragEnabled,
    ragProvider,
    checkRepeatThreshold,
    checkRepeatCharsThreshold,
    checkMaxSentenceLen,
    checkImageryThreshold,
    checkWordCountTolerance,
    bookPageWidth,
    bookAutosaveInterval,
    effectivePageWidth,
    effectiveAutosaveInterval,
    flushPendingPersist,
    init,
    apply,
    applyTheme,
    applyCompact,
    setOverlayDimmed,
    setThemeValue,
    setSize,
    setLh,
    setUiFontCn,
    setUiFontEn,
    setUiFontSizeStep,
    setProseFontCn,
    setProseFontEn,
    setPageWidth,
    setAutosaveInterval,
    setShelfView,
    setChatEnabled,
    setCompact,
    setSnapDays,
    setSnapCount,
    setDefaultGenre,
    setDefaultVolumeSize,
    setDefaultTargetWords,
    setDefaultChapterTargetWords,
    setDefaultShortStrict,
    setStyleInjection,
    setAutoConfirmOutline,
    setAiBatchSize,
    setCallsPerChapter,
    setRelationAutoMine,
    setRelationMineThreshold,
    setRagEnabled,
    setRagProvider,
    setCheckRepeatThreshold,
    setCheckRepeatCharsThreshold,
    setCheckMaxSentenceLen,
    setCheckImageryThreshold,
    setCheckWordCountTolerance,
  }
})
