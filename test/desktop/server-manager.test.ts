/**
 * 阶段 22 批 U1/U2：server-manager 回归（注入假 fork 驱动，不 mock electron 整模块）。
 *
 * - fork 参数与 options：--dir/--user-data/--port 0/--book/--mirror-console、
 *   token 经 env CLW_STUDIO_TOKEN 注入（E-9b：不经 argv——本机 ps 可见）、
 *   serviceName 单列名（S-12）、stdio pipe + env 注入 CLW_LOG_STDOUT=1（批 U2 单写者）
 * - 握手：ready 端口回传（每 fork 一轮，S-5）/ boot-error 信封 reject / 启动途中
 *   exit reject / ready 前不 resolve（时序锚定）
 * - token（U-6 A + 二轮 F-5）：首启生成 + 原子持久化 studio-token.json；跨 manager
 *   （跨 main 重启）复用同一 token；manager 内内存复用——文件被改也不换（启动读入
 *   内存一次、fork 一律复用内存值）
 * - start 时旧 child 在途：先 kill 等退出再 fork（两轮 fork 各自 ready，L-3 换轨）
 * - stopChild：kill + 等退出；无 child 直通；幂等
 * - 批 U2 shutdown：指令下发 → shutdown-done 回执 → 自然退出不 kill；child 无响应
 *   → 总超时强杀；exit 先于回执（无回执退出）直通；幂等；无 child 直通
 * - 批 U2 stdio 转发（§3.5 单写者 main 侧半边）：stdout JSON 行按 level/tag/msg 重发、
 *   err 透传重建 Error（F-3）、坏行/字段残缺原文兜底、跨 chunk 半行拼装、stderr 整行
 *   warn 进档
 * - D1（内存闸 2026-08-24 审计）：splitLines 单行缓冲上限 1MB——超限强制截断出行 +
 *   计数告警；正常行（带换行）行为不变
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createStudioServerManager,
  forwardLogLine,
  ServerBootError,
  SHUTDOWN_TOTAL_TIMEOUT_MS,
  STUDIO_SERVICE_NAME,
  splitLines,
  MAX_LINE_CHARS,
} from '../../src/desktop/server-manager.js'
import type { LogLike, ServerManagerDeps } from '../../src/desktop/server-manager.js'

/** utilityProcess 假件：EventEmitter 方法双变结构兼容 UtilityProcessLike */
class FakeChild extends EventEmitter {
  posted: unknown[] = []
  killed = 0
  pid = 4242
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

interface ForkRecord {
  modulePath: string
  args: string[]
  options: Record<string, unknown>
  child: FakeChild
}

/** 日志捕获件（转发用例断言口径：level/tag/msg/err 四元组） */
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
    fork: (modulePath, args, options) => {
      const child = new FakeChild()
      forkRecords.push({ modulePath, args, options: options as Record<string, unknown>, child })
      return child
    },
  })
  return { forkRecords, manager }
}

const tmpDirs: string[] = []
function mkUserData(): string {
  const d = mkdtempSync(join(tmpdir(), 'clw-mgr-ud-'))
  tmpDirs.push(d)
  return d
}

function flushMicrotasks(times = 4): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => new Promise<void>((r) => queueMicrotask(r)))
  return p
}

/** 流式 chunk 经 stream 机制异步送达：让渡事件循环拍数后断言 */
function flushStreams(): Promise<void> {
  return new Promise((r) => setImmediate(() => setImmediate(r)))
}

function argValue(args: string[], flag: string): string {
  const i = args.indexOf(flag)
  expect(i, `fork args 应含 ${flag}：${JSON.stringify(args)}`).toBeGreaterThan(-1)
  return args[i + 1] as string
}

/** E-9b：token 只经 env CLW_STUDIO_TOKEN 注入——fork 记录 env 侧取值（断言用） */
function envToken(rec: ForkRecord): string {
  const env = rec.options['env'] as Record<string, string | undefined>
  expect(env['CLW_STUDIO_TOKEN'], 'fork env 应含 CLW_STUDIO_TOKEN').toBeTruthy()
  return env['CLW_STUDIO_TOKEN'] as string
}

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/

