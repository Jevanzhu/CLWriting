/**
 * book.yaml 键 schema 表（三面单源）—— 自 yaml.ts 拆出（
 * ⑤④产品巨件拆分波1 · 缝 A）。
 *
 * 内容（自 yaml.ts 纯搬移，代码与注释逐字未改）：ConfigKeySpec/ConfigSectionSpec 接口、
 * 六个叶键 parse 工厂（positiveNumParse…snapshotNumParse）、scalarLeafEmit、
 * SECTION_SPECS 全表（「表行序 = 字节红线」原注随表同迁，见表头）、SECTION_BY_NAME、
 * PARSE_SECTION_ORDER、parseSectionSpec/dupChildError/findChild、数值/布尔解析底座
 * （parseFiniteNumber/parsePositiveNumber/parseStrictBool/warnBadBool）与 renderScalar。
 * 原文件内以上全部模块私有；拆分只对消费方（yaml.ts 残核 / yaml-patch.ts）开最小具名
 * 导出面，全库 import 面零改动。
 * 落位偏差记档：renderScalar 侦察原划归 yaml-patch，但本文件 scalarLeafEmit 调用它、
 * 而 yaml-patch 又依赖本文件 SECTION_SPECS（CONFIG_PATCH_LEAVES 表派生）——落
 * yaml-patch 即成循环依赖，实读后调整落位本文件（代码逐字未动）。
 */

import type { BookConfig } from './types.js'
import type { RawSection } from './yaml.js'
import { parseValue, stringifyValue } from './frontmatter.js'
import { LEAD_TYPES } from './leads.js'
import { log } from '../log/index.js'

/** budget 段 parse 面键序——历史 BUDGET_KEYS 白名单序。
 *  warn 输出顺序锁此旧序；与 stringify 落行序不同（见 SECTION_SPECS 表行序），如实
 *  参数化不抹平（parseKeyOrder 覆写）。 */
const BUDGET_PARSE_ORDER = ['calls_per_chapter', 'input_per_chapter', 'summary_chapter_max', 'summary_volume_max', 'tokens_per_chapter', 'cost_per_chapter', 'chat_max_calls'] as const

/** 短篇 budget 段输出判定——条件键三键（calls + 双口径 tokens/cost）
 *  任一已设即输出段；全未设整段省略（缺省语义，回落运行时合并层）。此前外层条件只认
 *  calls_per_chapter，短篇仅设 tokens/cost_per_chapter（批 5 起合法）时整段丢失。
 *  ：chat_max_calls 并入判定（短篇只设该键时同样不得整段丢失）。 */
function budgetHasAnyKey(budget: BookConfig['budget']): boolean {
  return (
    budget.calls_per_chapter !== undefined ||
    budget.tokens_per_chapter !== undefined ||
    budget.cost_per_chapter !== undefined ||
    budget.chat_max_calls !== undefined
  )
}

// ── ：book.yaml 键 schema 表（三面单源）────────
//
// 同一份键清单此前三处各写一遍：sectionsToConfig（逐段 findChild+parse+warn 手写）、
// stringifyBookConfig（逐键条件落行）、CONFIG_PATCH_LEAVES（补丁白名单登记表）——
// 历史两次实证漏登事故（1068 ++ 双口径/开关/深度键、:1096 机检阈值
// 五键：parse/stringify 已收而补丁白名单漏登，PUT /config 改键静默不落盘）。现收敛
// 为单一 schema 表：每键一行 {parse, emit, get}，三面全部从表派生，新增键只触一行。
// 三面间微差如实参数化不抹平：
// - budget 段 parse 键序（warn 顺序）≠ 落行序 → parseKeyOrder 覆写（BUDGET_PARSE_ORDER）；
// - leads.thresholds 为动态账本类名映射 → parse 段内自管（重复 fail-loud）+ patch 特例
//   块（patchBookConfigText 专用分支），无叶键 get、不入白名单；
// - 顶层标量三键（spec_version/kind/host）协议级、各面只写一处（stringify 头部块 /
//   patch setTopScalarKey），不入表。
// 红线锚（test/format/yaml-schema-snapshot.test.ts）：parse→stringify 字节逐位不变、
// warn 文案逐字不变、PATCH 白名单逐行等价。

/** parse 面单键上下文：flat 段 bucket = cfg 子对象本体（写穿）；bucket 段 = 暂存桶
 *  （段解析完非空才整段赋 cfg.section——style/summary/short/auto/checks/snapshots 语义） */
interface ParseCtx {
  cfg: BookConfig
  bucket: Record<string, unknown>
}

export interface ConfigKeySpec {
  key: string
  /** parse 面：键行存在时调用（容错语义 + warn 文案逐键抄录自原三面实现） */
  parse?: (node: RawSection, ctx: ParseCtx) => void
  /** stringify 面：产本键落行（空数组 = 不落行；行序 = 表行序 = 历史 stringify 序） */
  emit?: (cfg: BookConfig) => string[]
  /** patch 面：取有效值（undefined = 该键不落行——归一口径对齐 stringifyBookConfig）；
   *  缺省 = 不入 PATCH 白名单 */
  get?: (c: BookConfig) => unknown
}

