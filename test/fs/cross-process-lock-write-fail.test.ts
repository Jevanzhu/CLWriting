/**
 * 重审-10（2026-09-07 全量代码重审 §四.10）回归：锁获取两处零留痕/残留收口。
 *
 * ① open 'wx' 成功后 writeSync 失败（ENOSPC 半写）：非 EEXIST 上抛路径不清理刚
 *   创建的锁文件——残留依赖 STALE_GRACE_MS 500ms 宽限（期间对不可读锁判 held，
 *   调用方无谓空转重试）+ 陈锁接管自愈，且零留痕。修复 = best-effort 删残锁 +
 *   warn 留痕后原样上抛（不吞错，权限/磁盘类故障语义仍归调用方）。
 * ② 陈锁接管（grace 超龄/持有进程已死接管）分支零 warn——自愈发生但无迹可查，
 *   双 contender 场景无从诊断。修复 = 接管清理前 warn 留痕（带原持有 pid）。
 *
 * 注入手法：mock node:fs 的 writeSync 按开关注 ENOSPC（src 内 writeSync 仅本模块
 * 使用；log 走 node:fs/promises 不受影响），参考 test/fs/cross-process-lock.test.ts
 * 的 openSync/rmSync 注入同款。
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import { tryAcquireCrossProcessLock } from '../../src/fs/cross-process-lock.js'
import { log } from '../../src/log/index.js'

const fsState = vi.hoisted(() => ({ enospc: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeSync: (fd: number, buf: Uint8Array | string, ...rest: unknown[]) => {
      if (fsState.enospc) {
        const err = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException
        err.code = 'ENOSPC'
        throw err
      }
      return (actual.writeSync as (...a: unknown[]) => number)(fd, buf, ...rest)
    },
  }
})

const dir = mkdtempSync(join(tmpdir(), 'clwriting-cplock-wf-'))
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
const lp = (name: string): string => join(dir, `${name}.lock`)

beforeEach(() => {
  fsState.enospc = false
})

describe('重审-10: writeSync 失败清理 + 陈锁接管留痕', () => {
  it('open wx 成功后 writeSync ENOSPC → 上抛 + 刚创建的残锁被清理 + warn 留痕', () => {
    const p = lp('enospc')
    const warnSpy = vi.spyOn(log, 'warn')
    try {
      fsState.enospc = true
      expect(() => tryAcquireCrossProcessLock(p)).toThrowError(/ENOSPC/) // 不吞错（既有语义）
      expect(existsSync(p)).toBe(false) // 刚创建的残锁已清理（现状残留 → 红）
      expect(warnSpy).toHaveBeenCalled() // 留痕（现状零留痕 → 红）
      const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
      expect(warned).toContain('锁文件写入 pid 失败')
      expect(warned).toContain(p)
    } finally {
      fsState.enospc = false
      warnSpy.mockRestore()
    }
  })

  it('陈锁接管（持有进程已死）→ warn 留痕后照旧接管成功', () => {
    const p = lp('takeover-warn')
    const warnSpy = vi.spyOn(log, 'warn')
    try {
      writeFileSync(p, JSON.stringify({ pid: 4194303, bootTime: 0 }))
      const r = tryAcquireCrossProcessLock(p, { isProcessAlive: () => false, staleTakeoverJitterMs: 0 })
      expect(r).not.toBeNull() // 接管语义不变
      expect(warnSpy).toHaveBeenCalled() // 留痕（现状零留痕 → 红）
      const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
      expect(warned).toContain('陈锁接管')
      expect(warned).toContain('4194303') // 带原持有 pid
      r!()
    } finally {
      warnSpy.mockRestore()
    }
  })
})
