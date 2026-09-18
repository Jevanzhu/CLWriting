/**
 * 0918三轮修复批（C201）回归：自管字体枚举超时杀的 SIGTERM → SIGKILL 升级链。
 *
 * 修复前 spawnCollectKillFonts 超时只 SIGTERM 单发——装了 TERM handler 或陷入不可
 * 中断态的子进程不成杀（fc-list 挂死形态），孤儿存续到父进程退出。修复后超时回调
 * 起 2s 有界升级窗（对齐 server-proc killProcAwaitEscalating 纪律）：窗内 close 未到
 * 即补发 SIGKILL（不可被用户态拦截）；窗内正常退出则升级撤销（once('close') 挂点）。
 * 附 linuxFontListCommand 形态钉（fc-list 自管接线 ipc.ts loadFontList 的常量锚）。
 *
 * 假时钟两例钉升级窗撤销/补发判定；真子进程一例（posix 独有——win 的 SIGTERM 即
 * TerminateProcess 硬杀，「装 handler 吞 TERM」前提物理不成立）端到端收口。
 * 锚：0918三轮修复批 C201。
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  __resetFontListBreakerForTest,
  fontListWithTimeout,
  linuxFontListCommand,
  spawnCollectKillFonts,
  type FontListSpawn,
  type FontListSpawnChild,
} from '../../src/desktop/font-cache.js'

/** 最小假件：EventEmitter + kill 记录（无流——超时/升级路径不读输出）。 */
function makeKillRecordingChild(): { child: FontListSpawnChild & EventEmitter; kills: Array<string | undefined> } {
  const child = new EventEmitter() as FontListSpawnChild & EventEmitter
  const kills: Array<string | undefined> = []
  child.kill = (signal) => {
    kills.push(signal)
    return true
  }
  return { child, kills }
}

describe('C201（0918三轮修复批）：SIGTERM → SIGKILL 升级链', () => {
  it('SIGTERM 未成杀（无 close）→ 2s 升级窗补发 SIGKILL（假时钟推进）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const { child, kills } = makeKillRecordingChild()
      const p = spawnCollectKillFonts('fake-fc-list', [], {
        doSpawn: () => child,
        timeoutMs: 20,
        timeoutMessage: 'fc-list 枚举超时',
        exitCodeErrorPrefix: 'fc-list',
        parse: () => [],
      })
      const settle = expect(p).rejects.toThrow('fc-list 枚举超时')
      await vi.advanceTimersByTimeAsync(20)
      await settle
      expect(kills).toEqual(['SIGTERM'])
      await vi.advanceTimersByTimeAsync(2_000)
      expect(kills).toEqual(['SIGTERM', 'SIGKILL'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('窗内 close 到达 → 升级撤销（SIGKILL 不补发，once 挂点生效）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const { child, kills } = makeKillRecordingChild()
      const p = spawnCollectKillFonts('fake-fc-list', [], {
        doSpawn: () => child,
        timeoutMs: 20,
        timeoutMessage: 'fc-list 枚举超时',
        exitCodeErrorPrefix: 'fc-list',
        parse: () => [],
      })
      const settle = expect(p).rejects.toThrow('fc-list 枚举超时')
      await vi.advanceTimersByTimeAsync(20)
      await settle
      child.emit('close', null) // 进程实际死于 TERM 后的迟到 close（补挂升级撤销点）
      await vi.advanceTimersByTimeAsync(10_000)
      expect(kills).toEqual(['SIGTERM']) // 升级被撤销，不补发
    } finally {
      vi.useRealTimers()
    }
  })

  it('真子进程端到端：吞 TERM 的挂死子进程在升级窗内被 SIGKILL 收口（posix）', async () => {
    if (process.platform === 'win32') return
    __resetFontListBreakerForTest()
    // 吞 TERM + setInterval 保活：模拟 fc-list 挂死/不可中断态（不 kill 则活到测试进程退出）
    const script = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'
    let childPid: number | undefined
    const spawnImpl: FontListSpawn = (cmd, args, opts) => {
      const c = spawn(cmd, args, opts)
      childPid = c.pid
      return c
    }
    try {
      const t0 = Date.now()
      const p = fontListWithTimeout(() => new Promise<string[]>(() => {}), {
        platform: 'linux',
        command: process.execPath,
        args: ['-e', script],
        spawnImpl,
        timeoutMs: 150,
      })
      await expect(p).rejects.toThrow('已中止等待并终止子进程')
      expect(typeof childPid).toBe('number')
      // TERM 已被吞：此刻子进程仍活着（升级链的存在前提）
      let aliveAfterTerm = true
      try {
        process.kill(childPid!, 0)
      } catch {
        aliveAfterTerm = false
      }
      expect(aliveAfterTerm).toBe(true)
      // 升级窗（TERM 后 +2s）内 SIGKILL 收口 → 进程消失
      const deadline = Date.now() + 6_000
      let dead = false
      while (Date.now() < deadline) {
        try {
          process.kill(childPid!, 0)
        } catch {
          dead = true
          break
        }
        await new Promise((r) => setTimeout(r, 25))
      }
      expect(dead).toBe(true)
      expect(Date.now() - t0).toBeLessThan(9_000)
    } finally {
      __resetFontListBreakerForTest()
    }
  }, 15_000)

  it('linuxFontListCommand 形态钉：fc-list + family 首行 format（上游 libs/linux 逐字对齐）', () => {
    expect(linuxFontListCommand()).toEqual({ command: 'fc-list', args: ['-f', '%{family[0]}\\n'] })
  })
})
