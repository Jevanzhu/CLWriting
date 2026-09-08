/**
 * 重审-08（2026-09-07 全量代码重审 §四.8）回归：rename 成功后目录 fsync 失败的
 * 降级语义。
 *
 * 前提核校（读码证伪 + 行为锁定）：fsyncDir 的 bare catch 原本就吞掉包括 EIO 在内
 * 的全部错误（src/fs/atomic.ts fsyncDir，win EPERM 平台限制与真实 EIO 同被吞），
 * 评审所述「rename 成功后 fsyncDir 抛非 EPERM 上抛 → 目标已写入却报假失败」在现行
 * 代码不成立——本文件第一断言组锁定「不抛 + 目标在」（防未来收窄 catch 时回归）；
 * 真实缺口是**零留痕**：EIO 类耐久性降级与平台限制同被静默吞掉，无迹可查。
 * 修复 = 非 EPERM 失败 log.warn 留痕（log 仅依赖 node 内置，无 fs↔log 循环；本文件
 * 已有 log.warn('fs') 先例），仍不抛（目录条目耐久性 best-effort，抛出反而把已成功
 * 写入反转成假失败、诱发调用方重复写）。
 *
 * 注入手法：mock node:fs 的 fsyncSync，第 N 次调用（atomicWriteFile 缺省 fsync 下
 * 第 2 次 = 目录 fsync）抛注入码错误，其余透传（参考 test/fs/atomic.test.ts）。
 */
import { rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { log } from '../../src/log/index.js'

const h = vi.hoisted(() => ({ calls: 0, failNth: 0, code: 'EIO' as string }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      h.calls++
      if (h.failNth !== 0 && h.calls === h.failNth) {
        const err = new Error(`${h.code}: 模拟目录 fsync 失败（fd=${fd}）`) as NodeJS.ErrnoException
        err.code = h.code
        throw err
      }
      return actual.fsyncSync(fd)
    },
  }
})

const { atomicWriteFile, atomicWriteStream } = await import('../../src/fs/atomic.js')

let dir = ''
afterEach(() => {
  h.calls = 0
  h.failNth = 0
  h.code = 'EIO'
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = ''
  }
})

describe('重审-08: rename 后目录 fsync 失败 → 不抛 + 目标在 + 非 EPERM 留痕', () => {
  it('atomicWriteFile：目录 fsync EIO 不判失败（目标已写入）且 warn 留痕', () => {
    dir = mkdtempTracked(join(tmpdir(), 'clwriting-atomic-fd-'))
    const p = join(dir, 'a.json')
    const warnSpy = vi.spyOn(log, 'warn')
    try {
      h.failNth = 2 // 第 1 次 = 临时文件内容 fsync；第 2 次 = rename 后目录 fsync
      expect(() => atomicWriteFile(p, '{"a":1}')).not.toThrow() // 证伪锁定：现行 fsyncDir 从不上抛
      expect(readFileSync(p, 'utf-8')).toBe('{"a":1}') // 目标在位（不因目录 fsync 失败报假失败）
      // 留痕（重审-08 修复面）：非 EPERM 目录 fsync 失败此前零留痕
      expect(warnSpy).toHaveBeenCalled()
      const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
      expect(warned).toContain('目录 fsync')
      expect(warned).toContain(dir)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('atomicWriteStream：目录 fsync EIO 同款——不抛 + 目标在 + warn 留痕', () => {
    dir = mkdtempTracked(join(tmpdir(), 'clwriting-atomic-fs-'))
    const p = join(dir, 'b.md')
    const warnSpy = vi.spyOn(log, 'warn')
    try {
      h.failNth = 2 // 第 1 次 = 流内容 fsync；第 2 次 = rename 后目录 fsync
      expect(() =>
        atomicWriteStream(p, (append) => {
          append('# 标题\n\n')
          append('正文。')
        }),
      ).not.toThrow()
      expect(readFileSync(p, 'utf-8')).toBe('# 标题\n\n正文。')
      expect(warnSpy).toHaveBeenCalled()
      const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
      expect(warned).toContain('目录 fsync')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('win 平台限制形态（fsyncSync EPERM）维持静默——不 warn 不抛（文档化口径不回归）', () => {
    dir = mkdtempTracked(join(tmpdir(), 'clwriting-atomic-ep-'))
    const p = join(dir, 'c.json')
    const warnSpy = vi.spyOn(log, 'warn')
    try {
      h.failNth = 2
      h.code = 'EPERM'
      expect(() => atomicWriteFile(p, 'x')).not.toThrow()
      expect(existsSync(p)).toBe(true)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})
