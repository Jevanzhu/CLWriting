/**
 * R37-11（三十七轮批 B）回归：book.yaml 坏值静默吞补 warn 留痕。
 *
 * 根因：sectionsToConfig 的 kind / host / snapshots.max_days / snapshots.max_count
 * 四处值解析失败分支静默落默认（或跳过）——真实文件损坏/作者笔误（kind: shrt）时
 * 用户无感知：短篇稿被静默路由长篇轨、快照保留策略悄悄失效。修复：失败分支
 * log.warn 留痕（带键名 + 原始值片段，超 40 字符截断），解析行为不变（仍落默认）。
 * 口径对齐 :202 spec_version 的既有 warn 纪律（R26-38）。
 */
import { test, expect, vi } from 'vitest'
import { parseBookConfig } from '../../src/format/yaml.js'
import { log } from '../../src/log/index.js'

test('R37-11: kind 坏值 warn 留痕且仍落缺省 long（行为不变）', () => {
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const parsed = parseBookConfig('spec_version: 1\nkind: shrt\nbook:\n  title: T\n')
    expect(parsed.ok).toBe(true)
    // 坏值与「没写」同形（cfg.kind 保持 undefined，不落错值）——缺省 long 由下游
    // resolve 链兜底；解析层语义不变，只补 warn 留痕
    if (parsed.ok) expect(parsed.config.kind).toBeUndefined()
    const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
    expect(warned).toContain('kind 值非法')
    expect(warned).toContain('shrt')
    expect(warned).toContain('已按缺省 long 处理')
  } finally {
    warnSpy.mockRestore()
  }
})

test('R37-11: host 坏值 warn 留痕且仍落缺省 cc（行为不变）', () => {
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const parsed = parseBookConfig('spec_version: 1\nhost: claude\nbook:\n  title: T\n')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.config.host).toBe('cc')
    const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
    expect(warned).toContain('host 值非法')
    expect(warned).toContain('claude')
    expect(warned).toContain('已按缺省 cc 处理')
  } finally {
    warnSpy.mockRestore()
  }
})

test('R37-11: snapshots 两键坏值各自 warn 且整段按未设处理（config.snapshots 不落）', () => {
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const parsed = parseBookConfig([
      'spec_version: 1',
      'book:',
      '  title: T',
      'snapshots:',
      '  max_days: abc',
      '  max_count: -3',
    ].join('\n'))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.config.snapshots).toBeUndefined() // 坏键全忽略 → 段不落
    const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
    expect(warned).toContain('snapshots.max_days 值非正数')
    expect(warned).toContain('abc')
    expect(warned).toContain('snapshots.max_count 值非正数')
    expect(warned).toContain('-3')
  } finally {
    warnSpy.mockRestore()
  }
})

test('R37-11: 合法值不触发 warn（既有解析行为零扰动）', () => {
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const parsed = parseBookConfig([
      'spec_version: 1',
      'kind: short',
      'host: codex',
      'book:',
      '  title: T',
      'snapshots:',
      '  max_days: 7',
      '  max_count: 5',
    ].join('\n'))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.config.kind).toBe('short')
      expect(parsed.config.host).toBe('codex')
      expect(parsed.config.snapshots).toEqual({ max_days: 7, max_count: 5 })
    }
    expect(warnSpy).not.toHaveBeenCalled()
  } finally {
    warnSpy.mockRestore()
  }
})

test('R37-11: 超长坏值 warn 截断到 40 字符（不留整段垃圾进日志）', () => {
  const longJunk = 'x'.repeat(120)
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const parsed = parseBookConfig(`spec_version: 1\nkind: ${longJunk}\nbook:\n  title: T\n`)
    expect(parsed.ok).toBe(true)
    const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
    expect(warned).toContain('x'.repeat(40))
    expect(warned).not.toContain('x'.repeat(41)) // 40 字符封口
  } finally {
    warnSpy.mockRestore()
  }
})
