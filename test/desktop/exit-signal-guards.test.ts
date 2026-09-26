/**
 * 退出兜底守卫行为回归（信号集 / 重复信号硬退接线 / unhandledRejection 最后防线）
 * + 打包配置契约门（mac identity）。
 *
 * 来源记档（2026-09-26 测试资产行为化批）：原 r38-exit-guards.test.ts（三十八轮修复批
 * 回归）的源码文本断言按行为改写——
 * - R38-19/R38-23 原「main.ts 源码 toContain」断言 → 行为断言：经 main-fixtures Electron
 *   假件 + ④批 P2 监听器治理 harness（R0915-P2，import 后真实注册、记账 afterEach 拆除）
 *   动态重导入 main.ts，对捕获的监听器本体驱动断言。原头注「信号是进程级单例，测试进程
 *   内断言会串扰」的静态化理由已随该 harness 失效（注册可记账、可拆除、零残留）。
 * - R38-20（hexColor 白名单位数集）源码抠正则断言删除——行为面由 main.test.ts R74-21
 *   用例覆盖（本批补 4 位 hex 与 'transparent' 两臂），源码正则抽取形态不再保留。
 * - R38-3（electron-builder.yml mac identity = "-"）保留为打包配置契约门：签名语义是
 *   构建器（electron-builder）行为，无进程级行为可断言；源码/配置契约是该面的唯一锚。
 *
 * 原批动机（三十八轮修复批）：
 * - R38-19：退出兜底信号集必须含 SIGTERM（R1W-9 动机面收口——kill 默认信号不再硬杀
 *   跳过 before-quit 优雅停机链）；0918二轮修复批（C107）三信号注册改经
 *   createRepeatedSignalExit 工厂——首次到达仍走既有优雅链（app.quit()），同型第二次
 *   直接硬退（先 killNow 再 exit(1)，防 utilityProcess 孤儿）。响应逻辑正本已由
 *   repeated-signal-hard-exit.test.ts 单测，本件锁 main.ts 接线行为（信号集 + 路由）。
 * - R38-23：unhandledRejection 最后防线（log-only，不退出——退出语义由
 *   uncaughtException 独占）。
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  M,
  captureMainTestEnvPrev,
  bootstrapMainFixture,
  restoreMainTestEnv,
  cleanupMainTmpDirs,
} from './main-fixtures.js'
import {
  installMainProcessListenerHarness,
  removeTrackedProcessListeners,
  restoreMainProcessListenerHarness,
} from './main-process-harness.js'

// ── ④批 P2 监听器治理 harness（R0915-P2 承重墙，逐件复刻）─────────────────────────
installMainProcessListenerHarness()
const prevEnv = captureMainTestEnvPrev()

beforeAll(async () => {
  await bootstrapMainFixture()
})

afterAll(() => {
  removeTrackedProcessListeners()
  restoreMainProcessListenerHarness()
  restoreMainTestEnv(prevEnv)
  cleanupMainTmpDirs()
})

afterEach(() => {
  // 拆除本用例窗口内经包装注册的 process 监听器（含重导入 main.js 的六件套）
  removeTrackedProcessListeners()
})

const EXIT_SIGNALS = ['SIGINT', 'SIGBREAK', 'SIGTERM'] as const

/** 重导入 main.js 并返回「本次导入新增」的信号与 unhandledRejection 监听器 */
async function importMainAndCaptureListeners(): Promise<{
  signals: Record<(typeof EXIT_SIGNALS)[number], Array<() => void>>
  unhandledRejection: Array<(reason: unknown) => void>
}> {
  const before = new Set<(...a: unknown[]) => void>()
  // 'unhandledRejection' 非进程信号字面量联合——经窄化视图取监听器（EventEmitter 语义同源）
  const listenersOf = (e: string): Array<(...a: unknown[]) => void> =>
    (process as unknown as { listeners(event: string): Array<(...a: unknown[]) => void> }).listeners(e)
  for (const sig of [...EXIT_SIGNALS, 'unhandledRejection'] as const) {
    for (const h of listenersOf(sig)) before.add(h)
  }
  vi.resetModules()
  await import('../../src/desktop/main.js')
  // whenReady 假件已 resolve：让微任务 + 一拍宏任务走完生命周期注册（main 拆分件同款时序）
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  const fresh = (sig: (typeof EXIT_SIGNALS)[number] | 'unhandledRejection'): Array<(...a: unknown[]) => void> =>
    listenersOf(sig).filter((h) => !before.has(h))
  return {
    signals: {
      SIGINT: fresh('SIGINT') as Array<() => void>,
      SIGBREAK: fresh('SIGBREAK') as Array<() => void>,
      SIGTERM: fresh('SIGTERM') as Array<() => void>,
    },
    unhandledRejection: fresh('unhandledRejection') as Array<(reason: unknown) => void>,
  }
}

