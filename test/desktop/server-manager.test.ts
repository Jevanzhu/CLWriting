/**
 * 阶段 22 批 U1：server-manager 回归（注入假 fork 驱动，不 mock electron 整模块）。
 *
 * - fork 参数与 options：--dir/--user-data/--port 0/--token/--book/--mirror-console、
 *   serviceName 单列名（S-12）、env 缺省继承（不显式传 = process.env，批 U1 口径）
 * - 握手：ready 端口回传（每 fork 一轮，S-5）/ boot-error 信封 reject / 启动途中
 *   exit reject / ready 前不 resolve（时序锚定）
 * - token（U-6 A + 二轮 F-5）：首启生成 + 原子持久化 studio-token.json；跨 manager
 *   （跨 main 重启）复用同一 token；manager 内内存复用——文件被改也不换（启动读入
 *   内存一次、fork 一律复用内存值）
 * - start 时旧 child 在途：先 kill 等退出再 fork（两轮 fork 各自 ready，L-3 换轨）
 * - stopChild：kill + 等退出；无 child 直通；幂等
 */
import { describe, it, expect, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createStudioServerManager,
  ServerBootError,
  STUDIO_SERVICE_NAME,
} from '../../src/desktop/server-manager.js'

/** utilityProcess 假件：EventEmitter 方法双变结构兼容 UtilityProcessLike */
class FakeChild extends EventEmitter {
  posted: unknown[] = []
  killed = 0
  pid = 4242
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

function mkHarness(): {
  forkRecords: ForkRecord[]
  manager: ReturnType<typeof createStudioServerManager>
} {
  const forkRecords: ForkRecord[] = []
  const manager = createStudioServerManager({
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

function argValue(args: string[], flag: string): string {
  const i = args.indexOf(flag)
  expect(i, `fork args 应含 ${flag}：${JSON.stringify(args)}`).toBeGreaterThan(-1)
  return args[i + 1] as string
}

describe('批 U1：fork 参数与握手', () => {
  it('start → fork 参数（--dir/--user-data/--port 0/--token uuid）+ serviceName + env 缺省继承；ready 端口回传', async () => {
    const { forkRecords, manager } = mkHarness()
    const ud = mkUserData()
    const pending = manager.start({ workDir: '/books/lib', userDataPath: ud })
    const rec = forkRecords[0]!
    expect(argValue(rec.args, '--dir')).toBe('/books/lib')
    expect(argValue(rec.args, '--user-data')).toBe(ud)
    expect(argValue(rec.args, '--port')).toBe('0')
    expect(argValue(rec.args, '--token')).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/)
    expect(rec.options['serviceName']).toBe(STUDIO_SERVICE_NAME)
    // env 继承断言：不显式传 env = utilityProcess 缺省继承 process.env（Electron typings
    // 明文；批 U2 注入 CLW_LOG_STDOUT=1 时此处口径随改）
    expect(rec.options['env']).toBeUndefined()
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
    const token1 = argValue(h1.forkRecords[0]!.args, '--token')
    h1.forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
    await p1
    await h1.manager.stopChild()
    const stored = JSON.parse(readFileSync(join(ud, 'studio-token.json'), 'utf-8')) as { token: string }
    expect(stored.token).toBe(token1)
    // 新 manager（模拟 main 重启后 fork）：读同一文件复用同一 token
    const h2 = mkHarness()
    const p2 = h2.manager.start({ workDir: null, userDataPath: ud })
    expect(argValue(h2.forkRecords[0]!.args, '--token')).toBe(token1)
    h2.forkRecords[0]!.child.emit('message', { type: 'ready', port: 2 })
    await p2
    await h2.manager.stopChild()
  })

  it('manager 内内存复用：token 文件被改也不换（启动读入一次，fork 一律用内存值）', async () => {
    const ud = mkUserData()
    const { forkRecords, manager } = mkHarness()
    const p1 = manager.start({ workDir: null, userDataPath: ud })
    const token1 = argValue(forkRecords[0]!.args, '--token')
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
    await p1
    await manager.stopChild()
    // 会话中途文件损坏/被改 → 重启 child 仍用内存值（前端 token 不失效）
    writeFileSync(join(ud, 'studio-token.json'), JSON.stringify({ token: 'tampered' }))
    const p2 = manager.start({ workDir: null, userDataPath: ud })
    expect(argValue(forkRecords[1]!.args, '--token')).toBe(token1)
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 2 })
    await p2
    await manager.stopChild()
  })

  it('文件损坏/缺失 → 重生成覆写（窄边只影响下次启动）', async () => {
    const ud = mkUserData()
    writeFileSync(join(ud, 'studio-token.json'), 'not-json{')
    const { forkRecords, manager } = mkHarness()
    const p = manager.start({ workDir: null, userDataPath: ud })
    const token = argValue(forkRecords[0]!.args, '--token')
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 1 })
    await p
    await manager.stopChild()
    expect(JSON.parse(readFileSync(join(ud, 'studio-token.json'), 'utf-8')).token).toBe(token)
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
})

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})