describe('批 U1：fork 参数与握手', () => {
  it('start → fork 参数（--dir/--user-data/--port 0/token 经 env）+ serviceName + stdio pipe + env 注入 CLW_LOG_STDOUT；ready 端口回传', async () => {
    const { forkRecords, manager } = mkHarness()
    const ud = mkUserData()
    const pending = manager.start({ workDir: '/books/lib', userDataPath: ud })
    const rec = forkRecords[0]!
    expect(argValue(rec.args, '--dir')).toBe('/books/lib')
    expect(argValue(rec.args, '--user-data')).toBe(ud)
    expect(argValue(rec.args, '--port')).toBe('0')
    // E-9b：token 不经 argv（ps 可见）——argv 面无 --token，只经 env CLW_STUDIO_TOKEN 注入
    expect(rec.args).not.toContain('--token')
    expect(envToken(rec)).toMatch(UUID_RE)
    expect(rec.options['serviceName']).toBe(STUDIO_SERVICE_NAME)
    // 批 U2 单写者（§3.5）：pipe 收行 + CLW_LOG_STDOUT=1 让 child 日志只走 stdout；
    // env 是展开拷贝（继承 process.env），不污染 main 自身
    expect(rec.options['stdio']).toBe('pipe')
    const env = rec.options['env'] as Record<string, string | undefined>
    expect(env['CLW_LOG_STDOUT']).toBe('1')
    expect(env['PATH']).toBe(process.env['PATH'])
    expect(String(rec.modulePath)).toMatch(/server-utility\.js$/)
    expect(manager.isRunning()).toBe(false) // ready 前
    rec.child.emit('message', { type: 'ready', port: 45777 })
    await expect(pending).resolves.toBe(45777)
    expect(manager.isRunning()).toBe(true)
    await manager.stopChild()
  })

  it('book/mirrorConsole 下发；workDir null（welcome 态）不带 --dir', async () => {
    const { forkRecords, manager } = mkHarness()
    const ud = mkUserData()
    const p1 = manager.start({ workDir: null, userDataPath: ud, book: '书A', mirrorConsole: true })
    const r1 = forkRecords[0]!
    expect(r1.args).not.toContain('--dir')
    expect(argValue(r1.args, '--book')).toBe('书A')
    expect(r1.args).toContain('--mirror-console')
    r1.child.emit('message', { type: 'ready', port: 1 })
    await p1
    await manager.stopChild()
    const p2 = manager.start({ workDir: '/w', userDataPath: ud })
    const r2 = forkRecords[1]!
    expect(r2.args).not.toContain('--book')
    expect(r2.args).not.toContain('--mirror-console')
    r2.child.emit('message', { type: 'ready', port: 2 })
    await p2
    await manager.stopChild()
  })

  it('boot-error → ServerBootError 信封 reject；随后的 exit 不再二次收口', async () => {
    const { forkRecords, manager } = mkHarness()
    const ud = mkUserData()
    const pending = manager.start({ workDir: null, userDataPath: ud })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'boot-error', code: 'EADDRINUSE', message: '端口 0 已被占用（EADDRINUSE）' })
    await expect(pending).rejects.toBeInstanceOf(ServerBootError)
    await expect(pending).rejects.toMatchObject({ code: 'EADDRINUSE' })
    // child 退出事件晚到（boot-error 后 process.exit(1)）——settled 后不产生未处理拒绝
    child.emit('exit', 1)
    await flushMicrotasks()
    expect(manager.isRunning()).toBe(false)
  })

  it('启动途中 exit（无任何消息）→ ServerBootError(EXIT)', async () => {
    const { forkRecords, manager } = mkHarness()
    const pending = manager.start({ workDir: null, userDataPath: mkUserData() })
    forkRecords[0]!.child.emit('exit', 3)
    await expect(pending).rejects.toMatchObject({ code: 'EXIT' })
  })

  it('ready 前不 resolve（时序锚定：端口只能来自握手消息）', async () => {
    const { forkRecords, manager } = mkHarness()
    const pending = manager.start({ workDir: null, userDataPath: mkUserData() })
    let resolved = false
    void pending.then(() => {
      resolved = true
    })
    await flushMicrotasks()
    expect(resolved).toBe(false)
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 9 })
    await expect(pending).resolves.toBe(9)
    await manager.stopChild()
  })
})

