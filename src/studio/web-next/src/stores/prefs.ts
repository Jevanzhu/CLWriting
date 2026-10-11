import { defineStore } from 'pinia'
import { ref, computed, type Ref } from 'vue'
import { getGlobalPrefs, putGlobalPrefs, type GlobalPrefs } from '../api/prefs'
import { ApiError } from '../api/client'
import { createPrefsDomEffects } from '../composables/usePrefsDomEffects'
import { notifyCrossWindow } from '../shared/cross-window'
import { useUiStore } from './ui'
import type { ThemeId } from '../types/theme'

/**
 * 全局编辑器偏好 store（主题 + 排版 + 字体 + 书架视图 + 版本保留全局默认）。
 *
 * 存储：userData/global.json（APP 级，跨书库共享；对齐 Obsidian 全局配置）。
 * 替代旧 localStorage（LevelDB 黑盒，不可编辑不可备份）。
 *
 * 书级覆盖：pageWidth / autosaveInterval 可被 .clwriting/prefs.json 覆盖。
 * effectivePageWidth = 书级 > 全局；apply 用有效值。
 * 书级覆盖的持久化由 workspace store 统一写入 prefs.json（避免双写冲突）。
 *
 * 版本保留全局默认（snapDays/snapCount → 持久化为 global.json 的 snapMaxDays/snapMaxCount）：
 * 生效链 global.json → 硬编码 14 天 / 30 个（服务端 prune 同链）；所有书统一，
 * book.yaml snapshots 书级覆盖已于砍掉。
 *
 * 书级设定全局托底（同 snapMax* 模式修正口径）：题材/每卷章数/目标字数/
 * 每章字数/短篇严格/自动梳理/增量阈值/启用检索/检索提供方 可被书覆盖；文风注入/自动
 * 确认细纲/批量章数/单章上限（AI 写作组）与版本保留已砍书级，所有书统一。
 * 生效链 book.yaml 对应键 → 此处 → 硬编码回落（ref 初值即回落，服务端合并同链）；
 * 书级覆盖存 book.yaml（「本书」页各领域的「本书使用独立设定」组开关写），不进本 store。
 *
 * 对外接口（收口）：偏好读写走泛型 get(key) / set(key, value[, bookOnly])——
 * 键类型由 PREF_ROWS 经模块级 PrefValueMap 推导，拼错键编译期红；书级覆盖与有效值为
 * 直读 ref/computed；写 DOM 与窗控变暗副作用在 composables/usePrefsDomEffects.ts。
 *
 * 初始化：main.ts 在 mount 前 await init → API 读取 → apply CSS 变量。
 * 首次为空时从旧 localStorage 自动迁移。
 *
 * 新增一个偏好键的同步清单（四面，缺一即失效）：
 *  ① 本文件 DEFAULTS 补初值（ref 初值即硬编码回落）；
 *  ② PrefValueMap 加键（值型 = 承载 ref 的值型，类型锚强制对上）；
 *  ③ PREF_ROWS 加行（key 为落盘名、kind/范围守卫、side 副作用族按需）；
 *  ④ api/prefs.ts GlobalPrefs 接口补可选字段（服务端合并链末端同链）。
 * 书级可覆盖键另需 workspace store 与 book.yaml 合并链，不属本四面。
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

// ── 泛型读写面的模块级类型锚──
// 键集 = PREF_ROWS 行名（= 消费方观念中的偏好名）；值型 = 承载 ref 的值型。store 内
// 行表以本映射逐键标注校验：缺行/多行/r 值型不符任一即编译期红，调用点键拼错同红——
// 「表抄录零失手」由类型系统承接（原批以测试钉界，测试仍保留兜底运行时行为）。
export interface PrefValueMap {
  theme: ThemeId
  proseSize: number
  proseLh: number
  uiFontCn: string
  uiFontEn: string
  /** UI 字号档（-1 小 / 0 标准 / 1 大 / 2 特大）：整条字号刻度随 --font-size-step 平移 */
  uiFontSizeStep: number
  proseFontCn: string
  proseFontEn: string
  pageWidth: number
  autosaveInterval: number
  shelfView: 'grid' | 'list'
  chatEnabled: boolean
  compact: boolean
  /** 版本保留全局默认 · 保留天数（持久化键 snapMaxDays） */
  snapDays: number
  /** 版本保留全局默认 · 保留数量（持久化键 snapMaxCount） */
  snapCount: number
  defaultGenre: string
  defaultVolumeSize: number
  defaultTargetWords: number
  defaultChapterTargetWords: number
  defaultShortStrict: boolean
  styleInjection: 'light' | 'heavy'
  autoConfirmOutline: boolean
  /** 批量写作章数默认（持久化键 autoBatchSize） */
  aiBatchSize: number
  callsPerChapter: number
  relationAutoMine: boolean
  relationMineThreshold: number
  ragEnabled: boolean
  ragProvider: string
  // ── 机检阈值五键：读面 number | undefined（undefined = 未设 = 走引擎默认）；
  // 写面恒 number（见 PrefWriteValue）──
  checkRepeatThreshold: number | undefined
  checkRepeatCharsThreshold: number | undefined
  checkMaxSentenceLen: number | undefined
  checkImageryThreshold: number | undefined
  checkWordCountTolerance: number | undefined
}

