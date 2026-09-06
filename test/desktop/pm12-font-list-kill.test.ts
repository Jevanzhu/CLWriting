/**
 * PM-12（性能与内存专项审查 2026-09-05）：fontListWithTimeout 超时必杀 + 会话级探测熔断单测。
 *
 * ① 自管 spawn（deps.command 注入 node -e 假命令）超时后子进程被 kill（SIGTERM 送达），
 *   整体远小于默认 10s 档内结算；
 * ② 命令即退 × 超时 kill 竞态（ESRCH/EPIPE）无未处理异常——真子进程循环哨兵 + 假件
 *   「晚到 error emit」「kill 同步抛」两个确定性锚点；
 * ③ 连败 2 次后第 3 次不再 spawn（注入计数断言，即时降级 reject）；
 * ④ 败-成-败不熔断（成功清零计数）；
 * ⑤ 重置/阈值注入钩子有效；
 * ⑥ 缺省（不注入 command）维持 R40-28 原语义（load 路径行为零变化），熔断同挡；
 * ⑦ 自管命令起不来（ENOENT 启动面）回落 load（font-list 自带回落链保持可达）。
 *
 * 平台/命令/参数/spawn 全注入（win-fonts.test.ts 同口径）；假命令一律 node -e 跨平台
 * 形态（process.execPath + ['-e', script]，数组参数不经 shell）；零真实系统字体命令、
 * 零满档长等。熔断是模块级进程级状态——每个用例前后 __resetFontListBreakerForTest
 * 隔离，不外溢。
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  __resetFontListBreakerForTest,
  __setFontProbeBreakerThresholdForTest,
  fontListWithTimeout,
  type FontListSpawn,
  type FontListSpawnChild,
} from '../../src/desktop/font-cache.js'

/** 计数 spawn：包一层真 spawn 统计自管命令实跑次数（熔断「不再 spawn」断言用）。 */
function countingSpawn(): { spawnImpl: FontListSpawn; count: () => number } {
  let n = 0
  return {
    spawnImpl: (cmd, args, opts) => {
      n++
      return spawn(cmd, args, opts)
    },
    count: () => n,
  }
}