describe('批 U1：studioToken（U-6 A / 二轮 F-5）', () => {
  it('首启生成 + 原子持久化 studio-token.json；跨 manager（跨 main 重启）token 不变', async () => {
    const ud = mkUserData()
    const h1 = mkHarness()
    const p1 = h1.manager.start({ workDir: null, userDataPath: ud })
    const token1 = envToken(h1.forkRecords[0]!)
    h1.forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
    await p1
    await h1.manager.stopChild()
    const stored = JSON.parse(readFileSync(join(ud, 'studio-token.json'), 'utf-8')) as { token: string }
    expect(stored.token).toBe(token1)
    // 新 manager（模拟 main 重启后 fork）：读同一文件复用同一 token
    const h2 = mkHarness()
    const p2 = h2.manager.start({ workDir: null, userDataPath: ud })
    expect(envToken(h2.forkRecords[0]!)).toBe(token1)
    h2.forkRecords[0]!.child.emit('message', { type: 'ready', port: 2 })
    await p2
    await h2.manager.stopChild()
  })

  it('manager 内内存复用：token 文件被改也不换（启动读入一次，fork 一律用内存值）', async () => {
    const ud = mkUserData()
    const { forkRecords, manager } = mkHarness()
    const p1 = manager.start({ workDir: null, userDataPath: ud })
    const token1 = envToken(forkRecords[0]!)
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
    await p1
    await manager.stopChild()
    // 会话中途文件损坏/被改 → 重启 child 仍用内存值（前端 token 不失效）
    writeFileSync(join(ud, 'studio-token.json'), JSON.stringify({ token: 'tampered' }))
    const p2 = manager.start({ workDir: null, userDataPath: ud })
    expect(envToken(forkRecords[1]!)).toBe(token1)
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 2 })
    await p2
    await manager.stopChild()
  })

  it('文件损坏/缺失 → 重生成覆写（窄边只影响下次启动）', async () => {
    const ud = mkUserData()
    writeFileSync(join(ud, 'studio-token.json'), 'not-json{')
    const { forkRecords, manager } = mkHarness()
    const p = manager.start({ workDir: null, userDataPath: ud })
    const token = envToken(forkRecords[0]!)
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
    await p
    await manager.stopChild()
    expect(JSON.parse(readFileSync(join(ud, 'studio-token.json'), 'utf-8')).token).toBe(token)
  })

  // N-1（第五十四轮）：宿主 process.env 残留 CLW_STUDIO_TOKEN 不得穿透覆盖注入值——
  // fork env 拷贝上显式 delete 后再注入受控值（process.env 本身不动）
  it('N-1：宿主残留同名 env → child 收到的是注入 token（残留值不穿透、process.env 不动）', async () => {
    vi.stubEnv('CLW_STUDIO_TOKEN', 'stale-host-residue')
    try {
      const { forkRecords, manager } = mkHarness()
      const p = manager.start({ workDir: null, userDataPath: mkUserData() })
      const token = envToken(forkRecords[0]!)
      expect(token).not.toBe('stale-host-residue') // 残留值不穿透
      expect(token).toMatch(UUID_RE) // 注入的是受控生成/持久化值
      const env = forkRecords[0]!.options['env'] as Record<string, string | undefined>
      expect(env['CLW_STUDIO_TOKEN']).toBe(token) // child env 侧即受控值
      forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
      await p
      await manager.stopChild()
      // 只动拷贝：宿主 process.env 的残留值原样保留
      expect(process.env['CLW_STUDIO_TOKEN']).toBe('stale-host-residue')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('批 U1：旧 child 清理与 stopChild（L-3 换轨）', () => {
  it('start 时旧 child 在途 → 先 kill 等退出再 fork（两轮 fork 各自 ready）', async () => {
    const { forkRecords, manager } = mkHarness()
    const ud = mkUserData()
    const p1 = manager.start({ workDir: null, userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 11 })
    await p1
    const p2 = manager.start({ workDir: null, userDataPath: ud })
    await flushMicrotasks()
    expect(forkRecords[0]!.child.killed).toBe(1) // 旧 child 已 kill
    // 新 child 各发各的 ready（S-5：每 fork 一轮握手）
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 22 })
    await expect(p2).resolves.toBe(22)
    expect(manager.isRunning()).toBe(true)
    await manager.stopChild()
  })

  it('stopChild：无 child 直通；kill + 等退出；幂等', async () => {
    const { forkRecords, manager } = mkHarness()
    await expect(manager.stopChild()).resolves.toBeUndefined()
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
    await p
    const child = forkRecords[0]!.child
    await manager.stopChild()
    expect(child.killed).toBe(1)
    expect(manager.isRunning()).toBe(false)
    await expect(manager.stopChild()).resolves.toBeUndefined() // 幂等
  })
})

describe('批 U1：并发 start 防护', () => {
  it('在途 start 期间再调 start → 复用同一轮（不双 fork）', async () => {
    const { forkRecords, manager } = mkHarness()
    const ud = mkUserData()
    const p1 = manager.start({ workDir: null, userDataPath: ud })
    const p2 = manager.start({ workDir: null, userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 33 })
    await expect(p1).resolves.toBe(33)
    await expect(p2).resolves.toBe(33)
    expect(forkRecords.length).toBe(1)
    await manager.stopChild()
  })

  // E-9a（第五十三轮）：并发 start opts 不同不得静默复用前者配置——fail-closed reject
  // N-9（第五十四轮）：reject 改统一 Error 形态（非 HTTP 层不入错误码词表）+ warn 留痕
  it('E-9a：在途 start 期间以不同 opts 再调 → 拒绝 + warn 留痕（不静默吞没、不自创错误码）', async () => {
    const cap = mkLogCapture()
    const { forkRecords, manager } = mkHarness({ logger: cap.logger })
    const ud = mkUserData()
    const p1 = manager.start({ workDir: null, userDataPath: ud })
    // workDir 不同：后到调用方若被复用会拿到 welcome 态配置——必须 reject
    const p2 = manager.start({ workDir: '/other', userDataPath: ud })
    await expect(p2).rejects.toThrow(/不一致/)
    await expect(p2).rejects.not.toBeInstanceOf(ServerBootError) // 统一 Error，非 ServerBootError 信封
    // 拒绝必须留痕（reject 不静默）：warn 一条且携带原始 Error
    expect(cap.lines.filter((l) => l.level === 'warn' && l.msg.includes('不一致'))).toHaveLength(1)
    expect((cap.lines[0]!.err as Error).message).toContain('/other')
    // userDataPath / book 不同同理（任一关键 opts 不一致即拒绝）
    await expect(manager.start({ workDir: null, userDataPath: '/ud2' })).rejects.toThrow(/不一致/)
    await expect(manager.start({ workDir: null, userDataPath: ud, book: '书A' })).rejects.toThrow(/不一致/)
    // 在途轮不受影响：单一 fork、正常握手收口
    expect(forkRecords.length).toBe(1)
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 44 })
    await expect(p1).resolves.toBe(44)
    await manager.stopChild()
    // 在途轮 settle 后 start 恢复正常（不因曾 mismatch 拒绝后续调用）
    const p3 = manager.start({ workDir: '/other', userDataPath: ud })
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 55 })
    await expect(p3).resolves.toBe(55)
    await manager.stopChild()
  })

  it('E-9a：book null vs undefined 视为一致（可选字段缺省不触发误拒）', async () => {
    const { forkRecords, manager } = mkHarness()
    const ud = mkUserData()
    const p1 = manager.start({ workDir: null, userDataPath: ud })
    const p2 = manager.start({ workDir: null, userDataPath: ud, book: null, mirrorConsole: false })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 3 })
    await expect(p1).resolves.toBe(3)
    await expect(p2).resolves.toBe(3)
    expect(forkRecords.length).toBe(1)
    await manager.stopChild()
  })
})

