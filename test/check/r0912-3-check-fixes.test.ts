/**
 * R0912-3 修复批（2026-09-12 全量代码重评 §3.2 B4）check 域回归：
 *
 * - #29：checkFrontMatter 章号前缀解析收编 format/filename.ts chapterNoFromName 单源
 *   ——`6—标题.md` 宽容分隔形态不再静默失明（真不一致必报）；`06 标题.md` 补零/空格
 *   形态与 fm 章号一致不误伤；R33-30 路径形态容忍保留。
 * - #30：runner 对 book 层 repeat_threshold 夹紧 (0,1] + 越界 warn 留痕——手写 1.5
 *   不再无痕杀死复读比率口径（对齐 global 层 unitNum 先例）；≤0 维持解析层既有拒绝。
 * - #31：证据宽容引号集补 ASCII 单引号——单引号包裹证据不再 lead-evidence-miss 伪红；
 *   正文 span 剥引号面（stripQuotedSpans，字面 QUOTED_SPAN_RE）对撇号文本零变化。
 * - #32：checkNewNames 长度窗按码点计 + 名册正则 astral 适配——CJK 增补平面姓名
 *   双向盲区消除；BMP 常规名行为不变。
 */
import { test, expect, vi } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkFrontMatter, checkNewNames, checkSimile } from '../../src/check/count.js'
import { runAllChecks } from '../../src/check/runner.js'
import { DEFAULT_CONFIG, parseBookConfig } from '../../src/format/yaml.js'
import { stripQuotedSpans } from '../../src/check/quotes.js'
import { extractEvidenceCore, evidenceNeedles } from '../../src/check/leads.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import type { ChapterMeta } from '../../src/format/types.js'

