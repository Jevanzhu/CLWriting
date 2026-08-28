/**
 * 阶段 22 批 U2：server-utility 入口回归（假 parentPort 驱动 runUtilityEntry，
 * server-boot / graceful-shutdown 双 mock，process.exit spy 不真退）。
 *
 * - ready 握手：boot 成功 → postMessage({type:'ready',port})（§3.2）
 * - boot-error：监听失败 → describeBootError 信封回传 + exit(1)
 * - shutdown 指令：shutdownStudio(getWorkDir, server) 全流程 → shutdown-done 回执 +
 *   exit(0)；收尾 reject 也回执退出（main 总超时兜底，child 不挂死）
 * - 非 shutdown 消息直通忽略
 * - getWorkDir 闭包返回 parsed.workDir（不依赖调用时外部状态）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ParsedServerArgs } from '../../src/desktop/server-boot.js'

/** hoisted 状态：vi.mock 工厂内可引用（工厂闭包不得触外部词法绑定） */
const h = vi.hoisted(() => {
  const sentinelServer = { __sentinel: 'server' }
  return {
    sentinelServer,
    bootCalls: [] as { parsed: unknown; staticDir: unknown; cb: { onReady: (p: number) => void; onBootError: (e: Error) => void } }[],
    bootBehavior: 'ok' as 'ok' | 'error',
    readyPort: 45678,
    shutdownCalls: [] as { getWorkDir: () => string | null; server: unknown }[],
    shutdownImpl: (() => Promise.resolve()) as () => Promise<void>,
  }
})

vi.mock('../../src/desktop/server-boot.js', () => ({
  // 本测试直驱 runUtilityEntry(parsed)，argv 解析不在此测（见 server-boot.test.ts）
  parseServerArgs: (argv: string[]) => argv,
  bootServerFromArgs: (parsed: unknown, staticDir: unknown, cb: never) => {
    const callbacks = cb as unknown as { onReady: (p: number) => void; onBootError: (e: Error) => void }
    h.bootCalls.push({ parsed, staticDir, cb: callbacks })
    // 真实 listening/error 异步到达——queueMicrotask 模拟同型时序
    queueMicrotask(() => {
      if (h.bootBehavior === 'ok') callbacks.onReady(h.readyPort)
      else callbacks.onBootError(new Error('listen EADDRINUSE'))
    })
    return h.sentinelServer
  },
  describeBootError: (err: unknown, port: number) => ({
    code: String((err as Error).message).includes('EADDRINUSE') ? 'EADDRINUSE' : 'UNKNOWN',
    message: `端口 ${port} 已被占用（EADDRINUSE），请释放占用进程或用 --port 换端口`,
  }),
  deriveStaticDir: () => '/fake/static',
}))

vi.mock('../../src/desktop/graceful-shutdown.js', () => ({
  shutdownStudio: (getWorkDir: () => string | null, server: unknown) => {
    h.shutdownCalls.push({ getWorkDir, server })
    return h.shutdownImpl()
  },
}))

import { runUtilityEntry, installFatalExitHandlers } from '../../src/desktop/server-utility.js'

/** parentPort 假件：MessageEvent 包裹形状（消息在 e.data） */
class FakeParentPort {
  posted: unknown[] = []
  private handlers: ((event: { data?: unknown }) => void)[] = []
  postMessage(message: unknown): void {
    this.posted.push(message)
  }
  on(_event: 'message', listener: (event: { data?: unknown }) => void): unknown {
    this.handlers.push(listener)
    return this
  }
  /** main 侧下发指令的测试通道 */
  send(data: unknown): void {
    for (const handler of [...this.handlers]) handler({ data })
  }
}

function mkParsed(over: Partial<ParsedServerArgs> = {}): ParsedServerArgs {
  return {
    port: 0,
    workDir: '/books/lib',
    userDataPath: '/ud',
    book: null,
    token: 'tok',
    mirrorConsole: null,
    ...over,
  }
}

function flush(times = 6): Promise<void> {
  // R71-13：exit 改 setImmediate 调度后，纯 queueMicrotask 轮不触达 check 阶段——
  // flush 改为 setImmediate 轮次（每轮间微任务照常先排空，原有断言时序不受影响）
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => new Promise<void>((r) => setImmediate(r)))
  return p
}

