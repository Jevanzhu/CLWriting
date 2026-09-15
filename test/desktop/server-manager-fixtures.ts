/**
 * R0916-5b（2026-09-16，server-manager.test.ts 拆分批）：desktop server-manager 回归
 * 共享假件与装置——原 test/desktop/server-manager.test.ts 头部工具面（FakeChild 假
 * utilityProcess / ForkRecord·LogCapture 结构 / mkHarness·mkLogCapture 工厂 /
 * mkUserData 临时目录记账 / flushMicrotasks·flushStreams 让渡 / argValue·envToken
 * 断言助手 / UUID_RE）原样抽取，供 server-manager.test.ts 残核与各拆分件复用；
 * 除 export 前缀与原文件尾 afterAll 清理体单源化（cleanupServerManagerTmpDirs）
 * 外逐字节原样。
 *
 * 池语义：vitest forks 池 isolate 默认开——每个测试文件独立 fork 进程 + 全新模块图，
 * 本模块的 tmpDirs 记账按文件隔离，拆分件之间零串扰；mkdtempTracked（helpers/
 * temp-dir）自带的 afterEach 兜底回收与各件文件级 afterAll 调 cleanupServerManagerTmpDirs
 * 并存，语义与原单体文件同构。本文件无 vi.mock——server-manager 经依赖注入驱动
 * （mkHarness 注入假 fork），不涉及提升时序问题。
 */
import { expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStudioServerManager } from '../../src/desktop/server-manager.js'
import type { LogLike, ServerManagerDeps } from '../../src/desktop/server-manager.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** utilityProcess 假件：EventEmitter 方法双变结构兼容 UtilityProcessLike */
export class FakeChild extends EventEmitter {
  posted: unknown[] = []
  killed = 0
  // R28-21：pid 类型放宽为可 undefined（Electron 语义——UtilityProcess 退出后 pid 置
  // undefined），供「SIGTERM 被吞 + 窗口内已退」的 pid 重读用例注入
  pid: number | undefined = 4242
  stdout: PassThrough = new PassThrough()
  stderr: PassThrough = new PassThrough()
  postMessage(message: unknown): void {
    this.posted.push(message)
  }
  kill(): boolean {
    this.killed++
    // 真实 kill 异步收尸——exit 事件下一拍到达
    queueMicrotask(() => this.emit('exit', 0))
    return true
  }
}

export interface ForkRecord {
  modulePath: string
  args: string[]
  options: Record<string, unknown>
  child: FakeChild
}

/** 日志捕获件（转发用例断言口径：level/tag/msg/err 四元组） */
export interface LogCapture {
  lines: { level: string; tag: string; msg: string; err?: unknown }[]
  logger: LogLike
}

export function mkLogCapture(): LogCapture {
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

export function mkHarness(extra: ServerManagerDeps = {}): {
  forkRecords: ForkRecord[]
  manager: ReturnType<typeof createStudioServerManager>
} {
  const forkRecords: ForkRecord[] = []
  const manager = createStudioServerManager({
    ...extra,
    fork: (modulePath, args, options) => {
      const child = new FakeChild()
      forkRecords.push({ modulePath, args, options: options as Record<string, unknown>, child })
      return child
    },
  })
  return { forkRecords, manager }
}

const tmpDirs: string[] = []
export function mkUserData(): string {
  const d = mkdtempTracked(join(tmpdir(), 'clw-mgr-ud-'))
  tmpDirs.push(d)
  return d
}

export function flushMicrotasks(times = 4): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => new Promise<void>((r) => queueMicrotask(r)))
  return p
}

/** 流式 chunk 经 stream 机制异步送达：让渡事件循环拍数后断言 */
export function flushStreams(): Promise<void> {
  return new Promise((r) => setImmediate(() => setImmediate(r)))
}

export function argValue(args: string[], flag: string): string {
  const i = args.indexOf(flag)
  expect(i, `fork args 应含 ${flag}：${JSON.stringify(args)}`).toBeGreaterThan(-1)
  return args[i + 1] as string
}

/** E-9b：token 只经 env CLW_STUDIO_TOKEN 注入——fork 记录 env 侧取值（断言用） */
export function envToken(rec: ForkRecord): string {
  const env = rec.options['env'] as Record<string, string | undefined>
  expect(env['CLW_STUDIO_TOKEN'], 'fork env 应含 CLW_STUDIO_TOKEN').toBeTruthy()
  return env['CLW_STUDIO_TOKEN'] as string
}

export const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/

/** R0916-5b：原文件尾 afterAll 清理体单源化——各拆分件/残核文件级 afterAll 调用 */
export function cleanupServerManagerTmpDirs(): void {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
}