const META7 = { 章号: 7, 标题: '标题', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' } as ChapterMeta

const mismatchOf = (meta: ChapterMeta, fileName: string): unknown =>
  checkFrontMatter(meta, fileName).items.find((i) => i.checkId === 'fm-chapter-mismatch')

// ── #29：章号前缀解析单源（fm-chapter-mismatch 双向）──────────────

test('R0912-3 #29: 「6—标题.md」宽分隔形态章号不一致 → 报 fm-chapter-mismatch（此前静默失明）', () => {
  // 修复前窄正则只认 `-`，em-dash 形态解析不出前缀 → Number(undefined)=NaN → 整项跳过
  const hit = mismatchOf(META7, '6—标题.md')
  expect(hit).toBeDefined()
  expect((hit as { level: string }).level).toBe('red')
})

test('R0912-3 #29: 宽分隔形态章号一致不报；「06 标题.md」补零形态不误伤；无数字前缀豁免不变', () => {
  // 与宽容集判等：6—标题.md + fm 章号 6 → 一致不报（不因收编单源引入假阳）
  expect(mismatchOf({ ...META7, 章号: 6 }, '6—标题.md')).toBeUndefined()
  // 补零 + 空格分隔形态（tree/线索核验同宽容集）与 fm 章号判等后不误伤
  expect(mismatchOf({ ...META7, 章号: 6 }, '06 标题.md')).toBeUndefined()
  // 非数字文件名（前言.md）维持既有豁免
  expect(mismatchOf({ ...META7, 章号: 6 }, '前言.md')).toBeUndefined()
  // R33-30 路径形态容忍保留（basename 化后交单源）
  expect(mismatchOf(META7, '正文\\0002-x.md')).toBeDefined()
})

// ── #30：repeat_threshold 夹紧 (0,1] + warn 留痕 ──────────────────

const CH: ChapterMeta = { 章号: 1, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' }
const REP = '他推开门走了出去，雪落了下来，屋里的灯还亮着。'
const REP_BODY = REP.repeat(30) // 8-gram 重复率 ≈ 0.967（同 r52 口径）

const repeatItems = (report: ReturnType<typeof runAllChecks>) =>
  report.sections.flatMap((s) => s.items).filter((i) => i.checkId === 'repeat')

test('R0912-3 #30: repeat_threshold 1.5 → 夹紧 1 + warn 留痕（不再无痕静默杀死复读检查）', () => {
  const tmp = mkdtempTracked(join(tmpdir(), 'clwriting-r0912-3-'))
  const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
  try {
    const cfg = structuredClone(DEFAULT_CONFIG)
    cfg.checks = { repeat_threshold: 1.5, repeat_chars_threshold: 1_000_000 }
    const r = runAllChecks({ bookRoot: tmp, config: cfg, chapter: CH, body: REP_BODY, fileName: '001-雪夜.md' })
    // 夹紧为 1（而非按未设回落 0.15）：比率口径保持关（0.967 ≤ 1）、绝对阈百万 → repeat 静默
    expect(repeatItems(r)).toHaveLength(0)
    // 留痕：越界 warn 点名键与夹紧动作（修复前 1.5 直穿无任何痕迹）
    const hits = warnSpy.mock.calls.filter((c) => String(c[1]).includes('repeat_threshold') && String(c[1]).includes('夹紧'))
    expect(hits).toHaveLength(1)
  } finally {
    warnSpy.mockRestore()
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('R0912-3 #30: repeat_threshold 0.5 合法值原样生效；边界 1 不夹紧不 warn', () => {
  const tmp = mkdtempTracked(join(tmpdir(), 'clwriting-r0912-3-'))
  const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
  try {
    // 0.5 在 (0,1] 内 → 原样：比率口径 0.967 > 0.5 照常报黄，零 warn
    const cfg = structuredClone(DEFAULT_CONFIG)
    cfg.checks = { repeat_threshold: 0.5 }
    const rep = repeatItems(runAllChecks({ bookRoot: tmp, config: cfg, chapter: CH, body: REP_BODY, fileName: '001-雪夜.md' }))
    expect(rep).toHaveLength(1)
    expect(rep[0]!.message).toContain('复读率')
    // 边界 1 恰合法（(0,1] 含 1）→ 不夹紧、零 warn
    const cfg1 = structuredClone(DEFAULT_CONFIG)
    cfg1.checks = { repeat_threshold: 1, repeat_chars_threshold: 1_000_000 }
    expect(repeatItems(runAllChecks({ bookRoot: tmp, config: cfg1, chapter: CH, body: REP_BODY, fileName: '001-雪夜.md' }))).toHaveLength(0)
    expect(warnSpy.mock.calls.filter((c) => String(c[1]).includes('repeat_threshold'))).toHaveLength(0)
  } finally {
    warnSpy.mockRestore()
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('R0912-3 #30: repeat_threshold ≤0 维持解析层既有拒绝（按未设 + warn，回落全局链）', () => {
  const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
  try {
    const r0 = parseBookConfig('checks:\n  repeat_threshold: 0\n')
    expect(r0.ok).toBe(true)
    expect(r0.config.checks).toBeUndefined()
    const rn = parseBookConfig('checks:\n  repeat_threshold: -1\n')
    expect(rn.ok).toBe(true)
    expect(rn.config.checks).toBeUndefined()
    const hits = warnSpy.mock.calls.filter((c) => String(c[1]).includes('checks.repeat_threshold'))
    expect(hits.length).toBeGreaterThanOrEqual(2)
  } finally {
    warnSpy.mockRestore()
  }
})

// ── #31：证据宽容引号集补 ASCII 单引号（span 剥引号面零变化）─────────

test('R0912-3 #31: 单引号包裹证据可提取内文且针串命中（不再 lead-evidence-miss 伪红）', () => {
  // 长证据：CORE 取内文（修复前单引号两头不认 → 整串带引号去 grep 恒 miss）
  expect(extractEvidenceCore("'这一剑藏了十年的杀意'")).toBe('这一剑藏了十年的杀意')
  // 混合短引证据：多候选针串含全剥引号形态，正文无引号写法可命中
  const needles = evidenceNeedles("'雪落'无声")
  expect(needles).toContain('雪落无声')
  expect(needles.some((n) => '雪落无声，天地皆白。'.includes(n))).toBe(true)
})

test('R0912-3 #31: 剥引号消费面对撇号/ASCII 单引号文本行为零变化（R62-8 定谳维持）', () => {
  // ASCII 单引号不构成 span：内容不被剥除（本修复只动证据面 LENIENT，不动 QUOTED_SPAN_RE）
  expect(stripQuotedSpans("'像刀一样'锋利。")).toBe("'像刀一样'锋利。")
  // 英文缩写撇号不干扰既有中文 span 识别
  expect(stripQuotedSpans("他说it's fine。「住手。」")).toBe("他说it's fine。")
  // 含撇号叙述的比喻密度照常统计（checkSimile 剥引号口径不变）
  expect(checkSimile("他念着it's over。风像刀一样刮着脸。", 0).items).toHaveLength(1)
})

// ── #32：checkNewNames 码点长度窗 + 名册正则 astral 适配 ─────────────

const EXT = '\u{2A700}' // 𪀀（U+2A700，CJK 增补平面扩展区段，3 码元 UTF-16 计 6）

test('R0912-3 #32: 增补平面姓名名册登记后不再伪报新专名（名册正则 astral 适配）', () => {
  const tmp = mkdtempTracked(join(tmpdir(), 'clwriting-r0912-3-'))
  const roster = join(tmp, '名册.md')
  writeFileSync(roster, `- 已登记：${EXT}${EXT}${EXT}、云澈\n`, 'utf-8')
  try {
    const r = checkNewNames(`「${EXT}${EXT}${EXT}」缓缓抬头，「云澈」也在场。`, roster)
    // 修复前名册正则仅 BMP：生僻名恒判未登记；长度窗（UTF-16）亦把 3 码点名拒之窗外
    expect(r.items.filter((i) => i.checkId === 'new-name')).toHaveLength(0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('R0912-3 #32: 未登记增补平面姓名照常报候选（长度窗按码点计不误拒）', () => {
  const tmp = mkdtempTracked(join(tmpdir(), 'clwriting-r0912-3-'))
  const roster = join(tmp, '名册.md')
  writeFileSync(roster, '- 已登记：云澈\n', 'utf-8')
  try {
    const r = checkNewNames(`「${EXT}${EXT}${EXT}」缓缓抬头。`, roster)
    const hits = r.items.filter((i) => i.checkId === 'new-name')
    // 修复前 UTF-16 长度 6 > 4 静默跳过（该报不报）；修复后按 3 码点入窗照报
    expect(hits).toHaveLength(1)
    expect(hits[0]!.message).toContain(`${EXT}${EXT}${EXT}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('R0912-3 #32: BMP 常规名行为不变（登记不报/未登记报/超窗不候选）', () => {
  const tmp = mkdtempTracked(join(tmpdir(), 'clwriting-r0912-3-'))
  const roster = join(tmp, '名册.md')
  writeFileSync(roster, '- 已登记：云澈、林晚晴\n', 'utf-8')
  try {
    // 已登记 → 不报
    const ok = checkNewNames('「云澈」拔剑。「林晚晴」皱眉。', roster)
    expect(ok.items.filter((i) => i.checkId === 'new-name')).toHaveLength(0)
    // 未登记 → 照报
    const fresh = checkNewNames('「萧破军」现身。', roster)
    expect(fresh.items.filter((i) => i.checkId === 'new-name')).toHaveLength(1)
    // 6 字仍超窗不候选（窗口上界语义不变）
    const over = checkNewNames('「欧阳青锋慕容」现身。', roster)
    expect(over.items.filter((i) => i.checkId === 'new-name')).toHaveLength(0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
