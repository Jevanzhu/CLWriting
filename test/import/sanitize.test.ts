/**
 * sanitizeName 单测 —— 守护 P1 路径穿越修复(import.ts)。
 *
 * 净化是 import 落盘的穿越防线:文件名/书名/标题经此净化后才拼进 join,
 * 防逃出 workDir/bookRoot(源 v0.2 标题或 --name 含 ../ 或路径分隔符时)。
 */
import { describe, it, expect } from 'vitest'
import { sanitizeName } from '../../src/import/index.js'

describe('sanitizeName(路径穿越防线)', () => {
  it('剥离路径分隔符(防 join 逃逸)', () => {
    expect(sanitizeName('生死/抉择')).toBe('生死抉择')
    expect(sanitizeName('a\\b')).toBe('ab')
  })

  it('折叠连续点(防 .. 穿越段)', () => {
    expect(sanitizeName('../../etc')).toBe('.etc')
    expect(sanitizeName('a..b')).toBe('a.b')
  })

  it('剥离控制字符', () => {
    expect(sanitizeName('a\x00b\x1fc')).toBe('abc')
  })

  it('仅剩点或空 → 占位(防落盘成当前目录)', () => {
    expect(sanitizeName('../')).toBe('未命名')
    expect(sanitizeName('///')).toBe('未命名')
    expect(sanitizeName('.')).toBe('未命名')
  })

  it('正常中文名原样保留', () => {
    expect(sanitizeName('林远的旧案')).toBe('林远的旧案')
  })

  it('trim 首尾空白', () => {
    expect(sanitizeName('  标题  ')).toBe('标题')
  })
})
