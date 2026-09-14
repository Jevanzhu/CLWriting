/**
 * book.yaml 读写 —— 依据 #9 book.yaml 配置 spec。
 *
 * 与 frontmatter.ts 的区别：
 * - book.yaml 是独立 .yaml 文件（无 --- 包裹），机器域英文 key，多层嵌套段
 * - front matter 是中文 key、平铺、--- 包裹
 *
 * 这里手写一个支持「段（顶层 key:）+ 缩进子字段」的极简解析，覆盖 #9 第 2 节 schema。
 *
 * O-12（第十三轮）尺度登记：本文件 885 行属 schema 集中型（readBookConfig 及各段
 * 读写的单一事实源），拆 core/typed-schema 两层是结构优化非缺陷——随 rc 后重构批评估，
 * 拆分红线：readBookConfig 返回形状与 book.yaml 写入字节序不得变（fm 保形纪律同源）。
 */

import { readFileSync, existsSync } from 'node:fs'
import { atomicWriteFile } from '../fs/atomic.js'
import { canonicalizeText } from '../fs/text-canonical.js'
import type { BookConfig, ParseError } from './types.js'
import { parseValue, stringifyValue } from './frontmatter.js'
import { stripInlineComment, firstKeyColon } from './frontmatter-core.js'
import { LEAD_TYPES } from './leads.js'
import { log } from '../log/index.js'

// ── 默认值（#9 第 3 节，待 beta 的给占位）────────
//
// 书级设定全局托底（13 键）：style 段、auto 段、budget.calls_per_chapter、book.genre
// 从 DEFAULT_CONFIG 摘除——readBookConfig 起步值里带着默认值的话，书文件没写 = 解析结果
// 恒有值，「书级未设 → 回落全局」永远被遮蔽（解析层看不见「未设」）。这些键的默认值
// 迁移到 GLOBAL_FALLBACK_DEFAULTS（format/global-defaults.ts），由运行时合并层
// applyGlobalDefaults 兜底；错误回落分支（readBookConfig !ok）也因此只带必填骨架。
// budget 其余三键（input/summary 长程预算）不进全局托底，照旧在此预填。

export const DEFAULT_CONFIG: BookConfig = {
  spec_version: 1,
  host: 'cc',
  book: { title: '' },
  leads: { enabled: [] },
  budget: {
    input_per_chapter: 80000,
    summary_chapter_max: 200,
    summary_volume_max: 500,
  },
  growth: { realm_span_max: 2 },
}

/** P1-5（复审-0914-优化修复批）：budget 段 parse 面键序——历史 BUDGET_KEYS 白名单序。
 *  warn 输出顺序锁此旧序；与 stringify 落行序不同（见 SECTION_SPECS 表行序），如实
 *  参数化不抹平（parseKeyOrder 覆写）。 */
const BUDGET_PARSE_ORDER = ['calls_per_chapter', 'input_per_chapter', 'summary_chapter_max', 'summary_volume_max', 'tokens_per_chapter', 'cost_per_chapter'] as const

/** R26-10（二十六轮）：短篇 budget 段输出判定——条件键三键（calls + 双口径 tokens/cost）
 *  任一已设即输出段；全未设整段省略（缺省语义，回落运行时合并层）。此前外层条件只认
 *  calls_per_chapter，短篇仅设 tokens/cost_per_chapter（D3 批 5 起合法）时整段丢失。 */
function budgetHasAnyKey(budget: BookConfig['budget']): boolean {
  return (
    budget.calls_per_chapter !== undefined ||
    budget.tokens_per_chapter !== undefined ||
    budget.cost_per_chapter !== undefined
  )
}

// ── 解析：段 + 缩进子字段 ────────────────────────

interface RawSection {
  indent: number // 缩进空格数
  key: string
  value: string // 行内值（子段为空；块列表项后处理时拼成内联数组）
  children: RawSection[]
  listItems?: string[] // dd-P2：块式列表项（`- xxx` 行）暂存，循环后拼进 value
}

