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
import type { BookConfig, ParseError } from './types.js'
import { parseValue, stringifyValue } from './frontmatter.js'
import { stripInlineComment } from './frontmatter-core.js'
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

/** budget 段已知键白名单（解析用；calls_per_chapter 已可选化，不能再用 `in 起步值` 判定） */
const BUDGET_KEYS = new Set(['calls_per_chapter', 'input_per_chapter', 'summary_chapter_max', 'summary_volume_max', 'tokens_per_chapter', 'cost_per_chapter'])

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
  for (const [lineNo, line] of text.split('\n').entries()) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
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
    const colonIdx = content.indexOf(':')
    if (colonIdx === -1) continue
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

/** 段树 → BookConfig（#9 第 2 节）。
 *  全局托底改造：起步值不含 13 个可托底键——书文件没写就保持 undefined，
 *  「未设」语义存活到运行时合并层（applyGlobalDefaults）才回落。 */
function sectionsToConfig(roots: RawSection[]): BookConfig {
  const cfg: BookConfig = { ...DEFAULT_CONFIG, book: { ...DEFAULT_CONFIG.book }, leads: { ...DEFAULT_CONFIG.leads }, budget: { ...DEFAULT_CONFIG.budget }, growth: { ...DEFAULT_CONFIG.growth } }
  const find = (key: string) => roots.find((r) => r.key === key)

  if (find('spec_version')) cfg.spec_version = parseFiniteNumber(find('spec_version')!.value, 1)

  // kind（M8 #25）：顶层标量，缺省 long；只有显式 kind: short 才路由短篇轨
  const kindNode = find('kind')
  if (kindNode) {
    const k = String(parseValue(kindNode.value))
    if (k === 'short' || k === 'long') cfg.kind = k
  }

  // host（决策 12）：AI 宿主，缺省 cc；只认 cc/codex
  const hostNode = find('host')
  if (hostNode) {
    const h = String(parseValue(hostNode.value))
    if (h === 'cc' || h === 'codex') cfg.host = h
  }

  // workflow（W0 §2 已废弃删除）：存量 book.yaml 里的 workflow 行是未知字段，
  // 不解析、不赋值——下次存配置时 stringifyBookConfig 重建 yaml 自然丢弃该行。

  const book = find('book')
  if (book) {
    const t = book.children.find((c) => c.key === 'title')
    const g = book.children.find((c) => c.key === 'genre')
    const vs = book.children.find((c) => c.key === 'volume_size')
    const tw = book.children.find((c) => c.key === 'target_words')
    if (t) cfg.book.title = String(parseValue(t.value))
    // 全局托底：genre 空串归一 undefined（`genre: ''` 是旧 scaffold 烘焙的默认占位，
    // 与「没写」同义）——否则空串永远盖住 global.json 的 defaultGenre
    if (g) {
      const genre = String(parseValue(g.value))
      if (genre !== '') cfg.book.genre = genre
    }
    if (vs) {
      const volumeSize = parseFiniteNumber(vs.value, NaN)
      if (Number.isSafeInteger(volumeSize) && volumeSize > 0) cfg.book.volume_size = volumeSize
    }
    if (tw) {
      const targetWords = parseFiniteNumber(tw.value, NaN)
      if (Number.isFinite(targetWords) && targetWords > 0) cfg.book.target_words = targetWords
    }
    const ctw = book.children.find((c) => c.key === 'chapter_target_words')
    if (ctw) {
      const v = parseFiniteNumber(ctw.value, 0)
      if (Number.isFinite(v) && v > 0) cfg.book.chapter_target_words = v
    }
  }

  const leads = find('leads')
  if (leads) {
    const en = leads.children.find((c) => c.key === 'enabled')
    if (en) {
      const v = parseValue(en.value)
      if (Array.isArray(v)) {
        // X-P3a：未知账本类过滤 + 留痕——此前静默收下错别字值，作者以为启用了
        const valid = v.map(String).filter((s) => (LEAD_TYPES as readonly string[]).includes(s))
        if (valid.length < v.length) {
          log.warn('book.yaml', `leads.enabled 含未知账本类（合法值：${LEAD_TYPES.join('/')}），已忽略`)
        }
        cfg.leads.enabled = valid
      }
    }
    const th = leads.children.find((c) => c.key === 'thresholds')
    if (th) {
      const thresholds: Record<string, number> = {}
      for (const c of th.children) {
        const num = parseFiniteNumber(c.value, NaN)
        if (Number.isFinite(num)) thresholds[c.key] = num
      }
      if (Object.keys(thresholds).length > 0) cfg.leads.thresholds = thresholds
    }
  }

  const budget = find('budget')
  if (budget) {
    // 全局托底：白名单键 + 坏值不设键（留 undefined 给合并层回落）。
    // 此前 `c.key in cfg.budget` 靠起步值里预填的键当白名单——calls_per_chapter
    // 摘出 DEFAULT_CONFIG 后 in 检查永远 false，旧行内值会被静默丢弃
    for (const c of budget.children) {
      if (BUDGET_KEYS.has(c.key)) {
        const v = parseFiniteNumber(c.value, NaN)
        if (Number.isFinite(v)) (cfg.budget as Record<string, number | undefined>)[c.key] = v
      }
    }
  }

  // 全局托底：style 段从零构建——书里写了合法值才设，未写 = undefined（回落全局）
  const style = find('style')
  if (style) {
    const inj = style.children.find((c) => c.key === 'injection')
    if (inj) {
      const v = String(parseValue(inj.value))
      if (v === 'light' || v === 'heavy') cfg.style = { injection: v }
    }
  }

  // C1（批 2）：摘要金字塔开关——summary.auto: false 关闭生成钩子（回到手写约定现状）。
  // 仅认显式布尔；显式 true 也落 cfg（写侧序列化保真，round-trip 不归一）。
  // parseValue 不产出布尔（无布尔字面量规则）——此前 typeof 守卫是死分支，
  // 书里写 summary.auto: false 永远读不到（关闭开关静默失效），按 strict/confirm_outline
  // 同款字符串比较归一
  const summary = find('summary')
  if (summary) {
    const auto = summary.children.find((c) => c.key === 'auto')
    if (auto) {
      const v = String(parseValue(auto.value))
      if (v === 'true' || v === 'false') cfg.summary = { auto: v === 'true' }
    }
  }

  const short = find('short')
  if (short) {
    const shortConfig: NonNullable<BookConfig['short']> = {}
    const profile = short.children.find((c) => c.key === 'profile')
    if (profile) {
      const value = String(parseValue(profile.value)).trim()
      if (value.length > 0) shortConfig.profile = value
    }
    for (const key of [
      'target_emotions',
      'target_reversal_types',
      'target_ending_flavors',
      'series_motifs',
    ] as const) {
      const node = short.children.find((c) => c.key === key)
      if (!node) continue
      const value = parseValue(node.value)
      if (Array.isArray(value)) {
        const items = value.map(String).map((v) => v.trim()).filter(Boolean)
        if (items.length > 0) shortConfig[key] = items
      }
    }
    const strict = short.children.find((c) => c.key === 'strict')
    if (strict) shortConfig.strict = String(parseValue(strict.value)) === 'true'
    for (const key of [
      'word_min',
      'word_max',
      'body_part_threshold',
      'simile_threshold',
      'section_count',
      'opening_env_chars',
    ] as const) {
      const node = short.children.find((c) => c.key === key)
      if (!node) continue
      const value = parseFiniteNumber(node.value, NaN)
      if (Number.isFinite(value) && value > 0) shortConfig[key] = value
    }
    if (Object.keys(shortConfig).length > 0) cfg.short = shortConfig
  }

  // 全局托底：auto 段从零构建——有键才设（段内全没写 = 整段 undefined，回落全局链）
  const auto = find('auto')
  if (auto) {
    const autoConfig: NonNullable<BookConfig['auto']> = {}
    const co = auto.children.find((c) => c.key === 'confirm_outline')
    if (co) autoConfig.confirm_outline = String(parseValue(co.value)) === 'true'
    const bs = auto.children.find((c) => c.key === 'batch_size')
    if (bs) {
      const v = parseFiniteNumber(bs.value, NaN)
      if (Number.isFinite(v)) autoConfig.batch_size = v
    }
    // RB-KN-P2-10：关系图自动梳理两键——前端 useRelationGraph 已消费，原先解析/序列化
    // 均不支持（作者手写 book.yaml 永远解析成默认值，配置链路断裂）
    const ram = auto.children.find((c) => c.key === 'relation_auto_mine')
    if (ram) autoConfig.relation_auto_mine = String(parseValue(ram.value)) === 'true'
    const rmt = auto.children.find((c) => c.key === 'relation_mine_threshold')
    if (rmt) {
      const v = parseFiniteNumber(rmt.value, NaN)
      if (Number.isFinite(v)) autoConfig.relation_mine_threshold = v
    }
    if (Object.keys(autoConfig).length > 0) cfg.auto = autoConfig
  }

  const growth = find('growth')
  if (growth) {
    const rs = growth.children.find((c) => c.key === 'realm_span_max')
    if (rs) cfg.growth.realm_span_max = parseFiniteNumber(rs.value, DEFAULT_CONFIG.growth.realm_span_max ?? 2)
  }

  // checks 段（机检扩展词表，#10 项 7/11 数据源接线）：显式空数组 = 关（不得归一为
  // undefined——它与「未设」语义不同：未设才回落内置种子表，显式空数组是作者明确
  // 关掉）；段缺失 = 整段 undefined。项级 trim + 去空串与 short 段词表同口径
  const checks = find('checks')
  if (checks) {
    const checksConfig: NonNullable<BookConfig['checks']> = {}
    for (const key of ['imagery_words', 'leak_keywords'] as const) {
      const node = checks.children.find((c) => c.key === key)
      if (!node) continue
      const value = parseValue(node.value)
      // Array.isArray 才收：显式 [] 原样保留（长度 0 也设键）；标量/坏值忽略
      if (Array.isArray(value)) {
        // kk-P2-13：空白词条剔除留痕——静默吞会让作者以为整份词表已按原样生效
        const items = value.map(String)
        const kept = items.map((v) => v.trim()).filter(Boolean)
        if (kept.length < items.length) {
          log.warn('book.yaml', `checks.${key} 含空白词条已剔除（${items.length} 项 → ${kept.length} 项）`)
        }
        checksConfig[key] = kept
      } else {
        log.warn('book.yaml', `checks.${key} 值非数组（${node.value.trim()}），已忽略`)
      }
    }
    if (Object.keys(checksConfig).length > 0) cfg.checks = checksConfig
  }

  // 快照保留策略（单章版本回滚）：缺省不写字段 → 用代码默认值
  const snapshots = find('snapshots')
  if (snapshots) {
    const snapshotsConfig: NonNullable<BookConfig['snapshots']> = {}
    const md = snapshots.children.find((c) => c.key === 'max_days')
    if (md) {
      const v = parseFiniteNumber(md.value, 0)
      if (v > 0) snapshotsConfig.max_days = v
    }
    const mc = snapshots.children.find((c) => c.key === 'max_count')
    if (mc) {
      const v = parseFiniteNumber(mc.value, 0)
      if (v > 0) snapshotsConfig.max_count = v
    }
    if (Object.keys(snapshotsConfig).length > 0) cfg.snapshots = snapshotsConfig
  }

  // RAG 可选段（#37，非密：enabled/provider/endpoint/model；api_key 不入此）
  const rag = find('rag')
  if (rag) {
    const en = rag.children.find((c) => c.key === 'enabled')
    const pv = rag.children.find((c) => c.key === 'provider')
    const ep = rag.children.find((c) => c.key === 'endpoint')
    const md = rag.children.find((c) => c.key === 'model')
    const cd = rag.children.find((c) => c.key === 'candidate_depth')
    const depth = cd ? Number(parseValue(cd.value)) : NaN
    // 低级项（第六轮）：rag 段存在但缺 enabled 键 → 不再整段静默丢弃——
    // 手写了 provider/endpoint 显然意在启用，enabled 缺省 true（显式写 false 才关）
    if (en || pv || ep || md || (Number.isInteger(depth) && depth > 0)) cfg.rag = {
      enabled: en ? String(parseValue(en.value)) === 'true' : true,
      ...(pv ? { provider: String(parseValue(pv.value)) } : {}),
      ...(ep ? { endpoint: String(parseValue(ep.value)) } : {}),
      ...(md ? { model: String(parseValue(md.value)) } : {}),
      // A3（批 7）：候选深度可覆盖（正整数才收，缺省 20 走 recall 侧兜底）
      ...(Number.isInteger(depth) && depth > 0 ? { candidate_depth: depth } : {}),
    }
  }

  return cfg
}

