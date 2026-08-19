/**
 * book.yaml checks 段（机检扩展词表，#10 项 7/11 数据源接线）：
 * - 解析：内联/块列表、显式空数组（= 关掉内置回落）、段缺失 → undefined
 * - 序列化：缺省不落段；键存在即输出（含空数组，round-trip 保真）
 */
import { test, expect } from 'vitest'
import { parseBookConfig, stringifyBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'

const BASE = 'spec_version: 1\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n'

test('checks 段：内联列表解析（imagery + leak 两键）', () => {
  const out = parseBookConfig(
    BASE + 'checks:\n  imagery_words: [空气仿佛凝固, 嘴角勾起一抹]\n  leak_keywords: [身世之谜]\n',
  )
  expect(out.ok).toBe(true)
  expect(out.config.checks?.imagery_words).toEqual(['空气仿佛凝固', '嘴角勾起一抹'])
  expect(out.config.checks?.leak_keywords).toEqual(['身世之谜'])
})

test('checks 段：块列表写法解析（作者手写友好）', () => {
  const out = parseBookConfig(
    BASE + 'checks:\n  imagery_words:\n    - 空气仿佛凝固\n    - 落针可闻\n',
  )
  expect(out.ok).toBe(true)
  expect(out.config.checks?.imagery_words).toEqual(['空气仿佛凝固', '落针可闻'])
})

test('checks 段：显式空数组 = 关掉内置回落（不得归一为 undefined）', () => {
  const out = parseBookConfig(BASE + 'checks:\n  imagery_words: []\n')
  expect(out.ok).toBe(true)
  // undefined = 回落内置种子表；[] = 显式关——两者语义不同，必须区分
  expect(out.config.checks?.imagery_words).toEqual([])
})

test('checks 段：段缺失 → config.checks undefined（回落内置）', () => {
  const out = parseBookConfig(BASE)
  expect(out.ok).toBe(true)
  expect(out.config.checks).toBeUndefined()
})

test('stringifyBookConfig：未设 checks 不落段（现有仓库零改动红线）', () => {
  expect(stringifyBookConfig(DEFAULT_CONFIG)).not.toContain('checks:')
})

test('stringifyBookConfig：键存在即输出，空数组 round-trip 保真', () => {
  const text = stringifyBookConfig({
    ...structuredClone(DEFAULT_CONFIG),
    checks: { imagery_words: [], leak_keywords: ['身世之谜'] },
  })
  expect(text).toContain('checks:')
  expect(text).toContain('imagery_words: []')
  expect(text).toContain('leak_keywords:')
  // round-trip：序列化 → 解析回同值（显式空数组不丢）
  const back = parseBookConfig(text)
  expect(back.ok).toBe(true)
  expect(back.config.checks?.imagery_words).toEqual([])
  expect(back.config.checks?.leak_keywords).toEqual(['身世之谜'])
})

test('stringifyBookConfig：非空词表输出 + round-trip', () => {
  const text = stringifyBookConfig({
    ...structuredClone(DEFAULT_CONFIG),
    checks: { imagery_words: ['空气仿佛凝固'] },
  })
  expect(text).toContain('imagery_words:')
  expect(text).toContain('空气仿佛凝固')
  const back = parseBookConfig(text)
  expect(back.ok).toBe(true)
  expect(back.config.checks?.imagery_words).toEqual(['空气仿佛凝固'])
  expect(back.config.checks?.leak_keywords).toBeUndefined()
})
