/**
 * R1W-1（win 平台专项复审 R1）：清理路径 rmQuietly 单测。
 *
 * 契约：① 注入 rm 抛错 → 静默吞掉不反抛（清理失败绝不反转成功语义）；
 * ② 真 fs 冒烟——存在文件正常删除、不存在路径 force no-op 不抛。
 * 六个收编点（atomicWriteFile catch / atomicWriteStream ×4 / createFileExclusive
 * finally）的接线由既有 atomic*.test.ts 端到端行为覆盖（成功路径不变 + sweep 兼容）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rmQuietly } from '../../src/fs/atomic.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

describe('rmQuietly（R1W-1）', () => {
  it('注入 rm 抛 EBUSY → 静默吞掉，不向调用方反抛', () => {
    const err = Object.assign(new Error('mock EBUSY'), { code: 'EBUSY' })
    expect(() => rmQuietly('whatever.tmp', { rm: () => { throw err } })).not.toThrow()
  })

  it('注入 rm 抛 EPERM → 同样静默（清理路径永不反噬）', () => {
    const err = Object.assign(new Error('mock EPERM'), { code: 'EPERM' })
    expect(() => rmQuietly('whatever.tmp', { rm: () => { throw err } })).not.toThrow()
  })

  it('真 fs：存在文件正常删除', () => {
    const dir = mkdtempTracked('r1w1-rm-quietly-')
    const fp = join(dir, 'a.tmp')
    writeFileSync(fp, 'x')
    expect(existsSync(fp)).toBe(true)
    rmQuietly(fp)
    expect(existsSync(fp)).toBe(false)
  })

  it('真 fs：不存在路径 force 语义 no-op，不抛', () => {
    expect(() => rmQuietly(join(mkdtempTracked('r1w1-rm-quietly-'), 'missing.tmp'))).not.toThrow()
  })
})