function parseFiniteNumber(raw: string, fallback: number): number {
  const n = Number(parseValue(raw))
  return Number.isFinite(n) ? n : fallback
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
    const roots = parseSections(text)
    return { ok: true, config: sectionsToConfig(roots) }
  } catch (e) {
    return {
      ok: false,
      config: structuredClone(DEFAULT_CONFIG),
      error: { file, line: 0, message: `解析失败：${e instanceof Error ? e.message : String(e)}` },
    }
  }
}

/** BookConfig → YAML 文本（#9 第 2 节格式；短篇集走精简字段，M8 #25） */
export function stringifyBookConfig(cfg: BookConfig): string {
  const isShort = cfg.kind === 'short'
  const lines: string[] = [
    `spec_version: ${cfg.spec_version}`,
    // kind 只在 short 时输出（长篇缺省不写，现有仓库零改动红线，M8 #25）
    ...(isShort ? ['kind: short', ''] : ['']),
    `host: ${cfg.host ?? 'cc'}`,
    'book:',
    `  title: ${stringifyValue(cfg.book.title)}`,
  ]
  // 全局托底：genre 未设（含空串）不落行——空行 = 旧默认占位，写了就盖住全局默认
  if (cfg.book.genre !== undefined && cfg.book.genre !== '') {
    lines.push(`  genre: ${stringifyValue(cfg.book.genre)}`)
  }
  if (cfg.book.volume_size !== undefined) {
    lines.push(`  volume_size: ${cfg.book.volume_size}`)
  }
  if (cfg.book.target_words !== undefined) {
    lines.push(`  target_words: ${cfg.book.target_words}`)
  }
  if (cfg.book.chapter_target_words !== undefined) {
    lines.push(`  chapter_target_words: ${cfg.book.chapter_target_words}`)
  }

  // leads 段：长篇恒输出（账本类）；短篇无（账本降级单章章纲 #27）
  if (!isShort) {
    lines.push('', 'leads:', `  enabled: ${stringifyValue(cfg.leads.enabled)}`)
    if (cfg.leads.thresholds) {
      lines.push('  thresholds:')
      for (const [k, v] of Object.entries(cfg.leads.thresholds)) {
        lines.push(`    ${k}: ${v}`)
      }
    }
  }

  // budget 段：长短共用 calls_per_chapter；长篇额外含 summary 长程项（短篇无分层摘要）。
  // 全局托底：calls_per_chapter 条件行（未设不烘焙 8，回落交给运行时合并层）；短篇段内
  // 只剩这一键，未设时整段不输出；长篇 summary 三键照旧恒写（不进全局托底）
  if (!isShort || cfg.budget.calls_per_chapter !== undefined) {
    lines.push('', 'budget:')
    if (cfg.budget.calls_per_chapter !== undefined) {
      lines.push(`  calls_per_chapter: ${cfg.budget.calls_per_chapter}`)
    }
    // D3（批 5）：双口径预算键——设了才输出（未设不烘焙，回落交运行时合并层）
    if (cfg.budget.tokens_per_chapter !== undefined) {
      lines.push(`  tokens_per_chapter: ${cfg.budget.tokens_per_chapter}`)
    }
    if (cfg.budget.cost_per_chapter !== undefined) {
      lines.push(`  cost_per_chapter: ${cfg.budget.cost_per_chapter}`)
    }
    if (!isShort) {
      lines.push(
        `  input_per_chapter: ${cfg.budget.input_per_chapter ?? 80000}`,
        `  summary_chapter_max: ${cfg.budget.summary_chapter_max ?? 200}`,
        `  summary_volume_max: ${cfg.budget.summary_volume_max ?? 500}`,
      )
    }
  }

  // 全局托底：style 段仅当 injection 有值才输出（写法照 snapshots 段的条件输出范式）
  if (cfg.style?.injection !== undefined) {
    lines.push('', 'style:', `  injection: ${cfg.style.injection}`)
  }

  // C1（批 2）：summary 段仅当显式设过才输出（默认 auto=true 不烘焙，关掉的人写的 false 保真）
  if (cfg.summary?.auto !== undefined) {
    lines.push('', 'summary:', `  auto: ${cfg.summary.auto}`)
  }

  if (isShort && cfg.short && Object.keys(cfg.short).length > 0) {
    lines.push('', 'short:')
    if (cfg.short.profile) lines.push(`  profile: ${stringifyValue(cfg.short.profile)}`)
    if (cfg.short.target_emotions) lines.push(`  target_emotions: ${stringifyValue(cfg.short.target_emotions)}`)
    if (cfg.short.target_reversal_types) lines.push(`  target_reversal_types: ${stringifyValue(cfg.short.target_reversal_types)}`)
    if (cfg.short.target_ending_flavors) lines.push(`  target_ending_flavors: ${stringifyValue(cfg.short.target_ending_flavors)}`)
    if (cfg.short.series_motifs) lines.push(`  series_motifs: ${stringifyValue(cfg.short.series_motifs)}`)
    // 全局托底：显式 false 也照写（roundtrip 零 diff 红线——此前只写 true，
    // `strict: false` 旧文件重存会丢行；未设不输出）
    if (cfg.short.strict !== undefined) lines.push(`  strict: ${cfg.short.strict}`)
    for (const key of [
      'word_min',
      'word_max',
      'body_part_threshold',
      'simile_threshold',
      'section_count',
      'opening_env_chars',
    ] as const) {
      const value = cfg.short[key]
      if (value !== undefined) lines.push(`  ${key}: ${value}`)
    }
  }

  // 全局托底：auto 段只输出已定义键，全未定义省段（写法照 snapshots 段的条件输出范式）
  const autoLines: string[] = [
    ...(cfg.auto?.confirm_outline !== undefined ? [`  confirm_outline: ${cfg.auto.confirm_outline}`] : []),
    ...(cfg.auto?.batch_size !== undefined ? [`  batch_size: ${cfg.auto.batch_size}`] : []),
    // RB-KN-P2-10：显式配置过的关系图两键随写回（缺省不输出——现有仓库零改动红线）
    ...(cfg.auto?.relation_auto_mine !== undefined ? [`  relation_auto_mine: ${cfg.auto.relation_auto_mine}`] : []),
    ...(cfg.auto?.relation_mine_threshold !== undefined ? [`  relation_mine_threshold: ${cfg.auto.relation_mine_threshold}`] : []),
  ]
  if (autoLines.length > 0) lines.push('', 'auto:', ...autoLines)

  // growth 段：长篇输出（成长线/境界）；短篇无（无成长线）
  if (!isShort) {
    lines.push('', 'growth:', `  realm_span_max: ${cfg.growth.realm_span_max ?? 2}`)
  }

  // checks 段（机检扩展词表）：键存在即输出——含显式空数组（round-trip 保真：显式空
  // = 关掉内置回落，与「未设」语义不同，重存不得丢）；整段未设不落段（现有仓库零改动红线）。
  // 长短篇皆可选（高频意象/信息差机检长短都跑）。写法照 auto 段的条件输出范式
  const checksLines: string[] = [
    ...(cfg.checks?.imagery_words !== undefined
      ? [`  imagery_words: ${stringifyValue(cfg.checks.imagery_words)}`]
      : []),
    ...(cfg.checks?.leak_keywords !== undefined
      ? [`  leak_keywords: ${stringifyValue(cfg.checks.leak_keywords)}`]
      : []),
  ]
  if (checksLines.length > 0) lines.push('', 'checks:', ...checksLines)

  // RAG 可选段（#37，非密；key 绝不入此；长短皆可选）。
  // 设了 provider（应用级服务商引用）时不再写 endpoint/model——旧内联字段在 UI 选服务商时已清。
  // candidate_depth（A3 批 7）随段输出——漏写则 PUT /config 解析失败回退分支走本函数全量
  // 重生成时，已配的候选深度被静默抹掉（补丁白名单已认该键，两路口径须一致）
  if (cfg.rag) {
    lines.push(
      '',
      'rag:',
      `  enabled: ${cfg.rag.enabled}`,
      ...(cfg.rag.provider ? [`  provider: ${stringifyValue(cfg.rag.provider)}`] : []),
      ...(!cfg.rag.provider && cfg.rag.endpoint ? [`  endpoint: ${stringifyValue(cfg.rag.endpoint)}`] : []),
      ...(!cfg.rag.provider && cfg.rag.model ? [`  model: ${stringifyValue(cfg.rag.model)}`] : []),
      ...(cfg.rag.candidate_depth !== undefined ? [`  candidate_depth: ${cfg.rag.candidate_depth}`] : []),
    )
  }
  // 快照保留策略（缺省不输出——现有仓库零改动红线）
  if (cfg.snapshots && (cfg.snapshots.max_days !== undefined || cfg.snapshots.max_count !== undefined)) {
    lines.push(
      '',
      'snapshots:',
      ...(cfg.snapshots.max_days !== undefined ? [`  max_days: ${cfg.snapshots.max_days}`] : []),
      ...(cfg.snapshots.max_count !== undefined ? [`  max_count: ${cfg.snapshots.max_count}`] : []),
    )
  }
  return lines.join('\n') + '\n'
}

