/**
 * P1-5（复审-0914-优化修复批）字节级快照锁：book.yaml 键知识三面
 * （sectionsToConfig / stringifyBookConfig / CONFIG_PATCH_LEAVES）收敛为单一
 * schema 表（yaml.ts SECTION_SPECS）前后的现状锚。
 *
 * 锁什么（重构红线）：
 * 1. parse→stringify 字节输出（长篇全键 / 短篇全键 / 缺省 / 容错四形态）——
 *    toMatchInlineSnapshot 逐位钉死，表驱动重构前后不得差一字节；
 * 2. canonical 配置（覆盖全部键）stringify↔parse 双向往返：文本逐位不动点、
 *    配置深度相等（含显式空数组保真 / opening_env_chars 显式 0 保真）；
 * 3. PUT patch 白名单全集逐键锚（46 叶键 + thresholds 特例 + 3 顶层标量）：
 *    改任一键只动目标行，注释/未知段/未知子键逐字保留，重解析收回新值；
 *    删方向（新值 undefined）落行删除；缺段键走插入/追加分支；
 * 4. 容错形态 warn 文案逐字快照（parse 容错与 warn 文案逐位不变红线）。
 *
 * 本文件同时是 PATCH 白名单的清单锁：PATCH_ANCHORS + DELETE_ANCHORS 枚举
 * 即全量白名单（与 yaml.ts CONFIG_PATCH_LEAVES 表驱动派生结果一一对应），
 * 新增键漏登/多登都会在此显式暴露。
 */
