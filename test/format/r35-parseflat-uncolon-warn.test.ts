/**
 * R35-22（三十五轮）回归：parseFlat 无冒号残行 warn 留痕（对齐 yaml.ts R64-24 口径）。
 *
 * 缺陷：parseFlat 对无冒号行静默跳过——章 front matter 手写残句/续行「写了但不生效」
 * 无迹可查，与 book.yaml 侧的无冒号 warn 纪律分裂。
 */
import { test, expect, vi } from 'vitest'
import { parseFlat } from '../../src/format/frontmatter.js'
import { log } from '../../src/log/index.js'

test('R35-22: 无冒号残行 warn 留痕且不中断解析（后续键行照常入表）', () => {
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const m = parseFlat('标题: 某章\n这不是一行键值\n章号: 5')
    expect(m.get('标题')).toBe('某章')
    expect(m.get('章号')).toBe(5)
    expect(warnSpy).toHaveBeenCalled()
    const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
    expect(warned).toContain('无冒号行被丢弃')
    expect(warned).toContain('这不是一行键值')
  } finally {
    warnSpy.mockRestore()
  }
})

test('R35-22: 空行与注释行不触发 warn（既有跳过口径不变）', () => {
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const m = parseFlat('\n# 手写注释\n标题: 某章\n')
    expect(m.get('标题')).toBe('某章')
    expect(warnSpy).not.toHaveBeenCalled()
  } finally {
    warnSpy.mockRestore()
  }
})
