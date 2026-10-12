import { ref, type Ref } from 'vue'
import type { GlobalPrefs } from '../api/prefs'
import type { ThemeId } from '../types/theme'

/**
 * prefs 键表与读写面单源（自 stores/prefs.ts 拆出，纯移动/行为零变化）。
 *
 * 本件收「键 × 行为」的表驱动面四件：①默认值锚 + 类型锚（PREF_DEFAULTS / PrefValueMap）；
 * ②承载 ref 工厂（createPrefRefs）；③行表 PREF_ROWS 与守卫窗 NumWindow、逐键守卫应用
 * （applyPrefsTo）与全量组装（snapshotRows）；④行 setter 工厂（createRowSetters）。
 * store 侧只剩编排壳：建 refs、接线 DOM 副作用与持久化单飞链、泛型 get/set 出口、
 * 书级覆盖两键与生命周期出口。
 *
 * 新增一个偏好键的同步清单（四面，缺一即失效）：
 *  ① 本文件 PREF_DEFAULTS 补初值（ref 初值即硬编码回落）；
 *  ② 本文件 PrefValueMap 加键（值型 = 承载 ref 的值型，类型锚强制对上）；
 *  ③ 本文件 PREF_ROWS 加行（key 为落盘名、kind/范围守卫、side 副作用族按需）；
 *  ④ api/prefs.ts GlobalPrefs 接口补可选字段（服务端合并链末端同链）。
 * 书级可覆盖键另需 workspace store 与 book.yaml 合并链，不属本四面。
 *
 * 数值行的边界数字与取整只有一个来源——行上的 win（NumWindow，守卫与 setter 夹取同源
 * 派生）；逐键行为等价是红线，prefs 测试群（prefs-store / prefs-clamp-setters /
 * prefs-generic-getset 等）逐键五点钉界回归兜底。
 */

/** 各键硬编码回落初值（ref 初值即回落；书级未设时消费方直接落到这里）。 */
export const PREF_DEFAULTS = {
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
  // 全表唯一缺省 true 的键——其余「功能开关」缺省 false，本键语义是「默认开启、显式才关」
  knowledgeInjection: true,
}

// ── 泛型读写面的模块级类型锚──
// 键集 = PREF_ROWS 行名（= 消费方观念中的偏好名）；值型 = 承载 ref 的值型。行表以本
// 映射逐键标注校验：缺行/多行/r 值型不符任一即编译期红，调用点键拼错同红——
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
  /** 知识层方法参考自动注入默认（书级 auto.knowledge_injection；缺省 true = 注入） */
  knowledgeInjection: boolean
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
/** 可带 bookOnly 书级覆盖第三参的两键（双 ref 写，见 store 的 setPageWidth/setAutosaveInterval） */
export type BookOnlyKey = 'pageWidth' | 'autosaveInterval'
/** 泛型 set 的二元键集（除 bookOnly 双分支两键外全部行） */
export type WritablePrefKey = Exclude<PrefKey, BookOnlyKey>
/** 写面值型：机检五键读面含 undefined（= 未设），写入参数恒 number——undefined 只出现在读面 */
export type PrefWriteValue<K extends PrefKey> = PrefValueMap[K] extends number | undefined ? number : PrefValueMap[K]

/** 全量承载 ref 面（34 键；键集/值型由 PrefValueMap 钉死）。 */
export type PrefRefs = { [K in PrefKey]: Ref<PrefValueMap[K]> }