interface ConfigSectionSpec {
  name: string
  /** parse 段归类：flat = 写穿 cfg 子对象（book/leads/budget/growth）；
   *  bucket = 非空才整段赋（style/summary/short/auto/checks/snapshots）；
   *  custom = 段级自管（rag 触发器/展开语义） */
  parseKind: 'flat' | 'bucket' | 'custom'
  keys: readonly ConfigKeySpec[]
  /** parse 面键序覆写（仅 budget：warn 顺序锁历史 BUDGET_KEYS 序） */
  parseKeyOrder?: readonly string[]
  /** stringify 段门（false = 整段不落；body = 本段键行，「有行才落段」型段判定用） */
  gate: (cfg: BookConfig, body: readonly string[]) => boolean
  parseCustom?: (node: RawSection, cfg: BookConfig) => void
}

// ── 键行 parse 面工厂（语义与 warn 文案逐字抄录自原 sectionsToConfig 实现）──

/** （二十四轮 B 域）正数语义键族（预算/阈值/批量）：空值/非正数拒收——`key:`
 *  写空经 parseValue('')→Number('')=0 混过 isFinite 静默落 0（预算 0 = 每次调用都超限、
 *  阈值 0 = 全量误报，语义荒谬但消费侧无从区分），与非正数一并拒收（undefined = 未设，
 *  回落全局链），warn 留痕。 */
const positiveNumParse =
  (section: string, key: string) =>
  (node: RawSection, ctx: ParseCtx): void => {
    const v = parsePositiveNumber(node.value)
    if (v !== undefined) ctx.bucket[key] = v
    else log.warn('book.yaml', `${section}.${key} 值非正数（「${node.value.trim()}」），已忽略（按未设处理）`)
  }

/** budget.chat_max_calls 专用 fail-closed parse——非法值不得按「未设」放行
 *  （该键缺省 = 不限，坏值静默归未设会把配置错误放大成无界调用），warn 留痕后落 0：
 *  闸侧 0 = 「一次都不许调」（显式 0 同语义），宁拦勿放。显式写 0 与坏值在此
 *  同归 0（warn 文案已说明阻断后果），闸侧无需区分两种来源。
 *  随批评审夹紧（五轮处置批评审 nano-2，作者指令「修掉」）：次数口径键
 *  只收正整数——正小数（0.5 等）此前直穿（parsePositiveNumber 只验 >0），实效
 *  ⌈0.5⌉=1 次系安全方向怪形；与姊妹键 repeat_chars_threshold 消费点夹紧（本批评审
 *  前16-6-nano-1）同族收口，非正整数同走 fail-closed 落 0。 */
const failClosedNumParse =
  (section: string, key: string) =>
  (node: RawSection, ctx: ParseCtx): void => {
    const v = parsePositiveNumber(node.value)
    if (v !== undefined && Number.isInteger(v)) ctx.bucket[key] = v
    else {
      log.warn('book.yaml', `${section}.${key} 值非正整数（「${node.value.trim()}」），已按 fail-closed 落 0（chat AI 调用全部阻断），请修正为正整数或删除该键`)
      ctx.bucket[key] = 0
    }
  }

/** 布尔语义键族：parseStrictBool 收口（yes/on/1/True 同义收——此前
 *  只认字面 true/false，作者按 YAML 惯例写 yes 被反向关停）；非法值 warn + 按未设
 *  （label 供 warnBadBool 定位键名）。 */
const strictBoolParse =
  (bucketKey: string, label: string) =>
  (node: RawSection, ctx: ParseCtx): void => {
    const v = parseStrictBool(node.value)
    if (v !== undefined) ctx.bucket[bucketKey] = v
    else warnBadBool(label, node.value)
  }

/** short 段画像池数组键族：parseValue 数组化 → 逐项 trim 去空串，全空不设键（未设语义）。 */
const shortArrParse =
  (key: string) =>
  (node: RawSection, ctx: ParseCtx): void => {
    const value = parseValue(node.value)
    if (Array.isArray(value)) {
      const items = value.map(String).map((v) => v.trim()).filter(Boolean)
      if (items.length > 0) ctx.bucket[key] = items
    }
  }

/** short 段数值键族——坏值不再静默丢弃，warn 留痕（对齐 budget/
 *  bool 键的 /留痕模式——「配置写了但不生效」此前无迹可查）。
 *  opening_env_chars 特殊语义：显式 0 = 关闭「开头零环境」检查（与「未设 = 默认 300」
 *  区分，读侧 runner 据此跳过检查）；写空（`opening_env_chars:`）不是显式 0——
 *  parseValue('')→Number('')=0 会冒充关检，按未设处理 + warn。 */
const shortNumParse =
  (key: string) =>
  (node: RawSection, ctx: ParseCtx): void => {
    const value = parseFiniteNumber(node.value, NaN)
    const rawTrimmed = node.value.trim()
    if (key === 'opening_env_chars' && value === 0 && rawTrimmed !== '') {
      // 显式 0（含 '0'/'0.0' 引号形态）= 作者关检；写空（Number('')=0）不冒充关检
      ctx.bucket[key] = 0
    } else if (Number.isFinite(value) && value > 0) {
      ctx.bucket[key] = value
    } else {
      log.warn('book.yaml', `short.${key} 值非法（「${rawTrimmed}」），已忽略（按未设处理，回落缺省）`)
    }
  }

/** checks 段词表键族（#10 项 7/11 数据源接线）：显式空数组 = 关（不得归一为 undefined
 *  ——它与「未设」语义不同：未设才回落内置种子表，显式空数组是作者明确关掉）；
 *  项级 trim + 去空串与 short 段词表同口径（kk-剔除留痕）。 */
