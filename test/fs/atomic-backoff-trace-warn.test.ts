/**
 * 0918独立重评修复批（B009）回归：EPERM/EBUSY 退避留痕。
 *
 * 修复前 fsBackoffSleep（Atomics.wait 同步微睡）被 renameWithRetry/rmWithRetry 引用
 * 时零留痕——单次操作静默睡数百 ms 对作者/诊断零感知。修复后单次操作累计退避 ≥
 * BACKOFF_TRACE_MIN_MS（100ms，默认档即进入第 2 档 50+100 时）log.warn 一次（操作
 * 名/目标路径/累计耗时）；退避本身逐位不变，不传 trace 上下文零行为差。
 *
 * 计时可控形态：假 rename/rm 按脚本抛错 + 假 sleep 记录序列（阈值由 baseDelayMs
 * 折算，不依赖真实时钟）；末档真 fsBackoffSleep 最小 sleep 接线冒烟（60/120ms，
 * 验默认 sleep 通道的留痕路径）。锚：0918独立重评修复批 B009。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { log } from '../../src/log/index.js'
import { rmWithRetry, renameWithRetry, retryOnTransientFsError } from '../../src/fs/atomic.js'

const errOf = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`mock ${code}`), { code })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('0918独立重评修复批 B009: 退避累计留痕 warn 一次', () => {
  it('rename 退避累计 150ms（50+100）→ warn 恰一次，含操作名/双路径/累计耗时', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const delays: number[] = []
    let calls = 0
    renameWithRetry('从甲.md', '到乙.md', {
      rename: () => {
        if (++calls <= 2) throw errOf('EPERM')
      },
      sleep: (ms) => delays.push(ms),
    })
    expect(calls).toBe(3)
    expect(delays).toEqual([50, 100])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = warnSpy.mock.calls[0]!.join(' ')
    expect(warnSpy.mock.calls[0]![0]).toBe('fs')
    expect(msg).toContain('rename')
    expect(msg).toContain('从甲.md → 到乙.md')
    expect(msg).toContain('150ms')
    expect(msg).toContain('EPERM')
  })

  it('单次退避 50ms（未过 100ms 阈）→ 不留痕', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    let calls = 0
    renameWithRetry('a.md', 'b.md', {
      rename: () => {
        if (++calls === 1) throw errOf('EBUSY')
      },
      sleep: () => {},
    })
    expect(calls).toBe(2)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('退避到耗尽（3 次全败）→ 留痕仍只一次，随后既有上抛语义不变', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const delays: number[] = []
    expect(() =>
      rmWithRetry('删不掉的章.md', {
        rm: () => {
          throw errOf('EBUSY')
        },
        sleep: (ms) => delays.push(ms),
      }),
    ).toThrow('mock EBUSY')
    expect(delays).toEqual([50, 100, 200])
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('rm 退避累计 ≥100ms → warn 一次，含 rm 操作名与目标路径', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    let calls = 0
    rmWithRetry('回收站源.md', {
      rm: () => {
        if (++calls <= 2) throw errOf('EPERM')
      },
      sleep: () => {},
    })
    expect(calls).toBe(3)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = warnSpy.mock.calls[0]!.join(' ')
    expect(msg).toContain('rm')
    expect(msg).toContain('回收站源.md')
  })

  it('默认 sleep 接线（真 fsBackoffSleep）最小档冒烟：baseDelayMs 60 → 60+120ms 真睡，warn 一次', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    let calls = 0
    rmWithRetry('真睡冒烟.md', {
      rm: () => {
        if (++calls <= 2) throw errOf('EPERM')
      },
      baseDelayMs: 60,
    })
    expect(calls).toBe(3)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('无 trace 上下文（cross-process-lock Quiet 壳形态）→ 零新增留痕', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    let calls = 0
    retryOnTransientFsError(
      () => {
        if (++calls <= 2) throw errOf('EPERM')
      },
      { sleep: () => {}, retries: 3, baseDelayMs: 50 },
    )
    expect(calls).toBe(3)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