/** 泛型 get/set 的键集（= PREF_ROWS 行名 = PrefValueMap 键） */
export type PrefKey = keyof PrefValueMap
/** 可带 bookOnly 书级覆盖第三参的两键（双 ref 写，见 setPageWidth/setAutosaveInterval） */
export type BookOnlyKey = 'pageWidth' | 'autosaveInterval'
/** 泛型 set 的二元键集（除 bookOnly 双分支两键外全部行） */
export type WritablePrefKey = Exclude<PrefKey, BookOnlyKey>
/** 写面值型：机检五键读面含 undefined（= 未设），写入参数恒 number——undefined 只出现在读面 */
export type PrefWriteValue<K extends PrefKey> = PrefValueMap[K] extends number | undefined ? number : PrefValueMap[K]

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
  /** 文风注入强度默认（起唯一生效源：全局，已取消书级覆盖） */
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
  // ──：机检阈值全局托底五键（undefined = 未设 = 走引擎默认；刻意不进 DEFAULTS、
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
  /** 在途写回句柄（单飞排队判据；finally 复位） */
  let putInFlight: Promise<void> | null = null
  /** 最近一次成功落盘的服务端快照（PUT 的入参快照）——409 恢复时判定
   *  「本窗已改未落盘字段」的基线（当前 refs ≠ 此快照的字段即本窗脏字段）。 */
  let lastPersisted: GlobalPrefs | null = null

  /** 并发修订号：PUT /api/library/prefs 的 expectedRevision 依据。
   *  GET/写成功响应回传时同步（照 provider store 的维护方式），非响应式——仅供写路径用。
   * 配对未知态标记——init 失败（API 不可达）时 revision=0 是「未知」
   *  而非「服务端确为 0」，原样参与 PUT 会让首保存必 409（误报「已在其他窗口被修改」）。 */
  let revision = 0
  let revisionKnown = false

  /** 非 409 持久化失败的一次性提示去重标记——对齐 useSse 的
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
      // 200 但缺 prefs 字段（信封异常/旧网关代理截断）时 r.prefs 为
      // undefined——赋值后 Object.keys(undefined) 抛 TypeError，沿 main.ts mount 前的
      // top-level await 冒出，应用整体不挂载（白屏死）。`?? {}` 兜底为「空偏好」：走
      // applyPrefs 逐键守卫全跳过 = 全默认值，与 catch 的「API 不可达用默认」同口径降级。
      prefs = r.prefs ?? {}
      revision = r.revision
      revisionKnown = true
      apiOk = true
    } catch {
      /* API 不可达用默认——revision 维持未知态（写回前重 GET 对齐） */
    }

    // 迁移：API 可达且 prefs 为空（真·首次）时才从旧 localStorage 读取。
    // API 不可达不再误判「首次」——旧 localStorage 残值会覆盖
    // 展示态（服务端配置实际存在，重连后展示跳变）。迁移成功后清理旧键（对齐
    // workspace 侧已修口径），防旧残值在后续 API 不可达时再度触发伪迁移。
    if (apiOk && Object.keys(prefs).length === 0 && migrateFromLocalStorage()) {
      prefs = buildCache()
      // 迁移写内容即基线（迁移 PUT 失败时脏字段判定仍成立）。
      // 注记：评审曾建议「移到 PUT 落定
      // 后置位」，二阶分析后维持先行——①迁移 PUT 是裸调用不占 putInFlight 单飞槽，
      // 在途窗口内用户编辑可并发 schedulePersist → 撞 409 → recoverFromConflict 的
      // 本窗重放依赖 dirtyKeysOf 对比基线；移后 lastPersisted=null 走零脏口径
      // 会静默丢该次编辑（现行为可重放）。②先行置位保住头注「init 各完成
      // 路径均置基线」不变量。③迁移 PUT 失败的服务端缺口由 revisionKnown=false 的
      // 写前重 GET 链在下一次保存时对齐补写，无需基线参与。
      lastPersisted = prefs
      clearLegacyLocalStorage()
      // 迁移写带 expectedRevision = 上面那次 GET 的号（apiOk 即 revisionKnown）——
      // 服务端契约 PUT /api/library/prefs body {prefs, expectedRevision?}：
      // 缺失放行、不等回 409（server/api/prefs.ts revisionError 闸）。不带即全库唯一
      // 可无条件覆盖他窗同键的写：GET 与本次 PUT 之间他窗落盘的新值会被本次迁移的
      // 全量快照盖掉。带号后该情形收 409（不覆盖他窗），本地号随之陈旧 → 下一次用户保存
      // 经 recoverFromConflict 合并重试自愈。
      // 迁移写会 bump 服务端 revision——同步回存，否则首个用户保存带陈旧号 409
      void putGlobalPrefs(prefs, revision)
        .then((r) => {
          revision = r.revision
          revisionKnown = true
          notifyCrossWindow(['prefs']) // 落盘成功才广播：他窗重取时读到的是本窗已写入的值
        })
        .catch(() => {
          /* 409/网络失败：迁移值仍在 refs（展示不回退），服务端由后续保存链合并补写 */
        })
    } else {
      applyPrefs(prefs)
      lastPersisted = buildCache() // 初始服务端态即基线
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
      if (t === 'dark' || t === 'light') {
        theme.value = t
        has = true
      }
      // 逐键迁移收口为两个带载体 ref 的写函数（ref 类型即判据，无需跨形态断言）：
      // num 只收正有限数（未设/非法/空串一律不迁），str 只收非空串。
      const num = (k: string, r: Ref<number>): void => {
        const v = Number(localStorage.getItem(k))
        if (Number.isFinite(v) && v > 0) {
          r.value = v
          has = true
        }
      }
      const str = (k: string, r: Ref<string>): void => {
        const v = localStorage.getItem(k) ?? ''
        if (v) {
          r.value = v
          has = true
        }
      }
      num(OLD_LS.size, proseSize)
      num(OLD_LS.lh, proseLh)
      num(OLD_LS.pageWidth, pageWidth)
      num(OLD_LS.autosaveInterval, autosaveInterval)
      str(OLD_LS.uiFontCn, uiFontCn)
      str(OLD_LS.uiFontEn, uiFontEn)
      str(OLD_LS.proseFontCn, proseFontCn)
      str(OLD_LS.proseFontEn, proseFontEn)
      const sv = localStorage.getItem(OLD_LS.shelfView)
      if (sv === 'grid' || sv === 'list') {
        shelfView.value = sv
        has = true
      }
    } catch {
      /* localStorage 损坏降级 */
    }
    return has
  }

  /** 迁移完成后清理旧 localStorage 键——旧值残留会让后续
   *  「API 不可达」场景反复误判出伪迁移数据源 */
  function clearLegacyLocalStorage(): void {
    try {
      for (const key of Object.values(OLD_LS)) localStorage.removeItem(key)
    } catch {
      /* localStorage 不可用降级 */
    }
  }

  // ── 数值行窗口（守卫与 setter 夹取的单源）──
  /** setter 写入夹取窗：min 必给；max 缺省不封顶；round2 = 先两位小数取整再夹取
   *  （缺省整数取整）。 */
  interface ClampSpec {
    min: number
    max?: number
    round2?: boolean
  }
  /** 有夹取数值行的窗口（边界数字只在本描述里出现一次，两个消费者同源解读）：
   *  - clamp：setter 写入窗（applyPrefs 不读它，夹取归 setter）；
   *  - 守卫窗（applyPrefs 读 global.json 脏值，越界即跳过 = 保持现值）：下界缺省取
   *    clamp.min（含等于），`guardLo:'positive'` 覆盖为 v > 0——历史口径是「脏值只收正数，
   *    写入才收紧到 clamp.min」，两者本就不同，故按语义登记而非拉平数字；上界缺省不设，
   *    `guardHi:'clamp-max'` 取 clamp.max（含等于）；取整缺省不取整（脏值原样落 ref），
   *    `guardRound` = Math.round 后落 ref（脏值与写入两口径取整不同同为历史事实）。
   *  于是 clamp.min / clamp.max 一改，同界侧守卫随之跟随，不存在第二次可漏改的数字。 */
  interface NumWindowClamped {
    clamp: ClampSpec
    guardLo?: 'positive'
    guardHi?: 'clamp-max'
    guardRound?: boolean
  }
  /** 无夹取数值行（setter 原样赋值：字号族 / pageWidth / autosaveInterval）的窗口——
   *  守卫恒只收正数、无上界、不取整。类型上要求显式落成本形：既无 clamp 又无下界
   *  （全收任何 number）的行不可表达。 */
  interface NumWindowRaw {
    clamp?: undefined
    guardLo: 'positive'
    guardHi?: undefined
    guardRound?: undefined
  }
  type NumWindow = NumWindowClamped | NumWindowRaw

  /** 守卫窗判定（applyPrefs 单源调用）——缺省规则见 NumWindowClamped 头注。 */
  function guardAccepts(win: NumWindow, v: number): boolean {
    if (win.guardLo === 'positive') {
      if (!(v > 0)) return false // 脏值只收正数
    } else if (!(v >= win.clamp.min)) {
      return false // 缺省下界 = clamp.min（含等于）
    }
    if (win.guardHi === 'clamp-max' && win.clamp.max !== undefined && !(v <= win.clamp.max)) return false
    return true
  }

  /** 将 API 读到的 prefs 应用到各 ref。
   * 33 键手写 if 链收敛为 PREF_ROWS 表驱动逐键守卫——typeof 守卫/边界/取整/trim/
   * 枚举白名单逐键照抄原实现，行为等价；数值边界与取整从行窗口（NumWindow）单源派生。 */
  function applyPrefs(p: GlobalPrefs): void {
    for (const row of Object.values(PREF_ROWS)) {
      const v = p[row.key]
      if (row.kind === 'num') {
        if (typeof v !== 'number') continue
        if (!guardAccepts(row.win, v)) continue
        row.r.value = row.win.guardRound ? Math.round(v) : v
      } else if (row.kind === 'bool') {
        if (typeof v === 'boolean') row.r.value = v
      } else if (row.kind === 'str') {
        if (typeof v === 'string') row.r.value = row.trim ? v.trim() : v
      } else if (typeof v === 'string' && row.values.includes(v)) {
        // 白名单命中即落 ref：values 是 string[]，命中关系只在运行时成立（TS 不能把
        // includes 变成类型谓词），故此处把载体收成 Ref<string>——值为该键枚举子集由
        // 行白名单保证，落 ref 前已判定。
        ;(row.r as Ref<string>).value = v
      }
    }
  }

  // ── 偏好键描述表（三面单源）──
  // 一张表吃三面：applyPrefs 逐键守卫 / buildCache 全量组装 / SETTERS 写入（夹取 + 副作用）。
  // 行名改按承载 ref 名对齐（= 对外 get/set 键），JSON 持久化键仍走行内
  // key 字段（snapDays→snapMaxDays、aiBatchSize→autoBatchSize 两异名映射显式在行上）；
  // 行序 = 原 buildCache 键序——JSON.stringify 按插入序序列化，PUT body 字节逐位不变。
  // 「整文件重写，漏键 = 丢配置」的全量不变式由表完整性承担：行即全键（缺行/多行/
  // 承载 ref 值型不符任一即编译期红，调用点键拼错同红）；数值行的边界数字与取整
  // 只有一个来源——行上的 win（NumWindow，守卫与 setter 夹取同源派生）。
  // 逐键行为等价是红线：守卫边界/取整/trim/白名单/setter 夹取/默认值全部照抄原手写，
  // prefs 测试群（prefs-store / prefs-clamp-setters 等）逐键五点钉界回归兜底。

  /** 行公共面（不含承载 ref——r 的值型由 PrefValueMap 在映射面逐键钉死）。 */
  interface RowCommon {
    /** global.json 持久化键名（buildCache 落 JSON 的键；applyPrefs 读信封的键） */
    key: keyof GlobalPrefs
    /** setter 副作用族：写后 apply（排版 CSS 变量）/ applyTheme（主题+win 窗控）/
     *  applyCompact（紧凑 class）。缺省 = 纯写 + persist */
    side?: 'apply' | 'applyTheme' | 'applyCompact'
  }
  /** 行面其余字段：数值键（PrefValueMap 值型为 number 类）收成 { kind:'num'; win } 单形
   *  ——漏带 win 编译期红；非数值键按 kind 判别的三形，各自只带自己用到的字段。
   *  后者三形以 kind 单元判别收窄，applyPrefs / 行工厂按 kind 取到本形的字段。 */
  type RowSpec<K extends PrefKey> = PrefValueMap[K] extends number | undefined
    ? { kind: 'num'; win: NumWindow }
    : { kind: 'bool' } | { kind: 'str'; trim?: boolean } | { kind: 'enum'; values: readonly string[] }
  /** 行工厂入参面：行表里非数值键的声明类型是判别联合（bool/str/enum 三形），联合整体
   *  不能直接当入参（成员互不相容），故按「公共面 + 本 kind 用到的字段」收参；键与承载
   *  ref 的配对仍由调用点（SETTERS 传 PREF_ROWS.x）与行表标注保证。
   *  数值行 r 取 Ref<number | undefined>（宽型）：机检五键 ref 含 undefined（未设），
   *  纯 number ref 可赋（值型协变），无需再断言。 */
  type NumRow = RowCommon & { r: Ref<number | undefined>; win: NumWindow }
  type BoolRow = RowCommon & { r: Ref<boolean> }
  type StrRow = RowCommon & { r: Ref<string>; trim?: boolean }
  type EnumRow<T extends string> = RowCommon & { r: Ref<T> }

  const PREF_ROWS: { [K in PrefKey]: RowSpec<K> & RowCommon & { r: Ref<PrefValueMap[K]> } } = {
    theme: { key: 'theme', r: theme, kind: 'enum', values: ['dark', 'light'], side: 'applyTheme' },
    // 原样行四例（win 只有正数守卫；无夹取、无守卫上界）
    proseSize: { key: 'proseSize', r: proseSize, kind: 'num', win: { guardLo: 'positive' }, side: 'apply' },
    proseLh: { key: 'proseLh', r: proseLh, kind: 'num', win: { guardLo: 'positive' }, side: 'apply' },
    uiFontCn: { key: 'uiFontCn', r: uiFontCn, kind: 'str', side: 'apply' },
    uiFontEn: { key: 'uiFontEn', r: uiFontEn, kind: 'str', side: 'apply' },
    // UI 字号档（外观设置；-1 小 / 0 标准 / 1 大 / 2 特大）——整条字号刻度随
    // --font-size-step 平移（apply 里写合计值）；守卫上下界与夹取窗同界（guardHi 收 clamp.max）
    uiFontSizeStep: {
      key: 'uiFontSizeStep',
      r: uiFontSizeStep,
      kind: 'num',
      win: { clamp: { min: -1, max: 2 }, guardHi: 'clamp-max' },
      side: 'apply',
    },
    proseFontCn: { key: 'proseFontCn', r: proseFontCn, kind: 'str', side: 'apply' },
    proseFontEn: { key: 'proseFontEn', r: proseFontEn, kind: 'str', side: 'apply' },
    pageWidth: { key: 'pageWidth', r: pageWidth, kind: 'num', win: { guardLo: 'positive' }, side: 'apply' }, // setter 手写（bookOnly 双分支）
    autosaveInterval: { key: 'autosaveInterval', r: autosaveInterval, kind: 'num', win: { guardLo: 'positive' } }, // setter 手写（同上；无 apply）
    shelfView: { key: 'shelfView', r: shelfView, kind: 'enum', values: ['grid', 'list'] },
    chatEnabled: { key: 'chatEnabled', r: chatEnabled, kind: 'bool' },
    compact: { key: 'compact', r: compact, kind: 'bool', side: 'applyCompact' },
    // 版本保留全局默认（持久化为 snapMaxDays/snapMaxCount；夹取窗见行 win）
    snapDays: {
      key: 'snapMaxDays',
      r: snapDays,
      kind: 'num',
      win: { clamp: { min: 1, max: 365 }, guardLo: 'positive' },
    },
    snapCount: {
      key: 'snapMaxCount',
      r: snapCount,
      kind: 'num',
      win: { clamp: { min: 1, max: 200 }, guardLo: 'positive' },
    },
    // ── 书级设定全局托底 13 键：逐键类型/范围守卫（global.json 手改脏值不进 UI，保持回落）──
    defaultGenre: { key: 'defaultGenre', r: defaultGenre, kind: 'str', trim: true },
    defaultVolumeSize: {
      key: 'defaultVolumeSize',
      r: defaultVolumeSize,
      kind: 'num',
      win: { clamp: { min: 5, max: 500 }, guardRound: true },
    },
    // 目标字数/每章字数：JSON 层只存正整数（0 = 未设由 ref 初值表达），非法值保持现值
    defaultTargetWords: {
      key: 'defaultTargetWords',
      r: defaultTargetWords,
      kind: 'num',
      win: { clamp: { min: 0 }, guardLo: 'positive', guardRound: true },
    },
    defaultChapterTargetWords: {
      key: 'defaultChapterTargetWords',
      r: defaultChapterTargetWords,
      kind: 'num',
      win: { clamp: { min: 0 }, guardLo: 'positive', guardRound: true },
    },
    defaultShortStrict: { key: 'defaultShortStrict', r: defaultShortStrict, kind: 'bool' },
    styleInjection: { key: 'styleInjection', r: styleInjection, kind: 'enum', values: ['light', 'heavy'] },
    autoConfirmOutline: { key: 'autoConfirmOutline', r: autoConfirmOutline, kind: 'bool' },
    // ref 名与 JSON 键 autoBatchSize 不同源（避免与语义混淆）
    aiBatchSize: {
      key: 'autoBatchSize',
      r: aiBatchSize,
      kind: 'num',
      win: { clamp: { min: 1, max: 20 }, guardRound: true },
    },
    callsPerChapter: {
      key: 'callsPerChapter',
      r: callsPerChapter,
      kind: 'num',
      win: { clamp: { min: 1, max: 50 }, guardRound: true },
    },
    relationAutoMine: { key: 'relationAutoMine', r: relationAutoMine, kind: 'bool' },
    relationMineThreshold: {
      key: 'relationMineThreshold',
      r: relationMineThreshold,
      kind: 'num',
      win: { clamp: { min: 1, max: 20 }, guardRound: true },
    },
    ragEnabled: { key: 'ragEnabled', r: ragEnabled, kind: 'bool' },
    ragProvider: { key: 'ragProvider', r: ragProvider, kind: 'str', trim: true },
    // ──：机检阈值五键（undefined = 未设 = 走引擎默认；apply 守卫非法值保持现值）──
    // 复读占比守 (0,1]（>1 会把全书章节判复读）；浮点两位截断在夹取窗（round2），守卫上界
    // 与夹取上界同界（guardHi），脏值越 1 不收
    checkRepeatThreshold: {
      key: 'checkRepeatThreshold',
      r: checkRepeatThreshold,
      kind: 'num',
      win: { clamp: { min: 0.01, max: 1, round2: true }, guardLo: 'positive', guardHi: 'clamp-max' },
    },
    checkRepeatCharsThreshold: {
      key: 'checkRepeatCharsThreshold',
      r: checkRepeatCharsThreshold,
      kind: 'num',
      win: { clamp: { min: 2, max: 1000 }, guardLo: 'positive', guardRound: true },
    },
    checkMaxSentenceLen: {
      key: 'checkMaxSentenceLen',
      r: checkMaxSentenceLen,
      kind: 'num',
      win: { clamp: { min: 10, max: 500 }, guardLo: 'positive', guardRound: true },
    },
    checkImageryThreshold: {
      key: 'checkImageryThreshold',
      r: checkImageryThreshold,
      kind: 'num',
      win: { clamp: { min: 1, max: 100 }, guardLo: 'positive', guardRound: true },
    },
    checkWordCountTolerance: {
      key: 'checkWordCountTolerance',
      r: checkWordCountTolerance,
      kind: 'num',
      win: { clamp: { min: 1, max: 500 }, guardLo: 'positive' },
    },
  }

  /** 从当前全局 ref 构建 GlobalPrefs 对象（不含书级覆盖）。
   * 表驱动全量组装——键序即 JSON 键序（PUT body 字节不变），undefined 序列化时被
   *  JSON.stringify 丢弃 = 未设不覆盖盘上已有值（机检五键，与服务端合并写语义一致）。 */
  function buildCache(): GlobalPrefs {
    const out: GlobalPrefs = {}
    for (const row of Object.values(PREF_ROWS)) out[row.key] = row.r.value
    return out
  }

  /** PUT 链占位单源——body 起跑即同步占位（单飞不变式：
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

  /** revision 未知态写前对齐单源——的重 GET 块原在
   *  schedulePersist / flushPendingPersist 两处逐行双写，收敛本函数防漂移（语义零变化：
   *  已知即跳过；GET 失败照旧发 PUT，走既有 409/静默口径自愈）。 */
  async function ensureRevisionKnown(): Promise<void> {
    if (revisionKnown) return
    try {
      revision = (await getGlobalPrefs()).revision
      revisionKnown = true
    } catch {
      /* 网络不可达：照旧 PUT */
    }
  }

  /** debounce 写回 global.json（500ms）。
   * 快照移入定时器回调（此前防抖注册即捕快照，PUT 晚 500ms 发出，
   *  与在途 PUT 交叠时旧快照后到可丢改动）+ 在途单飞（在途时重走防抖排队，完成后以
   *  届时最新快照发出）。
   * fire 分支起始置空 persistTimer——
   *  此前回调执行完不置空，句柄停在「已 fire 的旧定时器」上恒非 null，而
   * flushPendingPersist 以 `!persistTimer` 作「无待写」判据，
   *  于是**保存过一次**的窗每次关窗都同值空写 PUT → 服务端无条件 bump revision → 其他
   *  存活窗下次保存伪 409 +「已在其他窗口被修改」误导 toast。定时器已 fire 即无待写，
   * 置空后守卫恢复原意（原注释「定时器只在冲刷内清空」正是缺口自述）。的返回
   *  真链 Promise 不变式不受影响（在途分支重排 schedulePersist 会重新武装句柄）。 */
  function schedulePersist(): void {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null // 本定时器已 fire，无待写（在途分支下方重排会重新武装）
      if (putInFlight) {
        schedulePersist() // 在途挂起排队：完成后重拍 500ms，快照届时重取
        return
      }
      void runPutChain(async () => {
        // revision 未知态（init 失败离线）首次 PUT 前重 GET 对齐——不再以 0
        // 自伤 409（ensureRevisionKnown 单源收敛）
        await ensureRevisionKnown()
        await doPersistPut()
      })
    }, 500)
  }

  /** 实际 PUT 段抽直（占位逻辑外提）；409 恢复见 recoverFromConflict（改写
   * 的「整体采纳远端」口径）。 */
  async function doPersistPut(): Promise<void> {
    // 快照先于 PUT：await 窗口内的新 setter 不属于本次落盘内容，成功后按快照记基线
    const cache = buildCache()
    try {
      // 带 expectedRevision 乐观并发——两面板同时保存时后写收 409 而非静默覆盖先写
      const r = await putGlobalPrefs(cache, revision)
      revision = r.revision
      revisionKnown = true
      lastPersisted = cache
      persistFailNotified = false // 成功落盘复位——恢复后再失败可再提示
      // 跨窗失效广播：本窗偏好已落盘 → 他窗走各自既有 GET 合并链重取（不回传值）。
      // 只在落盘成功后发——落盘前广播会让他窗 GET 到旧值且不会重试（本通道是提示，不是队列）。
      notifyCrossWindow(['prefs'])
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409) {
        // 非 409 失败（离线/网络/5xx）不再全静默——原口径直接
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

  /** 关窗/退出前的立即冲刷——清 500ms 防抖窗直发一次 PUT
   *  （主进程 flushRendererBeforeClose 经 window.__clwFlushPrefs 调用；revision 对齐与
   *  409 自愈口径与 schedulePersist 相同）。
   * 在途 PUT 时原实现 `if (putInFlight) return` 空返回——关窗钩子
   *  的返回值被主进程 executeJavaScript await，视为冲刷完成即放行销毁窗口，在途 PUT
   *  快照之后的偏好改动（<500ms 防抖窗内）随定时器与窗口一同死亡。改为：等在途真链
   *  落定（其失败已由 doPersistPut/恢复链内部消化，catch 兜底防御）后清防抖定时器、
   *  按届时最新快照补一笔直发；整链作为返回 Promise 交主进程预算内等待
   *  （flushRendererWithBudget 的 FLUSH_BUDGET_TIMEOUT 兜底，超时同权放行关窗）。 */
  async function flushPendingPersist(): Promise<void> {
    // 无待写不空写守卫（对齐 workspace.flushPendingBookPrefs 的
    // `if (!debounceTimer) return` 口径，待写标志即本 store 的 persistTimer）——书架/
    // 书库等独立窗关窗此前也无条件同值 PUT，服务端 revision 空 bump → 存活窗陈旧
    // revision 伪 409 +「已在其他窗口被修改」误导 toast。
    // 本守卫在原 schedulePersist
    // 下只兑现了一半——fire 后句柄不清空，「保存过一次」的窗恒判为有待写，仍每次关窗
    // 空写（原注释「定时器只在冲刷内清空，清后复改会重排」正是缺口自述；现已由 fire
    // 分支置空收口）。persistTimer 为空 = 确认无待写：本窗从未排过防抖写，或排过的
    // 定时器已 fire / 已被先前冲刷消费。此时不补发 PUT，但**仍等在途链落定**——刚
    // fire 出去的那笔 PUT 可能仍在途，主进程 await 本函数的语义是「冲刷完成才销毁
    // 窗口」，跳过等待会让已发出的写随窗口销毁而夭折（同源风险面）。
    if (!persistTimer) {
      if (putInFlight)
        await putInFlight.catch(() => {
          /* 在途失败已消化，此处不重试 */
        })
      return
    }
    if (putInFlight) {
      await putInFlight.catch(() => {
        /* 在途失败已消化，此处不重试 */
      })
    }
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    return runPutChain(async () => {
      // 同 schedulePersist——写前重 GET 对齐未知 revision（ensureRevisionKnown 单源）
      await ensureRevisionKnown()
      await doPersistPut()
    })
  }

  /** 本窗脏字段键集：当前值与最近成功落盘快照不一致的键（脏字段判定源）。 */
  function dirtyKeysOf(local: GlobalPrefs): string[] {
    // 无已持久化基线（lastPersisted 尚为 null——init 未完成/未调用态；
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

  /** 409 恢复——远端值垫底 + 本窗未落盘修改重放（原口径 applyPrefs 整体
   *  采纳远端，本窗未落盘的修改被静默丢弃）。重试 PUT 经 await 并入调用方的 putInFlight
   *  单飞：恢复窗口内的新保存排队到重试完成后发出，不再带陈旧 revision 再吃 409。
   *  本链自身还有 GET + 重试 PUT 两段 await 窗口，窗口内本窗新编辑只存在于 refs
   *  （localCache 是本笔 PUT 的快照，不含它们）：除按基线重放快照时的脏字段外，还须把
   *  「当前 refs ≠ 快照」的键以当前值覆盖进 merged，否则 applyPrefs 把它们回退成远端值，
   *  且回退态随即成为重试 PUT 的 body 与 lastPersisted 基线（编辑静默丢失 + 基线记错）。 */
  async function recoverFromConflict(localCache: GlobalPrefs): Promise<void> {
    let remote: Awaited<ReturnType<typeof getGlobalPrefs>>
    try {
      remote = await getGlobalPrefs()
    } catch {
      return /* 网络不可达保持现值，等下次 schedulePersist */
    }
    revision = remote.revision
    revisionKnown = true
    // 当前 refs = 「本窗最后意图」（快照后可能又改过）；与 localCache 不等的键即快照
    // 之后（含本 GET 在途）新改的键，合并时以当前值覆盖远端值。
    const current = buildCache()
    // 远端值垫底，本窗脏字段重放本地值（合并经 applyPrefs 的逐键类型/范围守卫落 refs）
    const merged: GlobalPrefs = { ...remote.prefs }
    for (const k of dirtyKeysOf(localCache)) merged[k] = localCache[k]
    for (const k of Object.keys(current)) {
      if (current[k] !== localCache[k]) merged[k] = current[k]
    }
    applyPrefs(merged)
    // 合并结果只写 refs 不落样式——非本窗脏的字段采纳远端新值后，
    // 排版 CSS 变量/主题 dataset/紧凑 class 仍停留在冲突前旧值，「已保留本窗修改并合并
    // 最新值」的提示弹出但样式不生效。对齐 init 的恢复链：applyPrefs 后接三连 apply
    applyTheme()
    applyCompact()
    apply()
    const retryCache = buildCache()
    try {
      const r = await putGlobalPrefs(retryCache, revision)
      revision = r.revision
      revisionKnown = true
      lastPersisted = retryCache
      persistFailNotified = false // 成功落盘复位（与 doPersistPut 成功分支同口径）
      notifyCrossWindow(['prefs']) // 合并重试已落盘：他窗按各自脏键合并链重取（同 doPersistPut）
      // 三态告知之「成功」——合并 + 重试落盘都成功才按现行口径提示
      useUiStore().toast('全局偏好已在其他窗口被修改，已保留本窗修改并合并最新值', 'warning')
    } catch {
      /* 三态告知之「已刷新+重试失败」——refs 已合并保留（本窗脏修改仍在，
       * lastPersisted 未推进 → 下次 schedulePersist 自动重试），但不得再按成功口径
       * 提示「已合并」误导作者（原实现 catch 静默 + 无条件成功 toast）。第三态
       * （GET 失败）维持上方静默：本窗值未动、无成功假象，等下次保存自动再走恢复链。 */
      useUiStore().toast(
        '全局偏好已在其他窗口被修改，已合并最新值，但重试保存失败——本窗修改已保留，将随下次改动自动重试',
        'error',
      )
    }
  }

  /** 跨窗失效通知的刷新入口（收到他窗 prefs 落盘广播时本窗重取）。
   *
   * 为什么是「失效通知」而不是「数据同步」：广播载荷不携带任何偏好值，本函数只把它当
   * 失效信号，重走既有 GET + applyPrefs 逐键守卫 + 脏键合并链——远端值垫底、本窗未落盘
   * 脏键重放覆盖。于是既不绕过 revision 乐观并发闸（不把别窗值直接写进 refs 造成
   * 「本窗未保存编辑被静默覆盖」），也不吃本窗脏键（红线）。
   *
   * 为什么不复用 recoverFromConflict：那条链尾接着重试 PUT + 「已在其他窗口被修改」toast。
   * 本链不是冲突（没有任何本窗写失败），PUT 会把刚采纳的远端值原样写回并 bump 服务端
   * revision → 他窗再收广播 → 写回环 + 误导提示。故只读不写。
   *
   * 基线推进只对非脏键（值确实随远端改了）：不推进则下次 409 恢复会把「已被采纳的远端
   * 旧值」误判成本窗脏字段重放，反过来盖掉他窗更新的值（跨窗反向覆盖）。脏键保持旧基线
   * → 仍判脏 → 下次保存链照旧重放/补写，本窗编辑不丢。 */
  async function refreshOnRemoteChange(): Promise<void> {
    let remote: Awaited<ReturnType<typeof getGlobalPrefs>>
    try {
      remote = await getGlobalPrefs()
    } catch {
      return /* 网络不可达：保持现值，等下次通知/保存链自愈（与 recoverFromConflict 同口径） */
    }
    revision = remote.revision
    revisionKnown = true
    // current 取在 await 之后：GET 在途期间的本窗新编辑（≠ 基线）同样判脏而被保留
    const current = buildCache()
    const dirty = new Set(dirtyKeysOf(current))
    // 远端值垫底，本窗脏键重放（合并经 applyPrefs 的逐键类型/范围守卫落 refs）
    const merged: GlobalPrefs = { ...remote.prefs }
    for (const k of Object.keys(current)) {
      if (dirty.has(k)) merged[k] = current[k]
    }
    applyPrefs(merged)
    // 采纳远端值后样式必须随落——排版 CSS 变量/主题 dataset/紧凑 class 不得停在旧值
    // （对齐 init 与 recoverFromConflict 的 applyPrefs 后三连）
    applyTheme()
    applyCompact()
    apply()
    if (lastPersisted) {
      // 采纳后的实际值（applyPrefs 守卫可能回落到本窗现值）= 服务端已知态，作非脏键新基线
      const after = buildCache()
      const next: GlobalPrefs = { ...lastPersisted }
      for (const k of Object.keys(after)) {
        if (!dirty.has(k)) next[k] = after[k]
      }
      lastPersisted = next
    }
  }

  // ── （批次续）：写 DOM 与窗控变暗副作用迁出 store——
  // applyTheme/setOverlayDimmed（含挂/摘过渡压制 class 的 classList.add('theme-instant')
  // / classList.remove('theme-instant') 两行，本体在 shared/theme-apply.ts）与
  // apply/applyCompact 本体移至 ../composables/usePrefsDomEffects.ts（createPrefsDomEffects
  // 工厂收 prefs refs，行为零变化）；setup 内同步解构接线——usePrefsStore 首次实例化
  // 即接好，init 在 main.ts mount 前调用，启动写 DOM 时序不晚于原实现（无启动闪主题）。
  // overlay-dim.test.ts 对本文件的 theme-instant 源码锁由本注记承接，base.css 的
  // html.theme-instant 规则改名须三处同步（base.css / shared/theme-apply.ts / 本注记）。
  const { apply, applyTheme, applyCompact, setOverlayDimmed } = createPrefsDomEffects({
    theme,
    proseSize,
    proseLh,
    effectivePageWidth,
    uiFontSizeStep,
    uiFontCn,
    uiFontEn,
    proseFontCn,
    proseFontEn,
    compact,
  })

  // ── setter（收口）──
  // 表驱动：「写 ref →（side 副作用）→ schedulePersist」
  // 三段式收拢行工厂，夹取窗（win.clamp）与副作用族（side）从 PREF_ROWS 行取——与
  // applyPrefs 守卫、buildCache 组装三面单源。行工厂之上再收一层：同构 setter 收进
  // SETTERS 键控映射，经泛型 set(key, value) 单出口（键类型由 PrefValueMap 推导，
  // 拼错键编译期红）；异形保留：setPageWidth / setAutosaveInterval（bookOnly 双分支
  // 双 ref 写，双 ref 无法进单行表——泛型 set 的第三参分支落点）。

  /** 行 setter 的收尾两段：按行 side 挂副作用 → schedulePersist 防抖落 global.json。 */
  function finishRow(row: RowCommon): void {
    if (row.side === 'apply') apply()
    else if (row.side === 'applyTheme') applyTheme()
    else if (row.side === 'applyCompact') applyCompact()
    schedulePersist()
  }
  /** 数值行 setter：行带夹取窗时 clamp [min, max]（先取整后夹取：缺省 Math.round，
   *  round2 = Math.round(v*100)/100 两位小数），否则原样赋值（字号族 / pageWidth /
   *  autosaveInterval 的「原样」口径）。夹取参数与 applyPrefs 守卫同源自行 win。 */
  const numRow =
    (row: NumRow) =>
    (v: number): void => {
      const clamp = row.win.clamp
      row.r.value = clamp
        ? Math.min(clamp.max ?? Infinity, Math.max(clamp.min, clamp.round2 ? Math.round(v * 100) / 100 : Math.round(v)))
        : v
      finishRow(row)
    }
  /** 布尔行 setter：纯赋值 */
  const boolRow =
    (row: BoolRow) =>
    (v: boolean): void => {
      row.r.value = v
      finishRow(row)
    }
  /** 字符串行 setter：行带 trim 时首尾去空（defaultGenre/ragProvider 写入即去空），
   *  否则纯赋值 */
  const strRow =
    (row: StrRow) =>
    (v: string): void => {
      row.r.value = row.trim ? v.trim() : v
      finishRow(row)
    }
  /** 联合枚举行 setter：纯赋值（'grid'|'list'、'light'|'heavy'、ThemeId） */
  const enumRow =
    <T extends string>(row: EnumRow<T>) =>
    (v: T): void => {
      row.r.value = v
      finishRow(row)
    }

  /** 31 个同构行的键控 setter 映射（键 = 行名 = PrefKey；set 的分发出口）。映射标注
   *  与 WritablePrefKey 逐键校验：缺行/多行/值型不符编译期红。 */
  const SETTERS: { [K in WritablePrefKey]: (v: PrefWriteValue<K>) => void } = {
    theme: enumRow<ThemeId>(PREF_ROWS.theme),
    proseSize: numRow(PREF_ROWS.proseSize),
    proseLh: numRow(PREF_ROWS.proseLh),
    uiFontCn: strRow(PREF_ROWS.uiFontCn),
    uiFontEn: strRow(PREF_ROWS.uiFontEn),
    /** UI 字号档（-1 小 / 0 标准 / 1 大 / 2 特大）：整条字号刻度随 --font-size-step 平移 */
    uiFontSizeStep: numRow(PREF_ROWS.uiFontSizeStep),
    proseFontCn: strRow(PREF_ROWS.proseFontCn),
    proseFontEn: strRow(PREF_ROWS.proseFontEn),
    shelfView: enumRow<'grid' | 'list'>(PREF_ROWS.shelfView),
    chatEnabled: boolRow(PREF_ROWS.chatEnabled),
    compact: boolRow(PREF_ROWS.compact),
    /** 版本保留全局默认（clamp 1-365 / 1-200；所有书统一） */
    snapDays: numRow(PREF_ROWS.snapDays),
    snapCount: numRow(PREF_ROWS.snapCount),
    // ── 书级设定全局托底 setter（clamp/trim 参数在 PREF_ROWS 行上表驱动）──
    defaultGenre: strRow(PREF_ROWS.defaultGenre),
    defaultVolumeSize: numRow(PREF_ROWS.defaultVolumeSize),
    defaultTargetWords: numRow(PREF_ROWS.defaultTargetWords),
    defaultChapterTargetWords: numRow(PREF_ROWS.defaultChapterTargetWords),
    defaultShortStrict: boolRow(PREF_ROWS.defaultShortStrict),
    styleInjection: enumRow<'light' | 'heavy'>(PREF_ROWS.styleInjection),
    autoConfirmOutline: boolRow(PREF_ROWS.autoConfirmOutline),
    aiBatchSize: numRow(PREF_ROWS.aiBatchSize),
    callsPerChapter: numRow(PREF_ROWS.callsPerChapter),
    relationAutoMine: boolRow(PREF_ROWS.relationAutoMine),
    relationMineThreshold: numRow(PREF_ROWS.relationMineThreshold),
    ragEnabled: boolRow(PREF_ROWS.ragEnabled),
    ragProvider: strRow(PREF_ROWS.ragProvider),
    // ──：机检阈值五键（夹取窗在行 win 上 → schedulePersist 防抖落 global.json；
    // checkRepeatThreshold 浮点两位截断在行 win.clamp.round2）──
    checkRepeatThreshold: numRow(PREF_ROWS.checkRepeatThreshold),
    checkRepeatCharsThreshold: numRow(PREF_ROWS.checkRepeatCharsThreshold),
    checkMaxSentenceLen: numRow(PREF_ROWS.checkMaxSentenceLen),
    checkImageryThreshold: numRow(PREF_ROWS.checkImageryThreshold),
    checkWordCountTolerance: numRow(PREF_ROWS.checkWordCountTolerance),
  }

  /** 纸张宽度：bookOnly=true 写书级覆盖，false 写全局默认（清除覆盖）——泛型 set 的
   *  pageWidth 分支落点。 */
  function setPageWidth(v: number, bookOnly = false): void {
    if (bookOnly) {
      bookPageWidth.value = v
      apply()
      // 书级持久化由 workspace watch 写 prefs.json 承担——书级键
      // 不在 buildCache 内，再 schedulePersist 是纯冗余 PUT global.json（服务端无条件
      // bump revision → 双窗伪 409）
      return
    }
    pageWidth.value = v
    bookPageWidth.value = null
    apply()
    schedulePersist()
  }
  /** 自动保存间隔：bookOnly=true 写书级覆盖，false 写全局默认（清除覆盖）——泛型 set 的
   *  autosaveInterval 分支落点。 */
  function setAutosaveInterval(v: number, bookOnly = false): void {
    if (bookOnly) {
      bookAutosaveInterval.value = v
      // 同 setPageWidth——书级持久化归 workspace watch，跳过全局 PUT
      return
    }
    autosaveInterval.value = v
    bookAutosaveInterval.value = null
    schedulePersist()
  }

  /** 泛型读：取承载 ref 的 .value——在 computed/watch/渲染效应内调用照常建立响应依赖
   *  （等价旧 ref 直读面）。键类型由 PrefValueMap 推导，拼错键编译期红。 */
  function get<K extends PrefKey>(key: K): PrefValueMap[K] {
    return PREF_ROWS[key].r.value
  }

  /** 泛型写：31 键走 SETTERS 行工厂（夹取/trim/副作用逐键同旧平铺 setter）；pageWidth/
   *  autosaveInterval 两键带 bookOnly 书级覆盖第三参（缺省 false）。两个重载把「哪些键
   *  带第三参」钉进类型面：二元键传第三参、值型不符均编译期红（重载 1 先试——只有
   *  bookOnly 两键吃第三参；非 bookOnly 键落重载 2，无第三参位）。 */
  function set<K extends BookOnlyKey>(key: K, value: number, bookOnly?: boolean): void
  function set<K extends PrefKey>(key: K, value: PrefWriteValue<K>): void
  function set(key: PrefKey, value: unknown, bookOnly?: boolean): void {
    if (key === 'pageWidth') {
      setPageWidth(value as number, bookOnly ?? false) // 重载 1 保证 number/bookOnly
      return
    }
    if (key === 'autosaveInterval') {
      setAutosaveInterval(value as number, bookOnly ?? false)
      return
    }
    // key 已排除 bookOnly 两键（控制流收窄到 WritablePrefKey）；实现体必须兼容重载 1
    // 的 (number, bookOnly?) 形态故 value 只能取宽型——键值配对由重载面保证，此处把
    // 宽型 value 交回键控映射（唯一的值面收窄：收到「可写键的值型并集」，非 any）。
    writeWritable(key, value as PrefWriteValue<WritablePrefKey>)
  }

  /** SETTERS 的分发口：泛型 K 下索引映射得该键的 setter 型（联合键索引得联合函数型，
   *  调用联合函数要求参数取交集——那是本文件要避免的形态）——本函数用泛型把相关性留住，
   *  调用方 set 的实现体只需一次值面收窄。 */
  function writeWritable<K extends WritablePrefKey>(key: K, value: PrefWriteValue<K>): void {
    SETTERS[key](value)
  }

  return {
    // ── 泛型读写面（键类型由 PrefValueMap 推导；pageWidth/autosaveInterval 带书级覆盖第三参）──
    get,
    set,
    // ── 书级覆盖与有效值（不进 PREF_ROWS：持久化归 workspace 的 prefs.json，消费方直写 ref）──
    bookPageWidth,
    bookAutosaveInterval,
    effectivePageWidth,
    effectiveAutosaveInterval,
    // ── 生命周期与冲刷 ──
    init,
    flushPendingPersist,
    /** 跨窗失效刷新（收到他窗 prefs 落盘广播时调用）：GET + 脏键合并，不落盘（见其注） */
    refreshOnRemoteChange,
    // ── 副作用句柄（本体在 composables/usePrefsDomEffects.ts；受保护消费方经 store 出口：
    // workspace.ts 直调 apply，ui.ts 遮罩链直调 setOverlayDimmed——两者签名逐位不变）──
    apply,
    setOverlayDimmed,
  }
})
