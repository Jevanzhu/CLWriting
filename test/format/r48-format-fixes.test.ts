/**
 * 四十八轮（R48）format 域修复回归：R48-7/8/52/53/54/55。
 * 各用例对应评审报告 R48-N 条目，源修见 src/format/{yaml,leads,frontmatter,frontmatter-core,style-compare}.ts。
 */
import { test, expect } from 'vitest'
import { rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseBookConfig } from '../../src/format/yaml.js'
import { parseHistory, parseHistoryWithPreamble, stringifyHistory, readLead, writeLead } from '../../src/format/leads.js'
import { hasOpenFrontMatterFence } from '../../src/format/frontmatter-core.js'
import { parseFlat, stringifyFlat } from '../../src/format/frontmatter.js'
import { charNgrams, missingNgrams } from '../../src/format/style-compare.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// ── R48-7：rag 段触发条件补 embed_timeout_ms ────────────────

test('R48-7: 手写 rag 段仅含 embed_timeout_ms → 整段不再被丢（enabled 缺省 true + 超时收下）', () => {
  const r = parseBookConfig(['rag:', '  embed_timeout_ms: 45000'].join('\n'))
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.config.rag).toBeDefined()
    expect(r.config.rag).toMatchObject({ enabled: true, embed_timeout_ms: 45000 })
  }
})

// ── R48-8：履历段标题与首条条目之间的手写散文 ────────────────

test('R48-8: parseHistoryWithPreamble 收集标题与首条间散文；节终散文一并兜住', () => {
  // 散文在标题与首条之间 → 收集
  const body = [
    '## 履历',
    '',
    '作者手写在履历开头的备忘。',
    '',
    '- 第012章 埋下：焦痕',
    '续行折入仍归上一条',
  ].join('\n')
  const { entries, preamble } = parseHistoryWithPreamble(body)
  expect(preamble).toBe('作者手写在履历开头的备忘。')
  expect(entries).toHaveLength(1)
  // 续行折入不受影响（R64-17 不回归）
  expect(entries[0]!.证据).toBe('焦痕 续行折入仍归上一条')

  // 节终（无条目）散文同样收集——bodyAfterHistory 只保节终标题之后的内容，
  // 标题与节终标题之间的散文此前同样物理丢失（R48-8 一并兜住）
  const endBody = ['## 履历', '', '节终散文归 after', '## 手记', '正文'].join('\n')
  const end = parseHistoryWithPreamble(endBody)
  expect(end.preamble).toBe('节终散文归 after')
  expect(end.entries).toHaveLength(0)
})

test('R48-8: readLead → writeLead 往返保真履历前散文（此前回写即物理删除）', () => {
  const dir = mkdtempTracked(join(tmpdir(), 'r48-preamble-'))
  const fp = join(dir, '悬念-031-灭门真凶.md')
  try {
    writeFileSync(fp, [
      '---',
      '编号: 悬念-031',
      '标题: 灭门真凶',
      '类型: 悬念',
      '状态: 进行中',
      '开启章: 12',
      '---',
      '',
      '## 履历',
      '',
      '此线每隔十章须回看一次节奏。',
      '',
      '- 第012章 埋下：焦痕',
    ].join('\n'), 'utf-8')

    const r1 = readLead(fp)
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    expect(r1.lead._historyPreamble).toBe('此线每隔十章须回看一次节奏。')

    writeLead(fp, r1.lead)
    const onDisk = readFileSync(fp, 'utf-8')
    expect(onDisk).toContain('此线每隔十章须回看一次节奏。')
    // 原位还原：散文在 ## 履历 标题与首条条目之间
    const headIdx = onDisk.indexOf('## 履历')
    const preIdx = onDisk.indexOf('此线每隔十章须回看一次节奏。')
    const entryIdx = onDisk.indexOf('- 第012章 埋下')
    expect(preIdx).toBeGreaterThan(headIdx)
    expect(preIdx).toBeLessThan(entryIdx)

    // 二次往返稳定（不增值/不漂移）
    const r2 = readLead(fp)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.lead._historyPreamble).toBe('此线每隔十章须回看一次节奏。')
    writeLead(fp, r2.lead)
    expect(readFileSync(fp, 'utf-8')).toBe(onDisk)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R48-8: stringifyHistory 无 preamble 时输出与旧口径逐字节一致', () => {
  const entries = [{ 章号: 12, 动词: '埋下', 证据: '焦痕' }]
  expect(stringifyHistory(entries)).toBe('## 履历\n\n- 第012章 埋下：焦痕')
  expect(stringifyHistory(entries, '  ')).toBe('## 履历\n\n- 第012章 埋下：焦痕')
  expect(stringifyHistory(entries, '备忘')).toBe('## 履历\n\n备忘\n\n- 第012章 埋下：焦痕')
})