describe('E-1：shutdown 总超时覆盖 child 最坏预算', () => {
  it('缺省总超时 ≥ 3.5s（child 侧 close 1.5s + settle 1.5s 串行 ≈3s，main 兜底不得在收尾窗口内强杀）', () => {
    // 缺省值锚定：回归到 2s 之类会重新出现「超时强杀打断 session/end 落库」
    expect(SHUTDOWN_TOTAL_TIMEOUT_MS).toBeGreaterThanOrEqual(3_500)
  })
})

describe('批 U2：shutdown 指令（§3.4 时序 4）', () => {
  // S-5 互斥门（shutdownStarted 后 exit 不触发重启）的用例随批 U3 重启逻辑落地——
  // 门在本批只置位无消费面，单独断言无可观测行为。

  it('指令下发 → shutdown-done 回执 → 自然退出：全程不 kill', async () => {
    const { forkRecords, manager } = mkHarness({ killWaitMs: 20 })
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 1 })
    await p
    const shutting = manager.shutdown()
    await flushMicrotasks(1)
    expect(child.posted).toEqual([{ type: 'shutdown' }])
    // 回执到达，exit 在途（真实 child 回执后立即 exit(0)——回执与 exit 间有异步缝）
    child.emit('message', { type: 'shutdown-done' })
    child.emit('exit', 0)
    await expect(shutting).resolves.toBeUndefined()
    expect(child.killed).toBe(0)
    expect(manager.isRunning()).toBe(false)
  })

  it('child 无响应 → 总超时强杀兜底', async () => {
    const { forkRecords, manager } = mkHarness({ shutdownTotalMs: 10, killWaitMs: 20 })
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 1 })
    await p
    await expect(manager.shutdown()).resolves.toBeUndefined()
    expect(child.posted).toEqual([{ type: 'shutdown' }])
    expect(child.killed).toBe(1)
    expect(manager.isRunning()).toBe(false)
  })

  it('exit 先到（无回执退出）→ 直通不强杀', async () => {
    const { forkRecords, manager } = mkHarness()
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 1 })
    await p
    const shutting = manager.shutdown()
    await flushMicrotasks(1)
    child.emit('exit', 0)
    await expect(shutting).resolves.toBeUndefined()
    expect(child.killed).toBe(0)
    expect(manager.isRunning()).toBe(false)
  })

  it('无 child 直通；二次调用幂等（不再下发指令）', async () => {
    const { forkRecords, manager } = mkHarness()
    await expect(manager.shutdown()).resolves.toBeUndefined()
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 1 })
    await p
    const shutting = manager.shutdown()
    await flushMicrotasks(1)
    child.emit('message', { type: 'shutdown-done' })
    child.emit('exit', 0)
    await shutting
    await expect(manager.shutdown()).resolves.toBeUndefined() // 已停机：幂等直通
    expect(child.posted).toEqual([{ type: 'shutdown' }])
  })
})

describe('批 U2：stdio 转发（§3.5 单写者 main 侧半边）', () => {
  it('stdout JSON 行按 level/tag/msg 重发；err 透传重建 Error（F-3）', async () => {
    const cap = mkLogCapture()
    const { forkRecords, manager } = mkHarness({ logger: cap.logger })
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 1 })
    await p
    child.stdout.write(
      JSON.stringify({ ts: '2026-08-23T00:00:00.000Z', level: 'info', tag: 'server', msg: '监听就绪' }) + '\n',
    )
    child.stdout.write(
      JSON.stringify({
        ts: '2026-08-23T00:00:00.001Z',
        level: 'error',
        tag: 'http',
        msg: '落库失败',
        err: { name: 'SqliteError', message: 'disk full', stack: 'SqliteError: disk full\n  at db.run' },
      }) + '\n',
    )
    await flushStreams()
    expect(cap.lines[0]).toEqual({ level: 'info', tag: 'server', msg: '监听就绪' })
    expect(cap.lines[1]).toMatchObject({ level: 'error', tag: 'http', msg: '落库失败' })
    const err = cap.lines[1]!.err as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('SqliteError')
    expect(err.message).toBe('disk full')
    expect(err.stack).toContain('SqliteError: disk full')
    await manager.stopChild()
  })

  it('跨 chunk 半行拼装 + 坏行/level 不可辨识/字段残缺原文兜底 + stderr 整行 warn', async () => {
    const cap = mkLogCapture()
    const { forkRecords, manager } = mkHarness({ logger: cap.logger })
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 1 })
    await p
    // 半行跨 chunk：切两段送达拼成一行
    const good = JSON.stringify({ level: 'info', tag: 'a', msg: 'm' })
    child.stdout.write(good.slice(0, 5))
    child.stdout.write(good.slice(5) + '\n')
    // 非 JSON 裸行（boot 期 console 直写等）：原文整行进档不吞
    child.stdout.write('Error: listen EADDRINUSE\n')
    // JSON 但 level 不可辨识：与坏行同口径
    child.stdout.write('{"level":"debug","tag":"x","msg":"y"}\n')
    // 字段残缺：tag/msg 非字符串 → 兜底 tag/原文 msg
    child.stdout.write('{"level":"info","tag":123}\n')
    // stderr（Node 警告/V8 诊断）：无 JSON 语义，整行 warn
    child.stderr.write('(node:12345) ExperimentalWarning: VM Modules\n')
    await flushStreams()
    expect(cap.lines.map((l) => [l.level, l.tag])).toEqual([
      ['info', 'a'],
      ['info', 'server-proc'],
      ['info', 'server-proc'],
      ['info', 'server-proc'],
      ['warn', 'server-proc'],
    ])
    expect(cap.lines[1]!.msg).toBe('Error: listen EADDRINUSE')
    expect(cap.lines[2]!.msg).toBe('{"level":"debug","tag":"x","msg":"y"}')
    expect(cap.lines[3]!.msg).toBe('{"level":"info","tag":123}')
    expect(cap.lines[4]!.msg).toBe('(node:12345) ExperimentalWarning: VM Modules')
    await manager.stopChild()
  })
})

