/**
 * IR-3（独立重评 2026-09-02）：gitAsync 超时/取消的 kill 升级链单测（假 child 注入，
 * 不起真 git 进程）——先 SIGTERM，宽限期后仍存活 → SIGKILL 强制收口；cancel 可撤
 * 升级；对已退出进程（kill 抛 ESRCH 形态）不炸。生产接线（超时/abort 两路）见
 * gitAsync 本体，其 settle 有界语义由 R36-5 既有用例锁定、不受本项影响。
 */
import { describe, expect, it } from 'vitest'
import { killWithEscalation } from '../../src/git/exec.js'

interface FakeChild {
  signals: string[]
  kill: (signal: NodeJS.Signals) => boolean
}

function fakeChild(opts?: { throwOnKill?: boolean }): FakeChild {
  const signals: string[] = []
  return {
    signals,
    kill(signal: NodeJS.Signals): boolean {
      if (opts?.throwOnKill) throw new Error('ESRCH')
      signals.push(signal)
      return true
    },
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('IR-3 killWithEscalation（SIGTERM→SIGKILL 升级）', () => {
  it('先发 SIGTERM；宽限期满仍存活 → 升级 SIGKILL', async () => {
    const child = fakeChild()
    const cancel = killWithEscalation(child, 30)
    expect(child.signals).toEqual(['SIGTERM'])
    await sleep(80)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    cancel()
  })

  it('cancel 在宽限期内撤销升级（TERM 后正常退出形态不再收 KILL）', async () => {
    const child = fakeChild()
    const cancel = killWithEscalation(child, 30)
    cancel()
    await sleep(80)
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('kill 抛错（已退出 ESRCH 形态）不炸同步调用与升级定时器', async () => {
    const child = fakeChild({ throwOnKill: true })
    const cancel = killWithEscalation(child, 30)
    await sleep(80)
    cancel()
  })
})
