/**
 * R34D-2（三十四轮）回归：履历畸形行不再折入上一条证据（账本静默损坏防线）。
 *
 * 修复背景：HISTORY_ENTRY_RE 证据段 `(.+)` 要求非空证据 + 章号后空格，三种畸形形态
 * （空证据 `- 第030章 递进：` / 缺空格 `- 第030章递进：` / 全角数字 `第０１２章`）
 * 此前全部落 R64-17 续行折入分支被折空格拼进上一条证据，下次 stringifyHistory 回写
 * 把改写后的证据物化——整条声明蒸发 + 上一条证据被污染。
 * 修后：空证据行由主正则收编；缺空格/全角数字由 HISTORY_ENTRY_LOOSE_RE 二次抢救为
 * 独立条目（回写物化为规范形态）；均不污染既有条目证据。
 * 附 R34D-11：readLeadDir 对 `.MD` 大写扩展名不再隐形。
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readLead,
  writeLead,
  parseHistory,
  stringifyHistory,
  readLeadDir,
} from '../../src/format/leads.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const FM = '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 12\n---\n'

// ── 三种畸形形态：不蒸发声明、不污染上一条 ──────────

test('R34D-2: 空证据行收编为独立条目，不污染上一条证据', () => {
  const body = `## 履历

- 第012章 埋下：林家祠堂的焦痕。
- 第030章 递进：
`
  const entries = parseHistory(body)
  expect(entries).toHaveLength(2)
  // 上一条证据不被折入污染（修复前「- 第030章 递进：」整行折进焦痕证据）
  expect(entries[0]!.证据).toBe('林家祠堂的焦痕。')
  expect(entries[1]!.章号).toBe(30)
  expect(entries[1]!.动词).toBe('递进')
  expect(entries[1]!.证据).toBe('')
})

test('R34D-2: 缺空格条目抢救为独立条目，不折入上一条', () => {
  const body = `## 履历

- 第012章 埋下：林家祠堂的焦痕。
- 第030章递进：管家提到狗没叫。
`
  const entries = parseHistory(body)
  expect(entries).toHaveLength(2)
  expect(entries[0]!.证据).toBe('林家祠堂的焦痕。')
  expect(entries[1]!.章号).toBe(30)
  expect(entries[1]!.动词).toBe('递进')
  expect(entries[1]!.证据).toBe('管家提到狗没叫。')
})

test('R34D-2: 全角数字章号抢救归一，声明不蒸发', () => {
  const body = `## 履历

- 第012章 埋下：林家祠堂的焦痕。
- 第０４７章 揭晓：真凶是二叔。
`
  const entries = parseHistory(body)
  expect(entries).toHaveLength(2)
  expect(entries[0]!.证据).toBe('林家祠堂的焦痕。')
  expect(entries[1]!.章号).toBe(47)
  expect(entries[1]!.动词).toBe('揭晓')
  expect(entries[1]!.证据).toBe('真凶是二叔。')
})

// ── parse→stringify 往返保真 ────────────────────

test('R34D-2: parse→stringify 往返保真（畸形行内容不丢、不拼进其他条目）', () => {
  const body = `## 履历

- 第012章 埋下：林家祠堂的焦痕。
- 第030章递进：管家提到狗没叫。
- 第０４７章 揭晓：真凶是二叔。
- 第052章 回收：
`
  const entries = parseHistory(body)
  const text = stringifyHistory(entries)
  // 全部声明物化为规范形态（章号半角、缺空格补齐、空证据保留）
  expect(text).toContain('- 第012章 埋下：林家祠堂的焦痕。')
  expect(text).toContain('- 第030章 递进：管家提到狗没叫。')
  expect(text).toContain('- 第047章 揭晓：真凶是二叔。')
  expect(text).toContain('- 第052章 回收：')
  // 不把畸形行文本拼进其他条目
  expect(text).not.toContain('林家祠堂的焦痕。 - 第030章')
  // 规范化后幂等（再解析走主正则、结果一致）
  expect(parseHistory(text)).toEqual(entries)
})

// ── readLead→writeLead 全链回写保真 ──────────────

test('R34D-2: readLead→writeLead 全链回写，畸形行声明不丢失且 after 段保真', () => {
  const dir = mkdtempTracked(join(tmpdir(), 'r34d-leads-'))
  const fp = join(dir, '悬念-001-灭门真凶.md')
  writeFileSync(fp, FM + `
## 履历

- 第012章 埋下：林家祠堂的焦痕。
- 第030章递进：管家提到狗没叫。

## 手记
作者备注。
`, 'utf-8')
  try {
    const r = readLead(fp)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.lead.履历).toHaveLength(2)
    writeLead(fp, r.lead)
    const out = readFileSync(fp, 'utf-8')
    // 畸形行声明以规范形态物化（不丢失、不拼进上一条证据）
    expect(out).toContain('- 第012章 埋下：林家祠堂的焦痕。')
    expect(out).toContain('- 第030章 递进：管家提到狗没叫。')
    expect(out).not.toContain('焦痕。 - 第030章')
    // after 段人工正文保真（bodyAfterHistory 节终口径不受影响）
    expect(out).toContain('## 手记')
    expect(out).toContain('作者备注。')
    // 回写后再读幂等（抢救条目已规范化，主正则直接接管）
    const r2 = readLead(fp)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.lead.履历).toEqual(r.lead.履历)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── R64-17 多行证据续行不受守卫影响 ──────────────

test('R34D-2: R64-17 多行证据续行折入不受畸形守卫影响', () => {
  const body = `## 履历

- 第012章 埋下：林家祠堂的焦痕，
在烛火下泛着暗红。
- 第030章 递进：管家提到狗没叫。
`
  const entries = parseHistory(body)
  expect(entries).toHaveLength(2)
  expect(entries[0]!.证据).toBe('林家祠堂的焦痕， 在烛火下泛着暗红。')
  expect(entries[1]!.证据).toBe('管家提到狗没叫。')
})

// ── R34D-11：readLeadDir 对 .MD 大写扩展名可见 ────

test('R34D-11: readLeadDir 发现 .MD 大写扩展名账本文件', () => {
  const dir = mkdtempTracked(join(tmpdir(), 'r34d-lead-md-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '悬念-001-灭门真凶.MD'), FM + '\n## 履历\n\n- 第012章 埋下：焦痕。\n', 'utf-8')
  try {
    const { leads, errors } = readLeadDir(dir)
    expect(errors).toHaveLength(0)
    expect(leads).toHaveLength(1)
    expect(leads[0]!.编号).toBe('悬念-001')
    expect(leads[0]!.履历[0]!.证据).toBe('焦痕。')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