describe('批 U2：forwardLogLine 解析口径（纯函数直测）', () => {
  it('warn 行无 err / err 非对象（字符串）→ 按无 err 处理不炸', () => {
    const cap = mkLogCapture()
    forwardLogLine(JSON.stringify({ level: 'warn', tag: 't', msg: 'm' }), cap.logger)
    forwardLogLine(JSON.stringify({ level: 'error', tag: 't', msg: 'm', err: 'boom' }), cap.logger)
    expect(cap.lines).toHaveLength(2)
    expect(cap.lines[0]).toMatchObject({ level: 'warn', tag: 't', msg: 'm' })
    expect(cap.lines[0]!.err).toBeUndefined()
    expect(cap.lines[1]!.err).toBeUndefined()
  })

  it('err 缺 message 字段（非完整形状）→ 按 undefined 处理', () => {
    const cap = mkLogCapture()
    forwardLogLine(JSON.stringify({ level: 'error', tag: 't', msg: 'm', err: { name: 'X' } }), cap.logger)
    expect(cap.lines[0]!.err).toBeUndefined()
  })
})

// ── D1（内存闸 2026-08-24 审计）：splitLines 单行缓冲上限 ──
// child 持续输出无换行内容（日志巨行 / \r 型进度条）时 buf 原先无界线性增长；
// 修复：超 1MB 强制截断出行 + 计数告警；带换行的正常行行为不变。
describe('D1: splitLines 单行缓冲上限（纯函数直测）', () => {
  it('超 1MB 无换行：强制截断出行（恰好 1MB）+ 计数告警；余量续入下一行', async () => {
    const out = new PassThrough()
    const lines: string[] = []
    const warns: number[] = []
    splitLines(out, (l) => lines.push(l), (n) => warns.push(n))
    out.write('a'.repeat(MAX_LINE_CHARS + 50)) // 超 1MB 无换行（\r 型进度条同型）
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    expect(lines[0]).toHaveLength(MAX_LINE_CHARS) // 截为恰好 1MB
    expect(lines[0]!).toBe('a'.repeat(MAX_LINE_CHARS))
    expect(warns).toEqual([1]) // 计数告警一次
    // 余量（总写入 - 1MB = 50）留在 buf 续累积：下一换行收口为正常行，不再告警
    out.write('\n')
    await vi.waitFor(() => expect(lines).toHaveLength(2))
    expect(lines[1]).toBe('a'.repeat(50))
    expect(warns).toEqual([1])
  })

  it('正常行不变：换行切分/跨 chunk 拼行/空行跳过口径保持，不触发告警', async () => {
    const out = new PassThrough()
    const lines: string[] = []
    const warns: number[] = []
    splitLines(out, (l) => lines.push(l), (n) => warns.push(n))
    out.write('hello ')
    out.write('world\nsecond\n\n')
    await flushStreams()
    expect(lines).toEqual(['hello world', 'second']) // 跨 chunk 半行拼装 + 空行跳过不变
    expect(warns).toEqual([]) // 无超限不告警
  })
})

describe('D1: stdio 转发接线（manager 全链路）', () => {
  it('child stdout 巨量无换行 → 截断行原文兜底进档 + server-manager 计数告警', async () => {
    const cap = mkLogCapture()
    const { forkRecords, manager } = mkHarness({ logger: cap.logger })
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 1 })
    await p
    child.stdout.write('x'.repeat(MAX_LINE_CHARS + 10)) // 非 JSON 巨行且无换行
    await vi.waitFor(() => {
      // 截断行（非 JSON）原文兜底进档：长度封在 1MB
      const forced = cap.lines.filter((l) => l.level === 'info' && l.tag === 'server-proc')
      expect(forced).toHaveLength(1)
      expect(forced[0]!.msg).toHaveLength(MAX_LINE_CHARS)
    })
    // 计数告警经注入 logger 落档（stdout 侧口径）
    const warns = cap.lines.filter((l) => l.level === 'warn' && l.tag === 'server-manager')
    expect(warns).toHaveLength(1)
    expect(warns[0]!.msg).toContain('stdout')
    expect(warns[0]!.msg).toContain('截断')
    await manager.stopChild()
  })
})

