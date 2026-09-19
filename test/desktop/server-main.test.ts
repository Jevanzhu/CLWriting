/**
 * server-main 入口回归（单立清账批 2026-09-17：入口解耦后进程内直测）。
 *
 * 此前整文件顶层执行（import 即读 argv / 真绑端口 / 真注册 SIGINT/SIGTERM），
 * 信号兜底修复（M-8 / R-20 / R1010b-DSK-P3-7）长期无测试装置即此因。解耦后：
 * - runServerMain：server-boot 仅 mock bootServerFromArgs（parseServerArgs /
 *   resolveEnvPort / deriveStaticDir / describeBootError 用真件）——断言装配链
 *   （--port > CLWRITING_PORT > 7878、userDataPath 缺省/透传、staticDir 派生）、
 *   onBootError → exit(1)、返回 server 实例。
 * - installSignalFallback：process.on spy 捕获 handler 直驱 + setTimeout spy 假
 *   句柄——close 接线 / close 先到 exit(0) 幂等 / close 悬置走 2s 兜底 + unref /
 *   重复信号不重排 timer（R1010b-DSK-P3-7 回归锚）/ 清理函数摘除。
 * - vitest 探针：import 态不绑端口不注册信号（顶层接线跳过）。
 *
 * 真链路（真起 server + argv/env 透传）由子进程黑盒 test/studio/server-main-error.test.ts
 * 锚定，不在此重复。
 */
import { describe, it, expect, vi, beforeEach, afterEach , type MockInstance } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { ParsedServerArgs } from '../../src/desktop/server-boot.js'

/** hoisted 状态：vi.mock 工厂内可引用（工厂闭包不得触外部词法绑定） */
const h = vi.hoisted(() => {
  const sentinelServer = { __sentinel: 'server-main' }
  return {
    sentinelServer,
    bootCalls: [] as {
      parsed: ParsedServerArgs
      staticDir: string
      cb: { onReady: (p: number) => void; onBootError: (e: Error) => void }
    }[],
    bootBehavior: 'ok' as 'ok' | 'error',
    readyPort: 45678,
  }
})

// server-boot 真件为主，只换 bootServerFromArgs（真件会起真 server 绑端口）——
// 装配链（parse/resolveEnvPort/deriveStaticDir/describeBootError）用真件断言
vi.mock('../../src/desktop/server-boot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/desktop/server-boot.js')>()
  return {
    ...actual,
    bootServerFromArgs: (
      parsed: ParsedServerArgs,
      staticDir: string,
      cb: { onReady: (p: number) => void; onBootError: (e: Error) => void },
    ) => {
      h.bootCalls.push({ parsed, staticDir, cb })
      // 真实 listening/error 异步到达——queueMicrotask 模拟同型时序
      queueMicrotask(() => {
        if (h.bootBehavior === 'ok') cb.onReady(h.readyPort)
        else cb.onBootError(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }))
      })
      return h.sentinelServer as never
    },
  }
})

vi.mock('../../src/fs/user-data-path.js', () => ({
  defaultUserDataPath: () => '/fake/user-data',
}))

import { runServerMain, installSignalFallback } from '../../src/desktop/server-main.js'

// win 平台 fileURLToPath 需带盘符（file:///g/... 会抛 ERR_INVALID_FILE_URL_PATH）
const MODULE_URL = 'file:///G:/app/dist/desktop/server-main.js'

/** process.exit spy：自类型（ReturnType 按工厂调用面推导，不手写 MockInstance 泛参） */
function spyExit() {
  return vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
}

let exitSpy: ReturnType<typeof spyExit>
let errSpy: MockInstance<typeof console.error>

beforeEach(() => {
  h.bootCalls.length = 0
  h.bootBehavior = 'ok'
  exitSpy = spyExit()
  // log 未 init 时 console 镜像——静音 ready/boot-error 行，断言不挂在日志形态上
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  exitSpy.mockRestore()
  errSpy.mockRestore()
  vi.restoreAllMocks()
})