/** 解析 YAML 文本为段树（支持 2 空格缩进） */
function parseSections(text: string): RawSection[] {
  const roots: RawSection[] = []
  const stack: RawSection[] = [] // 按缩进维护
  const listNodes: RawSection[] = [] // 收集了块列表项的节点（循环后统一拼值）
  const make = (indent: number, key: string, value: string): RawSection => ({
    indent, key, value, children: [],
  })

  // ii 批：上一行产出的键节点——用于「更深缩进行跟在有值键后」的错挂检测（ff P2-2）
  let lastNode: RawSection | undefined
  // R26-37（二十六轮）：tab 缩进 warn 留痕开关（首个 tab 一次，不刷屏）
  let tabWarned = false
  for (const [lineNo, line] of text.split('\n').entries()) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    // R26-37（二十六轮）：缩进含 tab 时 warn 一次——2 空格缩进协议下 tab 按字符数
    // 凑合可解析（计数维持现状，改语义风险大），但作者无从知晓文件混入了 tab、
    // 段挂靠类问题难排查；留痕不中断解析。
    if (!tabWarned && line.slice(0, indent).includes('\t')) {
      tabWarned = true
      log.warn('book.yaml', `book.yaml 第 ${lineNo + 1} 行缩进含 tab（本协议为 2 空格缩进），已按字符数解析；建议改用空格`)
    }
    const content = line.trim()
    // ii 批（ff P2-2）：有值键（`key: v`）不能有缩进子行——真 YAML 里这是语法错误，
    // 此前子行会被静默挂到更外层段上（配置无声错位）。改挂前显式报错，宁可红不可错
    if (lastNode && lastNode.value !== '' && indent > lastNode.indent) {
      throw new Error(`第 ${lineNo + 1} 行缩进子行不能挂在有值键「${lastNode.key}:」下（YAML 语法错误）：${content}`)
    }
    // 低级项（第六轮）：块式列表项（`- xxx`）判定先于冒号——`- 惊悚: 高` 含冒号但语义
    // 是列表项文本，原先被当 key 行解析成键「- 惊悚」再被白名单静默吞掉（含冒号的
    // 块列表风格整段无声失效）。挂到最近一个「空值父键」，拼成内联数组值由 parseValue
    // 原生解析（dd-P2）
    if (content.startsWith('- ')) {
      const parent = stack.length > 0 ? stack[stack.length - 1] : undefined
      const item = stripComment(content.slice(2)).trim()
      if (parent && parent.value === '' && item) {
        // R27-24（二十七轮）：段头直挂块列表 warn——顶层段（indent 0）按映射（子键）
        // 解析，列表项被拼进段 value 后所有子键读取全部落空（如 leads: 下直接
        // `- 主线`，作者意图是 leads.enabled，实际 enabled 无声丢失）。留痕不中断。
        if (parent.indent === 0) {
          log.warn('yaml', `book.yaml 段头「${parent.key}:」直挂块列表（${content.slice(0, 40)}）——该段按子键解析，列表值不会被子键读到；如需列表请落到列表型子键下（如 leads: 的 enabled:）`)
        }
        parent.listItems = [...(parent.listItems ?? []), item]
        if (!listNodes.includes(parent)) listNodes.push(parent)
      } else {
        // Y-26（第五十七轮）：无处挂靠的块列表项（顶层列表 / 父键已有标量值）此前
        // 静默吞掉——同文件 leads.enabled 未知类有 warn 先例，补齐同款留痕防「配置
        // 写了但不生效」无迹可查
        log.warn('yaml', `book.yaml 块列表项无处挂靠被丢弃：${content.slice(0, 40)}`)
      }
      continue
    }
    // R31-2（三十一轮）：键位冒号双认 `:`/`：` 取先出现者（firstKeyColon，与 parseFlat
    // 同一实现）——手写全角冒号键行（`title：测试`）此前整行走「无冒号」warn 被丢弃，
    // 段/键无声丢失。值侧 stripComment 等切分后逻辑不受影响。
    const colonIdx = firstKeyColon(content)
    if (colonIdx === -1) {
      // R64-24（十二轮）：无冒号残行此前静默吞掉（Y-26 同款「配置写了但不生效」
      // 风险面）——手写残句/续行无迹消失。warn 留痕不中断解析。
      log.warn('yaml', `book.yaml 无冒号行被丢弃：${content.slice(0, 40)}`)
      continue
    }
    const key = content.slice(0, colonIdx).trim()
    const value = stripComment(content.slice(colonIdx + 1)).trim()

    const node = make(indent, key, value)
    lastNode = node

    // 弹栈到父级（缩进比自己小的最近一个）
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
      stack.pop()
    }
    if (stack.length === 0) {
      roots.push(node)
    } else {
      stack[stack.length - 1]!.children.push(node)
    }
    // 有子段潜力（value 为空且是 map）的入栈
    if (value === '') {
      stack.push(node)
    }
  }
  // 块列表项拼成内联数组——逐项走 stringifyValue 转义（含逗号/括号/引号项加引号），
  // 与解析端 splitInlineArray 的引号跳过（K17）对称；此前裸 join 含逗号项拼完即错位
  for (const node of listNodes) {
    if (node.listItems && node.listItems.length > 0 && node.value === '') {
      node.value = '[' + node.listItems.map((it) => stringifyValue(it)).join(', ') + ']'
    }
  }
  return roots
}

/** 剥行内注释（原 stripComment）。N-4（第五十四轮）：实现下沉 frontmatter-core.ts
 *  stripInlineComment（与 frontmatter.ts 共用同一函数——经 core 无循环 import），
 *  语义逐字不变：`#` 且前面是空白（或行首）即注释起点，引号内不算；
 *  `endpoint: http://x#y` 的 # 前无空白 → 保留为字面值（与主流 YAML 同语义）。 */
const stripComment = stripInlineComment

// ── P1-5（复审-0914-优化修复批）：book.yaml 键 schema 表（三面单源）────────
//
// 同一份键清单此前三处各写一遍：sectionsToConfig（逐段 findChild+parse+warn 手写）、
// stringifyBookConfig（逐键条件落行）、CONFIG_PATCH_LEAVES（补丁白名单登记表）——
// 历史两次实证漏登事故（:1068 D3+C1+A3 双口径/开关/深度键、:1096 R52-E-2 机检阈值
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