describe('批 U3：崩溃退避自动重启（U-2/S-1/S-5/S-9）', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  /** 起一个 child 并完成握手（fork 在 start 调用内同步发生，取件须在 start 之后） */
  async function bootAt(
    manager: ReturnType<typeof createStudioServerManager>,
    forkRecords: ForkRecord[],
    port: number,
  ): Promise<void> {
    const p = manager.start({ workDir: '/w', userDataPath: mkUserData() })
    forkRecords[0]!.child.emit('message', { type: 'ready', port })
    await p
  }

  it('异常退出 → 自动重启：钉住原端口（S-1）+ 同 token + 原参数面复刻', async () => {
    const { forkRecords, manager } = mkHarness({ backoffMs: [0, 5000, 15000] })
    await bootAt(manager, forkRecords, 45100)
    const token1 = envToken(forkRecords[0]!)
    // 模拟崩溃（非 kill——exit 事件直接到达）
    forkRecords[0]!.child.emit('exit', 1)
    await vi.waitFor(() => expect(forkRecords.length).toBe(2), { timeout: 300 })
    const rec2 = forkRecords[1]!
    expect(argValue(rec2.args, '--port')).toBe('45100') // 钉住原端口，非 '0'
    expect(envToken(rec2)).toBe(token1) // 同一内存 token
    expect(argValue(rec2.args, '--dir')).toBe('/w')
    rec2.child.emit('message', { type: 'ready', port: 45100 })
    await flushMicrotasks()
    expect(manager.isRunning()).toBe(true)
  })

  it('S-5：shutdown / stopChild 主动停机后的 exit 不触发重启（封 fork 数锚定）', async () => {
    // shutdown 路径
    {
      const { forkRecords, manager } = mkHarness({ backoffMs: [0, 5000, 15000], killWaitMs: 20 })
      await bootAt(manager, forkRecords, 1)
      const child = forkRecords[0]!.child
      const shutting = manager.shutdown()
      await flushMicrotasks(1)
      child.emit('message', { type: 'shutdown-done' })
      child.emit('exit', 0)
      await shutting
      await sleep(40) // backoff[0]=0：若门失效，新 fork 早已出现
      expect(forkRecords.length).toBe(1)
    }
    // stopChild 路径
    {
      const { forkRecords, manager } = mkHarness({ backoffMs: [0, 5000, 15000] })
      await bootAt(manager, forkRecords, 2)
      await manager.stopChild() // kill → exit（主动）
      await sleep(40)
      expect(forkRecords.length).toBe(1)
    }
  })

  it('退避序列 10/20/30ms 三次自动重启，第 4 次崩溃转封顶回调（quit 不再重启）', async () => {
    let exhausted = 0
    const { forkRecords, manager } = mkHarness({
      backoffMs: [10, 20, 30],
      onRestartExhausted: () => {
        exhausted++
        return 'quit'
      },
    })
    await bootAt(manager, forkRecords, 1)
    for (let i = 0; i < 4; i++) {
      forkRecords[i]!.child.emit('exit', 1)
      if (i < 3) {
        await vi.waitFor(() => expect(forkRecords.length).toBe(i + 2), { timeout: 300 })
        forkRecords[i + 1]!.child.emit('message', { type: 'ready', port: 1 })
        await flushMicrotasks()
      }
    }
    await vi.waitFor(() => expect(exhausted).toBe(1), { timeout: 300 })
    await sleep(80) // 若封顶失效会继续 fork
    expect(forkRecords.length).toBe(4) // 首启 1 + 自动重启 3，无第 5 次
  })

  it('封顶回调选 restart：计数清零立即开新周期', async () => {
    let exhausted = 0
    const { forkRecords, manager } = mkHarness({
      backoffMs: [10, 20, 30],
      onRestartExhausted: () => {
        exhausted++
        return 'restart'
      },
    })
    await bootAt(manager, forkRecords, 1)
    for (let i = 0; i < 4; i++) {
      forkRecords[i]!.child.emit('exit', 1)
      await vi.waitFor(() => expect(forkRecords.length).toBe(i + 2), { timeout: 300 })
      forkRecords[i + 1]!.child.emit('message', { type: 'ready', port: 1 })
      await flushMicrotasks()
    }
    expect(exhausted).toBe(1)
    // 第 4 次崩溃后封顶 → restart 决断 → 新周期第 1 次重启（fork#5）
    await vi.waitFor(() => expect(forkRecords.length).toBe(5), { timeout: 300 })
  })

  it('S-9：ready 后稳定过窗口计数清零——后续崩溃回退避第 1 档而非第 2 档', async () => {
    // backoff[1]=2000ms：若计数未清零，第二次崩溃后的重启要等 2s（用例 300ms 内必超时）
    const { forkRecords, manager } = mkHarness({ backoffMs: [10, 2000, 3000], stabilityResetMs: 40 })
    await bootAt(manager, forkRecords, 1)
    forkRecords[0]!.child.emit('exit', 1)
    await vi.waitFor(() => expect(forkRecords.length).toBe(2), { timeout: 300 })
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 1 })
    await flushMicrotasks()
    await sleep(80) // 稳定窗口 40ms 已过（child 存活）
    forkRecords[1]!.child.emit('exit', 1) // 计数已清零 → 仍按第 1 档 10ms 重启
    await vi.waitFor(() => expect(forkRecords.length).toBe(3), { timeout: 300 })
  })

  it('退避等待窗口内 shutdown：挂起重启作废（退出途中不 fork 孤儿）', async () => {
    const { forkRecords, manager } = mkHarness({ backoffMs: [80, 80, 80] })
    await bootAt(manager, forkRecords, 1)
    forkRecords[0]!.child.emit('exit', 1)
    await flushMicrotasks(2) // 排程已挂（80ms 后）
    await manager.shutdown() // active 已空：置门 + 取消挂起重启直通
    await sleep(200)
    expect(forkRecords.length).toBe(1)
  })

  it('重启握手失败（boot-error/EADDRINUSE 残留）按退避继续', async () => {
    const { forkRecords, manager } = mkHarness({ backoffMs: [10, 20, 30] })
    await bootAt(manager, forkRecords, 1)
    forkRecords[0]!.child.emit('exit', 1)
    await vi.waitFor(() => expect(forkRecords.length).toBe(2), { timeout: 300 })
    // 重启轮握手失败：钉住端口可能仍被垂死进程占着（EADDRINUSE → boot-error）
    forkRecords[1]!.child.emit('message', { type: 'boot-error', code: 'EADDRINUSE', message: 'x' })
    await vi.waitFor(() => expect(forkRecords.length).toBe(3), { timeout: 300 }) // 按退避第 2 档继续
    forkRecords[2]!.child.emit('message', { type: 'ready', port: 1 })
    await flushMicrotasks()
    expect(manager.isRunning()).toBe(true)
  })

  it('显式 start 换轮作废挂起重启；新一轮端口回 0（非钉住）', async () => {
    const { forkRecords, manager } = mkHarness({ backoffMs: [80, 80, 80] })
    await bootAt(manager, forkRecords, 45555)
    forkRecords[0]!.child.emit('exit', 1)
    await flushMicrotasks(2) // 挂起 80ms 重启
    const p2 = manager.start({ workDir: '/w2', userDataPath: mkUserData() })
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 9 })
    await expect(p2).resolves.toBe(9)
    expect(argValue(forkRecords[1]!.args, '--port')).toBe('0') // 显式 start 永远 OS 分配
    expect(argValue(forkRecords[1]!.args, '--dir')).toBe('/w2')
    await sleep(200) // 挂起重启已被作废
    expect(forkRecords.length).toBe(2)
  })

  // P3（打包修复批）：child 已崩但退避重启在途——isRunning() 为 false 而
  // hasPendingRestart() 为 true；stopChild（= legacyStopHandle.close 路径）须把
  // 挂起重启一并作废（S-5），否则 main「关旧」判据漏检、重启落地成孤儿 fork
  it('P3：挂起重启在途——hasPendingRestart 反映排程；stopChild 作废挂起重启', async () => {
    const { forkRecords, manager } = mkHarness({ backoffMs: [80, 80, 80] })
    expect(manager.hasPendingRestart()).toBe(false) // 初始无排程
    await bootAt(manager, forkRecords, 1)
    expect(manager.hasPendingRestart()).toBe(false)
    forkRecords[0]!.child.emit('exit', 1) // 崩溃：child 没了但重启已排程（80ms 后）
    await flushMicrotasks(2)
    expect(manager.isRunning()).toBe(false) // 原判据在此返 null → 漏关漏取消
    expect(manager.hasPendingRestart()).toBe(true)
    await manager.stopChild() // 无 active child：直通但必须取消挂起重启
    expect(manager.hasPendingRestart()).toBe(false)
    await sleep(200)
    expect(forkRecords.length).toBe(1) // 重启未落地（无孤儿 fork）
  })

  // X-3（第五十六轮）：restartTimer 已触发、重启握手在途的窗口内 start() 三守卫
  // （starting/active/hasPendingRestart）皆空——修复前会再 fork 双 child，后完成者
  // 赢得 active、先完成者孤儿无人杀。修复后重启占 starting 通道：同参数 start 复用
  // 在途轮（含钉住端口），参数不一致沿用 E-9a fail-closed reject。
  it('X-3：重启在途窗口并发 start（同参数）→ 复用在途轮不双 fork；参数不一致 fail-closed', async () => {
    const { forkRecords, manager } = mkHarness({ backoffMs: [0, 5000, 15000] })
    const ud = mkUserData()
    const p1 = manager.start({ workDir: '/w', userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 45300 })
    await p1
    forkRecords[0]!.child.emit('exit', 1) // 崩溃 → backoff[0]=0 立即排程重启
    await vi.waitFor(() => expect(forkRecords.length).toBe(2), { timeout: 300 })
    expect(argValue(forkRecords[1]!.args, '--port')).toBe('45300') // 重启钉住端口
    // 此刻 ready 未发（握手在途）= 三守卫皆空的窗口；并发 start 同参数必须复用在途轮
    const p2 = manager.start({ workDir: '/w', userDataPath: ud })
    await expect(manager.start({ workDir: '/other', userDataPath: ud })).rejects.toThrow(/不一致/)
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 45300 })
    await expect(p2).resolves.toBe(45300) // 复用在途重启轮（钉住端口，非 OS 分配）
    await flushMicrotasks()
    expect(manager.isRunning()).toBe(true)
    expect(forkRecords.length).toBe(2) // 全程仅首启 + 重启两次 fork（无双 fork）
  })
})