/** 轮询等桩文件出现（子进程真跑起来）/消失（SIGTERM 送达 → 处理器删桩退出）。 */
async function waitFor(path: string, want: boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (existsSync(path) === want) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('PM-12：fontListWithTimeout 超时必杀（自管 spawn 路径）', () => {
  it('超时后子进程被 kill（SIGTERM 送达）：整体远小于 10s 档内结算', async () => {
    __resetFontListBreakerForTest()
    const { spawnImpl, count } = countingSpawn()
    // 假挂起命令：落 marker 桩文件 → 拦 SIGTERM 删桩退出 → 10s 自灭兜底。
    // marker 消失即证明 SIGTERM 真送达且子进程退出（不 kill 则活满 10s+）。
    const marker = join(tmpdir(), `pm12-font-kill-${process.pid}-${Date.now()}.marker`)
    const script =
      'const fs=require("fs");fs.writeFileSync(process.argv[1],"1");' +
      'process.on("SIGTERM",()=>{try{fs.unlinkSync(process.argv[1])}catch{}process.exit(0)});' +
      'setTimeout(()=>{},10000)'
    try {
      const t0 = Date.now()
      const p = fontListWithTimeout(() => new Promise<string[]>(() => {}), {
        platform: 'darwin',
        command: process.execPath,
        args: ['-e', script, marker],
        spawnImpl,
        timeoutMs: 150,
      })
      expect(await waitFor(marker, true, 2000)).toBe(true) // 先证子进程真跑起来（防「没 spawn」假通过）
      await expect(p).rejects.toThrow('已中止等待并终止子进程')
      const settleMs = Date.now() - t0
      expect(count()).toBe(1)
      expect(settleMs).toBeLessThan(3000) // 不等默认 10s 档（实机 ~200ms，放宽 CI 抖动余量）
      // R56-P2-2：win 上 child.kill('SIGTERM') 是无条件终止（Node 无信号捕获语义，
      // 处理器收不到）——子进程内 process.on('SIGTERM') 删桩退出的验收面物理不可能
      // 成立，仅 posix 可验；win 侧 kill 结算时序（上方 settleMs < 3000）仍覆盖。
      if (process.platform !== 'win32') {
        expect(await waitFor(marker, false, 2000)).toBe(true) // 超时后 ~300ms 内子进程已退出
      }
    } finally {
      if (existsSync(marker)) rmSync(marker, { force: true })
      __resetFontListBreakerForTest()
    }
  })

  it('命令即退 × 超时 kill 竞态：无未处理异常（uncaughtException/unhandledRejection 哨兵）', async () => {
    __resetFontListBreakerForTest()
    const uncaught: unknown[] = []
    const unhandled: unknown[] = []
    const onUncaught = (e: unknown): void => {
      uncaught.push(e)
    }
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e)
    }
    process.on('uncaughtException', onUncaught)
    process.on('unhandledRejection', onUnhandled)
    try {
      // 1ms 紧超时 × 即退命令（node 起进程 ~30ms）：kill 打点与 spawn/退出事件全面重叠。
      // 每轮重置熔断——本用例连败属预期，只测 kill 竞态面，防熔断第 3 轮起改写 reject 文案。
      for (let i = 0; i < 5; i++) {
        __resetFontListBreakerForTest()
        await expect(
          fontListWithTimeout(() => new Promise<string[]>(() => {}), {
            platform: 'darwin',
            command: process.execPath,
            args: ['-e', ''],
            timeoutMs: 1,
          }),
        ).rejects.toThrow('已中止等待并终止子进程')
      }
      expect(uncaught).toEqual([]) // ESRCH/EPIPE 未监听会在此爆出
      expect(unhandled).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
      process.off('unhandledRejection', onUnhandled)
      __resetFontListBreakerForTest()
    }
  })

  it('确定性锚点 A：kill 后晚到的 child error（ESRCH 异步形态）被吞（error 监听在位）', async () => {
    __resetFontListBreakerForTest()
    const child = new EventEmitter() as FontListSpawnChild & EventEmitter
    const kills: Array<string | undefined> = []
    child.kill = (signal) => {
      kills.push(signal)
      return true
    }
    const p = fontListWithTimeout(() => new Promise<string[]>(() => {}), {
      platform: 'darwin',
      command: 'fake-font-cmd',
      spawnImpl: () => child,
      timeoutMs: 20,
    })
    await expect(p).rejects.toThrow('已中止等待并终止子进程')
    expect(kills).toEqual(['SIGTERM']) // 超时回调以 SIGTERM 必杀
    // EventEmitter 语义：error 无监听时 emit 会同步 throw——不炸即监听在位且 settled 后吞掉
    expect(() => child.emit('error', new Error('kill ESRCH'))).not.toThrow()
  })

  it('确定性锚点 B：kill 同步抛 ESRCH 被 try/catch 吞掉，超时仍按 reject 结算', async () => {
    __resetFontListBreakerForTest()
    const child = new EventEmitter() as FontListSpawnChild & EventEmitter
    child.kill = () => {
      throw new Error('kill ESRCH')
    }
    await expect(
      fontListWithTimeout(() => new Promise<string[]>(() => {}), {
        platform: 'darwin',
        command: 'fake-font-cmd',
        spawnImpl: () => child,
        timeoutMs: 20,
      }),
    ).rejects.toThrow('已中止等待并终止子进程')
  })
})