const checksWordListParse =
  (key: string) =>
  (node: RawSection, ctx: ParseCtx): void => {
    const value = parseValue(node.value)
    if (Array.isArray(value)) {
      const items = value.map(String)
      const kept = items.map((v) => v.trim()).filter(Boolean)
      if (kept.length < items.length) {
        log.warn('book.yaml', `checks.${key} 含空白词条已剔除（${items.length} 项 → ${kept.length} 项）`)
      }
      ctx.bucket[key] = kept
    } else {
      log.warn('book.yaml', `checks.${key} 值非数组（${node.value.trim()}），已忽略`)
    }
  }

/** snapshots 保留策略数值键——坏值静默吞补 warn 留痕（真实文件
 *  损坏 max_days: abc/0/-3 时用户无感知）。与 positiveNumParse 的微差如实保留：
 *  判定走 parseFiniteNumber(value, 0) + v>0，warn 文案截 40 字（历史 slice(0,40) 形态）。 */
const snapshotNumParse =
  (key: string) =>
  (node: RawSection, ctx: ParseCtx): void => {
    const v = parseFiniteNumber(node.value, 0)
    if (v > 0) ctx.bucket[key] = v
    else log.warn('book.yaml', `snapshots.${key} 值非正数（「${node.value.trim().slice(0, 40)}」），已忽略（按未设处理）`)
  }

// ── 键行 stringify 面工厂 ──

/** 叶键行 emit：undefined 不落行；值侧 renderScalar（字符串/数组走 stringifyValue 转义、
 *  其余 String 化）——与历史逐键内联插值逐位同形（数字 `: 8`、布尔 `: true`、数组
 *  stringifyValue）。 */
const scalarLeafEmit =
  (key: string, pick: (c: BookConfig) => unknown) =>
  (cfg: BookConfig): string[] => {
    const v = pick(cfg)
    return v === undefined ? [] : [`  ${key}: ${renderScalar(v)}`]
  }