// ── S1（五十九轮）：shutdown/stopChild 对「握手中的在途 fork」的停机竞态 ──
// 握手窗口内 active===null，原 shutdown 只看 active → before-quit 落在该窗口时新
// child 收不到 shutdown 指令、不走优雅停机，只能硬杀。修复：先 await starting
// （catch 握手失败）再判 active；launch fork 后检查 shutdownStarted 即杀。
describe('S1: 停机对在途 fork 的可见性', () => {
  it('shutdown 落在 start 握手窗口内 → 等 ready 后对新 child 下发 shutdown 指令（优雅停机，非硬杀）', async () => {
    const { forkRecords, manager } = mkHarness({ shutdownTotalMs: 200, killWaitMs: 50 })
    const ud = mkUserData()
    const starting = manager.start({ workDir: '/w', userDataPath: ud })
    const child = forkRecords[0]!.child
    // 握手在途（ready 未发）时 before-quit 触发——原实现此处 if (!current) return 漏停
    const shuttingDown = manager.shutdown()
    child.emit('message', { type: 'ready', port: 46000 })
    await expect(starting).resolves.toBe(46000)
    // 新 child 被优雅停机链覆盖：收到 shutdown 指令
    await flushMicrotasks()
    expect(child.posted).toContainEqual({ type: 'shutdown' })
    child.emit('message', { type: 'shutdown-done' })
    child.emit('exit', 0)
    await shuttingDown
    expect(child.killed).toBe(0) // 回执路径不 kill（优雅停机语义保留）
    expect(forkRecords.length).toBe(1)
  })

  it('stopChild 落在 start 握手窗口内 → 等 ready 后 kill 新 child（不漏杀成孤儿）', async () => {
    const { forkRecords, manager } = mkHarness()
    const ud = mkUserData()
    const starting = manager.start({ workDir: '/w', userDataPath: ud })
    const child = forkRecords[0]!.child
    const stopping = manager.stopChild()
    child.emit('message', { type: 'ready', port: 46001 })
    await expect(starting).resolves.toBe(46001)
    await stopping
    expect(child.killed).toBe(1) // 新 child 被 kill（原实现 active===null 直通漏杀）
    expect(manager.isRunning()).toBe(false)
    expect(forkRecords.length).toBe(1)
  })

  it('shutdown 等待中握手失败（boot-error）→ 吞启动失败继续停机面，不挂死不炸', async () => {
    const { forkRecords, manager } = mkHarness({ shutdownTotalMs: 200 })
    const ud = mkUserData()
    const starting = manager.start({ workDir: '/w', userDataPath: ud })
    const shuttingDown = manager.shutdown()
    forkRecords[0]!.child.emit('message', { type: 'boot-error', code: 'EADDRINUSE', message: 'x' })
    await expect(starting).rejects.toThrow(ServerBootError)
    await expect(shuttingDown).resolves.toBeUndefined() // catch 握手失败，静默收口
    expect(forkRecords.length).toBe(1) // 停机门置位后无重启 fork
  })
})