describe('PM-12：会话级探测熔断（进程级模块状态）', () => {
  /** 即败形态（process.exit(1)）：不等超时档，连败断言零长等。 */
  const failOnce = (spawnImpl: FontListSpawn) =>
    fontListWithTimeout(() => new Promise<string[]>(() => {}), {
      platform: 'darwin',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      spawnImpl,
    })

  it('连败 2 次后第 3 次不再 spawn：即时 reject 走降级契约（注入计数断言）', async () => {
    __resetFontListBreakerForTest()
    const { spawnImpl, count } = countingSpawn()
    await expect(failOnce(spawnImpl)).rejects.toThrow('退出码 1')
    await expect(failOnce(spawnImpl)).rejects.toThrow('退出码 1')
    expect(count()).toBe(2)
    const t0 = Date.now()
    await expect(failOnce(spawnImpl)).rejects.toThrow('已熔断')
    expect(Date.now() - t0).toBeLessThan(500) // 即时结算：不再 spawn、不再等满超时
    expect(count()).toBe(2) // 第 3 次零 spawn
    __resetFontListBreakerForTest()
  })

  it('败-成-败不熔断：成功清零计数', async () => {
    __resetFontListBreakerForTest()
    const { spawnImpl, count } = countingSpawn()
    const run = (script: string) =>
      fontListWithTimeout(() => new Promise<string[]>(() => {}), {
        platform: 'darwin',
        command: process.execPath,
        args: ['-e', script],
        spawnImpl,
      })
    await expect(run('process.exit(1)')).rejects.toThrow('退出码 1')
    await expect(run('console.log("PingFang SC")')).resolves.toEqual(['PingFang SC']) // darwin 行口径解析
    await expect(run('process.exit(1)')).rejects.toThrow('退出码 1')
    expect(count()).toBe(3) // 三次都真跑，未熔断
    __resetFontListBreakerForTest()
  })

  it('重置钩子有效：熔断后 __resetFontListBreakerForTest 恢复探测', async () => {
    __resetFontListBreakerForTest()
    const { spawnImpl, count } = countingSpawn()
    await expect(failOnce(spawnImpl)).rejects.toThrow('退出码 1')
    await expect(failOnce(spawnImpl)).rejects.toThrow('退出码 1')
    await expect(failOnce(spawnImpl)).rejects.toThrow('已熔断')
    __resetFontListBreakerForTest()
    await expect(
      fontListWithTimeout(() => new Promise<string[]>(() => {}), {
        platform: 'darwin',
        command: process.execPath,
        args: ['-e', 'console.log("LXGW WenKai")'],
        spawnImpl,
      }),
    ).resolves.toEqual(['LXGW WenKai'])
    expect(count()).toBe(3) // 重置后恢复真跑（熔断期那次零 spawn：败×2 + 成×1）
    __resetFontListBreakerForTest()
  })

  it('阈值注入钩子有效：阈值抬到 3，第 3 次仍真跑、第 4 次才熔断', async () => {
    __resetFontListBreakerForTest()
    __setFontProbeBreakerThresholdForTest(3)
    try {
      const { spawnImpl, count } = countingSpawn()
      await expect(failOnce(spawnImpl)).rejects.toThrow('退出码 1')
      await expect(failOnce(spawnImpl)).rejects.toThrow('退出码 1')
      await expect(failOnce(spawnImpl)).rejects.toThrow('退出码 1') // 阈值 3：第 3 次仍放行
      expect(count()).toBe(3)
      await expect(failOnce(spawnImpl)).rejects.toThrow('已熔断')
      expect(count()).toBe(3)
    } finally {
      __resetFontListBreakerForTest() // 还原常量档 + 清计数，不外溢后续用例
    }
  })
})

describe('PM-12：缺省路径（不注入 command）= R40-28 原语义，熔断同挡', () => {
  it('load 返回值即返回值（缺省路径行为零变化的锚点）', async () => {
    __resetFontListBreakerForTest()
    try {
      await expect(fontListWithTimeout(async () => ['PingFang SC'])).resolves.toEqual(['PingFang SC'])
      await expect(fontListWithTimeout(async () => ['PingFang SC'])).resolves.toEqual(['PingFang SC'])
    } finally {
      __resetFontListBreakerForTest()
    }
  })

  it('load 连败 2 次后第 3 次不再触 load（熔断覆盖缺省路径）', async () => {
    __resetFontListBreakerForTest()
    let loadCalls = 0
    const fail = () =>
      fontListWithTimeout(() => {
        loadCalls++
        return Promise.reject(new Error('系统命令失败'))
      })
    await expect(fail()).rejects.toThrow('系统命令失败')
    await expect(fail()).rejects.toThrow('系统命令失败')
    await expect(fail()).rejects.toThrow('已熔断')
    expect(loadCalls).toBe(2)
    __resetFontListBreakerForTest()
  })

  it('自管命令起不来（ENOENT 启动面）：回落 load，font-list 自带回落链保持可达', async () => {
    __resetFontListBreakerForTest()
    try {
      await expect(
        fontListWithTimeout(async () => ['回退字体'], {
          platform: 'darwin',
          command: '/nonexistent/pm12-no-such-font-bin',
        }),
      ).resolves.toEqual(['回退字体'])
    } finally {
      __resetFontListBreakerForTest()
    }
  })
})
