/**
 * 内存审计修复（2026-08-24 批 A1）回归：atomicWriteStream——大产物流式原子写。
 *
 * - 逐段 append 的产物字节与整串 atomicWriteFile 恒等（导出合并稿流式化的正确性根基）
 * - 回调抛错 → 不落半截目标 + tmp 清理（沿用 atomicWriteFile 同款失败语义）
 */
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { atomicWriteFile, atomicWriteStream } from '../../src/fs/atomic.js'

const dir = mkdtempSync(join(tmpdir(), 'atomic-stream-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('atomicWriteStream（内存闸 A1）', () => {
  it('逐段 append 产物与整串 atomicWriteFile 字节恒等（utf8 多段含分隔符）', () => {
    const parts = ['# 第一章\n\n正文一。', '# 第二章\n\n正文二。', '# 第三章\n\n正文三。']
    const whole = parts.join('\n\n---\n\n')
    atomicWriteFile(join(dir, 'whole.md'), whole)
    atomicWriteStream(join(dir, 'stream.md'), (append) => {
      parts.forEach((p, i) => {
        if (i > 0) append('\n\n---\n\n')
        append(p)
      })
    })
    expect(readFileSync(join(dir, 'stream.md'), 'utf8')).toBe(readFileSync(join(dir, 'whole.md'), 'utf8'))
  })

  it('回调抛错 → 目标不落盘 + tmp 残留清理（半截不可见）', () => {
    const target = join(dir, 'fail.md')
    expect(() =>
      atomicWriteStream(target, (append) => {
        append('半截内容')
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(existsSync(target)).toBe(false)
    expect(readdirSync(dir).some((f) => f.startsWith('.fail.md') && f.endsWith('.tmp'))).toBe(false)
  })
})
