/**
 * 四轮-D403（2026-09-18 全量源码独立重评四轮修复批）回归：
 * book.yaml 缩进含全角空格（U+3000）——2 空格缩进协议下 U+3000 同为 trimStart
 * 认可的空白、按 1 字符凑合可解析（与 tab 同待遇），但此前无任何留痕，作者无从
 * 知晓文件混入了全角空格、段挂靠类问题难排查（tab 形态已有 R26-37 warn 先例）。
 * 修复：检测行首 U+3000 → 同 tab 口径 warn 一次留痕，解析不中断（计数口径与
 * tab 同：按字符数维持现状）。
 */
import { test, expect, vi } from 'vitest'
import { parseBookConfig } from '../../src/format/yaml.js'

test('四轮-D403: U+3000 缩进 warn 触发，解析结果与 2 空格/tab 形态一致', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const ref = parseBookConfig('book:\n  title: 同一本书\n  genre: 玄幻\n')
    const tabForm = parseBookConfig('book:\n\ttitle: 同一本书\n\tgenre: 玄幻\n')
    const r = parseBookConfig('book:\n\u3000title: 同一本书\n\u3000genre: 玄幻\n')
    expect(ref.ok).toBe(true)
    expect(tabForm.ok).toBe(true)
    expect(r.ok).toBe(true)
    // 解析口径与 tab 同待遇：三种形态落同一 config（不再静默错挂）
    if (r.ok && tabForm.ok && ref.ok) {
      expect(JSON.stringify(r.config)).toBe(JSON.stringify(ref.config))
      expect(JSON.stringify(tabForm.config)).toBe(JSON.stringify(ref.config))
    }
    // warn 留痕（未 initLogging 时镜像 console.warn）
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('全角空格'))).toBe(true)
    // 两开关独立：tab 形态只触发 tab warn、不触发全角空格 warn（口径对齐 R26-37）
    const wideWarnsBefore = warnSpy.mock.calls.filter((c) => String(c[0]).includes('全角空格')).length
    parseBookConfig('book:\n\ttitle: 纯tab书\n')
    const wideWarnsAfter = warnSpy.mock.calls.filter((c) => String(c[0]).includes('全角空格')).length
    expect(wideWarnsAfter).toBe(wideWarnsBefore)
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('tab'))).toBe(true)
  } finally {
    warnSpy.mockRestore()
  }
})

test('四轮-D403: 多个 U+3000 行只 warn 一次（单次 parse 内去重，不刷屏）', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const r = parseBookConfig('book:\n\u3000title: A书\n\u3000genre: 都市\n')
    expect(r.ok).toBe(true)
    const warns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('全角空格'))
    expect(warns).toHaveLength(1)
  } finally {
    warnSpy.mockRestore()
  }
})