// ── R48-55：续行折叠剥行首列表标记 ──────────────────────────

test('R48-55: bullet 续行折叠剥 `- `/`* ` 标记（此前物化「证据 - 备注」不可逆污染）', () => {
  const dash = parseHistory(['## 履历', '- 第012章 埋下：焦痕', '- 备注：待补特写'].join('\n'))
  expect(dash[0]!.证据).toBe('焦痕 备注：待补特写')
  const star = parseHistory(['## 履历', '- 第012章 埋下：焦痕', '* 手记折行'].join('\n'))
  expect(star[0]!.证据).toBe('焦痕 手记折行')
  // 非标记纯文本续行不受影响
  const plain = parseHistory(['## 履历', '- 第012章 埋下：焦痕', '第二行续文'].join('\n'))
  expect(plain[0]!.证据).toBe('焦痕 第二行续文')
})

// ── R48-52：未闭合 fm 判定单源 ─────────────────────────────

test('R48-52: hasOpenFrontMatterFence 与 splitFrontMatter 同口径（起始有/闭合无 → true）', () => {
  expect(hasOpenFrontMatterFence('---\n章号: 1\n标题: 没写结尾\n\n正文')).toBe(true)
  expect(hasOpenFrontMatterFence('---\n章号: 1\n---\n正文')).toBe(false)
  expect(hasOpenFrontMatterFence('只有正文没有 front matter')).toBe(false)
  // BOM 容忍与起始整行精确判定同源（R-12 口径）
  expect(hasOpenFrontMatterFence('\uFEFF---\n章号: 1')).toBe(true)
  expect(hasOpenFrontMatterFence('----\n不是起始')).toBe(false)
})

// ── R48-53：ngram 按码位取窗（astral 汉字不被劈成代理对） ────

test('R48-53: 扩展 B 区生僻字 n-gram 完整取窗，禁词候选不再静默失效', () => {
  // 三个扩展 B 区汉字：UTF-16 下 6 码元，旧码元取窗劈出孤立代理对
  const astral = '𠀀𠀁𠀂'
  const grams = [...charNgrams(astral, 3)]
  expect(grams).toContain(astral)
  // 无孤立代理对混入：剥掉合法代理对后不应残留任何代理码元
  // （注意不用 u 标志——u 模式按码点匹配永远碰不到代理码元，检测必须在码元层）
  const hasLoneSurrogate = (s: string) => /[\uD800-\uDFFF]/.test(s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))
  for (const g of grams) expect(hasLoneSurrogate(g)).toBe(false)
  // 词级信号：报出的缺失项全部为完整 gram（旧码元取窗 + `.length !== n` 兜底判定
  // 会劈出孤立代理对/把合法 astral gram 滤掉）；纯 astral gram 被更长缺失项覆盖是
  // 极大化去碎片既有语义，此处只验码位口径不回退
  const miss = missingNgrams(`前缀${astral}后缀`, '作者版另有其文')
  expect(miss.length).toBeGreaterThan(0)
  for (const g of miss) expect(hasLoneSurrogate(g)).toBe(false)
  expect(miss.some((g) => g.includes(astral))).toBe(true)
})

// ── R48-54：块标量体内纯空白行保原貌 ───────────────────────

test('R48-54: literal 块空白行保留行内缩进（按 minIndent 截断）；folded 空白行仍为段落边界', () => {
  // literal：4 空格空白行、minIndent 2 → 保留 2 空格原貌（旧归一成真空行）
  expect(parseFlat('钩子: |\n  第一段\n    \n  第二段').get('钩子')).toBe('第一段\n  \n第二段')
  // 短于 minIndent 的空白行截到空
  expect(parseFlat('钩子: |\n  第一段\n \n  第二段').get('钩子')).toBe('第一段\n\n第二段')
  // folded：空白行按 YAML 语义仍是段落边界（不回归 Z-20）
  expect(parseFlat('钩子: >\n  第一段\n    \n  第二段').get('钩子')).toBe('第一段\n第二段')

  // 往返稳定：保留下来的缩进空白行写回再读不漂移
  const v = '第一段\n  \n第二段'
  const fmText = stringifyFlat(new Map([['钩子', v]]))
  const body = fmText
  expect(parseFlat(body).get('钩子')).toBe(v)
})