// ── schema 表本体（表行序 = 历史 stringifyBookConfig 落行序，字节红线；
//    段 parse 触发顺序另见 PARSE_SECTION_ORDER）──
export const SECTION_SPECS: readonly ConfigSectionSpec[] = [
  {
    name: 'book',
    parseKind: 'flat',
    // book 段恒输出（title 必填）且紧随 host 无段间空行（stringify 头部块历史语义）
    gate: () => true,
    keys: [
      {
        key: 'title',
        // 0914 空串归一对齐 genre 先例（`title: ''` 是空占位，与
        // 「没写」同义，不写穿 bucket）——book 段起步值 DEFAULT_CONFIG.book.title 本为
        // ''，parse 面归一零观察差；get 面归一（'' → undefined）对齐 patchBookConfigText
        // 的 leafEquals 差分口径（显式清空 = 删行，与 genre 同语义；API 层对 PUT 空
        // title 已有必填拒收，删除臂仅内部直调可达）。
        parse: (node, ctx) => {
          const title = String(parseValue(node.value))
          if (title !== '') ctx.bucket.title = title
        },
        emit: (cfg) => [`  title: ${stringifyValue(cfg.book.title)}`],
        get: (c) => (c.book.title === '' ? undefined : c.book.title),
      },
      {
        key: 'genre',
        // 全局托底：genre 空串归一 undefined（`genre: ''` 是旧 scaffold 烘焙的默认占位，
        // 与「没写」同义）——否则空串永远盖住 global.json 的 defaultGenre
        parse: (node, ctx) => {
          const genre = String(parseValue(node.value))
          if (genre !== '') ctx.bucket.genre = genre
        },
        emit: (cfg) =>
          cfg.book.genre !== undefined && cfg.book.genre !== ''
            ? [`  genre: ${stringifyValue(cfg.book.genre)}`]
            : [],
        get: (c) => (c.book.genre === '' ? undefined : c.book.genre),
      },
      {
        key: 'volume_size',
        parse: (node, ctx) => {
          const volumeSize = parseFiniteNumber(node.value, NaN)
          // 坏值静默忽略补 warn（kind/host 与阈值族
          // 同文件留痕纪律——「配置写了但不生效」须有迹可查，否则字数规划静默失真）
          if (Number.isSafeInteger(volumeSize) && volumeSize > 0) ctx.bucket.volume_size = volumeSize
          else log.warn('book.yaml', `book.volume_size 值非法（「${node.value.trim().slice(0, 40)}」），已忽略（按未设处理）`)
        },
        emit: (cfg) => (cfg.book.volume_size !== undefined ? [`  volume_size: ${cfg.book.volume_size}`] : []),
        get: (c) => c.book.volume_size,
      },
      {
        key: 'target_words',
        // 同 volume_size
        parse: (node, ctx) => {
          const targetWords = parseFiniteNumber(node.value, NaN)
          if (Number.isFinite(targetWords) && targetWords > 0) ctx.bucket.target_words = targetWords
          else log.warn('book.yaml', `book.target_words 值非法（「${node.value.trim().slice(0, 40)}」），已忽略（按未设处理）`)
        },
        emit: (cfg) => (cfg.book.target_words !== undefined ? [`  target_words: ${cfg.book.target_words}`] : []),
        get: (c) => c.book.target_words,
      },
      {
        key: 'chapter_target_words',
        // 同 volume_size（空值经 parseFiniteNumber 落 0，同样进 warn 分支——
        // 「写了空」与「没写」的语义差须留痕）
        parse: (node, ctx) => {
          const v = parseFiniteNumber(node.value, 0)
          if (Number.isFinite(v) && v > 0) ctx.bucket.chapter_target_words = v
          else log.warn('book.yaml', `book.chapter_target_words 值非法（「${node.value.trim().slice(0, 40)}」），已忽略（按未设处理）`)
        },
        emit: (cfg) => (cfg.book.chapter_target_words !== undefined ? [`  chapter_target_words: ${cfg.book.chapter_target_words}`] : []),
        get: (c) => c.book.chapter_target_words,
      },
    ],
  },
  {
    name: 'leads',
    parseKind: 'flat',
    // leads 段：长篇恒输出（账本类）；短篇无（账本降级单章章纲 #27）
    gate: (cfg) => cfg.kind !== 'short',
    keys: [
      {
        key: 'enabled',
        parse: (node, ctx) => {
          const v = parseValue(node.value)
          if (Array.isArray(v)) {
            // 未知账本类过滤 + 留痕——此前静默收下错别字值，作者以为启用了
            const valid = v.map(String).filter((s) => (LEAD_TYPES as readonly string[]).includes(s))
            if (valid.length < v.length) {
              log.warn('book.yaml', `leads.enabled 含未知账本类（合法值：${LEAD_TYPES.join('/')}），已忽略`)
            }
            ctx.bucket.enabled = valid
          }
        },
        emit: (cfg) => [`  enabled: ${stringifyValue(cfg.leads.enabled)}`],
        get: (c) => c.leads.enabled,
      },
      {
        // thresholds 子键为动态账本类名（无法逐键预枚举 findChild），
        // 就地镜像 findChild 的重复判定——段内同名子键此前按遍历序后值静默
        // 覆盖前值，现 fail-loud（dupChildError 同一文案，经 parseBookConfig 捕获转错误信封）。
        // patch 面为特例块（patchBookConfigText thresholds 专用分支），无叶键 get。
        key: 'thresholds',
        parse: (node, ctx) => {
          const thresholds: Record<string, number> = {}
          const seen = new Set<string>()
          for (const c of node.children) {
            if (seen.has(c.key)) {
              throw dupChildError(node, c.key)
            }
            seen.add(c.key)
            // （二十四轮 B 域）：空值/非正数拒收——`复读率:` 写空经 parseValue('')→
            // Number('')=0 混过 isFinite 静默落 0（阈值 0 = 全量误报），与「未设」语义
            // 割裂。正数才收，否则 warn 留痕按未设（回落全局链）。
            const num = parsePositiveNumber(c.value)
            if (num !== undefined) thresholds[c.key] = num
            else log.warn('book.yaml', `leads.thresholds.${c.key} 值非正数（「${c.value.trim()}」），已忽略（按未设处理）`)
          }
          if (Object.keys(thresholds).length > 0) ctx.bucket.thresholds = thresholds
        },
        emit: (cfg) =>
          cfg.leads.thresholds
            ? ['  thresholds:', ...Object.entries(cfg.leads.thresholds).map(([k, v]) => `    ${k}: ${v}`)]
            : [],
      },
    ],
  },
  {
    name: 'budget',
    parseKind: 'flat',
    // 段门「!isShort || 条件键三键任一已设」——原外层条件只认
    // calls_per_chapter，短篇仅设 tokens_per_chapter/cost_per_chapter 时整段丢失、
    // 重存即丢配置；段内各键仍按自身 undefined 条件落行，未设键不烘焙。
    // 全局托底：calls_per_chapter 条件行（未设不烘焙 8，回落交给运行时合并层）；
    // input/summary 长程三键不进全局托底，短篇不落（无分层摘要）、长篇未设落历史缺省。
    gate: (cfg) => cfg.kind !== 'short' || budgetHasAnyKey(cfg.budget),
    // parse 面 warn 顺序锁历史 BUDGET_KEYS 白名单序（与落行序不同，如实参数化）
    parseKeyOrder: [...BUDGET_PARSE_ORDER],
    keys: [
      {
        key: 'calls_per_chapter',
        parse: positiveNumParse('budget', 'calls_per_chapter'),
        emit: scalarLeafEmit('calls_per_chapter', (c) => c.budget.calls_per_chapter),
        get: (c) => c.budget.calls_per_chapter,
      },
      {
        // 双口径预算键——设了才输出（未设不烘焙，回落交运行时合并层）
        key: 'tokens_per_chapter',
        parse: positiveNumParse('budget', 'tokens_per_chapter'),
        emit: scalarLeafEmit('tokens_per_chapter', (c) => c.budget.tokens_per_chapter),
        get: (c) => c.budget.tokens_per_chapter,
      },
      {
        key: 'cost_per_chapter',
        parse: positiveNumParse('budget', 'cost_per_chapter'),
        emit: scalarLeafEmit('cost_per_chapter', (c) => c.budget.cost_per_chapter),
        get: (c) => c.budget.cost_per_chapter,
      },
      {
        key: 'input_per_chapter',
        parse: positiveNumParse('budget', 'input_per_chapter'),
        emit: (cfg) => (cfg.kind !== 'short' ? [`  input_per_chapter: ${cfg.budget.input_per_chapter ?? 80000}`] : []),
        get: (c) => c.budget.input_per_chapter,
      },
      {
        key: 'summary_chapter_max',
        parse: positiveNumParse('budget', 'summary_chapter_max'),
        emit: (cfg) => (cfg.kind !== 'short' ? [`  summary_chapter_max: ${cfg.budget.summary_chapter_max ?? 200}`] : []),
        get: (c) => c.budget.summary_chapter_max,
      },
      {
        key: 'summary_volume_max',
        parse: positiveNumParse('budget', 'summary_volume_max'),
        emit: (cfg) => (cfg.kind !== 'short' ? [`  summary_volume_max: ${cfg.budget.summary_volume_max ?? 500}`] : []),
        get: (c) => c.budget.summary_volume_max,
      },
      {
        // chat 任务按书预算键——设了才输出；无 get 面（不入 PATCH 白名单，
        // 手编 book.yaml 面；入白名单须同步 yaml-schema-snapshot 清单锁，本批最小触达不动）
        key: 'chat_max_calls',
        parse: failClosedNumParse('budget', 'chat_max_calls'),
        emit: scalarLeafEmit('chat_max_calls', (c) => c.budget.chat_max_calls),
      },
    ],
  },
  {
    name: 'style',
    parseKind: 'bucket',
    // 全局托底：style 段仅当 injection 有值才输出（写法照 snapshots 段的条件输出范式）
    gate: (_cfg, body) => body.length > 0,
    keys: [
      {
        key: 'injection',
        parse: (node, ctx) => {
          const v = String(parseValue(node.value))
          if (v === 'light' || v === 'heavy') ctx.bucket.injection = v
        },
        emit: (cfg) => (cfg.style?.injection !== undefined ? [`  injection: ${cfg.style.injection}`] : []),
        get: (c) => c.style?.injection,
      },
    ],
  },
  {
    name: 'summary',
    parseKind: 'bucket',
    // summary 段仅当显式设过才输出（默认 auto=true 不烘焙，关掉的人写的 false 保真）
    gate: (_cfg, body) => body.length > 0,
    keys: [
      {
        // 摘要金字塔开关——summary.auto: false 关闭生成钩子（回到手写约定
        // 现状）。显式布尔落 cfg（写侧序列化保真，round-trip 不归一）。parseValue 不产出
        // 布尔——：收口 parseStrictBool（yes/on/1/True 同义收，非法值
        // warn + 按未设 = 不设键回落全局链）
        key: 'auto',
        parse: strictBoolParse('auto', 'summary.auto'),
        emit: (cfg) => (cfg.summary?.auto !== undefined ? [`  auto: ${cfg.summary.auto}`] : []),
        get: (c) => c.summary?.auto,
      },
    ],
  },
  {
    name: 'short',
    parseKind: 'bucket',
    // 短篇段：仅 kind: short 输出且段内至少一键（长篇缺省忽略，#25）
    gate: (cfg) => cfg.kind === 'short' && cfg.short != null && Object.keys(cfg.short).length > 0,
    keys: [
      {
        key: 'profile',
        parse: (node, ctx) => {
          const value = String(parseValue(node.value)).trim()
          if (value.length > 0) ctx.bucket.profile = value
        },
        emit: (cfg) => (cfg.short?.profile ? [`  profile: ${stringifyValue(cfg.short.profile)}`] : []),
        get: (c) => c.short?.profile,
      },
      { key: 'target_emotions', parse: shortArrParse('target_emotions'), emit: scalarLeafEmit('target_emotions', (c) => c.short?.target_emotions), get: (c) => c.short?.target_emotions },
      { key: 'target_reversal_types', parse: shortArrParse('target_reversal_types'), emit: scalarLeafEmit('target_reversal_types', (c) => c.short?.target_reversal_types), get: (c) => c.short?.target_reversal_types },
      { key: 'target_ending_flavors', parse: shortArrParse('target_ending_flavors'), emit: scalarLeafEmit('target_ending_flavors', (c) => c.short?.target_ending_flavors), get: (c) => c.short?.target_ending_flavors },
      { key: 'series_motifs', parse: shortArrParse('series_motifs'), emit: scalarLeafEmit('series_motifs', (c) => c.short?.series_motifs), get: (c) => c.short?.series_motifs },
      {
        // parseStrictBool 收口（原 `String === 'true'` 把 strict: yes
        // 解析成 false 反向开关）；非法值 warn + 按未设（回落 defaultShortStrict 托底链）。
        // 全局托底：显式 false 也照写（roundtrip 零 diff 红线——此前只写 true，
        // `strict: false` 旧文件重存会丢行；未设不输出）
        key: 'strict',
        parse: strictBoolParse('strict', 'short.strict'),
        emit: (cfg) => (cfg.short?.strict !== undefined ? [`  strict: ${cfg.short.strict}`] : []),
        get: (c) => c.short?.strict,
      },
      { key: 'word_min', parse: shortNumParse('word_min'), emit: scalarLeafEmit('word_min', (c) => c.short?.word_min), get: (c) => c.short?.word_min },
      { key: 'word_max', parse: shortNumParse('word_max'), emit: scalarLeafEmit('word_max', (c) => c.short?.word_max), get: (c) => c.short?.word_max },
      { key: 'body_part_threshold', parse: shortNumParse('body_part_threshold'), emit: scalarLeafEmit('body_part_threshold', (c) => c.short?.body_part_threshold), get: (c) => c.short?.body_part_threshold },
      { key: 'simile_threshold', parse: shortNumParse('simile_threshold'), emit: scalarLeafEmit('simile_threshold', (c) => c.short?.simile_threshold), get: (c) => c.short?.simile_threshold },
      { key: 'section_count', parse: shortNumParse('section_count'), emit: scalarLeafEmit('section_count', (c) => c.short?.section_count), get: (c) => c.short?.section_count },
      { key: 'opening_env_chars', parse: shortNumParse('opening_env_chars'), emit: scalarLeafEmit('opening_env_chars', (c) => c.short?.opening_env_chars), get: (c) => c.short?.opening_env_chars },
    ],
  },
  {
    name: 'auto',
    parseKind: 'bucket',
    // 全局托底：auto 段只输出已定义键，全未定义省段（写法照 snapshots 段的条件输出范式）
    gate: (_cfg, body) => body.length > 0,
    keys: [
      {
        // parseStrictBool 收口 + 非法值 warn 按未设（回落全局链）
        key: 'confirm_outline',
        parse: strictBoolParse('confirm_outline', 'auto.confirm_outline'),
        emit: (cfg) => (cfg.auto?.confirm_outline !== undefined ? [`  confirm_outline: ${cfg.auto.confirm_outline}`] : []),
        get: (c) => c.auto?.confirm_outline,
      },
      {
        // 空值/非正数拒收（写空落 0 = 连写批大小 0，语义荒谬）；warn 按未设。
        key: 'batch_size',
        parse: positiveNumParse('auto', 'batch_size'),
        emit: scalarLeafEmit('batch_size', (c) => c.auto?.batch_size),
        get: (c) => c.auto?.batch_size,
      },
      {
        // 关系图自动梳理两键——前端 useRelationGraph 已消费，原先解析/序列化
        // 均不支持（作者手写 book.yaml 永远解析成默认值，配置链路断裂）。
        // parseStrictBool 收口 + 非法值 warn 按未设（回落全局链）
        key: 'relation_auto_mine',
        parse: strictBoolParse('relation_auto_mine', 'auto.relation_auto_mine'),
        emit: (cfg) => (cfg.auto?.relation_auto_mine !== undefined ? [`  relation_auto_mine: ${cfg.auto.relation_auto_mine}`] : []),
        get: (c) => c.auto?.relation_auto_mine,
      },
      {
        // 同 batch_size——关系梳理阈值空值/非正数拒收，warn 按未设。
        key: 'relation_mine_threshold',
        parse: positiveNumParse('auto', 'relation_mine_threshold'),
        emit: scalarLeafEmit('relation_mine_threshold', (c) => c.auto?.relation_mine_threshold),
        get: (c) => c.auto?.relation_mine_threshold,
      },
    ],
  },
  {
    name: 'growth',
    parseKind: 'flat',
    // growth 段：长篇输出（成长线/境界）；短篇无（无成长线）
    gate: (cfg) => cfg.kind !== 'short',
    keys: [
      {
        // 无正值校验——`realm_span_max: 0`/负数此前原样落 cfg，
        // checkGrowth 的跨度检查（idx-prevIdx > 0 恒真）会让一切正常晋阶报红；
        // 非数字/非正数一律 fail-loud 产可读错误（parseBookConfig 捕获转错误信封，
        // 对齐顶层段重复 的 fail-loud 口径）
        key: 'realm_span_max',
        parse: (node, ctx) => {
          const v = parseFiniteNumber(node.value, NaN)
          if (!Number.isFinite(v) || v <= 0) {
            throw new Error(`growth.realm_span_max 必须为正数（实际「${node.value.trim()}」），请修正 book.yaml 的 growth 段`)
          }
          ctx.bucket.realm_span_max = v
        },
        emit: (cfg) => [`  realm_span_max: ${cfg.growth.realm_span_max ?? 2}`],
        get: (c) => c.growth.realm_span_max,
      },
    ],
  },
  {
    name: 'checks',
    parseKind: 'bucket',
    // 机检段（长短篇皆可选：高频意象/信息差机检长短都跑）：键存在即输出——含显式空数组
    // （round-trip 保真：显式空 = 关掉内置回落，与「未设」语义不同，重存不得丢）；
    // 整段未设不落段（现有仓库零改动红线）。写法照 auto 段的条件输出范式
    gate: (_cfg, body) => body.length > 0,
    keys: [
      { key: 'imagery_words', parse: checksWordListParse('imagery_words'), emit: scalarLeafEmit('imagery_words', (c) => c.checks?.imagery_words), get: (c) => c.checks?.imagery_words },
      { key: 'leak_keywords', parse: checksWordListParse('leak_keywords'), emit: scalarLeafEmit('leak_keywords', (c) => c.checks?.leak_keywords), get: (c) => c.checks?.leak_keywords },
      // 机检阈值五键——此前解析面不认（作者手写被静默丢弃，按引擎
      // 默认值执行，配置链路断裂）。正数校验 + 非法值 warn 按未设（口径，回落
      // 全局链/引擎默认即可，不 fail-loud：调参面写坏不阻断写作）
      { key: 'repeat_threshold', parse: positiveNumParse('checks', 'repeat_threshold'), emit: scalarLeafEmit('repeat_threshold', (c) => c.checks?.repeat_threshold), get: (c) => c.checks?.repeat_threshold },
      { key: 'repeat_chars_threshold', parse: positiveNumParse('checks', 'repeat_chars_threshold'), emit: scalarLeafEmit('repeat_chars_threshold', (c) => c.checks?.repeat_chars_threshold), get: (c) => c.checks?.repeat_chars_threshold },
      { key: 'max_sentence_len', parse: positiveNumParse('checks', 'max_sentence_len'), emit: scalarLeafEmit('max_sentence_len', (c) => c.checks?.max_sentence_len), get: (c) => c.checks?.max_sentence_len },
      { key: 'imagery_threshold', parse: positiveNumParse('checks', 'imagery_threshold'), emit: scalarLeafEmit('imagery_threshold', (c) => c.checks?.imagery_threshold), get: (c) => c.checks?.imagery_threshold },
      { key: 'word_count_tolerance', parse: positiveNumParse('checks', 'word_count_tolerance'), emit: scalarLeafEmit('word_count_tolerance', (c) => c.checks?.word_count_tolerance), get: (c) => c.checks?.word_count_tolerance },
    ],
  },
  {
    name: 'rag',
    parseKind: 'custom',
    // RAG 可选段（#37，非密；key 绝不入此；长短皆可选）。parse 段级自管：段存在但缺
    // enabled 键 → 不再整段静默丢弃——手写了 provider/endpoint 显然意在启用，
    // enabled 缺省 true（显式写 false 才关）；触发条件补 embed_timeout_ms（
    // 与 depth 同口径：正整数才收）
    gate: (cfg) => cfg.rag != null,
    parseCustom: (node, cfg) => {
      const en = findChild(node, 'enabled')
      const pv = findChild(node, 'provider')
      const ep = findChild(node, 'endpoint')
      const md = findChild(node, 'model')
      const cd = findChild(node, 'candidate_depth')
      const depth = cd ? Number(parseValue(cd.value)) : NaN
      const et = findChild(node, 'embed_timeout_ms')
      const embedTimeout = et ? Number(parseValue(et.value)) : NaN
      // enabled 收口 parseStrictBool（`enabled: yes/1` 此前被当
      // false 反向关停）；非法值 warn + 按未设 = 段存在时的缺省 true
      let ragEnabled = true
      if (en) {
        const v = parseStrictBool(en.value)
        if (v !== undefined) ragEnabled = v
        else warnBadBool('rag.enabled', en.value)
      }
      if (en || pv || ep || md || (Number.isInteger(depth) && depth > 0) || (Number.isInteger(embedTimeout) && embedTimeout > 0)) {
        cfg.rag = {
          enabled: ragEnabled,
          ...(pv ? { provider: String(parseValue(pv.value)) } : {}),
          ...(ep ? { endpoint: String(parseValue(ep.value)) } : {}),
          ...(md ? { model: String(parseValue(md.value)) } : {}),
          // 候选深度可覆盖（正整数才收，缺省 20 走 recall 侧兜底）
          ...(Number.isInteger(depth) && depth > 0 ? { candidate_depth: depth } : {}),
          // embedding 超时可覆盖（正整数才收，缺省 30s 走 embed.ts 兜底）
          ...(Number.isInteger(embedTimeout) && embedTimeout > 0 ? { embed_timeout_ms: embedTimeout } : {}),
        }
      }
    },
    keys: [
      { key: 'enabled', emit: (cfg) => (cfg.rag != null ? [`  enabled: ${cfg.rag.enabled}`] : []), get: (c) => c.rag?.enabled },
      // 设了 provider（应用级服务商引用）时不再写 endpoint/model——旧内联字段在 UI 选服务商时已清
      { key: 'provider', emit: (cfg) => (cfg.rag?.provider ? [`  provider: ${stringifyValue(cfg.rag.provider)}`] : []), get: (c) => c.rag?.provider },
      { key: 'endpoint', emit: (cfg) => (cfg.rag != null && !cfg.rag.provider && cfg.rag.endpoint ? [`  endpoint: ${stringifyValue(cfg.rag.endpoint)}`] : []), get: (c) => (c.rag?.provider ? undefined : c.rag?.endpoint) },
      { key: 'model', emit: (cfg) => (cfg.rag != null && !cfg.rag.provider && cfg.rag.model ? [`  model: ${stringifyValue(cfg.rag.model)}`] : []), get: (c) => (c.rag?.provider ? undefined : c.rag?.model) },
      // candidate_depth随段输出——漏写则 PUT /config 解析失败回退分支走本函数全量
      // 重生成时，已配的候选深度被静默抹掉（补丁白名单已认该键，两路口径须一致）
      { key: 'candidate_depth', emit: scalarLeafEmit('candidate_depth', (c) => c.rag?.candidate_depth), get: (c) => c.rag?.candidate_depth },
      { key: 'embed_timeout_ms', emit: scalarLeafEmit('embed_timeout_ms', (c) => c.rag?.embed_timeout_ms), get: (c) => c.rag?.embed_timeout_ms },
    ],
  },
  {
    name: 'snapshots',
    parseKind: 'bucket',
    // 快照保留策略（单章版本回滚）：缺省不写字段 → 用代码默认值；段门/键行照条件输出
    // 范式（缺省不输出——现有仓库零改动红线）
    gate: (cfg) => cfg.snapshots != null && (cfg.snapshots.max_days !== undefined || cfg.snapshots.max_count !== undefined),
    keys: [
      { key: 'max_days', parse: snapshotNumParse('max_days'), emit: scalarLeafEmit('max_days', (c) => c.snapshots?.max_days), get: (c) => c.snapshots?.max_days },
      { key: 'max_count', parse: snapshotNumParse('max_count'), emit: scalarLeafEmit('max_count', (c) => c.snapshots?.max_count), get: (c) => c.snapshots?.max_count },
    ],
  },
]

