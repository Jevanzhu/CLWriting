/**
 * R51-F-3（五十一轮）回归：book 段字数规划三键坏值静默忽略补 warn 留痕。
 *
 * volume_size / target_words / chapter_target_words 坏值此前静默丢弃——违背同文件
 * R37-11（kind/host）/R76-15（阈值族）确立的「配置写了但不生效须有迹可查」warn
 * 纪律：作者笔误（`target_words: 三十万`）后字数规划/投稿画像静默失真无诊断线索。
 * 修复：失败分支 log.warn（键名 + 原始值片段），解析行为不变（仍按未设）。
 */
import { test, expect, vi } from 'vitest'
import { parseBookConfig } from '../../src/format/yaml.js'
import { log } from '../../src/log/index.js'

test('R51-F-3: volume_size 坏值 warn 留痕且按未设处理（行为不变）', () => {
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const parsed = parseBookConfig('spec_version: 1\nbook:\n  title: T\n  volume_size: 三十卷\n')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.config.book.volume_size).toBeUndefined()
    const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
    expect(warned).toContain('book.volume_size 值非法')
    expect(warned).toContain('三十卷')
    expect(warned).toContain('已忽略')
  } finally {
    warnSpy.mockRestore()
  }
})

test('R51-F-3: target_words 坏值 warn 留痕且按未设处理', () => {
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const parsed = parseBookConfig('spec_version: 1\nbook:\n  title: T\n  target_words: -5\n')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.config.book.target_words).toBeUndefined()
    const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
    expect(warned).toContain('book.target_words 值非法')
    expect(warned).toContain('-5')
  } finally {
    warnSpy.mockRestore()
  }
})

test('R51-F-3: chapter_target_words 空值（写了空）同样 warn——「写了空」与「没写」语义差留痕', () => {
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const parsed = parseBookConfig('spec_version: 1\nbook:\n  title: T\n  chapter_target_words: \n')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.config.book.chapter_target_words).toBeUndefined()
    const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
    expect(warned).toContain('book.chapter_target_words 值非法')
  } finally {
    warnSpy.mockRestore()
  }
})

test('R51-F-3: 合法值不触发 warn（warn 面不扩大）', () => {
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const parsed = parseBookConfig(
      'spec_version: 1\nbook:\n  title: T\n  volume_size: 3\n  target_words: 200000\n  chapter_target_words: 3000\n',
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.config.book.volume_size).toBe(3)
      expect(parsed.config.book.target_words).toBe(200000)
      expect(parsed.config.book.chapter_target_words).toBe(3000)
    }
    expect(warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')).not.toContain('值非法')
  } finally {
    warnSpy.mockRestore()
  }
})
