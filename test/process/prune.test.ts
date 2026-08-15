/**
 * A3（DSH-3）：无模型文本修剪器——code point 头尾保 + marker 单次 + 严格更小校验。
 */
import { test, expect } from 'vitest'
import { pruneTextMiddle, PRUNE_MARKER } from '../../src/process/prune.js'

/** 造指定 code point 长度的中文文本（带位置锚点） */
function cn(len: number): string {
  return '刃'.repeat(len)
}

test('阈值内 → 原引用返回（no-op 透传，=== 判定可用）', () => {
  const s = cn(100)
  expect(pruneTextMiddle(s)).toBe(s)
  expect(pruneTextMiddle('')).toBe('')
})

test('恰好等于阈值 → 不修剪', () => {
  const s = cn(4096)
  expect(pruneTextMiddle(s)).toBe(s)
})

test('超阈值 → 头尾保留 + marker 恰好一次 + 中段消失', () => {
  const s = cn(6000)
  const out = pruneTextMiddle(s)
  expect(out).not.toBe(s)
  expect(out.split(PRUNE_MARKER).length - 1).toBe(1)
  // 头 2048 + marker + 尾 512
  expect(out.startsWith(cn(2048))).toBe(true)
  expect(out.endsWith(cn(512))).toBe(true)
  // 严格更小：小于阈值且小于原长
  expect(Array.from(out).length).toBeLessThan(4096)
  expect(Array.from(out).length).toBeLessThan(6000)
})

test('code point 度量——不劈 surrogate pair（emoji 计 1）', () => {
  // '😀' = 2 UTF-16 单元、1 code point；6000 个 emoji 远超 4096 code point
  const s = '😀'.repeat(6000)
  const out = pruneTextMiddle(s)
  expect(out.startsWith('😀'.repeat(2048))).toBe(true)
  expect(out.endsWith('😀'.repeat(512))).toBe(true)
  // 头尾边界处 emoji 完整（无乱码代理孤对）
  const [head, tail] = out.split(PRUNE_MARKER)
  expect(head!.endsWith('😀')).toBe(true)
  expect(tail!.startsWith('😀')).toBe(true)
})

test('自定义阈值（接线处口径：6000/4800/1024）', () => {
  const s = '甲'.repeat(7000)
  const out = pruneTextMiddle(s, { threshold: 6000, head: 4800, tail: 1024 })
  expect(out.startsWith('甲'.repeat(4800))).toBe(true)
  expect(out.endsWith('甲'.repeat(1024))).toBe(true)
  expect(Array.from(out).length).toBeLessThan(6000)
})

test('配置非法（head+tail+marker ≥ threshold）→ throw 不静默', () => {
  expect(() => pruneTextMiddle(cn(10000), { threshold: 1000, head: 900, tail: 200 })).toThrow('配置非法')
})