/** 承载 ref 工厂：初值即硬编码回落（见 PREF_DEFAULTS）；机检五键初值 undefined = 未设。 */
export function createPrefRefs(): PrefRefs {
  return {
    theme: ref<ThemeId>(PREF_DEFAULTS.theme),
    proseSize: ref(PREF_DEFAULTS.proseSize),
    proseLh: ref(PREF_DEFAULTS.proseLh),
    uiFontCn: ref(''),
    uiFontEn: ref(''),
    /** UI 字号档（外观设置；-1 小 / 0 标准 / 1 大 / 2 特大）——整条字号刻度随
     *  --font-size-step 平移，平台基准（win +1px）之上叠加。两平台通用。 */
    uiFontSizeStep: ref(0),
    proseFontCn: ref(''),
    proseFontEn: ref(''),
    pageWidth: ref(PREF_DEFAULTS.pageWidth),
    autosaveInterval: ref(PREF_DEFAULTS.autosaveInterval),
    shelfView: ref<'grid' | 'list'>(PREF_DEFAULTS.shelfView),
    /** 对话助手开关（默认关闭） */
    chatEnabled: ref(PREF_DEFAULTS.chatEnabled),
    /** 紧凑模式：收窄侧栏间距 / 减小列表行高（默认关闭） */
    compact: ref(PREF_DEFAULTS.compact),
    /** 版本保留全局默认（天数/数量；持久化为 snapMaxDays/snapMaxCount，所有书统一） */
    snapDays: ref(PREF_DEFAULTS.snapDays),
    snapCount: ref(PREF_DEFAULTS.snapCount),
    // ── 书级设定全局托底（书级 book.yaml 未设时的展示/生效值；持久化为 global.json 14 键）──
    /** 题材默认（'' = 未设；书级 book.genre） */
    defaultGenre: ref(PREF_DEFAULTS.defaultGenre),
    /** 每卷章数默认（仅长篇使用；书级 book.volume_size） */
    defaultVolumeSize: ref(PREF_DEFAULTS.defaultVolumeSize),
    /** 目标字数默认（0 = 未设；书级 book.target_words） */
    defaultTargetWords: ref(PREF_DEFAULTS.defaultTargetWords),
    /** 每章字数默认（0 = 未设；书级 book.chapter_target_words） */
    defaultChapterTargetWords: ref(PREF_DEFAULTS.defaultChapterTargetWords),
    /** 短篇严格模式默认（仅短篇书生效；书级 short.strict） */
    defaultShortStrict: ref(PREF_DEFAULTS.defaultShortStrict),
    /** 文风注入强度默认（起唯一生效源：全局，已取消书级覆盖） */
    styleInjection: ref<'light' | 'heavy'>(PREF_DEFAULTS.styleInjection),
    /** 自动确认细纲默认（书级 auto.confirm_outline） */
    autoConfirmOutline: ref(PREF_DEFAULTS.autoConfirmOutline),
    /** 批量写作章数默认（书级 auto.batch_size；注意 ref 名与 JSON 键 autoBatchSize 不同，避免与语义混淆） */
    aiBatchSize: ref(PREF_DEFAULTS.autoBatchSize),
    /** 单章调用上限默认（书级 budget.calls_per_chapter） */
    callsPerChapter: ref(PREF_DEFAULTS.callsPerChapter),
    /** 关系图自动梳理默认（书级 auto.relation_auto_mine） */
    relationAutoMine: ref(PREF_DEFAULTS.relationAutoMine),
    /** 关系图章节增量阈值默认（书级 auto.relation_mine_threshold） */
    relationMineThreshold: ref(PREF_DEFAULTS.relationMineThreshold),
    /** 知识检索启用默认（书级 rag.enabled） */
    ragEnabled: ref(PREF_DEFAULTS.ragEnabled),
    /** 知识检索提供方默认（'' = 未设；书级 rag.provider，引用应用级 RAG 提供方 id） */
    ragProvider: ref(PREF_DEFAULTS.ragProvider),
    /** 知识层方法参考注入默认（缺省 true = 写稿/三审自动注入知识层语料） */
    knowledgeInjection: ref(PREF_DEFAULTS.knowledgeInjection),
    // ── 机检阈值全局托底五键（undefined = 未设 = 走引擎默认；刻意不进 PREF_DEFAULTS、
    // 无硬编码托底值——引擎默认参数即最终回落，与 defaultTargetWords 的「0 = 未设」不同源）──
    /** 复读占比阈值默认（0-1 小数；书级 checks.repeat_threshold） */
    checkRepeatThreshold: ref<number | undefined>(undefined),
    /** 复读最小连续字数默认（正整数；书级 checks.repeat_chars_threshold） */
    checkRepeatCharsThreshold: ref<number | undefined>(undefined),
    /** 超长句判定长度默认（正整数；书级 checks.max_sentence_len） */
    checkMaxSentenceLen: ref<number | undefined>(undefined),
    /** 高频意象报黄次数阈值默认（正整数；书级 checks.imagery_threshold） */
    checkImageryThreshold: ref<number | undefined>(undefined),
    /** 字数容差百分比默认（正数；书级 checks.word_count_tolerance） */
    checkWordCountTolerance: ref<number | undefined>(undefined),
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
 *  - clamp：setter 写入窗（applyPrefsTo 不读它，夹取归 setter）；
 *  - 守卫窗（applyPrefsTo 读 global.json 脏值，越界即跳过 = 保持现值）：下界缺省取
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

/** 守卫窗判定（applyPrefsTo 单源调用）——缺省规则见 NumWindowClamped 头注。 */
function guardAccepts(win: NumWindow, v: number): boolean {
  if (win.guardLo === 'positive') {
    if (!(v > 0)) return false // 脏值只收正数
  } else if (!(v >= win.clamp.min)) {
    return false // 缺省下界 = clamp.min（含等于）
  }
  if (win.guardHi === 'clamp-max' && win.clamp.max !== undefined && !(v <= win.clamp.max)) return false
  return true
}

/** 行公共面（不含承载 ref——r 的值型由 PrefValueMap 在映射面逐键钉死）。 */
interface RowCommon {
  /** global.json 持久化键名（snapshotRows 落 JSON 的键；applyPrefsTo 读信封的键） */
  key: keyof GlobalPrefs
  /** setter 副作用族：写后 apply（排版 CSS 变量）/ applyTheme（主题+win 窗控）/
   *  applyCompact（紧凑 class）。缺省 = 纯写 + persist */
  side?: 'apply' | 'applyTheme' | 'applyCompact'
}
/** 行面其余字段：数值键（PrefValueMap 值型为 number 类）收成 { kind:'num'; win } 单形
 *  ——漏带 win 编译期红；非数值键按 kind 判别的三形，各自只带自己用到的字段。
 *  后者三形以 kind 单元判别收窄，applyPrefsTo / 行工厂按 kind 取到本形的字段。 */
type RowSpec<K extends PrefKey> = PrefValueMap[K] extends number | undefined
  ? { kind: 'num'; win: NumWindow }
  : { kind: 'bool' } | { kind: 'str'; trim?: boolean } | { kind: 'enum'; values: readonly string[] }
/** 行工厂入参面：行表里非数值键的声明类型是判别联合（bool/str/enum 三形），联合整体
 *  不能直接当入参（成员互不相容），故按「公共面 + 本 kind 用到的字段」收参；键与承载
 *  ref 的配对仍由调用点（createRowSetters 传 rows.x）与行表标注保证。
 *  数值行 r 取 Ref<number | undefined>（宽型）：机检五键 ref 含 undefined（未设），
 *  纯 number ref 可赋（值型协变），无需再断言。 */
type NumRow = RowCommon & { r: Ref<number | undefined>; win: NumWindow }
type BoolRow = RowCommon & { r: Ref<boolean> }
type StrRow = RowCommon & { r: Ref<string>; trim?: boolean }
type EnumRow<T extends string> = RowCommon & { r: Ref<T> }

/** 行表类型：全键行（键集 = PrefKey，逐键值型由 PrefValueMap 对上）。 */
export type PrefRows = { [K in PrefKey]: RowSpec<K> & RowCommon & { r: Ref<PrefValueMap[K]> } }

// ── 偏好键描述表（三面单源）──
// 一张表吃三面：applyPrefsTo 逐键守卫 / snapshotRows 全量组装 / createRowSetters 写入
// （夹取 + 副作用）。行名按承载 ref 名对齐（= 对外 get/set 键），JSON 持久化键仍走行内
// key 字段（snapDays→snapMaxDays、aiBatchSize→autoBatchSize 两异名映射显式在行上）；
// 行序 = buildCache 键序（JSON.stringify 按插入序序列化，PUT body 字节逐位不变）。
// 「整文件重写，漏键 = 丢配置」的全量不变式由表完整性承担：行即全键（缺行/多行/
// 承载 ref 值型不符任一即编译期红，调用点键拼错同红）。
export function createPrefRows(refs: PrefRefs): PrefRows {
  return {
    theme: { key: 'theme', r: refs.theme, kind: 'enum', values: ['dark', 'light'], side: 'applyTheme' },
    // 原样行四例（win 只有正数守卫；无夹取、无守卫上界）
    proseSize: { key: 'proseSize', r: refs.proseSize, kind: 'num', win: { guardLo: 'positive' }, side: 'apply' },
    proseLh: { key: 'proseLh', r: refs.proseLh, kind: 'num', win: { guardLo: 'positive' }, side: 'apply' },
    uiFontCn: { key: 'uiFontCn', r: refs.uiFontCn, kind: 'str', side: 'apply' },
    uiFontEn: { key: 'uiFontEn', r: refs.uiFontEn, kind: 'str', side: 'apply' },
    // UI 字号档（外观设置；-1 小 / 0 标准 / 1 大 / 2 特大）——整条字号刻度随
    // --font-size-step 平移（apply 里写合计值）；守卫上下界与夹取窗同界（guardHi 收 clamp.max）
    uiFontSizeStep: {
      key: 'uiFontSizeStep',
      r: refs.uiFontSizeStep,
      kind: 'num',
      win: { clamp: { min: -1, max: 2 }, guardHi: 'clamp-max' },
      side: 'apply',
    },
    proseFontCn: { key: 'proseFontCn', r: refs.proseFontCn, kind: 'str', side: 'apply' },
    proseFontEn: { key: 'proseFontEn', r: refs.proseFontEn, kind: 'str', side: 'apply' },
    pageWidth: { key: 'pageWidth', r: refs.pageWidth, kind: 'num', win: { guardLo: 'positive' }, side: 'apply' }, // setter 手写（bookOnly 双分支）
    autosaveInterval: { key: 'autosaveInterval', r: refs.autosaveInterval, kind: 'num', win: { guardLo: 'positive' } }, // setter 手写（同上；无 apply）
    shelfView: { key: 'shelfView', r: refs.shelfView, kind: 'enum', values: ['grid', 'list'] },
    chatEnabled: { key: 'chatEnabled', r: refs.chatEnabled, kind: 'bool' },
    compact: { key: 'compact', r: refs.compact, kind: 'bool', side: 'applyCompact' },
    // 版本保留全局默认（持久化为 snapMaxDays/snapMaxCount；夹取窗见行 win）
    snapDays: {
      key: 'snapMaxDays',
      r: refs.snapDays,
      kind: 'num',
      win: { clamp: { min: 1, max: 365 }, guardLo: 'positive' },
    },
    snapCount: {
      key: 'snapMaxCount',
      r: refs.snapCount,
      kind: 'num',
      win: { clamp: { min: 1, max: 200 }, guardLo: 'positive' },
    },
    // ── 书级设定全局托底 14 键：逐键类型/范围守卫（global.json 手改脏值不进 UI，保持回落）──
    defaultGenre: { key: 'defaultGenre', r: refs.defaultGenre, kind: 'str', trim: true },
    defaultVolumeSize: {
      key: 'defaultVolumeSize',
      r: refs.defaultVolumeSize,
      kind: 'num',
      win: { clamp: { min: 5, max: 500 }, guardRound: true },
    },
    // 目标字数/每章字数：JSON 层只存正整数（0 = 未设由 ref 初值表达），非法值保持现值
    defaultTargetWords: {
      key: 'defaultTargetWords',
      r: refs.defaultTargetWords,
      kind: 'num',
      win: { clamp: { min: 0 }, guardLo: 'positive', guardRound: true },
    },
    defaultChapterTargetWords: {
      key: 'defaultChapterTargetWords',
      r: refs.defaultChapterTargetWords,
      kind: 'num',
      win: { clamp: { min: 0 }, guardLo: 'positive', guardRound: true },
    },
    defaultShortStrict: { key: 'defaultShortStrict', r: refs.defaultShortStrict, kind: 'bool' },
    styleInjection: { key: 'styleInjection', r: refs.styleInjection, kind: 'enum', values: ['light', 'heavy'] },
    autoConfirmOutline: { key: 'autoConfirmOutline', r: refs.autoConfirmOutline, kind: 'bool' },
    // ref 名与 JSON 键 autoBatchSize 不同源（避免与语义混淆）
    aiBatchSize: {
      key: 'autoBatchSize',
      r: refs.aiBatchSize,
      kind: 'num',
      win: { clamp: { min: 1, max: 20 }, guardRound: true },
    },
    callsPerChapter: {
      key: 'callsPerChapter',
      r: refs.callsPerChapter,
      kind: 'num',
      win: { clamp: { min: 1, max: 50 }, guardRound: true },
    },
    relationAutoMine: { key: 'relationAutoMine', r: refs.relationAutoMine, kind: 'bool' },
    relationMineThreshold: {
      key: 'relationMineThreshold',
      r: refs.relationMineThreshold,
      kind: 'num',
      win: { clamp: { min: 1, max: 20 }, guardRound: true },
    },
    ragEnabled: { key: 'ragEnabled', r: refs.ragEnabled, kind: 'bool' },
    ragProvider: { key: 'ragProvider', r: refs.ragProvider, kind: 'str', trim: true },
    knowledgeInjection: { key: 'knowledgeInjection', r: refs.knowledgeInjection, kind: 'bool' },
    // ── 机检阈值五键（undefined = 未设 = 走引擎默认；apply 守卫非法值保持现值）──
    // 复读占比守 (0,1]（>1 会把全书章节判复读）；浮点两位截断在夹取窗（round2），守卫上界
    // 与夹取上界同界（guardHi），脏值越 1 不收
    checkRepeatThreshold: {
      key: 'checkRepeatThreshold',
      r: refs.checkRepeatThreshold,
      kind: 'num',
      win: { clamp: { min: 0.01, max: 1, round2: true }, guardLo: 'positive', guardHi: 'clamp-max' },
    },
    checkRepeatCharsThreshold: {
      key: 'checkRepeatCharsThreshold',
      r: refs.checkRepeatCharsThreshold,
      kind: 'num',
      win: { clamp: { min: 2, max: 1000 }, guardLo: 'positive', guardRound: true },
    },
    checkMaxSentenceLen: {
      key: 'checkMaxSentenceLen',
      r: refs.checkMaxSentenceLen,
      kind: 'num',
      win: { clamp: { min: 10, max: 500 }, guardLo: 'positive', guardRound: true },
    },
    checkImageryThreshold: {
      key: 'checkImageryThreshold',
      r: refs.checkImageryThreshold,
      kind: 'num',
      win: { clamp: { min: 1, max: 100 }, guardLo: 'positive', guardRound: true },
    },
    checkWordCountTolerance: {
      key: 'checkWordCountTolerance',
      r: refs.checkWordCountTolerance,
      kind: 'num',
      win: { clamp: { min: 1, max: 500 }, guardLo: 'positive' },
    },
  }
}

/** 将 API 读到的 prefs 应用到各 ref。
 * 34 键手写 if 链收敛为行表驱动逐键守卫——typeof 守卫/边界/取整/trim/
 * 枚举白名单逐键照抄原实现，行为等价；数值边界与取整从行窗口（NumWindow）单源派生。 */
export function applyPrefsTo(rows: PrefRows, p: GlobalPrefs): void {
  for (const row of Object.values(rows)) {
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

/** 从当前 refs 构建 GlobalPrefs 对象（不含书级覆盖）。
 * 表驱动全量组装——键序即 JSON 键序（PUT body 字节不变），undefined 序列化时被
 *  JSON.stringify 丢弃 = 未设不覆盖盘上已有值（机检五键，与服务端合并写语义一致）。 */
export function snapshotRows(rows: PrefRows): GlobalPrefs {
  const out: GlobalPrefs = {}
  for (const row of Object.values(rows)) out[row.key] = row.r.value
  return out
}

/** setter 尾段依赖（store 侧接线：DOM 副作用三件 + 防抖落盘）。 */
export interface PrefsRowEffects {
  apply: () => void
  applyTheme: () => void
  applyCompact: () => void
  schedulePersist: () => void
}

/** 行 setter 工厂：「写 ref →（side 副作用）→ schedulePersist」三段式收拢。
 * 夹取窗（win.clamp）与副作用族（side）从行取——与 applyPrefsTo 守卫、snapshotRows
 * 组装三面单源。异形（pageWidth / autosaveInterval 的 bookOnly 双分支双 ref 写）不进
 * 本表——双 ref 无法进单行表，由 store 泛型 set 的第三参分支承担。 */
export function createRowSetters(
  rows: PrefRows,
  effects: PrefsRowEffects,
): { [K in WritablePrefKey]: (v: PrefWriteValue<K>) => void } {
  /** 行 setter 的收尾两段：按行 side 挂副作用 → schedulePersist 防抖落 global.json。 */
  function finishRow(row: RowCommon): void {
    if (row.side === 'apply') effects.apply()
    else if (row.side === 'applyTheme') effects.applyTheme()
    else if (row.side === 'applyCompact') effects.applyCompact()
    effects.schedulePersist()
  }
  /** 数值行 setter：行带夹取窗时 clamp [min, max]（先取整后夹取：缺省 Math.round，
   *  round2 = Math.round(v*100)/100 两位小数），否则原样赋值（字号族 / pageWidth /
   *  autosaveInterval 的「原样」口径）。夹取参数与 applyPrefsTo 守卫同源自行 win。 */
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

  /** 32 个同构行的键控 setter 映射（键 = 行名 = PrefKey；store 泛型 set 的分发出口）。
   *  映射标注与 WritablePrefKey 逐键校验：缺行/多行/值型不符编译期红。 */
  return {
    theme: enumRow<ThemeId>(rows.theme),
    proseSize: numRow(rows.proseSize),
    proseLh: numRow(rows.proseLh),
    uiFontCn: strRow(rows.uiFontCn),
    uiFontEn: strRow(rows.uiFontEn),
    /** UI 字号档（-1 小 / 0 标准 / 1 大 / 2 特大）：整条字号刻度随 --font-size-step 平移 */
    uiFontSizeStep: numRow(rows.uiFontSizeStep),
    proseFontCn: strRow(rows.proseFontCn),
    proseFontEn: strRow(rows.proseFontEn),
    shelfView: enumRow<'grid' | 'list'>(rows.shelfView),
    chatEnabled: boolRow(rows.chatEnabled),
    compact: boolRow(rows.compact),
    /** 版本保留全局默认（clamp 1-365 / 1-200；所有书统一） */
    snapDays: numRow(rows.snapDays),
    snapCount: numRow(rows.snapCount),
    // ── 书级设定全局托底 setter（clamp/trim 参数在行上表驱动）──
    defaultGenre: strRow(rows.defaultGenre),
    defaultVolumeSize: numRow(rows.defaultVolumeSize),
    defaultTargetWords: numRow(rows.defaultTargetWords),
    defaultChapterTargetWords: numRow(rows.defaultChapterTargetWords),
    defaultShortStrict: boolRow(rows.defaultShortStrict),
    styleInjection: enumRow<'light' | 'heavy'>(rows.styleInjection),
    autoConfirmOutline: boolRow(rows.autoConfirmOutline),
    aiBatchSize: numRow(rows.aiBatchSize),
    callsPerChapter: numRow(rows.callsPerChapter),
    relationAutoMine: boolRow(rows.relationAutoMine),
    relationMineThreshold: numRow(rows.relationMineThreshold),
    ragEnabled: boolRow(rows.ragEnabled),
    ragProvider: strRow(rows.ragProvider),
    knowledgeInjection: boolRow(rows.knowledgeInjection),
    // ── 机检阈值五键（夹取窗在行 win 上 → schedulePersist 防抖落 global.json；
    // checkRepeatThreshold 浮点两位截断在行 win.clamp.round2）──
    checkRepeatThreshold: numRow(rows.checkRepeatThreshold),
    checkRepeatCharsThreshold: numRow(rows.checkRepeatCharsThreshold),
    checkMaxSentenceLen: numRow(rows.checkMaxSentenceLen),
    checkImageryThreshold: numRow(rows.checkImageryThreshold),
    checkWordCountTolerance: numRow(rows.checkWordCountTolerance),
  }
}