interface ConfigKeySpec {
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

/** R76-15（二十四轮 B 域）正数语义键族（预算/阈值/批量）：空值/非正数拒收——`key:`
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

/** R26-12（二十六轮）布尔语义键族：parseStrictBool 收口（yes/on/1/True 同义收——此前
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

/** R29-B7（二十九轮）：short 段数值键族——坏值不再静默丢弃，warn 留痕（对齐 budget/
 *  bool 键的 R76-15/R26-12 留痕模式——「配置写了但不生效」此前无迹可查）。
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
 *  项级 trim + 去空串与 short 段词表同口径（kk-P2-13：剔除留痕）。 */
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

/** R37-11（三十七轮）：snapshots 保留策略数值键——坏值静默吞补 warn 留痕（真实文件
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
const SECTION_SPECS: readonly ConfigSectionSpec[] = [
  {
    name: 'book',
    parseKind: 'flat',
    // book 段恒输出（title 必填）且紧随 host 无段间空行（stringify 头部块历史语义）
    gate: () => true,
    keys: [
      {
        key: 'title',
        // 全库重评-0914 P3-16：空串归一对齐 genre 先例（`title: ''` 是空占位，与
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
          // R51-F-3（五十一轮）：坏值静默忽略补 warn（R37-11 kind/host 与 R76-15 阈值族
          // 同文件留痕纪律——「配置写了但不生效」须有迹可查，否则字数规划静默失真）
          if (Number.isSafeInteger(volumeSize) && volumeSize > 0) ctx.bucket.volume_size = volumeSize
          else log.warn('book.yaml', `book.volume_size 值非法（「${node.value.trim().slice(0, 40)}」），已忽略（按未设处理）`)
        },
        emit: (cfg) => (cfg.book.volume_size !== undefined ? [`  volume_size: ${cfg.book.volume_size}`] : []),
        get: (c) => c.book.volume_size,
      },
      {
        key: 'target_words',
        // R51-F-3：同 volume_size
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
        // R51-F-3：同 volume_size（空值经 parseFiniteNumber 落 0，同样进 warn 分支——
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
            // X-P3a：未知账本类过滤 + 留痕——此前静默收下错别字值，作者以为启用了
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
        // R57-D-1（五十七轮）：thresholds 子键为动态账本类名（无法逐键预枚举 findChild），
        // 就地镜像 findChild（R73-21）的重复判定——段内同名子键此前按遍历序后值静默
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
            // R76-15（二十四轮 B 域）：空值/非正数拒收——`复读率:` 写空经 parseValue('')→
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
    // R26-10（二十六轮）：段门「!isShort || 条件键三键任一已设」——原外层条件只认
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
        // D3（批 5）：双口径预算键——设了才输出（未设不烘焙，回落交运行时合并层）
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
    // C1（批 2）：summary 段仅当显式设过才输出（默认 auto=true 不烘焙，关掉的人写的 false 保真）
    gate: (_cfg, body) => body.length > 0,
    keys: [
      {
        // C1（批 2）：摘要金字塔开关——summary.auto: false 关闭生成钩子（回到手写约定
        // 现状）。显式布尔落 cfg（写侧序列化保真，round-trip 不归一）。parseValue 不产出
        // 布尔——R26-12（二十六轮）：收口 parseStrictBool（yes/on/1/True 同义收，非法值
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
    // 短篇段：仅 kind: short 输出且段内至少一键（长篇缺省忽略，M8 #25）
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
        // R26-12（二十六轮）：parseStrictBool 收口（原 `String() === 'true'` 把 strict: yes
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
        // R26-12（二十六轮）：parseStrictBool 收口 + 非法值 warn 按未设（回落全局链）
        key: 'confirm_outline',
        parse: strictBoolParse('confirm_outline', 'auto.confirm_outline'),
        emit: (cfg) => (cfg.auto?.confirm_outline !== undefined ? [`  confirm_outline: ${cfg.auto.confirm_outline}`] : []),
        get: (c) => c.auto?.confirm_outline,
      },
      {
        // R76-15：空值/非正数拒收（写空落 0 = 连写批大小 0，语义荒谬）；warn 按未设。
        key: 'batch_size',
        parse: positiveNumParse('auto', 'batch_size'),
        emit: scalarLeafEmit('batch_size', (c) => c.auto?.batch_size),
        get: (c) => c.auto?.batch_size,
      },
      {
        // RB-KN-P2-10：关系图自动梳理两键——前端 useRelationGraph 已消费，原先解析/序列化
        // 均不支持（作者手写 book.yaml 永远解析成默认值，配置链路断裂）。
        // R26-12（二十六轮）：parseStrictBool 收口 + 非法值 warn 按未设（回落全局链）
        key: 'relation_auto_mine',
        parse: strictBoolParse('relation_auto_mine', 'auto.relation_auto_mine'),
        emit: (cfg) => (cfg.auto?.relation_auto_mine !== undefined ? [`  relation_auto_mine: ${cfg.auto.relation_auto_mine}`] : []),
        get: (c) => c.auto?.relation_auto_mine,
      },
      {
        // R76-15：同 batch_size——关系梳理阈值空值/非正数拒收，warn 按未设。
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
        // R73-20（二十一轮）：无正值校验——`realm_span_max: 0`/负数此前原样落 cfg，
        // checkGrowth 的跨度检查（idx-prevIdx > 0 恒真）会让一切正常晋阶报红；
        // 非数字/非正数一律 fail-loud 产可读错误（parseBookConfig 捕获转错误信封，
        // 对齐顶层段重复 R72-8 C-5 的 fail-loud 口径）
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
      // R52-E-2（五十二轮）：机检阈值五键——此前解析面不认（作者手写被静默丢弃，按引擎
      // 默认值执行，配置链路断裂）。正数校验 + 非法值 warn 按未设（R76-15 口径，回落
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
    // enabled 键 → 不再整段静默丢弃（第六轮）——手写了 provider/endpoint 显然意在启用，
    // enabled 缺省 true（显式写 false 才关）；触发条件补 embed_timeout_ms（R48-7，
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
      // R26-12（二十六轮）：enabled 收口 parseStrictBool（`enabled: yes/1` 此前被当
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
          // A3（批 7）：候选深度可覆盖（正整数才收，缺省 20 走 recall 侧兜底）
          ...(Number.isInteger(depth) && depth > 0 ? { candidate_depth: depth } : {}),
          // R62-27：embedding 超时可覆盖（正整数才收，缺省 30s 走 embed.ts 兜底）
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
      // candidate_depth（A3 批 7）随段输出——漏写则 PUT /config 解析失败回退分支走本函数全量
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

const SECTION_BY_NAME: ReadonlyMap<string, ConfigSectionSpec> = new Map(SECTION_SPECS.map((s) => [s.name, s]))

/** parse 面段序（历史 sectionsToConfig 处理序：snapshots 先于 rag——warn/报错触发顺序
 *  锁旧序；stringify 段序 = 表序，rag 先于 snapshots）。 */
const PARSE_SECTION_ORDER: readonly string[] = ['book', 'leads', 'budget', 'style', 'summary', 'short', 'auto', 'growth', 'checks', 'snapshots', 'rag']

/** 段解析驱动（表派生）：逐键 findChild（段内重复 fail-loud）+ 键行 parse；
 *  bucket 段非空才整段赋（style/summary/short/auto/checks/snapshots 语义）。 */
function parseSectionSpec(spec: ConfigSectionSpec, sectionNode: RawSection, cfg: BookConfig): void {
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

/** R73-21（二十一轮）/ R57-D-1（五十七轮）——原 sectionsToConfig 闭包上提模块级
 *  （P1-5 表驱动三面共用，语义与文案逐字不变）：段内子键重复 fail-loud（顶层段重复
 *  已 fail-loud〔R72-8 C-5〕，但段内同名子键 find 静默取首〔作者复制粘贴出两个
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

/** 段树 → BookConfig（#9 第 2 节）。
 *  全局托底改造：起步值不含 13 个可托底键——书文件没写就保持 undefined，
 *  「未设」语义存活到运行时合并层（applyGlobalDefaults）才回落。
 *  P1-5（复审-0914-优化修复批）：段键解析整体改 schema 表驱动（SECTION_SPECS），
 *  本函数只保留顶层标量三键与段循环骨架；逐键容错语义与 warn 文案随键行迁入表。 */
function sectionsToConfig(roots: RawSection[]): BookConfig {
  // R72-8（二十轮 C-5）：同名重复顶层段报错——原 find 静默取首个，作者复制粘贴出两个
  // `style:` 段时后段整段无效无提示。fail-loud（parseBookConfig 的 catch 转错误信封）。
  const seenKeys = new Set<string>()
  for (const r of roots) {
    if (seenKeys.has(r.key)) {
      throw new Error(`顶层段「${r.key}」重复：同名段只取首个会静默丢弃后段配置，请合并或删除重复段`)
    }
    seenKeys.add(r.key)
  }
  const cfg: BookConfig = { ...DEFAULT_CONFIG, book: { ...DEFAULT_CONFIG.book }, leads: { ...DEFAULT_CONFIG.leads }, budget: { ...DEFAULT_CONFIG.budget }, growth: { ...DEFAULT_CONFIG.growth } }
  const find = (key: string) => roots.find((r) => r.key === key)

  // R26-38（二十六轮）：spec_version 非法值 warn 留痕（维持回落 1）——此前
  // parseFiniteNumber 静默回落，版本号写错无迹可查
  const sv = find('spec_version')
  if (sv) {
    const parsed = parseFiniteNumber(sv.value, NaN)
    if (Number.isFinite(parsed)) cfg.spec_version = parsed
    else {
      log.warn('book.yaml', `spec_version 值非法（「${sv.value.trim()}」），回落 1`)
      cfg.spec_version = 1
    }
  }

  // kind（M8 #25）：顶层标量，缺省 long；只有显式 kind: short 才路由短篇轨
  const kindNode = find('kind')
  if (kindNode) {
    const k = String(parseValue(kindNode.value))
    if (k === 'short' || k === 'long') cfg.kind = k
    // R37-11（三十七轮）：坏值静默落默认补 warn 留痕——作者笔误（kind: shrt）时
    // 短篇稿被静默路由长篇轨，无迹可查（对齐 spec_version 的 warn 纪律）
    else log.warn('book.yaml', `kind 值非法（「${kindNode.value.trim().slice(0, 40)}」），已按缺省 long 处理`)
  }

  // host（决策 12）：AI 宿主，缺省 cc；只认 cc/codex
  const hostNode = find('host')
  if (hostNode) {
    const h = String(parseValue(hostNode.value))
    if (h === 'cc' || h === 'codex') cfg.host = h
    // R37-11：同 kind——坏值静默回落 cc 无迹可查
    else log.warn('book.yaml', `host 值非法（「${hostNode.value.trim().slice(0, 40)}」），已按缺省 cc 处理`)
  }

  // workflow（W0 §2 已废弃删除）：存量 book.yaml 里的 workflow 行是未知字段，
  // 不解析、不赋值——下次存配置时 stringifyBookConfig 重建 yaml 自然丢弃该行。

  // 段键：schema 表驱动（P1-5）——段序锁历史处理序（PARSE_SECTION_ORDER）
  for (const name of PARSE_SECTION_ORDER) {
    const spec = SECTION_BY_NAME.get(name)
    const sectionNode = find(name)
    if (!spec || !sectionNode) continue
    parseSectionSpec(spec, sectionNode, cfg)
  }

  return cfg
}

function parseFiniteNumber(raw: string, fallback: number): number {
  const n = Number(parseValue(raw))
  return Number.isFinite(n) ? n : fallback
}

/** R76-15（二十四轮 B 域）：正数语义字段（预算/阈值/批量）专用——空值键（`key:` 写空）
 *  经 parseValue('')→Number('')=0 混过 isFinite 静默落 0，与非正数一并拒收（返回
 *  undefined = 未设，回落全局链）。与 snapshots max_days/max_count 的 v>0 收门口径
 *  同源，warn 留痕由调用方负责（区分键名）。 */
function parsePositiveNumber(raw: string): number | undefined {
  const n = Number(parseValue(raw))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** R26-12（二十六轮）：布尔语义键（summary.auto / short.strict / auto.confirm_outline /
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

/** R26-12：布尔键非法值 warn 留痕（tag/句式对齐本文件 R76-15 口径），按未设处理。 */
function warnBadBool(key: string, raw: string): void {
  log.warn('book.yaml', `${key} 值非合法布尔（「${raw.trim()}」，合法：true/false/yes/no/on/off/1/0），已忽略（按未设处理，回落缺省）`)
}

// ── 公开 API ────────────────────────────────────

/** 读 book.yaml（容错：缺文件/坏文件返回默认 + 错误） */
export function readBookConfig(
  filePath: string,
): { ok: true; config: BookConfig } | { ok: false; config: BookConfig; error: ParseError } {
  // X-P2-17：错误分支返回默认配置的深拷贝——共享单例引用一旦被调用方 mutate 即串污染后续所有读
  const freshDefault = (): BookConfig => structuredClone(DEFAULT_CONFIG)
  if (!existsSync(filePath)) {
    return {
      ok: false,
      config: freshDefault(),
      error: { file: filePath, line: 0, message: 'book.yaml 不存在（用默认配置）' },
    }
  }
  let text: string
  try {
    text = readFileSync(filePath, 'utf-8')
  } catch (e) {
    return {
      ok: false,
      config: freshDefault(),
      error: { file: filePath, line: 0, message: `读取失败：${e instanceof Error ? e.message : String(e)}` },
    }
  }
  return parseBookConfig(text, filePath)
}

/** 从 YAML 文本解析 BookConfig（readBookConfig 的字符串版）。
 *  供文本级读改写场景（migrate-defaults 等）在内存里判定配置值，免落盘临时文件。 */
export function parseBookConfig(
  text: string,
  file = '<text>',
): { ok: true; config: BookConfig } | { ok: false; config: BookConfig; error: ParseError } {
  try {
    // R42-34（四十二轮）：解析最外层文本入口剥前导 BOM 一次（窄剥——不引 canonicalizeText，
    // 它会连带归一行尾，而解析器对 CRLF 已容忍〔逐行 trim 剥 \r 尾〕，不必徒增行为面）。
    // 此前首行 \uFEFF 全凭 trim() 恰好剥 ZWNBSP 才不出键名事故，且首行缩进被多计 1
    // （trimStart 剥 BOM 计入缩进字符数）——首个段的 1 空格/tab 缩进子行被弹栈提为
    // 顶层键后静默丢弃。同缺陷族先例：frontmatter-core.ts splitFrontMatter /
    // install/books.ts readBooksStrict（R40-25）/ 本文件 matchesKeyLine（R37-10），
    // 解析器本体在此收口。
    const roots = parseSections(text.replace(/^\uFEFF/, ''))
    return { ok: true, config: sectionsToConfig(roots) }
  } catch (e) {
    return {
      ok: false,
      config: structuredClone(DEFAULT_CONFIG),
      error: { file, line: 0, message: `解析失败：${e instanceof Error ? e.message : String(e)}` },
    }
  }
}

/** BookConfig → YAML 文本（#9 第 2 节格式；短篇集走精简字段，M8 #25）。
 *  P1-5（复审-0914-优化修复批）：逐键条件落行改 schema 表驱动——段体 = 表行 emit
 *  拼接（行序 = 表序 = 历史落行序），段门 gate / 段间空行 / 头部三行保持历史语义；
 *  新增键只触表一行。字节红线由 yaml-schema-snapshot 快照钉住。 */
export function stringifyBookConfig(cfg: BookConfig): string {
  const isShort = cfg.kind === 'short'
  const lines: string[] = [
    `spec_version: ${cfg.spec_version}`,
    // kind 只在 short 时输出（长篇缺省不写，现有仓库零改动红线，M8 #25）
    ...(isShort ? ['kind: short', ''] : ['']),
    `host: ${cfg.host ?? 'cc'}`,
  ]
  for (const spec of SECTION_SPECS) {
    // 段体 = 该段全部键行（emit 空数组键不落行；「有行才落段」型段由 gate 判 body）
    const body = spec.keys.flatMap((k) => (k.emit ? k.emit(cfg) : []))
    if (!spec.gate(cfg, body)) continue
    // book 段紧随 host 无段间空行；其余段前置空行分隔（历史段间风格）
    if (spec.name !== 'book') lines.push('')
    lines.push(`${spec.name}:`, ...body)
  }
  return lines.join('\n') + '\n'
}

/** 写 book.yaml */
export function writeBookConfig(filePath: string, cfg: BookConfig): void {
  // 平台规范化批（2026-09-03）：恒 LF——R40-9 的「按盘上主导行尾整文件渲染」随规范形
  // 拍板废止（CRLF 存量由启动迁移 v4 归一）；stringifyBookConfig 本就恒 LF，输出即规范形。
  atomicWriteFile(filePath, stringifyBookConfig(cfg))
}

/**
 * 文本级补丁：替换或追加一个顶层段（V-P2-4）。
 *
 * 读改写场景（历史生产例 enableRag 已删，现存直接消费面为补丁族测试）不能走
 * stringifyBookConfig 全量重生成——解析模型只保
 * 已知字段，作者的 # 注释、未知段、未知子键会静默丢失。此函数只重写目标段的
 * 行区间，区间外的原文（含注释与未知内容）逐字保留。
 *
 * @param raw 现有 book.yaml 全文（空串 = 无文件，纯追加）
 * @param section 顶层段名（如 'rag'）
 * @param body 段体行（不含段头行，如 '  enabled: true'）
 */
/** Z-7（第五十八轮）：补丁族段定位的 CRLF 容忍——split('\n') 残留 \r 尾，无值段头
 *  （`book:\r`）两条件均不中会走追加分支在文件尾造重复段（解析取首个段 → 改动静默丢失）。
 *  统一剥 \r 后比对（md 侧 frontmatter 同族口径）。
 *  R37-10（三十七轮）/ R2W-6（win 平台专项复审 R2）双线同旨合并：再补行首 BOM 剥除
 *  （只剥一次）——文件首键行带 UTF-8 BOM（\uFEFF，记事本「UTF-8 with BOM」保存形态）
 *  时段定位同样失明、误走追加分支造重复段/重复键（下次解析撞 fail-loud 重复守卫，
 *  全书配置降级默认；读侧先例 R33D-3；调用方均为 findIndex 直吃 raw 原文，上游无
 *  统一剥除点，故在本函数收口）。 */
function matchesKeyLine(line: string, key: string): boolean {
  const noBom = line.startsWith('\uFEFF') ? line.slice(1) : line
  const bare = noBom.endsWith('\r') ? noBom.slice(0, -1) : noBom
  return bare === `${key}:` || bare.startsWith(`${key}: `)
}

/**
 * P1-6（复审-0914-优化修复批）：补丁族段定位单源——此前 patchTopSection /
 * setTopSectionKey / setSectionKeyBlock（yaml.ts 三处）与 migrate-defaults
 * （matchesKeyLineCRLF + topSectionSpan + 段内最小缩进循环）四处逐字重复
 * 「段头扫描 + 段尾扫描 + 段体最小缩进」骨架；现收编本函数，四处改薄壳/委托。
 *
 * 定位边界语义逐位保留（含 R71-4 / Z-7 修复语义）：
 * - 段头：matchesKeyLine——剥行首 BOM（只一次，R37-10/R2W-6）与行尾 \r（Z-7 CRLF
 *   容忍）后全等 `key:` 或前缀 `key: `；
 * - end = 下一个顶层 key（非缩进、非注释、非空行）之前；段到文件尾 = lines.length；
 * - childIndent = 段体内容行（非空、非注释）最小缩进；段体无内容行 = -1。
 *   （migrate-defaults 侧 matchesKeyLineCRLF 原无 BOM 剥除——其头注自记「同
 *   yaml.ts matchesKeyLine 口径」，本地复制漏 BOM 属口径漂移，单源后按注释意图
 *   对齐为含 BOM 剥除形态；该差异面仅及「BOM 文件首段定位失败走 no-op」一隅，
 *   修后 BOM 存量书迁移恢复生效。）
 */
export interface TopSectionSpan {
  start: number
  end: number
  childIndent: number
}

export function locateTopSection(lines: readonly string[], section: string): TopSectionSpan | null {
  const start = lines.findIndex((l) => matchesKeyLine(l, section))
  if (start === -1) return null
  // 段区间末尾 = 下一个顶层 key（非缩进、非注释、非空行）之前
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (l.trim() !== '' && !l.trimStart().startsWith('#') && !/^\s/.test(l)) {
      end = i
      break
    }
  }
  // 直接子键缩进 = 段体内容行最小缩进（嵌套更深的行不是本段的直接子键）
  let childIndent = -1
  for (let i = start + 1; i < end; i++) {
    const l = lines[i]!
    if (l.trim() === '' || l.trimStart().startsWith('#')) continue
    const ind = l.length - l.trimStart().length
    if (childIndent === -1 || ind < childIndent) childIndent = ind
  }
  return { start, end, childIndent }
}

export function patchTopSection(raw: string, section: string, body: string): string {
  // 平台规范化批（2026-09-03）：输出规范形（LF）——MP2-4 的「新行随原文行尾」语义
  // 随规范形拍板翻转；未触碰行原样保留（含注释），其 CRLF 残尾随整输出归一剥除。
  const lines = raw.split('\n')
  const span = locateTopSection(lines, section) // P1-6：段定位委托单源
  if (!span) {
    // 追加：空文件直接写；有内容则补齐结尾换行 + 空行分隔（对齐 stringify 的段间风格）。
    const sectionLines = [`${section}:`, ...body.split('\n')]
    if (raw === '') return `${sectionLines.join('\n')}\n`
    const prefix = raw.endsWith('\n') ? raw : `${raw}\n`
    return canonicalizeText(`${prefix}\n${sectionLines.join('\n')}\n`)
  }
  const { start, end } = span
  // 保留旧段尾部的空行 run（段间分隔）——替换体本身无尾空行，不补会与下一段粘连
  let blanks = 0
  for (let i = end - 1; i > start; i--) {
    if (lines[i]!.trim() === '') blanks++
    else break
  }
  return canonicalizeText(
    [
      ...lines.slice(0, start),
      `${section}:`,
      ...body.split('\n'),
      ...Array.from({ length: blanks }, () => ''),
      ...lines.slice(end),
    ].join('\n'),
  )
}

/**
 * GG-P2-8：文本级替换顶层段内单个子键行（只动 `key:` 那一行，段内其余行含未知子键、
 * 缩进注释逐字保留；段外内容更是零触碰）。
 *
 * 与 patchTopSection（整段替换）的取舍：改名/单项改值场景单键行替换更小更稳——
 * 整段替换须重排段体（未知子键会丢），单键行替换天然保形。区间口径与 patchTopSection
 * 一致（下一个顶层 key 之前）；直接子键缩进 = 段体内容行最小缩进（嵌套更深的行不碰）。
 *
 * 键不存在 → 插在段头之后（body 空时用 2 空格惯例）；段不存在 → 追加只含该键的段
 * （与 patchTopSection 追加分支同风格）。title 行若带行尾注释会随行重写丢失（值本身
 * 罕见带注释，接受；整段保注释的目标由「其余行不动」达成）。
 */
export function setTopSectionKey(raw: string, section: string, key: string, value: string): string {
  // 平台规范化批：输出规范形（LF）——MP2-4 行尾保真语义翻转（patchTopSection 同款）
  const lines = raw.split('\n')
  const span = locateTopSection(lines, section) // P1-6：段定位委托单源
  const keyLine = (indent: number): string => ' '.repeat(indent) + `${key}: ${value}`
  if (!span) {
    const sectionLines = [`${section}:`, keyLine(2)]
    if (raw === '') return `${sectionLines.join('\n')}\n`
    const prefix = raw.endsWith('\n') ? raw : `${raw}\n`
    return canonicalizeText(`${prefix}\n${sectionLines.join('\n')}\n`)
  }
  const { start, end, childIndent } = span
  if (childIndent === -1) {
    // 段体无内容行 → 键插在段头后
    lines.splice(start + 1, 0, keyLine(2))
    return canonicalizeText(lines.join('\n'))
  }
  const pad = ' '.repeat(childIndent)
  // R71-4：键行匹配剥 \r（上方 matchesKeyLine 同口径，Z-7 同族）——CRLF book.yaml 的
  // 裸键行（`  thresholds:\r`）两条件均不中会被判「键不存在」，替换走插入分支残留
  // 旧块成重复段
  const isKeyLine = (l: string): boolean => {
    const bare = l.endsWith('\r') ? l.slice(0, -1) : l
    return bare === `${pad}${key}:` || bare.startsWith(`${pad}${key}: `)
  }
  for (let i = start + 1; i < end; i++) {
    if (isKeyLine(lines[i]!)) {
      lines[i] = keyLine(childIndent)
      return canonicalizeText(lines.join('\n'))
    }
  }
  // 键不在段内 → 插在段头后首行（先于既有子键，与 stringify 的 title 首位习惯一致）
  lines.splice(start + 1, 0, keyLine(childIndent))
  return canonicalizeText(lines.join('\n'))
}

// ── kk-P1-5：PUT /config 的文本级补丁写 ──────────

/**
 * 文本级替换/删除/插入段内单个子键块（键行 + 其块列表 `- ` 项 / 嵌套映射子行）。
 *
 * setTopSectionKey 只重写键行本身——值是块列表（`- 项`）或嵌套映射（thresholds）
 * 时，旧块行会残留成孤儿。本函数把键行连同其块行整段换掉；区间/缩进口径与
 * setTopSectionKey 一致（下一个顶层 key 之前；段体内容行最小缩进 = 直接子键缩进）。
 *
 * @param keyLine 键行内容（不含缩进，如 `title: 新书名` / `thresholds:`）；null = 删除整个键块
 * @param blockLines 键行后的块体行（不含缩进，函数按子键缩进+2 落位；仅嵌套映射用）
 */
export function setSectionKeyBlock(
  raw: string,
  section: string,
  key: string,
  keyLine: string | null,
  blockLines: string[] = [],
): string {
  // 平台规范化批：输出规范形（LF）——MP2-4 同族连带语义翻转（patchTopSection 同款）
  const lines = raw.split('\n')
  const span = locateTopSection(lines, section) // P1-6：段定位委托单源
  if (!span) {
    if (keyLine === null) return raw
    const body = [`  ${keyLine}`, ...blockLines.map((l) => `    ${l}`)]
    if (raw === '') return `${section}:\n${body.join('\n')}\n`
    const prefix = raw.endsWith('\n') ? raw : `${raw}\n`
    return canonicalizeText(`${prefix}\n${section}:\n${body.join('\n')}\n`)
  }
  const { start, end, childIndent } = span
  const pad = ' '.repeat(childIndent === -1 ? 2 : childIndent)
  if (childIndent !== -1) {
    // R71-4：键行匹配剥 \r（上方 matchesKeyLine 同口径，Z-7 同族）——CRLF book.yaml 的
    // 裸键行（`  thresholds:\r`）两条件均不中会被判「键不存在」：删除模式静默丢改
    // （原样返回）、替换模式在段头后再插一份残留重复块
    const isKeyLine = (l: string): boolean => {
      const bare = l.endsWith('\r') ? l.slice(0, -1) : l
      return bare === `${pad}${key}:` || bare.startsWith(`${pad}${key}: `)
    }
    for (let i = start + 1; i < end; i++) {
      if (!isKeyLine(lines[i]!)) continue
      // 块体吞并：同缩进 `- ` 列表项（YAML 允许列表与键同列）或更深缩进的内容行
      let blockEnd = i + 1
      while (blockEnd < end) {
        const l = lines[blockEnd]!
        if (l.trim() === '' || l.trimStart().startsWith('#')) break
        const ind = l.length - l.trimStart().length
        if ((l.trimStart().startsWith('- ') && ind >= childIndent) || ind > childIndent) blockEnd++
        else break
      }
      const replacement =
        keyLine === null ? [] : [pad + keyLine, ...blockLines.map((l) => pad + '  ' + l)]
      lines.splice(i, blockEnd - i, ...replacement)
      return canonicalizeText(lines.join('\n'))
    }
  }
  // 键不在段内：插入模式插在段头后；删除模式无键可删，原样返回
  if (keyLine === null) return raw
  lines.splice(start + 1, 0, ...[pad + keyLine, ...blockLines.map((l) => pad + '  ' + l)])
  return canonicalizeText(lines.join('\n'))
}

/** 顶层标量键（spec_version/kind/host）的替换/删除/插入（无缩进，含锚定插入） */
function setTopScalarKey(raw: string, key: string, line: string | null): string {
  // 平台规范化批：输出规范形（LF）——MP2-4 同族连带语义翻转
  const lines = raw.split('\n')
  const idx = lines.findIndex((l) => matchesKeyLine(l, key))
  if (idx !== -1) {
    if (line === null) lines.splice(idx, 1)
    else lines[idx] = line
    return canonicalizeText(lines.join('\n'))
  }
  if (line === null) return raw
  // 插在 spec_version 行后（文件头惯例位置）；无则文件首行
  const anchor = lines.findIndex((l) => matchesKeyLine(l, 'spec_version'))
  lines.splice(anchor === -1 ? 0 : anchor + 1, 0, line)
  return canonicalizeText(lines.join('\n'))
}

/** 补丁叶子：段内单键 + 取有效值（undefined = 该键不落行——归一口径对齐 stringifyBookConfig） */
interface ConfigPatchLeaf {
  section: string
  key: string
  get: (c: BookConfig) => unknown
}

// P1-5（复审-0914-优化修复批）：补丁白名单改 schema 表派生（有 get 的键行即补丁叶，
// 派生序 = 表序 = 历史 stringifyBookConfig 落行序）。历史两次漏登事故（D3+C1+A3
// 双口径/开关/深度键、R52-E-2 机检阈值五键：parse/stringify 已收而白名单漏登，
// PUT /config 改这些键会静默不落盘）自此结构性杜绝——parse 收的键表里必有行。
// leads.thresholds 动态映射无叶键 get（patchBookConfigText 特例块处理）。
// 派生结果与历史手写登记表逐行等价（无新增/删减），yaml-schema-snapshot 快照锁。
const CONFIG_PATCH_LEAVES: readonly ConfigPatchLeaf[] = SECTION_SPECS.flatMap((spec) =>
  spec.keys
    .filter((k): k is ConfigKeySpec & { get: (c: BookConfig) => unknown } => k.get !== undefined)
    .map((k) => ({ section: spec.name, key: k.key, get: k.get })),
)

function renderScalar(v: unknown): string {
  return typeof v === 'string' || Array.isArray(v) ? stringifyValue(v) : String(v)
}

function leafEquals(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * kk-P1-5：PUT /config 的文本级补丁——对比旧解析值与新配置，只重写发生变化的键行，
 * 其余原文（作者手写注释、未知段、未知子键、块列表/嵌套块的排版）逐字保留。
 *
 * 此前 PUT 走 stringifyBookConfig 全量重生成，与 migrate-defaults 修掉的红线同款：
 * 解析模型只保已知字段，作者注释/未知段静默丢失。调用方须传「同一文件解析出的
 * 旧配置」当基线（解析烘焙的默认值两边一致，diff 只会浮出用户真实改动——缺段
 * 文件不会被默认值污染出一堆新行）。
 */
export function patchBookConfigText(raw: string, oldCfg: BookConfig, newCfg: BookConfig): string {
  let text = raw
  const top = (key: string, from: unknown, to: unknown): void => {
    if (leafEquals(from, to)) return
    text = to === undefined ? setTopScalarKey(text, key, null) : setTopScalarKey(text, key, `${key}: ${renderScalar(to)}`)
  }
  top('spec_version', oldCfg.spec_version, newCfg.spec_version)
  // Y-25（第五十七轮·登记说明）：short→long 时此处写显式 `kind: long`，与
  // stringifyBookConfig「long 缺省不写」口径不一——文本补丁是单键外科替换，改成
  // 删除行需重排注释邻接结构，风险大于收益；解析侧认 long（语义无损），维持显式写。
  top('kind', oldCfg.kind, newCfg.kind)
  top('host', oldCfg.host ?? 'cc', newCfg.host ?? 'cc')

  for (const leaf of CONFIG_PATCH_LEAVES) {
    const from = leaf.get(oldCfg)
    const to = leaf.get(newCfg)
    if (leafEquals(from, to)) continue
    text = setSectionKeyBlock(text, leaf.section, leaf.key, to === undefined ? null : `${leaf.key}: ${renderScalar(to)}`)
  }

  // thresholds 嵌套映射：键行 + 子行整块换（含删除）
  const thFrom = oldCfg.leads.thresholds
  const thTo = newCfg.leads.thresholds
  if (!leafEquals(thFrom, thTo)) {
    text = setSectionKeyBlock(
      text,
      'leads',
      'thresholds',
      thTo === undefined ? null : 'thresholds:',
      thTo === undefined ? [] : Object.entries(thTo).map(([k, v]) => `${k}: ${v}`),
    )
  }
  return text
}