describe('R38-19 + C107：退出信号集接线行为（首达优雅链、同型二达硬退）', () => {
  it('三信号（SIGINT/SIGBREAK/SIGTERM）各注册恰好一个处理器；首达 → app.quit() 优雅链一次', async () => {
    const { signals } = await importMainAndCaptureListeners()
    for (const sig of EXIT_SIGNALS) {
      expect(signals[sig], `${sig} 应恰好注册一个退出处理器`).toHaveLength(1)
    }
    // 首达语义：每个信号首次到达都进优雅链（app.quit() 幂等门防重入），不硬退
    const q0 = M.quitCalls
    signals.SIGINT[0]!()
    signals.SIGBREAK[0]!()
    signals.SIGTERM[0]!()
    expect(M.quitCalls).toBe(q0 + 3) // 异型信号不互触发（C107 语义）：各走一次优雅链
  })

  it('SIGTERM 同型第二次到达 → 先 killNow 对在途 child 发 kill，再 exit(1) 硬退（R1W-9：kill 默认信号不跳优雅链）', async () => {
    const { signals } = await importMainAndCaptureListeners()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      const h = signals.SIGTERM[0]!
      const q0 = M.quitCalls
      h() // 首达：优雅链
      expect(M.quitCalls).toBe(q0 + 1)
      const child = M.forkChildren.at(-1)!
      const k0 = child.killed
      h() // 同型二达：硬退出口
      expect(child.killed).toBe(k0 + 1) // 先 killNow（防 utilityProcess 孤儿）
      expect(exitSpy).toHaveBeenCalledWith(1) // 再 exit(1)
    } finally {
      exitSpy.mockRestore()
    }
  })
})

describe('R38-23：unhandledRejection 最后防线（log-only，不退出）', () => {
  it('注册 unhandledRejection 处理器；触发 → log.error 留痕、不 process.exit', async () => {
    const { unhandledRejection } = await importMainAndCaptureListeners()
    expect(unhandledRejection).toHaveLength(1)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      const err0 = M.logErrors.length
      unhandledRejection[0]!(new Error('漏网 rejection')) // 兜底语义：记录不退出
      expect(M.logErrors.length).toBeGreaterThan(err0)
      const last = M.logErrors.at(-1) as [string, string, unknown] | undefined
      expect(String(last?.[1])).toContain('未处理的 promise rejection')
      expect(exitSpy).not.toHaveBeenCalled() // 退出语义维持 uncaughtException 独占
    } finally {
      exitSpy.mockRestore()
    }
  })
})

describe('R38-3：electron-builder.yml mac identity 为 "-"（打包配置契约门，保留记档）', () => {
  it('mac 块 identity = "-"（真 ad-hoc 密封；null = 完全跳过签名，语义不同）', () => {
    // 保留理由：electron-builder 的签名行为是构建期语义，无进程级行为可断言——配置
    // 契约是该面唯一可锚形态（源码文本断言处置批注记：契约门类保留）。
    // 断言口径：取 YAML 标量值而非整行字面量——'-' 与 "-" 是同一个标量（格式化门统一
    // 单引号），钉字面量会让「格式归一」这类无害改动假红；语义面（值为 '-'、且非 null
    // 的「完全跳过签名」）逐位保留。
    const builderYml = readFileSync(join(import.meta.dirname, '../../electron-builder.yml'), 'utf-8')
    const macBlock = builderYml.slice(builderYml.indexOf('\nmac:'), builderYml.indexOf('\nwin:'))
    const identityScalar = macBlock.match(/^ {2}identity: (.+)$/m)?.[1]?.trim()
    expect(identityScalar).toMatch(/^['"]-['"]$/)
    expect(identityScalar).not.toBe('null')
  })
})