export const SECTION_BY_NAME: ReadonlyMap<string, ConfigSectionSpec> = new Map(SECTION_SPECS.map((s) => [s.name, s]))

/** parse 面段序（历史 sectionsToConfig 处理序：snapshots 先于 rag——warn/报错触发顺序
 *  锁旧序；stringify 段序 = 表序，rag 先于 snapshots）。 */
export const PARSE_SECTION_ORDER: readonly string[] = ['book', 'leads', 'budget', 'style', 'summary', 'short', 'auto', 'growth', 'checks', 'snapshots', 'rag']

/** 段解析驱动（表派生）：逐键 findChild（段内重复 fail-loud）+ 键行 parse；
 *  bucket 段非空才整段赋（style/summary/short/auto/checks/snapshots 语义）。 */
export function parseSectionSpec(spec: ConfigSectionSpec, sectionNode: RawSection, cfg: BookConfig): void {
  if (spec.parseKind === 'custom') {
    if (spec.parseCustom) spec.parseCustom(sectionNode, cfg)
    return
  }
  const cfgBag = cfg as unknown as Record<string, unknown>
  const bucket: Record<string, unknown> = spec.parseKind === 'flat' ? (cfgBag[spec.name] as Record<string, unknown>) : {}
  for (const key of spec.parseKeyOrder ?? spec.keys.map((k) => k.key)) {
    const row = spec.keys.find((k) => k.key === key)
    if (row?.parse === undefined) continue
    const child = findChild(sectionNode, key)
    if (child !== undefined) row.parse(child, { cfg, bucket })
  }
  if (spec.parseKind === 'bucket' && Object.keys(bucket).length > 0) {
    cfgBag[spec.name] = bucket
  }
}

