/**
 * rmDirRetry（test/helpers/rm-dir-retry.ts）的收口语义守卫。
 *
 * 三条不变量：
 * - 只重试瞬时 errno（ENOTEMPTY/EPERM/EBUSY），且重试次数有界——attempts 次后必收口，
 *   不无限重试、不长墙钟等待；
 * - 每次收口都先留痕一行（含目标路径与最后一次 errno），不存在静默失败路径；
 * - 收口分流按档：'throw' 原样上抛最后错误（真故障照旧红）、'warn' 吞掉（兜底清理
 *   不改写用例自身结果）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rmDirRetry } from './rm-dir-retry.js'
import { tempDirTracked } from './temp-dir.js'

const errOf = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`mock ${code}`), { code })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('rmDirRetry：瞬时 errno 有界重试', () => {
  it('占用毫秒级让出（ENOTEMPTY 第 2 次成功）→ 重试救回，不留痕', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    rmDirRetry('/some/归还中的目录', {
      delayMs: 1,
      rm: () => {
        if (++calls === 1) throw errOf('ENOTEMPTY')
      },
    })
    expect(calls).toBe(2) // 首败 + 重试成功
    expect(warn).not.toHaveBeenCalled()
  })

  it('持续瞬时 errno → 尝试恰 attempts 次即收口（上界有界），留痕含路径与最后一次 errno', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    expect(() =>
      rmDirRetry('/some/win 占用中的目录', {
        attempts: 3,
        delayMs: 1,
        rm: () => {
          calls++
          throw errOf('EPERM')
        },
      }),
    ).toThrow('mock EPERM')
    expect(calls).toBe(3) // 收口点 = attempts，不多试一次
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0]![0])
    expect(msg).toContain('/some/win 占用中的目录') // 留痕带路径
    expect(msg).toContain('EPERM') // 留痕带最后一次 errno
    expect(msg).toContain('3 次')
  })

  it('确定性错误（EACCES）不重试：一次即收口，留痕 errno 后原样上抛', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    expect(() =>
      rmDirRetry('/some/不可写目录', {
        rm: () => {
          calls++
          throw errOf('EACCES')
        },
      }),
    ).toThrow('mock EACCES')
    expect(calls).toBe(1) // 非瞬时错误不进退避
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('EACCES')
  })

  it("'warn' 档（兜底清理口径）：留痕后吞掉不反抛，重试仍以 attempts 为界", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    expect(() =>
      rmDirRetry('/some/兜底目录', {
        attempts: 2,
        delayMs: 1,
        onExhausted: 'warn',
        rm: () => {
          calls++
          throw errOf('EBUSY')
        },
      }),
    ).not.toThrow()
    expect(calls).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0]![0])
    expect(msg).toContain('/some/兜底目录')
    expect(msg).toContain('EBUSY')
  })

  it('默认删除通道（rmSync recursive+force）：真目录树删净、缺席路径 no-op 不抛', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = tempDirTracked('rm-dir-retry-')
    const nested = join(root, '工作区', '版本', 'v1')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'v.md'), 'x', 'utf-8')
    rmDirRetry(root)
    expect(existsSync(root)).toBe(false)
    rmDirRetry(join(root, '早已不存在')) // force:true 语义——不抛、不留痕
    expect(warn).not.toHaveBeenCalled()
  })
})