import { test, expect, vi } from 'vitest'
import { parseBookConfig, stringifyBookConfig, patchBookConfigText, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

// ── 形态基线（canonical：手写形态即 stringify 产物形态）────────

const LONG_FIXTURE = [
  'spec_version: 1',
  '',
  'host: cc',
  'book:',
  '  title: 长篇样本',
  '  genre: 玄幻',
  '  volume_size: 40',
  '  target_words: 800000',
  '  chapter_target_words: 3000',
  '',
  'leads:',
  '  enabled: [悬念, 布局线]',
  '  thresholds:',
  '    悬念: 40',
  '',
  'budget:',
  '  calls_per_chapter: 8',
  '  tokens_per_chapter: 50000',
  '  cost_per_chapter: 0.5',
  '  input_per_chapter: 90000',
  '  summary_chapter_max: 200',
  '  summary_volume_max: 500',
  '',
  'style:',
  '  injection: heavy',
  '',
  'summary:',
  '  auto: false',
  '',
  'auto:',
  '  confirm_outline: true',
  '  batch_size: 4',
  '  relation_auto_mine: true',
  '  relation_mine_threshold: 5',
  '',
  'growth:',
  '  realm_span_max: 3',
  '',
  'checks:',
  '  imagery_words: [月, 剑]',
  '  leak_keywords: [真名]',
  '  repeat_threshold: 0.2',
  '  repeat_chars_threshold: 150',
  '  max_sentence_len: 50',
  '  imagery_threshold: 5',
  '  word_count_tolerance: 20',
  '',
  'rag:',
  '  enabled: true',
  '  provider: mySvc',
  '  candidate_depth: 30',
  '  embed_timeout_ms: 45000',
  '',
  'snapshots:',
  '  max_days: 30',
  '  max_count: 50',
  '',
].join('\n')

const SHORT_FIXTURE = [
  'spec_version: 1',
  'kind: short',
  '',
  'host: codex',
  'book:',
  '  title: 短篇样本',
  '  target_words: 60000',
  '',
  'budget:',
  '  tokens_per_chapter: 30000',
  '  cost_per_chapter: 0.2',
  '',
  'short:',
  '  profile: 番茄恐怖',
  '  target_emotions: [压抑, 恐惧]',
  '  target_reversal_types: [身份反转]',
  '  target_ending_flavors: [开放]',
  '  series_motifs: [镜子]',
  '  strict: false',
  '  word_min: 6000',
  '  word_max: 18000',
  '  body_part_threshold: 3',
  '  simile_threshold: 8',
  '  section_count: 4',
  '  opening_env_chars: 0',
  '',
  'checks:',
  '  imagery_words: []',
  '',
  'rag:',
  '  enabled: false',
  '',
  'snapshots:',
  '  max_count: 10',
  '',
].join('\n')

/** 容错形态：每族 warn 各触发一次（文案快照见下方专用用例）；非 canonical——
 *  快照捕获的是「解析后重存」的规范化幸存面（坏值不落行/未知段丢弃）。 */
const TOLERANCE_FIXTURE = [
  '# 顶部作者注释',
  'spec_version: abc',
  'kind: maybe',
  'host: badhost',
  'book:',
  '  title: 容错书 # 行尾注释',
  "  genre: ''",
  '  volume_size: -5',
  '  target_words: abc',
  '  chapter_target_words:',
  'leads:',
  '  enabled: [悬念, 未知类]',
  '  thresholds:',
  '    悬念: notanum',
  '    布局线: 20',
  'budget:',
  '  calls_per_chapter: 0',
  '  tokens_per_chapter: 100',
  '  input_per_chapter: abc',
  'style:',
  '  injection: strong',
  'summary:',
  '  auto: maybe',
  'auto:',
  '  confirm_outline: maybe',
  '  batch_size: 0',
  '  relation_mine_threshold: -2',
  'checks:',
  '  imagery_words: [月, , 剑]',
  '  leak_keywords: notanarray',
  '  repeat_threshold: 0',
  '  max_sentence_len: abc',
  'snapshots:',
  '  max_days: -1',
  '  max_count: 0',
  'rag:',
  '  enabled: maybe',
  '  candidate_depth: 0',
  '未知段:',
  '  foo: bar',
  '',
].join('\n')

// ── 1. parse→stringify 字节快照 ─────────────────

test('P1-5 快照: parse→stringify 字节输出（长篇全键/短篇全键/缺省/容错四形态）', () => {
  const out: Record<string, string> = {}
  const long = parseBookConfig(LONG_FIXTURE)
  const short = parseBookConfig(SHORT_FIXTURE)
  const tol = parseBookConfig(TOLERANCE_FIXTURE)
  expect(long.ok, '长篇基线解析失败').toBe(true)
  expect(short.ok, '短篇基线解析失败').toBe(true)
  expect(tol.ok, '容错形态解析失败').toBe(true)
  if (long.ok) out['长篇全键'] = stringifyBookConfig(long.config)
  if (short.ok) out['短篇全键'] = stringifyBookConfig(short.config)
  out['缺省'] = stringifyBookConfig(structuredClone(DEFAULT_CONFIG))
  if (tol.ok) out['容错形态重存'] = stringifyBookConfig(tol.config)
  expect(out).toMatchInlineSnapshot(`
    {
      "容错形态重存": "spec_version: 1

    host: cc
    book:
      title: 容错书

    leads:
      enabled: [悬念]
      thresholds:
        布局线: 20

    budget:
      tokens_per_chapter: 100
      input_per_chapter: 80000
      summary_chapter_max: 200
      summary_volume_max: 500

    growth:
      realm_span_max: 2

    checks:
      imagery_words: [月, 剑]

    rag:
      enabled: true
    ",
      "短篇全键": "spec_version: 1
    kind: short

    host: codex
    book:
      title: 短篇样本
      target_words: 60000

    budget:
      tokens_per_chapter: 30000
      cost_per_chapter: 0.2

    short:
      profile: 番茄恐怖
      target_emotions: [压抑, 恐惧]
      target_reversal_types: [身份反转]
      target_ending_flavors: [开放]
      series_motifs: [镜子]
      strict: false
      word_min: 6000
      word_max: 18000
      body_part_threshold: 3
      simile_threshold: 8
      section_count: 4
      opening_env_chars: 0

    checks:
      imagery_words: []

    rag:
      enabled: false

    snapshots:
      max_count: 10
    ",
      "缺省": "spec_version: 1

    host: cc
    book:
      title: ""

    leads:
      enabled: []

    budget:
      input_per_chapter: 80000
      summary_chapter_max: 200
      summary_volume_max: 500

    growth:
      realm_span_max: 2
    ",
      "长篇全键": "spec_version: 1

    host: cc
    book:
      title: 长篇样本
      genre: 玄幻
      volume_size: 40
      target_words: 800000
      chapter_target_words: 3000

    leads:
      enabled: [悬念, 布局线]
      thresholds:
        悬念: 40

    budget:
      calls_per_chapter: 8
      tokens_per_chapter: 50000
      cost_per_chapter: 0.5
      input_per_chapter: 90000
      summary_chapter_max: 200
      summary_volume_max: 500

    style:
      injection: heavy

    summary:
      auto: false

    auto:
      confirm_outline: true
      batch_size: 4
      relation_auto_mine: true
      relation_mine_threshold: 5

    growth:
      realm_span_max: 3

    checks:
      imagery_words: [月, 剑]
      leak_keywords: [真名]
      repeat_threshold: 0.2
      repeat_chars_threshold: 150
      max_sentence_len: 50
      imagery_threshold: 5
      word_count_tolerance: 20

    rag:
      enabled: true
      provider: mySvc
      candidate_depth: 30
      embed_timeout_ms: 45000

    snapshots:
      max_days: 30
      max_count: 50
    ",
    }
  `)
})

// ── 2. canonical 往返：文本不动点 + 配置深度相等 ──

const LONG_CFG: BookConfig = {
  spec_version: 1,
  host: 'cc', // DEFAULT 预填键：parse 起步值烘焙 'cc'，canonical 配置须显式带才能深度相等
  book: { title: '长篇样本', genre: '玄幻', volume_size: 40, target_words: 800000, chapter_target_words: 3000 },
  leads: { enabled: ['悬念', '布局线'], thresholds: { 悬念: 40 } },
  budget: {
    calls_per_chapter: 8,
    tokens_per_chapter: 50000,
    cost_per_chapter: 0.5,
    input_per_chapter: 90000,
    summary_chapter_max: 200,
    summary_volume_max: 500,
  },
  style: { injection: 'heavy' },
  summary: { auto: false },
  auto: { confirm_outline: true, batch_size: 4, relation_auto_mine: true, relation_mine_threshold: 5 },
  growth: { realm_span_max: 3 },
  checks: {
    imagery_words: ['月', '剑'],
    leak_keywords: ['真名'],
    repeat_threshold: 0.2,
    repeat_chars_threshold: 150,
    max_sentence_len: 50,
    imagery_threshold: 5,
    word_count_tolerance: 20,
  },
  rag: { enabled: true, provider: 'mySvc', candidate_depth: 30, embed_timeout_ms: 45000 },
  snapshots: { max_days: 30, max_count: 50 },
}

const SHORT_CFG: BookConfig = {
  spec_version: 1,
  kind: 'short',
  host: 'codex',
  book: { title: '短篇样本', target_words: 60000 },
  leads: { enabled: [] },
  budget: { tokens_per_chapter: 30000, cost_per_chapter: 0.2, input_per_chapter: 80000, summary_chapter_max: 200, summary_volume_max: 500 },
  short: {
    profile: '番茄恐怖',
    target_emotions: ['压抑', '恐惧'],
    target_reversal_types: ['身份反转'],
    target_ending_flavors: ['开放'],
    series_motifs: ['镜子'],
    strict: false,
    word_min: 6000,
    word_max: 18000,
    body_part_threshold: 3,
    simile_threshold: 8,
    section_count: 4,
    opening_env_chars: 0,
  },
  checks: { imagery_words: [] },
  rag: { enabled: false },
  snapshots: { max_count: 10 },
  // growth 属 DEFAULT 起步值预填键：短篇 parse 恒烘焙 {realm_span_max: 2}，而 stringify
  // 短篇不落 growth 段——canonical 配置须带预填值才能往返深度相等
  growth: { realm_span_max: 2 },
}

test('P1-5 快照: canonical 配置 stringify↔parse 双向往返（长篇全键，含显式空数组语义）', () => {
  const text1 = stringifyBookConfig(LONG_CFG)
  const back = parseBookConfig(text1)
  expect(back.ok).toBe(true)
  if (!back.ok) return
  expect(back.config).toEqual(LONG_CFG)
  // 不动点：再 stringify 逐位相同；显式空数组保真（不得归一 undefined）
  const text2 = stringifyBookConfig(back.config)
  expect(text2).toBe(text1)
  const emptyArr: BookConfig = { ...structuredClone(LONG_CFG), checks: { imagery_words: [], leak_keywords: [] } }
  const emptyText = stringifyBookConfig(emptyArr)
  expect(emptyText).toContain('imagery_words: []')
  expect(emptyText).toContain('leak_keywords: []')
  const emptyBack = parseBookConfig(emptyText)
  expect(emptyBack.ok).toBe(true)
  if (emptyBack.ok) expect(emptyBack.config.checks).toEqual({ imagery_words: [], leak_keywords: [] })
})

test('P1-5 快照: canonical 配置 stringify↔parse 双向往返（短篇全键，opening_env_chars 显式 0 保真）', () => {
  const text1 = stringifyBookConfig(SHORT_CFG)
  const back = parseBookConfig(text1)
  expect(back.ok).toBe(true)
  if (!back.ok) return
  expect(back.config).toEqual(SHORT_CFG)
  expect(back.config.short?.opening_env_chars).toBe(0)
  const text2 = stringifyBookConfig(back.config)
  expect(text2).toBe(text1)
})

// ── 3. PUT patch 白名单全集逐键锚 ────────────────

/** 长篇补丁基线：注释哨兵 + 未知子键 + 未知段 + 全部长篇段 */
const PATCH_LONG = [
  '# 头部作者注释',
  'spec_version: 1',
  '',
  'host: cc',
  'book:',
  '  title: 旧书名',
  '  genre: 玄幻',
  '  volume_size: 40',
  '  unknown_sub: 保留我',
  '',
  '# leads 段前注释',
  'leads:',
  '  enabled:',
  '    - 悬念',
  '    - 布局线',
  '  thresholds:',
  '    悬念: 40',
  '',
  'budget:',
  '  calls_per_chapter: 8',
  '  tokens_per_chapter: 50000',
  '  cost_per_chapter: 0.5',
  '  input_per_chapter: 90000',
  '  summary_chapter_max: 200',
  '  summary_volume_max: 500',
  '',
  'style:',
  '  injection: light',
  '',
  'summary:',
  '  auto: true',
  '',
  'auto:',
  '  confirm_outline: false',
  '  batch_size: 8',
  '  relation_auto_mine: false',
  '  relation_mine_threshold: 3',
  '',
  'growth:',
  '  realm_span_max: 2',
  '',
  'checks:',
  '  imagery_words: [月, 剑]',
  '  leak_keywords: [真名]',
  '  repeat_threshold: 0.15',
  '  repeat_chars_threshold: 200',
  '  max_sentence_len: 60',
  '  imagery_threshold: 3',
  '  word_count_tolerance: 30',
  '',
  'rag:',
  '  enabled: true',
  '  endpoint: https://old.example.com',
  '  model: old-model',
  '  candidate_depth: 30',
  '',
  'snapshots:',
  '  max_days: 14',
  '  max_count: 30',
  '',
  '# 尾部未知段',
  'my_custom:',
  '  foo: bar',
  '',
].join('\n')

/** 短篇补丁基线：short 段 12 键 + kind/宿主 */
const PATCH_SHORT = [
  '# 短篇头部注释',
  'spec_version: 1',
  'kind: short',
  '',
  'host: codex',
  'book:',
  '  title: 短篇旧名',
  '',
  'short:',
  '  profile: 番茄恐怖',
  '  target_emotions: [压抑, 恐惧]',
  '  target_reversal_types: [身份反转]',
  '  target_ending_flavors: [开放]',
  '  series_motifs: [镜子]',
  '  strict: false',
  '  word_min: 6000',
  '  word_max: 18000',
  '  body_part_threshold: 3',
  '  simile_threshold: 8',
  '  section_count: 4',
  '  opening_env_chars: 0',
  '',
  '# 尾部未知段',
  'my_custom:',
  '  foo: bar',
  '',
].join('\n')

const LONG_SENTINELS = ['# 头部作者注释', '  unknown_sub: 保留我', '# leads 段前注释', '# 尾部未知段', 'my_custom:', '  foo: bar']
const SHORT_SENTINELS = ['# 短篇头部注释', '# 尾部未知段', 'my_custom:', '  foo: bar']

interface PatchAnchor {
  /** 键标识（section.key 或顶层标量名） */
  label: string
  base: 'long' | 'short'
  /** 旧→新：mutate 克隆配置得 next（须为 get 归一后的自洽形态） */
  mutate: (cfg: BookConfig) => void
}

/** PUT /config 白名单全集（46 叶键 + thresholds 特例 + 3 顶层标量）。
 *  本清单即白名单锁：与 CONFIG_PATCH_LEAVES 派生结果一一对应。 */
const PATCH_ANCHORS: PatchAnchor[] = [
  { label: 'spec_version', base: 'long', mutate: (c) => { c.spec_version = 2 } },
  { label: 'kind(short→long 显式落行)', base: 'short', mutate: (c) => { c.kind = 'long' } },
  { label: 'host', base: 'long', mutate: (c) => { c.host = 'codex' } },
  { label: 'book.title', base: 'long', mutate: (c) => { c.book.title = '新书名' } },
  { label: 'book.genre', base: 'long', mutate: (c) => { c.book.genre = '都市' } },
  { label: 'book.volume_size', base: 'long', mutate: (c) => { c.book.volume_size = 55 } },
  { label: 'book.target_words', base: 'long', mutate: (c) => { c.book.target_words = 900000 } },
  { label: 'book.chapter_target_words', base: 'long', mutate: (c) => { c.book.chapter_target_words = 2500 } },
  { label: 'leads.enabled', base: 'long', mutate: (c) => { c.leads.enabled = ['成长线', '设定线'] } },
  { label: 'leads.thresholds(特例块)', base: 'long', mutate: (c) => { c.leads.thresholds = { 悬念: 60, 布局线: 25 } } },
  { label: 'budget.calls_per_chapter', base: 'long', mutate: (c) => { c.budget.calls_per_chapter = 6 } },
  { label: 'budget.tokens_per_chapter', base: 'long', mutate: (c) => { c.budget.tokens_per_chapter = 60000 } },
  { label: 'budget.cost_per_chapter', base: 'long', mutate: (c) => { c.budget.cost_per_chapter = 0.8 } },
  { label: 'budget.input_per_chapter', base: 'long', mutate: (c) => { c.budget.input_per_chapter = 95000 } },
  { label: 'budget.summary_chapter_max', base: 'long', mutate: (c) => { c.budget.summary_chapter_max = 250 } },
  { label: 'budget.summary_volume_max', base: 'long', mutate: (c) => { c.budget.summary_volume_max = 600 } },
  { label: 'style.injection', base: 'long', mutate: (c) => { c.style!.injection = 'heavy' } },
  { label: 'summary.auto', base: 'long', mutate: (c) => { c.summary!.auto = false } },
  { label: 'auto.confirm_outline', base: 'long', mutate: (c) => { c.auto!.confirm_outline = true } },
  { label: 'auto.batch_size', base: 'long', mutate: (c) => { c.auto!.batch_size = 5 } },
  { label: 'auto.relation_auto_mine', base: 'long', mutate: (c) => { c.auto!.relation_auto_mine = true } },
  { label: 'auto.relation_mine_threshold', base: 'long', mutate: (c) => { c.auto!.relation_mine_threshold = 7 } },
  { label: 'growth.realm_span_max', base: 'long', mutate: (c) => { c.growth.realm_span_max = 4 } },
  { label: 'checks.imagery_words', base: 'long', mutate: (c) => { c.checks!.imagery_words = ['雪', '刀'] } },
  { label: 'checks.leak_keywords', base: 'long', mutate: (c) => { c.checks!.leak_keywords = [] } },
  { label: 'checks.repeat_threshold', base: 'long', mutate: (c) => { c.checks!.repeat_threshold = 0.25 } },
  { label: 'checks.repeat_chars_threshold', base: 'long', mutate: (c) => { c.checks!.repeat_chars_threshold = 120 } },
  { label: 'checks.max_sentence_len', base: 'long', mutate: (c) => { c.checks!.max_sentence_len = 80 } },
  { label: 'checks.imagery_threshold', base: 'long', mutate: (c) => { c.checks!.imagery_threshold = 4 } },
  { label: 'checks.word_count_tolerance', base: 'long', mutate: (c) => { c.checks!.word_count_tolerance = 25 } },
  { label: 'rag.enabled', base: 'long', mutate: (c) => { c.rag!.enabled = false } },
  { label: 'rag.provider(旧内联 endpoint/model 随切删除)', base: 'long', mutate: (c) => {
      c.rag!.provider = 'mySvc'
      c.rag!.endpoint = undefined
      c.rag!.model = undefined
    } },
  { label: 'rag.endpoint', base: 'long', mutate: (c) => { c.rag!.endpoint = 'https://new.example.com' } },
  { label: 'rag.model', base: 'long', mutate: (c) => { c.rag!.model = 'new-model' } },
  { label: 'rag.candidate_depth', base: 'long', mutate: (c) => { c.rag!.candidate_depth = 25 } },
  { label: 'rag.embed_timeout_ms', base: 'long', mutate: (c) => { c.rag!.embed_timeout_ms = 60000 } },
  { label: 'snapshots.max_days', base: 'long', mutate: (c) => { c.snapshots!.max_days = 21 } },
  { label: 'snapshots.max_count', base: 'long', mutate: (c) => { c.snapshots!.max_count = 40 } },
  { label: 'short.profile', base: 'short', mutate: (c) => { c.short!.profile = '惊悚快节奏' } },
  { label: 'short.target_emotions', base: 'short', mutate: (c) => { c.short!.target_emotions = ['恐惧'] } },
  { label: 'short.target_reversal_types', base: 'short', mutate: (c) => { c.short!.target_reversal_types = ['视角反转'] } },
  { label: 'short.target_ending_flavors', base: 'short', mutate: (c) => { c.short!.target_ending_flavors = ['反转'] } },
  { label: 'short.series_motifs', base: 'short', mutate: (c) => { c.short!.series_motifs = ['钟声'] } },
  { label: 'short.strict', base: 'short', mutate: (c) => { c.short!.strict = true } },
  { label: 'short.word_min', base: 'short', mutate: (c) => { c.short!.word_min = 5000 } },
  { label: 'short.word_max', base: 'short', mutate: (c) => { c.short!.word_max = 25000 } },
  { label: 'short.body_part_threshold', base: 'short', mutate: (c) => { c.short!.body_part_threshold = 2 } },
  { label: 'short.simile_threshold', base: 'short', mutate: (c) => { c.short!.simile_threshold = 6 } },
  { label: 'short.section_count', base: 'short', mutate: (c) => { c.short!.section_count = 6 } },
  { label: 'short.opening_env_chars', base: 'short', mutate: (c) => { c.short!.opening_env_chars = 200 } },
]

/** 删方向锚（新值 undefined → 落行删除）；仅可选键（必填键删除语义不成立） */
const DELETE_ANCHORS: PatchAnchor[] = [
  { label: 'book.genre → 未设（get 归一删行）', base: 'long', mutate: (c) => { c.book.genre = undefined } },
  { label: 'style.injection → undefined', base: 'long', mutate: (c) => { delete c.style } },
  { label: 'summary.auto → undefined', base: 'long', mutate: (c) => { delete c.summary } },
  { label: 'auto.batch_size → undefined', base: 'long', mutate: (c) => { c.auto!.batch_size = undefined } },
  { label: 'budget.tokens_per_chapter → undefined', base: 'long', mutate: (c) => { c.budget.tokens_per_chapter = undefined } },
  { label: 'checks.leak_keywords → undefined', base: 'long', mutate: (c) => { c.checks!.leak_keywords = undefined } },
  { label: 'rag.endpoint → undefined', base: 'long', mutate: (c) => { c.rag!.endpoint = undefined } },
  { label: 'rag.candidate_depth → undefined', base: 'long', mutate: (c) => { delete c.rag!.candidate_depth } },
  { label: 'snapshots.max_count → undefined', base: 'long', mutate: (c) => { c.snapshots!.max_count = undefined } },
  { label: 'leads.thresholds → undefined（特例块删除）', base: 'long', mutate: (c) => { c.leads.thresholds = undefined } },
]

function runAnchor(a: PatchAnchor): void {
  const raw = a.base === 'long' ? PATCH_LONG : PATCH_SHORT
  const parsed = parseBookConfig(raw)
  expect(parsed.ok, `${a.label} 基线解析失败`).toBe(true)
  if (!parsed.ok) return
  const old = parsed.config
  const next = structuredClone(old)
  a.mutate(next)
  const out = patchBookConfigText(raw, old, next)
  // 文本确实动了
  expect(out, `${a.label} 补丁未生效`).not.toBe(raw)
  // 区间外哨兵逐字保留
  for (const s of a.base === 'long' ? LONG_SENTINELS : SHORT_SENTINELS) {
    expect(out, `${a.label} 丢失哨兵 ${s}`).toContain(s)
  }
  // 回读等于 next（改键真生效且未伤及其余键）
  const reparsed = parseBookConfig(out)
  expect(reparsed.ok, `${a.label} 补丁后解析失败`).toBe(true)
  if (reparsed.ok) {
    expect(reparsed.config, `${a.label} 补丁后回读 ≠ next`).toEqual(next)
  }
}

test('P1-5 快照: PUT patch 白名单全集逐键生效（46 叶键 + thresholds 特例 + 3 顶层标量）', () => {
  expect(PATCH_ANCHORS).toHaveLength(50)
  for (const a of PATCH_ANCHORS) runAnchor(a)
})

test('P1-5 快照: PUT patch 删方向（新值 undefined 落行删除）', () => {
  expect(DELETE_ANCHORS).toHaveLength(10)
  for (const a of DELETE_ANCHORS) runAnchor(a)
})

test('P1-5 快照: 缺段键走插入/追加分支（snapshots 整段缺失时补键追加成段）', () => {
  const raw = PATCH_LONG.replace(/\nsnapshots:\n  max_days: 14\n  max_count: 30\n/, '\n')
  expect(raw).not.toContain('snapshots')
  const parsed = parseBookConfig(raw)
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) return
  const next = structuredClone(parsed.config)
  next.snapshots = { max_days: 30 }
  const out = patchBookConfigText(raw, parsed.config, next)
  expect(out).toContain('snapshots:')
  expect(out).toContain('  max_days: 30')
  expect(out).not.toContain('max_count')
  expect(out).toContain('# 尾部未知段')
  const reparsed = parseBookConfig(out)
  expect(reparsed.ok).toBe(true)
  if (reparsed.ok) expect(reparsed.config).toEqual(next)
})