/** 写 book.yaml */
export function writeBookConfig(filePath: string, cfg: BookConfig): void {
  atomicWriteFile(filePath, stringifyBookConfig(cfg))
}

/**
 * 文本级补丁：替换或追加一个顶层段（V-P2-4）。
 *
 * 读改写场景（enableRag 等）不能走 stringifyBookConfig 全量重生成——解析模型只保
 * 已知字段，作者的 # 注释、未知段、未知子键会静默丢失。此函数只重写目标段的
 * 行区间，区间外的原文（含注释与未知内容）逐字保留。
 *
 * @param raw 现有 book.yaml 全文（空串 = 无文件，纯追加）
 * @param section 顶层段名（如 'rag'）
 * @param body 段体行（不含段头行，如 '  enabled: true'）
 */
export function patchTopSection(raw: string, section: string, body: string): string {
  const lines = raw.split('\n')
  const start = lines.findIndex((l) => l === `${section}:` || l.startsWith(`${section}: `))
  if (start === -1) {
    // 追加：空文件直接写；有内容则补齐结尾换行 + 空行分隔（对齐 stringify 的段间风格）
    if (raw === '') return `${section}:\n${body}\n`
    const prefix = raw.endsWith('\n') ? raw : raw + '\n'
    return `${prefix}\n${section}:\n${body}\n`
  }
  // 段区间末尾 = 下一个顶层 key（非缩进、非注释、非空行）之前
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (l.trim() !== '' && !l.trimStart().startsWith('#') && !/^\s/.test(l)) {
      end = i
      break
    }
  }
  // 保留旧段尾部的空行 run（段间分隔）——替换体本身无尾空行，不补会与下一段粘连
  let blanks = 0
  for (let i = end - 1; i > start; i--) {
    if (lines[i]!.trim() === '') blanks++
    else break
  }
  return [
    ...lines.slice(0, start),
    `${section}:`,
    ...body.split('\n'),
    ...Array.from({ length: blanks }, () => ''),
    ...lines.slice(end),
  ].join('\n')
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
  const lines = raw.split('\n')
  const start = lines.findIndex((l) => l === `${section}:` || l.startsWith(`${section}: `))
  const keyLine = (indent: number): string => ' '.repeat(indent) + `${key}: ${value}`
  if (start === -1) {
    if (raw === '') return `${section}:\n${keyLine(2)}\n`
    const prefix = raw.endsWith('\n') ? raw : raw + '\n'
    return `${prefix}\n${section}:\n${keyLine(2)}\n`
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (l.trim() !== '' && !l.trimStart().startsWith('#') && !/^\s/.test(l)) {
      end = i
      break
    }
  }
  // 直接子键缩进 = 段体内容行最小缩进（与 migrate-defaults 的 deleteSectionKey 同判定）
  let childIndent = -1
  for (let i = start + 1; i < end; i++) {
    const l = lines[i]!
    if (l.trim() === '' || l.trimStart().startsWith('#')) continue
    const ind = l.length - l.trimStart().length
    if (childIndent === -1 || ind < childIndent) childIndent = ind
  }
  if (childIndent === -1) {
    // 段体无内容行 → 键插在段头后
    lines.splice(start + 1, 0, keyLine(2))
    return lines.join('\n')
  }
  const pad = ' '.repeat(childIndent)
  const isKeyLine = (l: string): boolean => l === `${pad}${key}:` || l.startsWith(`${pad}${key}: `)
  for (let i = start + 1; i < end; i++) {
    if (isKeyLine(lines[i]!)) {
      lines[i] = keyLine(childIndent)
      return lines.join('\n')
    }
  }
  // 键不在段内 → 插在段头后首行（先于既有子键，与 stringify 的 title 首位习惯一致）
  lines.splice(start + 1, 0, keyLine(childIndent))
  return lines.join('\n')
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
  const lines = raw.split('\n')
  const start = lines.findIndex((l) => l === `${section}:` || l.startsWith(`${section}: `))
  if (start === -1) {
    if (keyLine === null) return raw
    const body = [`  ${keyLine}`, ...blockLines.map((l) => `    ${l}`)]
    if (raw === '') return `${section}:\n${body.join('\n')}\n`
    const prefix = raw.endsWith('\n') ? raw : raw + '\n'
    return `${prefix}\n${section}:\n${body.join('\n')}\n`
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (l.trim() !== '' && !l.trimStart().startsWith('#') && !/^\s/.test(l)) {
      end = i
      break
    }
  }
  let childIndent = -1
  for (let i = start + 1; i < end; i++) {
    const l = lines[i]!
    if (l.trim() === '' || l.trimStart().startsWith('#')) continue
    const ind = l.length - l.trimStart().length
    if (childIndent === -1 || ind < childIndent) childIndent = ind
  }
  const pad = ' '.repeat(childIndent === -1 ? 2 : childIndent)
  if (childIndent !== -1) {
    const isKeyLine = (l: string): boolean => l === `${pad}${key}:` || l.startsWith(`${pad}${key}: `)
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
      return lines.join('\n')
    }
  }
  // 键不在段内：插入模式插在段头后；删除模式无键可删，原样返回
  if (keyLine === null) return raw
  lines.splice(start + 1, 0, pad + keyLine, ...blockLines.map((l) => pad + '  ' + l))
  return lines.join('\n')
}

