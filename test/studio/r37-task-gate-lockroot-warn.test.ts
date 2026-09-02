/**
 * R37-21（三十七轮批 D）回归：configureTaskGateLockRoot 覆盖非空旧值时 warn。
 *
 * 修复前：模块级 lockRoot 被重复 configure 静默覆盖——锁根漂移无从察觉（旧锁根下
 * 已持有的锁文件从此查询/续期失联）。修复后：覆盖非空旧值（且值实际变化）时
 * log.warn 带旧/新路径留痕；覆盖本身仍是合法操作（单进程单锁根契约，注释如实记）。
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureTaskGateLockRoot,
  acquireTaskGate,
  isTaskGateHeld,
} from '../../src/studio/server/api/task-gate.js'
import { log } from '../../src/log/index.js'

let dirs: string[] = []

function tmpLockDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'r37-tg-lock-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  configureTaskGateLockRoot(null) // 复位模块态（测试进程初值即 null）
  vi.restoreAllMocks()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('R37-21 task-gate 锁根覆盖告警', () => {
  it('首次配置（null → 值）不告警；覆盖非空旧值告警（带旧/新路径）；同值重配不告警', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const dirA = tmpLockDir()
    const dirB = tmpLockDir()

    configureTaskGateLockRoot(dirA) // null → A：非覆盖，不告警
    expect(warnSpy).not.toHaveBeenCalled()

    configureTaskGateLockRoot(dirB) // A → B：覆盖非空旧值 → warn
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = warnSpy.mock.calls[0]![1]
    expect(msg).toContain(dirA)
    expect(msg).toContain(dirB)

    configureTaskGateLockRoot(dirB) // B → B：值未变，不告警
    expect(warnSpy).toHaveBeenCalledTimes(1)

    configureTaskGateLockRoot(null) // B → null：显式清空（startServer 缺省形态）——
    // 覆盖非空旧值同告警（清空同样是锁根漂移，如实留痕不豁免）
    expect(warnSpy).toHaveBeenCalledTimes(2)
    expect(warnSpy.mock.calls[1]![1]).toContain(dirB)
  })

  it('覆盖后新值生效：acquire 走新锁根落锁文件（值真正换轨）', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    const dirA = tmpLockDir()
    const dirB = tmpLockDir()
    configureTaskGateLockRoot(dirA)
    configureTaskGateLockRoot(dirB) // 告警一次，但覆盖合法

    const release = acquireTaskGate('r37锁根书', 'analyze')
    expect(release).not.toBeNull()
    expect(isTaskGateHeld('r37锁根书', 'analyze')).toBe(true)
    expect(readdirSync(dirB)).toHaveLength(1) // 锁文件落在新锁根（sha256 名 *.lock）
    expect(readdirSync(dirA)).toHaveLength(0) // 旧锁根无残留
    release!()
    expect(readdirSync(dirB)).toHaveLength(0)
  })
})
