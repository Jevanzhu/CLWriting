/**
 * R52-E-2（五十二轮）回归：机检阈值五键配置面——
 * checks.repeat_threshold / repeat_chars_threshold / max_sentence_len /
 * imagery_threshold / word_count_tolerance 此前 parse/stringify/补丁白名单三层全断
 * （作者手写 book.yaml 被静默丢弃，PUT /config 改键静默不落盘）。
 * 本文件钉：解析合法收值 / 坏值 warn 按未设 / round-trip 保真 / patchBookConfigText 落盘。
 */
import { test, expect, vi } from 'vitest'
import {
  parseBookConfig,
  stringifyBookConfig,
  patchBookConfigText,
  DEFAULT_CONFIG,
} from '../../src/format/yaml.js'
import { log } from '../../src/log/index.js'

const BOOK_HEAD = 'spec_version: 1\nbook:\n  title: T\n'

function yamlWithChecks(lines: string[]): string {
  return BOOK_HEAD + ['checks:', ...lines.map((l) => `  ${l}`)].join('\n') + '\n'
}

test('R52-E-2: checks 五阈值键合法值 → 收进 cfg.checks（数值保真，含小数）', () => {
  const parsed = parseBookConfig(
    yamlWithChecks([
      'repeat_threshold: 0.2',
      'repeat_chars_threshold: 300',
      'max_sentence_len: 80',
      'imagery_threshold: 5',
      'word_count_tolerance: 40',
    ]),
  )
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) return
  expect(parsed.config.checks).toMatchObject({
    repeat_threshold: 0.2,
    repeat_chars_threshold: 300,
    max_sentence_len: 80,
    imagery_threshold: 5,
    word_count_tolerance: 40,
  })
})

test('R52-E-2: 坏值（非数字/负数/零）→ warn 留痕按未设，好键不受连坐', () => {
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const parsed = parseBookConfig(
      yamlWithChecks([
        'repeat_threshold: abc',
        'repeat_chars_threshold: -1',
        'max_sentence_len: 0',
        'imagery_threshold: 5',
      ]),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    // 坏键不落（与「未设」同形，回落全局链/引擎默认）
    expect(parsed.config.checks?.repeat_threshold).toBeUndefined()
    expect(parsed.config.checks?.repeat_chars_threshold).toBeUndefined()
    expect(parsed.config.checks?.max_sentence_len).toBeUndefined()
    // 好键保留
    expect(parsed.config.checks?.imagery_threshold).toBe(5)
    const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
    expect(warned).toContain('checks.repeat_threshold 值非正数')
    expect(warned).toContain('abc')
    expect(warned).toContain('checks.repeat_chars_threshold 值非正数')
    expect(warned).toContain('checks.max_sentence_len 值非正数')
  } finally {
    warnSpy.mockRestore()
  }
})

test('R52-E-2: round-trip——parse → stringify → parse 五键保真', () => {
  const first = parseBookConfig(
    yamlWithChecks(['repeat_threshold: 0.25', 'repeat_chars_threshold: 250', 'max_sentence_len: 90', 'imagery_threshold: 6', 'word_count_tolerance: 45']),
  )
  expect(first.ok).toBe(true)
  if (!first.ok) return
  const second = parseBookConfig(stringifyBookConfig(first.config))
  expect(second.ok).toBe(true)
  if (!second.ok) return
  expect(second.config.checks).toEqual(first.config.checks)
})

test('R52-E-2: stringify 未设键不落行（现仓库零改动红线）', () => {
  const text = stringifyBookConfig(structuredClone(DEFAULT_CONFIG))
  expect(text).not.toContain('repeat_threshold')
  expect(text).not.toContain('word_count_tolerance')
  expect(text).not.toContain('checks:')
})

test('R52-E-2: patchBookConfigText 补丁白名单认五键——PUT /config 改键落盘', () => {
  const oldText = yamlWithChecks(['imagery_threshold: 3'])
  const oldParsed = parseBookConfig(oldText)
  expect(oldParsed.ok).toBe(true)
  if (!oldParsed.ok) return
  const newCfg = structuredClone(oldParsed.config)
  // 改一个已有键 + 新增一个此前未设的键
  newCfg.checks = {
    ...newCfg.checks,
    imagery_threshold: 7,
    repeat_threshold: 0.3,
  }
  const patched = patchBookConfigText(oldText, oldParsed.config, newCfg)
  const reparsed = parseBookConfig(patched)
  expect(reparsed.ok).toBe(true)
  if (!reparsed.ok) return
  expect(reparsed.config.checks?.imagery_threshold).toBe(7)
  expect(reparsed.config.checks?.repeat_threshold).toBe(0.3)
})

test('R52-E-2: patchBookConfigText 未变化的五键不产生无谓改写', () => {
  const oldText = yamlWithChecks(['max_sentence_len: 75'])
  const oldParsed = parseBookConfig(oldText)
  expect(oldParsed.ok).toBe(true)
  if (!oldParsed.ok) return
  const patched = patchBookConfigText(oldText, oldParsed.config, structuredClone(oldParsed.config))
  expect(patched).toBe(oldText)
})
