/**
 * R55-A-1 / R55-A-2（五十五轮）回归（server-manager，注入假件手法同
 * server-manager.test.ts / r51-a3-a6-server-manager.test.ts）：
 * - A-1〔P2〕session-end 观察窗 5s 与停机链最坏预算失配（settle 2s + 总超时 3.5s +
 *   kill 2s×2 ≈ 慢而正常 ~5.5s / child 挂死 ~9.5-11.5s）：restartPinned 在 shuttingDown
 *   态不再立即拒自愈——有界等待停机收口后重试原路径；等待上限可注入
 *   （restartShutdownWaitMs）；等待期/收口时本进程已入退出链（isProcessExiting）则
 *   放弃；超时仍返 null 不悬挂。
 * - A-2〔P3〕子进程 stdio 流 error 补 logger.warn 留痕（原先空回调零留痕）。
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStudioServerManager, splitLines } from '../../src/desktop/server-manager.js'
import type { LogLike, ServerManagerDeps } from '../../src/desktop/server-manager.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** utilityProcess 假件：EventEmitter 方法双变结构兼容 UtilityProcessLike（同存量手法） */
class FakeChild extends EventEmitter {
  posted: unknown[] = []
  killed = 0
  pid: number | undefined = 4242
  stdout: PassThrough = new PassThrough()
  stderr: PassThrough = new PassThrough()
  postMessage(message: unknown): void {
    this.posted.push(message)
  }
  kill(): boolean {
    this.killed++
    queueMicrotask(() => this.emit('exit', 0))
    return true
  }
}

interface ForkRecord {
  args: string[]
  child: FakeChild
}

/** 日志捕获件（口径同 server-manager.test.ts：level/tag/msg/err 四元组） */
interface LogCapture {
  lines: { level: string; tag: string; msg: string; err?: unknown }[]
  logger: LogLike
}

function mkLogCapture(): LogCapture {
  const lines: LogCapture['lines'] = []
  return {
    lines,
    logger: {
      error: (tag, msg, err) => lines.push({ level: 'error', tag, msg, err }),
      warn: (tag, msg, err) => lines.push({ level: 'warn', tag, msg, err }),
      info: (tag, msg) => lines.push({ level: 'info', tag, msg }),
    },
  }
}

function mkHarness(extra: ServerManagerDeps = {}): {
  forkRecords: ForkRecord[]
  manager: ReturnType<typeof createStudioServerManager>
} {
  const forkRecords: ForkRecord[] = []
  const manager = createStudioServerManager({
    ...extra,
    fork: (_modulePath, args, options) => {
      void options
      const child = new FakeChild()
      forkRecords.push({ args, child })
      return child
    },
  })
  return { forkRecords, manager }
}

function mkUserData(): string {
  return mkdtempTracked(join(tmpdir(), 'r55-mgr-ud-')) // afterEach 兜底回收（temp-dir 助手）
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref())

/** 微任务让渡：确认 restartPinned 在等待期既未 fork 也未落定 */
function flushMicrotasks(times = 6): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => new Promise<void>((r) => queueMicrotask(r)))
  return p
}

/** 慢而正常收尾形态：shutdown 指令到达后 delayMs 毫秒 child 才退出（0 = 不响应） */
function exitAfterShutdown(child: FakeChild, delayMs: number): void {
  const original = child.postMessage.bind(child)
  child.postMessage = (message: unknown) => {
    original(message)
    if ((message as { type?: string })?.type === 'shutdown' && delayMs > 0) {
      setTimeout(() => child.emit('exit', 0), delayMs).unref()
    }
  }
}

async function startReady(manager: ReturnType<typeof createStudioServerManager>, forkRecords: ForkRecord[], port: number): Promise<void> {
  const p1 = manager.start({ workDir: '/w', userDataPath: mkUserData() })
  forkRecords[0]!.child.emit('message', { type: 'ready', port })
  await p1
}