/** / ——原 sectionsToConfig 闭包上提模块级
 *  （表驱动三面共用，语义与文案逐字不变）：段内子键重复 fail-loud（顶层段重复
 *  已 fail-loud〔 〕，但段内同名子键 find 静默取首〔作者复制粘贴出两个
 *  `genre:` 时后值无声丢失〕，同文件两种容错策略口径统一为「宁可红不可错」）；
 *  报错文案收口 dupChildError 单源（budget / leads.thresholds 两段同口径复用同一
 *  文案模板，不自创第三种报错形态）。 */
function dupChildError(section: RawSection, key: string): Error {
  return new Error(`顶层段「${section.key}」内子键「${key}」重复：同名子键只取首个会静默丢弃后值，请合并或删除重复键`)
}

function findChild(section: RawSection, key: string): RawSection | undefined {
  const hits = section.children.filter((c) => c.key === key)
  if (hits.length > 1) {
    throw dupChildError(section, key)
  }
  return hits[0]
}

export function parseFiniteNumber(raw: string, fallback: number): number {
  const n = Number(parseValue(raw))
  return Number.isFinite(n) ? n : fallback
}

/** （二十四轮 B 域）：正数语义字段（预算/阈值/批量）专用——空值键（`key:` 写空）
 *  经 parseValue('')→Number('')=0 混过 isFinite 静默落 0，与非正数一并拒收（返回
 *  undefined = 未设，回落全局链）。与 snapshots max_days/max_count 的 v>0 收门口径
 *  同源，warn 留痕由调用方负责（区分键名）。 */
