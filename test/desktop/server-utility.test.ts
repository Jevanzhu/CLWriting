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

import { runUtilityEntry } from '../../src/desktop/server-utility.js'

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
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => new Promise<void>((r) => queueMicrotask(r)))
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
})