describe('R55-A-1: restartPinned 停机收口有界等待', () => {
  it('shuttingDown 态调用 → 停机收口后有界等待复位并重试成功（钉住端口、单次 fork）', async () => {
    const { forkRecords, manager } = mkHarness({
      shutdownTotalMs: 400, // 兜底不触发（child 60ms 自退）
      killWaitMs: 50,
      restartShutdownWaitMs: 1_000, // 远大于 child 收尾延时
    })
    await startReady(manager, forkRecords, 47010)
    exitAfterShutdown(forkRecords[0]!.child, 60)
    const shutting = manager.shutdown()
    // 停机在途（shuttingDown 置位）时观察窗自愈到达：修复前立即返 null
    const recovered = manager.restartPinned()
    await flushMicrotasks()
    expect(forkRecords.length).toBe(1) // 等待期内不 fork、不提前落定（修复前此处已返 null）
    // child 60ms 后退出 → shutdown 收口 → 唤醒等待者 → 重试 fork（宏任务链，轮询等待）
    await vi.waitFor(() => expect(forkRecords.length).toBe(2), { timeout: 1_000, interval: 10 })
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 47010 }) // 恢复轮钉住端口
    await expect(recovered).resolves.toBe(47010)
    await shutting
    expect(forkRecords.length).toBe(2) // 首启 + 恢复，无双 fork
    expect(forkRecords[1]!.args).toContain('47010') // 恢复轮复刻钉住端口（S-1 同源）
    await manager.stopChild()
  })

  it('停机迟迟不复位 → 注入等待上限到点返 null（不悬挂、不 fork）', async () => {
    const { forkRecords, manager } = mkHarness({
      shutdownTotalMs: 400, // child 对 shutdown 无响应 → 总超时兜底收口
      killWaitMs: 50,
      restartShutdownWaitMs: 60, // 远小于停机收口时刻
    })
    await startReady(manager, forkRecords, 47011)
    const shutting = manager.shutdown()
    const recovered = manager.restartPinned()
    await expect(recovered).resolves.toBeNull()
    expect(forkRecords.length).toBe(1) // 超时放弃，不 fork 孤儿
    await shutting
    expect(forkRecords.length).toBe(1) // 停机链自行收口后也无恢复 fork
  })

  it('等待收口时本进程已入退出链（isProcessExiting）→ 放弃返 null', async () => {
    let exiting = false
    const { forkRecords, manager } = mkHarness({
      shutdownTotalMs: 400,
      killWaitMs: 50,
      restartShutdownWaitMs: 1_000,
      isProcessExiting: () => exiting,
    })
    await startReady(manager, forkRecords, 47012)
    exitAfterShutdown(forkRecords[0]!.child, 60)
    const shutting = manager.shutdown()
    const recovered = manager.restartPinned()
    exiting = true // 等待窗口内 before-quit 链接管（main 注入 appTearingDown 读数形态）
    await expect(recovered).resolves.toBeNull()
    await shutting
    expect(forkRecords.length).toBe(1) // 退出链上不 fork 新 child
  })

  it('入口已在本进程退出链 → 立即返 null（不等待、不 fork）', async () => {
    const { forkRecords, manager } = mkHarness({
      shutdownTotalMs: 5_000,
      restartShutdownWaitMs: 60_000, // 若误入等待将远超断言窗
      isProcessExiting: () => true,
    })
    await startReady(manager, forkRecords, 47013)
    const shutting = manager.shutdown()
    const recovered = manager.restartPinned()
    const outcome = await Promise.race([
      recovered.then((v) => `resolved:${String(v)}`),
      delay(100).then(() => 'pending'),
    ])
    expect(outcome).toBe('resolved:null') // 入口即放弃，不白等 60s
    expect(forkRecords.length).toBe(1)
    forkRecords[0]!.child.emit('exit', 0) // 让 shutdown 链快速收口，不拖测试
    await shutting
  })
})

describe('R55-A-2: 子进程 stdio 流错误留痕', () => {
  it('stdout/stderr 流 error → logger.warn 记「stdio 流异常，转发中止」（附 err message）', async () => {
    const cap = mkLogCapture()
    const { forkRecords, manager } = mkHarness({ logger: cap.logger })
    await startReady(manager, forkRecords, 47014)
    forkRecords[0]!.child.stdout.emit('error', new Error('EPIPE: broken pipe'))
    forkRecords[0]!.child.stderr.emit('error', 'non-error throw')
    const stdioWarns = cap.lines.filter(
      (l) => l.level === 'warn' && l.tag === 'server-manager' && l.msg.includes('stdio 流异常'),
    )
    expect(stdioWarns.length).toBe(2) // 两路各留痕一条
    expect(stdioWarns[0]!.msg).toContain('stdout')
    expect(stdioWarns[0]!.msg).toContain('EPIPE: broken pipe')
    expect(stdioWarns[1]!.msg).toContain('stderr')
    expect(stdioWarns[1]!.msg).toContain('non-error throw')
    await manager.stopChild()
  })

  it('splitLines 未传 onError 时流 error 仍静默吞（不反噬调用方，行为不变）', () => {
    const out = new PassThrough()
    const lines: string[] = []
    splitLines(out, (l) => lines.push(l))
    expect(() => out.emit('error', new Error('x'))).not.toThrow()
    expect(lines).toEqual([])
  })
})