describe('runServerMain：node 直跑形态装配链', () => {
  it('端口链 --port > CLWRITING_PORT > 缺省 7878（resolveEnvPort 真件）', () => {
    runServerMain(['node', 'server-main.js', '--port', '123'], {}, MODULE_URL)
    expect(h.bootCalls[0]!.parsed.port).toBe(123)
    runServerMain([], { CLWRITING_PORT: '9000' }, MODULE_URL)
    expect(h.bootCalls[1]!.parsed.port).toBe(9000)
    runServerMain([], {}, MODULE_URL)
    expect(h.bootCalls[2]!.parsed.port).toBe(7878)
  })

  it('userDataPath：--user-data 透传；缺省补 defaultUserDataPath()（dd-P3）', () => {
    runServerMain(['node', 'server-main.js', '--user-data', '/ud'], {}, MODULE_URL)
    expect(h.bootCalls[0]!.parsed.userDataPath).toBe('/ud')
    runServerMain([], {}, MODULE_URL)
    expect(h.bootCalls[1]!.parsed.userDataPath).toBe('/fake/user-data')
  })

  it('staticDir 相对 moduleUrl 派生（deriveStaticDir 真件：入口目录 ../web）', () => {
    runServerMain([], {}, MODULE_URL)
    expect(h.bootCalls[0]!.staticDir).toBe(join(dirname(fileURLToPath(MODULE_URL)), '..', 'web'))
  })

  it('boot 成功 → onReady 走 logger 不退出；返回 server 实例', async () => {
    const server = runServerMain([], {}, MODULE_URL)
    expect(server).toBe(h.sentinelServer)
    await new Promise<void>((r) => queueMicrotask(r))
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('监听失败 → describeBootError 信封（真件）+ exit(1)（RB-SV-P2-3）', async () => {
    h.bootBehavior = 'error'
    runServerMain([], {}, MODULE_URL)
    await new Promise<void>((r) => queueMicrotask(r))
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})

/** process.on spy 捕获安装的信号 handler（不真注册到测试进程） */
function captureSignalHandlers() {
  const captured: Record<string, () => void> = {}
  const onSpy = vi
    .spyOn(process, 'on')
    .mockImplementation(((evt: string, fn: () => void) => {
      captured[evt] = fn
      return process
    }) as never)
  return { captured, onSpy }
}

/** setTimeout spy：返回带 unref 的假句柄并登记（exitNow 回调可直驱模拟 2s 到点） */
function fakeTimerHandles() {
  const handles: { fn: () => void; unref: ReturnType<typeof vi.fn> }[] = []
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
    const unref = vi.fn()
    handles.push({ fn, unref })
    return { unref } as unknown as NodeJS.Timeout
  }) as never)
  return { handles, spy }
}

describe('installSignalFallback：信号兜底（M-8/R-20/R1010b-DSK-P3-7）', () => {
  it('SIGINT/SIGTERM 双注册；信号触发 server.close(exitNow)', () => {
    const { captured, onSpy } = captureSignalHandlers()
    try {
      const close = vi.fn()
      installSignalFallback({ close })
      expect(captured['SIGINT']).toBeTruthy()
      expect(captured['SIGTERM']).toBeTruthy()
      captured['SIGINT']!()
      expect(close).toHaveBeenCalledTimes(1)
      expect(typeof close.mock.calls[0]![0]).toBe('function') // close 回调 = exitNow
    } finally {
      onSpy.mockRestore()
    }
  })

  it('close 先完成（长连接全断形态）→ exitNow 经 close 回调触发 exit(0)，幂等不重复退', () => {
    const { captured, onSpy } = captureSignalHandlers()
    try {
      const close = vi.fn((cb?: (err?: Error | null) => void) => {
        if (cb) cb()
      })
      installSignalFallback({ close })
      captured['SIGINT']!()
      captured['SIGTERM']!() // 双信号连发：exiting 幂等（M-8 防双触发）
      expect(exitSpy).toHaveBeenCalledTimes(1)
      expect(exitSpy).toHaveBeenCalledWith(0)
    } finally {
      onSpy.mockRestore()
    }
  })

  it('0918四轮修复批（C403）: close 回调带 err → log 留痕 + exit(1)，幂等不重复退', () => {
    const { captured, onSpy } = captureSignalHandlers()
    try {
      const closeErr = new Error('close 中断（假件）')
      const close = vi.fn((cb?: (err?: Error | null) => void) => {
        if (cb) cb(closeErr)
      })
      installSignalFallback({ close })
      captured['SIGINT']!()
      expect(exitSpy).toHaveBeenCalledTimes(1)
      expect(exitSpy).toHaveBeenCalledWith(1)
      captured['SIGTERM']!() // 双信号连发：exiting 幂等不二次退
      expect(exitSpy).toHaveBeenCalledTimes(1)
      // log 留痕（log 未 init 时 console 镜像，beforeEach 已静音并捕获）
      expect(
        errSpy.mock.calls.some((line) => String(line).includes('server close 失败')),
      ).toBe(true)
    } finally {
      onSpy.mockRestore()
    }
  })

  it('close 悬置（SSE/keep-alive 残留连接形态）→ 2s 兜底 timer exit(0)，句柄 unref（R-20）', () => {
    const { captured, onSpy } = captureSignalHandlers()
    const { handles, spy: timerSpy } = fakeTimerHandles()
    try {
      installSignalFallback({ close: vi.fn() }) // close 不回调（悬置）
      captured['SIGINT']!()
      expect(handles).toHaveLength(1)
      expect(handles[0]!.unref).toHaveBeenCalledTimes(1) // R-20：不作为活跃句柄拖慢退出
      expect(exitSpy).not.toHaveBeenCalled() // 2s 未到不退
      handles[0]!.fn() // 模拟 2s 到点
      expect(exitSpy).toHaveBeenCalledWith(0)
      expect(timerSpy).toHaveBeenCalledWith(expect.any(Function), 2_000)
    } finally {
      timerSpy.mockRestore()
      onSpy.mockRestore()
    }
  })

  it('R1010b-DSK-P3-7: 重复信号不重排兜底 timer（排前查重，单槽）', () => {
    const { captured, onSpy } = captureSignalHandlers()
    const { handles, spy: timerSpy } = fakeTimerHandles()
    try {
      installSignalFallback({ close: vi.fn() })
      captured['SIGINT']!()
      captured['SIGTERM']!() // Ctrl+C 后补 kill / 进程管理器双信号
      captured['SIGINT']!()
      expect(timerSpy).toHaveBeenCalledTimes(1) // 已有在途兜底不重排
      expect(handles).toHaveLength(1)
    } finally {
      timerSpy.mockRestore()
      onSpy.mockRestore()
    }
  })

  it('清理函数：摘除两信号 handler + 清在途兜底 timer（测试拆除面）', () => {
    const { captured, onSpy } = captureSignalHandlers()
    const { spy: timerSpy } = fakeTimerHandles()
    const removeSpy = vi.spyOn(process, 'removeListener').mockImplementation((() => process) as never)
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation((() => undefined) as never)
    try {
      const cleanup = installSignalFallback({ close: vi.fn() })
      captured['SIGINT']!() // 在途兜底先立起（timer 已排）
      cleanup()
      const removedEvents = removeSpy.mock.calls.map(([evt]) => evt)
      expect(removedEvents).toContain('SIGINT')
      expect(removedEvents).toContain('SIGTERM')
      expect(clearSpy).toHaveBeenCalledTimes(1)
      expect(timerSpy).toHaveBeenCalledTimes(1) // cleanup 不多排
    } finally {
      clearSpy.mockRestore()
      removeSpy.mockRestore()
      timerSpy.mockRestore()
      onSpy.mockRestore()
    }
  })
})

describe('vitest 探针：import 态顶层接线跳过', () => {
  it('import 不绑端口（零 boot 调用）不注册信号——探针留痕带 [vitest] 前缀', async () => {
    const onSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as never)
    try {
      vi.resetModules()
      await import('../../src/desktop/server-main.js') // VITEST=true 环境下 import 即触发探针
      const sigEvents = onSpy.mock.calls.filter(([evt]) => evt === 'SIGINT' || evt === 'SIGTERM')
      expect(sigEvents).toEqual([]) // 不真注册信号（不杀测试进程）
      expect(h.bootCalls).toHaveLength(0) // 不真绑端口（不触 runServerMain）
      expect(
        errSpy.mock.calls.some(([line]) => String(line).includes('[server-main][vitest]')),
      ).toBe(true) // 探针留痕与误用直跑口径可区分
    } finally {
      onSpy.mockRestore()
    }
  })
})