/** 顶层标量键（spec_version/kind/host）的替换/删除/插入（无缩进，含锚定插入） */
function setTopScalarKey(raw: string, key: string, line: string | null): string {
  const lines = raw.split('\n')
  const idx = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}: `))
  if (idx !== -1) {
    if (line === null) lines.splice(idx, 1)
    else lines[idx] = line
    return lines.join('\n')
  }
  if (line === null) return raw
  // 插在 spec_version 行后（文件头惯例位置）；无则文件首行
  const anchor = lines.findIndex((l) => l === 'spec_version:' || l.startsWith('spec_version: '))
  lines.splice(anchor === -1 ? 0 : anchor + 1, 0, line)
  return lines.join('\n')
}

/** 补丁叶子：段内单键 + 取有效值（undefined = 该键不落行——归一口径对齐 stringifyBookConfig） */
interface ConfigPatchLeaf {
  section: string
  key: string
  get: (c: BookConfig) => unknown
}

// genre 空串 ≡ 未设（解析侧同归一）；rag 设 provider 时 endpoint/model 不落行
// （stringify 同规则——旧内联字段切服务商后即删）
const CONFIG_PATCH_LEAVES: readonly ConfigPatchLeaf[] = [
  { section: 'book', key: 'title', get: (c) => c.book.title },
  { section: 'book', key: 'genre', get: (c) => (c.book.genre === '' ? undefined : c.book.genre) },
  { section: 'book', key: 'volume_size', get: (c) => c.book.volume_size },
  { section: 'book', key: 'target_words', get: (c) => c.book.target_words },
  { section: 'book', key: 'chapter_target_words', get: (c) => c.book.chapter_target_words },
  { section: 'leads', key: 'enabled', get: (c) => c.leads.enabled },
  { section: 'budget', key: 'calls_per_chapter', get: (c) => c.budget.calls_per_chapter },
  // D3（批 5）双口径 + C1（批 2）开关 + A3（批 7）候选深度——此前漏登白名单，
  // PUT /config 改这些键会静默不落盘（BUDGET_KEYS 与 stringify 侧均已认这些键）
  { section: 'budget', key: 'tokens_per_chapter', get: (c) => c.budget.tokens_per_chapter },
  { section: 'budget', key: 'cost_per_chapter', get: (c) => c.budget.cost_per_chapter },
  { section: 'budget', key: 'input_per_chapter', get: (c) => c.budget.input_per_chapter },
  { section: 'budget', key: 'summary_chapter_max', get: (c) => c.budget.summary_chapter_max },
  { section: 'budget', key: 'summary_volume_max', get: (c) => c.budget.summary_volume_max },
  { section: 'style', key: 'injection', get: (c) => c.style?.injection },
  { section: 'summary', key: 'auto', get: (c) => c.summary?.auto },
  { section: 'short', key: 'profile', get: (c) => c.short?.profile },
  { section: 'short', key: 'target_emotions', get: (c) => c.short?.target_emotions },
  { section: 'short', key: 'target_reversal_types', get: (c) => c.short?.target_reversal_types },
  { section: 'short', key: 'target_ending_flavors', get: (c) => c.short?.target_ending_flavors },
  { section: 'short', key: 'series_motifs', get: (c) => c.short?.series_motifs },
  { section: 'short', key: 'strict', get: (c) => c.short?.strict },
  { section: 'short', key: 'word_min', get: (c) => c.short?.word_min },
  { section: 'short', key: 'word_max', get: (c) => c.short?.word_max },
  { section: 'short', key: 'body_part_threshold', get: (c) => c.short?.body_part_threshold },
  { section: 'short', key: 'simile_threshold', get: (c) => c.short?.simile_threshold },
  { section: 'short', key: 'section_count', get: (c) => c.short?.section_count },
  { section: 'short', key: 'opening_env_chars', get: (c) => c.short?.opening_env_chars },
  { section: 'auto', key: 'confirm_outline', get: (c) => c.auto?.confirm_outline },
  { section: 'auto', key: 'batch_size', get: (c) => c.auto?.batch_size },
  { section: 'auto', key: 'relation_auto_mine', get: (c) => c.auto?.relation_auto_mine },
  { section: 'auto', key: 'relation_mine_threshold', get: (c) => c.auto?.relation_mine_threshold },
  { section: 'growth', key: 'realm_span_max', get: (c) => c.growth.realm_span_max },
  { section: 'checks', key: 'imagery_words', get: (c) => c.checks?.imagery_words },
  { section: 'checks', key: 'leak_keywords', get: (c) => c.checks?.leak_keywords },
  { section: 'rag', key: 'enabled', get: (c) => c.rag?.enabled },
  { section: 'rag', key: 'provider', get: (c) => c.rag?.provider },
  { section: 'rag', key: 'endpoint', get: (c) => (c.rag?.provider ? undefined : c.rag?.endpoint) },
  { section: 'rag', key: 'model', get: (c) => (c.rag?.provider ? undefined : c.rag?.model) },
  { section: 'rag', key: 'candidate_depth', get: (c) => c.rag?.candidate_depth },
  { section: 'snapshots', key: 'max_days', get: (c) => c.snapshots?.max_days },
  { section: 'snapshots', key: 'max_count', get: (c) => c.snapshots?.max_count },
]

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