function parsePositiveNumber(raw: string): number | undefined {
  const n = Number(parseValue(raw))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** 布尔语义键（summary.auto / short.strict / auto.confirm_outline /
 *  auto.relation_auto_mine / rag.enabled）专用宽松布尔解析。此前五处只认字面
 *  `String(parseValue(v)) === 'true'`，作者按 YAML 惯例写 yes/on/1/True 一律按 false
 *  静默生效（反向开关：想开却关、想关却开，配置链路无声错位）。认 true/false/yes/no/
 *  on/off/1/0（大小写不敏感）；其余返回 undefined = 未设语义，由调用方 warn 留痕后
 *  按该键缺省语义处理。 */
const TRUE_BOOLS = new Set(['true', 'yes', 'on', '1'])
const FALSE_BOOLS = new Set(['false', 'no', 'off', '0'])

function parseStrictBool(raw: string): boolean | undefined {
  const v = String(parseValue(raw)).trim().toLowerCase()
  if (TRUE_BOOLS.has(v)) return true
  if (FALSE_BOOLS.has(v)) return false
  return undefined
}

/** 布尔键非法值 warn 留痕（tag/句式对齐本文件口径），按未设处理。 */
function warnBadBool(key: string, raw: string): void {
  log.warn('book.yaml', `${key} 值非合法布尔（「${raw.trim()}」，合法：true/false/yes/no/on/off/1/0），已忽略（按未设处理，回落缺省）`)
}

export function renderScalar(v: unknown): string {
  return typeof v === 'string' || Array.isArray(v) ? stringifyValue(v) : String(v)
}