// ── 4. 容错 warn 文案逐字快照 ───────────────────

test('P1-5 快照: 容错形态 warn 文案逐字快照（parse 容错语义红线）', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const r = parseBookConfig(TOLERANCE_FIXTURE)
    expect(r.ok).toBe(true)
    const msgs = warnSpy.mock.calls.map((c) => c.map((x) => String(x)).join(' | '))
    expect(msgs).toMatchInlineSnapshot(`
      [
        "[book.yaml] spec_version 值非法（「abc」），回落 1",
        "[book.yaml] kind 值非法（「maybe」），已按缺省 long 处理",
        "[book.yaml] host 值非法（「badhost」），已按缺省 cc 处理",
        "[book.yaml] book.volume_size 值非法（「-5」），已忽略（按未设处理）",
        "[book.yaml] book.target_words 值非法（「abc」），已忽略（按未设处理）",
        "[book.yaml] book.chapter_target_words 值非法（「」），已忽略（按未设处理）",
        "[book.yaml] leads.enabled 含未知账本类（合法值：悬念/感情线/布局线/设定线/成长线/关系线），已忽略",
        "[book.yaml] leads.thresholds.悬念 值非正数（「notanum」），已忽略（按未设处理）",
        "[book.yaml] budget.calls_per_chapter 值非正数（「0」），已忽略（按未设处理）",
        "[book.yaml] budget.input_per_chapter 值非正数（「abc」），已忽略（按未设处理）",
        "[book.yaml] summary.auto 值非合法布尔（「maybe」，合法：true/false/yes/no/on/off/1/0），已忽略（按未设处理，回落缺省）",
        "[book.yaml] auto.confirm_outline 值非合法布尔（「maybe」，合法：true/false/yes/no/on/off/1/0），已忽略（按未设处理，回落缺省）",
        "[book.yaml] auto.batch_size 值非正数（「0」），已忽略（按未设处理）",
        "[book.yaml] auto.relation_mine_threshold 值非正数（「-2」），已忽略（按未设处理）",
        "[book.yaml] checks.imagery_words 含空白词条已剔除（3 项 → 2 项）",
        "[book.yaml] checks.leak_keywords 值非数组（notanarray），已忽略",
        "[book.yaml] checks.repeat_threshold 值非正数（「0」），已忽略（按未设处理）",
        "[book.yaml] checks.max_sentence_len 值非正数（「abc」），已忽略（按未设处理）",
        "[book.yaml] snapshots.max_days 值非正数（「-1」），已忽略（按未设处理）",
        "[book.yaml] snapshots.max_count 值非正数（「0」），已忽略（按未设处理）",
        "[book.yaml] rag.enabled 值非合法布尔（「maybe」，合法：true/false/yes/no/on/off/1/0），已忽略（按未设处理，回落缺省）",
      ]
    `)
    if (r.ok) {
      // 容错语义要点（文案之外的行为面）
      expect(r.config.spec_version).toBe(1)
      expect(r.config.kind).toBeUndefined()
      expect(r.config.host).toBe('cc')
      expect(r.config.book.title).toBe('容错书')
      expect(r.config.book.genre).toBeUndefined()
      expect(r.config.book.volume_size).toBeUndefined()
      expect(r.config.book.target_words).toBeUndefined()
      expect(r.config.book.chapter_target_words).toBeUndefined()
      expect(r.config.leads.enabled).toEqual(['悬念'])
      expect(r.config.leads.thresholds).toEqual({ 布局线: 20 })
      expect(r.config.budget.calls_per_chapter).toBeUndefined()
      expect(r.config.budget.tokens_per_chapter).toBe(100)
      // input_per_chapter 属 DEFAULT 预填键（不进全局托底）：坏值 warn 后维持起步值 80000
      expect(r.config.budget.input_per_chapter).toBe(80000)
      expect(r.config.style).toBeUndefined()
      expect(r.config.summary).toBeUndefined()
      expect(r.config.auto).toBeUndefined()
      expect(r.config.checks?.imagery_words).toEqual(['月', '剑'])
      expect(r.config.checks?.leak_keywords).toBeUndefined()
      expect(r.config.checks?.repeat_threshold).toBeUndefined()
      expect(r.config.checks?.max_sentence_len).toBeUndefined()
      expect(r.config.snapshots).toBeUndefined()
      expect(r.config.rag).toEqual({ enabled: true })
      expect('未知段' in (r.config as unknown as Record<string, unknown>)).toBe(false)
    }
  } finally {
    warnSpy.mockRestore()
  }
})