/** process.exit spy：自类型（ReturnType 按工厂调用面推导，不手写 MockInstance 泛参） */
function spyExit() {
  return vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
}

let exitSpy: ReturnType<typeof spyExit>

beforeEach(() => {
  h.bootCalls.length = 0
  h.bootBehavior = 'ok'
  h.shutdownCalls.length = 0
  h.shutdownImpl = () => Promise.resolve()
  exitSpy = spyExit()
})

afterEach(() => {
  exitSpy.mockRestore()
})

describe('批 U2：runUtilityEntry 握手与 shutdown 指令', () => {
  it('boot 成功 → ready 端口回传；返回 server 实例透传给 shutdownStudio', async () => {
    const port = new FakeParentPort()
    const parsed = mkParsed()
    const server = runUtilityEntry(port, parsed)
    expect(server).toBe(h.sentinelServer)
    expect(h.bootCalls[0]!.parsed).toBe(parsed)
    expect(h.bootCalls[0]!.staticDir).toBe('/fake/static')
    await flush()
    expect(port.posted).toEqual([{ type: 'ready', port: 45678 }])
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('监听失败 → boot-error 信封回传 + exit(1)', async () => {
    h.bootBehavior = 'error'
    const port = new FakeParentPort()
    runUtilityEntry(port, mkParsed({ port: 7878 }))
    await flush()
    expect(port.posted).toEqual([
      { type: 'boot-error', code: 'EADDRINUSE', message: '端口 7878 已被占用（EADDRINUSE），请释放占用进程或用 --port 换端口' },
    ])
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('shutdown 指令 → shutdownStudio(getWorkDir=workDir, server) → shutdown-done 回执 + exit(0)', async () => {
    const port = new FakeParentPort()
    const parsed = mkParsed({ workDir: '/books/我的书' })
    runUtilityEntry(port, parsed)
    await flush()
    port.send({ type: 'shutdown' })
    await flush()
    expect(h.shutdownCalls).toHaveLength(1)
    expect(h.shutdownCalls[0]!.getWorkDir()).toBe('/books/我的书')
    expect(h.shutdownCalls[0]!.server).toBe(h.sentinelServer)
    expect(port.posted).toEqual([{ type: 'ready', port: 45678 }, { type: 'shutdown-done' }])
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('收尾 reject 也回执退出（catch 吞错走 finally，child 不挂死）', async () => {
    h.shutdownImpl = () => Promise.reject(new Error('settle 卡死'))
    const port = new FakeParentPort()
    runUtilityEntry(port, mkParsed())
    await flush()
    port.send({ type: 'shutdown' })
    await flush()
    expect(port.posted.at(-1)).toEqual({ type: 'shutdown-done' })
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('非 shutdown 消息直通忽略', async () => {
    const port = new FakeParentPort()
    runUtilityEntry(port, mkParsed())
    await flush()
    port.send({ type: 'ready', port: 1 })
    port.send('不是对象')
    await flush()
    expect(h.shutdownCalls).toHaveLength(0)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  // R71-13（总七十一轮）：boot-error / shutdown-done 回执后不得同步 exit——同步退出会
  // 截断 postMessage 的跨进程投递；退出必须让出至少一个事件循环轮次（setImmediate）。
  // 回归锚：老实现（回执后同步 process.exit）在微任务排空后 exit 已被调用 → 本用例红。
  it('R71-13: boot-error 回执已发而事件循环未让出轮次时不退出——exit 推迟到 setImmediate 轮', async () => {
    h.bootBehavior = 'error'
    const port = new FakeParentPort()
    runUtilityEntry(port, mkParsed())
    // 只排空微任务（boot 回调经 queueMicrotask 到达）：回执应在场，exit 尚未发生
    let p = Promise.resolve()
    for (let i = 0; i < 6; i++) p = p.then(() => new Promise<void>((r) => queueMicrotask(r)))
    await p
    expect(port.posted.at(-1)).toMatchObject({ type: 'boot-error' })
    expect(exitSpy).not.toHaveBeenCalled() // 同步 exit 形态在此即已调用（回归断言点）
    // 让出 macrotask 轮次（check 阶段）后才退出
    await new Promise<void>((r) => setImmediate(r))
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('R71-13: shutdown-done 回执后 exit(0) 同样推迟到 setImmediate 轮', async () => {
    const port = new FakeParentPort()
    runUtilityEntry(port, mkParsed())
    await flush()
    port.send({ type: 'shutdown' })
    // shutdownImpl resolve 走微任务链（.catch/.finally）；微任务排空后回执在场、exit 未发生
    let p = Promise.resolve()
    for (let i = 0; i < 6; i++) p = p.then(() => new Promise<void>((r) => queueMicrotask(r)))
    await p
    expect(port.posted.at(-1)).toEqual({ type: 'shutdown-done' })
    expect(exitSpy).not.toHaveBeenCalled() // 回执先于退出至少一个轮次（回归断言点）
    await new Promise<void>((r) => setImmediate(r))
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})

describe('P3：无 parentPort 探针区分（vitest 测试态 vs 误用直跑）', () => {
  it('vitest 态留痕带 [vitest] 前缀且不退出——与误用直跑报错文本可区分', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      vi.resetModules()
      await import('../../src/desktop/server-utility.js') // VITEST=true 环境下 import 即触发探针
      const line = String(errSpy.mock.calls[0]?.[0])
      expect(line).toContain('[server-utility][vitest]') // 专属前缀：日志里可与误用态区分
      expect(line).toContain('测试态')
      expect(line).not.toContain('缺少 process.parentPort') // 与误用直跑报错口径不重叠
      expect(exitSpy).not.toHaveBeenCalled() // 测试态只留痕不退出（不杀 worker）
    } finally {
      errSpy.mockRestore()
      exitSpy.mockRestore()
    }
  })
})

// R65-41（总六十五轮）：顶层 fatal 兜底——unhandledRejection / uncaughtException 经
// stdout 日志通道记 error 后 process.exit(1)（记日志后主动退出，交给 restart 退避）。
// vitest import 态（无 parentPort）不注册：防测试 worker 的无关 rejection 触发 exit。
describe('R65-41：installFatalExitHandlers（fatal 记日志后 exit(1)）', () => {
  it('两个 handler 各自：log.error 留痕（tag=server-utility）+ process.exit(1)', () => {
    const captured: Record<string, (reasonOrErr: unknown) => void> = {}
    const onSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(((evt: string, fn: (a: unknown) => void) => {
        if (evt === 'uncaughtException' || evt === 'unhandledRejection') captured[evt] = fn
        return process
      }) as never)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    // log 未 init 时为 console 镜像（emit error 级走 console.error）
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      installFatalExitHandlers()
      expect(captured['uncaughtException']).toBeTruthy()
      expect(captured['unhandledRejection']).toBeTruthy()

      const boom = new Error('异步炸了')
      captured['unhandledRejection']!(boom)
      expect(exitSpy).toHaveBeenCalledWith(1)
      // log 未 init 时 console.error 镜像一行 `[tag] msg` + err——断言首参含 tag 与事件名
      expect(
        errSpy.mock.calls.some(([line]) => String(line).includes('server-utility') && String(line).includes('unhandledRejection')),
      ).toBe(true)

      exitSpy.mockClear()
      errSpy.mockClear()
      captured['uncaughtException']!(boom)
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(
        errSpy.mock.calls.some(([line]) => String(line).includes('server-utility') && String(line).includes('uncaughtException')),
      ).toBe(true)
    } finally {
      onSpy.mockRestore()
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })

  it('vitest import 态不注册 fatal handler（无 parentPort 分支不接线）', async () => {
    const onSpy = vi.spyOn(process, 'on').mockImplementation((() => process) as never)
    try {
      vi.resetModules()
      await import('../../src/desktop/server-utility.js')
      const fatalEvents = onSpy.mock.calls.filter(([evt]) => evt === 'uncaughtException' || evt === 'unhandledRejection')
      expect(fatalEvents).toEqual([]) // 测试态 import 不注册（不杀 worker）
    } finally {
      onSpy.mockRestore()
    }
  })
})