// B-7（第六十轮）：停机中 start fail-closed 拒绝——S1 只覆盖「shutdown 先于 start」
// 正向时序；反向时序（shutdown 已置位并停驻等待点、starting===null）下 start 进入
// 此前会在 IIFE 首行同步复位 shutdownStarted → 新 child 在停机流程中途存活。
// 现状唯一调用链 bootstrapRunner 有守卫挡住（不可达），本修复把调用纪律变成机制。
// 语义边界：只挡停机「进行中」窗口（独立 shuttingDown 生命周期门）——shutdownStarted
// 另承载「主动 kill 标记」（stopActiveChild 置位），stopChild 后的 start 换轮仍放行。
describe('B-7: 停机中 start 反向窗口 fail-closed 拒绝', () => {
  it('shutdown 停驻等待点时 start → reject 且不 fork；收口后 start 开新生命周期', async () => {
    const { forkRecords, manager } = mkHarness({ shutdownTotalMs: 5_000 })
    const ud = mkUserData()
    const starting = manager.start({ workDir: '/w', userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
    await starting
    // 发起 shutdown：置位后停驻在 done/exit/timeout 等待点（FakeChild 不自退）
    const shuttingDownP = manager.shutdown()
    await flushMicrotasks(2)
    // 反向时序：停机中 start 进入——修复前 IIFE 首行复位停机门并 fork 第二个 child
    await expect(manager.start({ workDir: '/w', userDataPath: ud })).rejects.toThrow('停机流程进行中')
    expect(forkRecords).toHaveLength(1)
    // 收口停机（回执 + 退出）
    forkRecords[0]!.child.emit('message', { type: 'shutdown-done' })
    forkRecords[0]!.child.emit('exit', 0)
    await shuttingDownP
    // 停机完成后：start 开新生命周期正常放行（fork 第二个 child；shutdownStarted 的
    // 主动 kill 标记语义不复位，由新 start 的 IIFE 首行按既有语义处理）
    const second = manager.start({ workDir: '/w', userDataPath: ud })
    expect(forkRecords).toHaveLength(2)
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 2 })
    await expect(second).resolves.toBe(2)
    await manager.stopChild()
  })

  it('对照：stopChild（非停机流程）后的 start 换轮照常放行（kill 标记 ≠ 停机门）', async () => {
    const { forkRecords, manager } = mkHarness()
    const ud = mkUserData()
    const first = manager.start({ workDir: '/w', userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
    await first
    await manager.stopChild()
    const second = manager.start({ workDir: '/w', userDataPath: ud })
    expect(forkRecords).toHaveLength(2)
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 2 })
    await expect(second).resolves.toBe(2)
    await manager.stopChild()
  })
})

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})
