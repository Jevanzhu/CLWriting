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
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** utilityProcess 假件：EventEmitter 方法双变结构兼容 UtilityProcessLike */
class FakeChild extends EventEmitter {
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
  const d = mkdtempTracked(join(tmpdir(), 'clw-mgr-ud-'))
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

  // ── R0911-A-P3-2（2026-09-11 全量重评 GLM-5.3 修复批）：utilityProcess 'error' 监听面 ──
  it('启动途中 error（V8 FatalError/spawn 失败形态）→ ServerBootError(FORK_ERROR) 快失败，不等满握手超时', async () => {
    const { forkRecords, manager } = mkHarness()
    const pending = manager.start({ workDir: null, userDataPath: mkUserData() })
    // Electron 契约：'error' 三参（type / location / 完整崩溃报告文本），非 Error 对象
    forkRecords[0]!.child.emit('error', 'FatalError', 'heap/0x1c8', 'report: invalid table size')
    await expect(pending).rejects.toMatchObject({ code: 'FORK_ERROR' })
    await expect(pending).rejects.toThrow(/FatalError @ heap\/0x1c8/)
  })

  it('ready 后 error（运行中异常终止）→ 持久监听诊断留痕不崩进程（EventEmitter error 无监听即 uncaught 的防线锚定）', async () => {
    const cap = mkLogCapture()
    const { forkRecords, manager } = mkHarness({ logger: cap.logger })
    const pending = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 7 })
    await pending
    child.emit('error', 'FatalError', '', 'report: OOM')
    const hit = cap.lines.find((l) => l.level === 'error' && l.msg.includes('utilityProcess 异常终止'))
    expect(hit, '诊断日志未落档').toBeTruthy()
    expect(hit?.err).toBe('report: OOM') // 完整崩溃报告进档（V8 级根因可考古）
    await manager.stopChild()
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

  // R1W-6（win 平台专项复审 R1）：win 环境名大小写不敏感——残留的小写/混写变体
  // 此前躲过大写 delete 形成双重键、child 取值未指定。逐键 toUpperCase 清除后
  // 子 env 内只剩大写受控键（该断言跨平台成立：posix 上小写键也被循环清掉）。
  it('R1W-6：宿主残留小写变体 env → child env 无大小写双重键，仅大写受控值', async () => {
    vi.stubEnv('clw_studio_token', 'stale-lower-residue')
    try {
      const { forkRecords, manager } = mkHarness()
      const p = manager.start({ workDir: null, userDataPath: mkUserData() })
      const env = forkRecords[0]!.options['env'] as Record<string, string | undefined>
      const tokenKeys = Object.keys(env).filter((k) => k.toUpperCase() === 'CLW_STUDIO_TOKEN')
      expect(tokenKeys).toEqual(['CLW_STUDIO_TOKEN']) // 双重键清除，仅大写受控键
      expect(env['CLW_STUDIO_TOKEN']).not.toBe('stale-lower-residue')
      expect(Object.values(env)).not.toContain('stale-lower-residue')
      forkRecords[0]!.child.emit('message', { type: 'ready', port: 2 })
      await p
      await manager.stopChild()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // R41-7（四十一轮）：env 大小写清除面补 CLW_LOG_STDOUT——下方注入 CLW_LOG_STDOUT=1，
  // 残留混写变体（clw_log_stdout）同样双键穿透，child 日志形态被旧值劫持
  it('R41-7：宿主残留 clw_log_stdout 变体 → child env 无双重键，仅受控 CLW_LOG_STDOUT=1', async () => {
    vi.stubEnv('clw_log_stdout', 'stale-log-residue')
    try {
      const { forkRecords, manager } = mkHarness()
      const p = manager.start({ workDir: null, userDataPath: mkUserData() })
      const env = forkRecords[0]!.options['env'] as Record<string, string | undefined>
      const logKeys = Object.keys(env).filter((k) => k.toUpperCase() === 'CLW_LOG_STDOUT')
      expect(logKeys).toEqual(['CLW_LOG_STDOUT'])
      expect(env['CLW_LOG_STDOUT']).toBe('1')
      forkRecords[0]!.child.emit('message', { type: 'ready', port: 3 })
      await p
      await manager.stopChild()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // R43-26（四十三轮）：剥除面补 dev/资源定位变量——宿主残留 CLW_DEV_UI / CLW_DEV_CORS /
  // CLWRITING_RESOURCES_DIR（含 win 混写变体）不得穿透进 child env：dev 双变量会让打包
  // child 的 Origin 白名单放行 5173，资源变量会让 asar 内捆绑资源被宿主残留目录劫持
  //（resources.ts 无打包态检查，剥除即回落模块相对推导）。
  it('R43-26：宿主残留 CLW_DEV_UI/CLW_DEV_CORS/CLWRITING_RESOURCES_DIR（含混写变体）→ child env 全剥除', async () => {
    vi.stubEnv('CLW_DEV_UI', '1')
    vi.stubEnv('clw_dev_cors', '1') // 混写变体（win 大小写不敏感残留形态）同剥
    vi.stubEnv('CLWRITING_RESOURCES_DIR', '/stale/host/resources')
    try {
      const { forkRecords, manager } = mkHarness()
      const p = manager.start({ workDir: null, userDataPath: mkUserData() })
      const env = forkRecords[0]!.options['env'] as Record<string, string | undefined>
      expect(Object.keys(env).filter((k) => k.toUpperCase() === 'CLW_DEV_UI')).toEqual([])
      expect(Object.keys(env).filter((k) => k.toUpperCase() === 'CLW_DEV_CORS')).toEqual([])
      expect(Object.keys(env).filter((k) => k.toUpperCase() === 'CLWRITING_RESOURCES_DIR')).toEqual([])
      expect(Object.values(env)).not.toContain('/stale/host/resources')
      forkRecords[0]!.child.emit('message', { type: 'ready', port: 4 })
      await p
      await manager.stopChild()
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

  // R28-21（二十八轮）：SIGKILL 升级前重读 proc.pid——killWaitMs（2s）窗内子进程已死亡
  // 且 pid 被系统复用时，按入口快照盲杀会误伤无关进程（极窄理论窗）。Electron 退出后
  // pid 置 undefined，重读 undefined = 已退出（exit 事件竞态迟到）→ 跳过升级走「超时放行」。
  describe('R28-21：SIGKILL 升级前 pid 重读', () => {
    /** SIGTERM 被吞形态的假件：kill 只计数，不派发 exit（killWaitMs 窗口内「仍活」） */
    function swallowTerm(child: FakeChild): void {
      child.kill = () => {
        child.killed++
        return true
      }
    }

    it('killWaitMs 窗内 child 已退（pid 置 undefined）→ 不升级 SIGKILL（防 pid 复用误杀无关进程）', async () => {
      const { forkRecords, manager } = mkHarness({ killWaitMs: 40 })
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      try {
        const p = manager.start({ workDir: null, userDataPath: mkUserData() })
        const child = forkRecords[0]!.child
        child.emit('message', { type: 'ready', port: 1 })
        await p
        swallowTerm(child)
        const stopping = manager.stopChild()
        // 窗口过半后模拟 Electron 语义：进程已退，pid 置 undefined（exit 事件竞态迟到）
        await new Promise((r) => setTimeout(r, 10))
        child.pid = undefined
        await expect(stopping).resolves.toBeUndefined()
        expect(killSpy).not.toHaveBeenCalled() // 修复前按入口快照 pid=4242 盲杀
        // 竞态迟到的 exit 事件补达：active 由 exit 监听清空（停机语义收口）
        child.emit('exit', 0)
        await flushMicrotasks()
        expect(manager.isRunning()).toBe(false)
      } finally {
        killSpy.mockRestore()
      }
    })

    it('对照：窗口内 pid 仍在（真挂死）→ 照常升级 SIGKILL（修复不弱化强杀兜底）', async () => {
      const { forkRecords, manager } = mkHarness({ killWaitMs: 40 })
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      try {
        const p = manager.start({ workDir: null, userDataPath: mkUserData() })
        const child = forkRecords[0]!.child
        child.emit('message', { type: 'ready', port: 1 })
        await p
        swallowTerm(child)
        const stopping = manager.stopChild()
        await new Promise((r) => setTimeout(r, 10))
        expect(child.pid).toBe(4242) // pid 未变（真挂死形态）
        await expect(stopping).resolves.toBeUndefined()
        expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL')
      } finally {
        killSpy.mockRestore()
      }
    })
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

// ── R50-A-4（五十轮）：exit 冲刷残留半行 ──
// 子进程崩溃时尾行常无换行（最后诊断/堆栈恰卡半行），只挂 'data' 的切分缓冲随进程
// 死亡丢弃——恰是最关键取证线索。修复：splitLines 返回切分器句柄，forwardChildStdio
// 在 child exit 时对两路缓冲各强制冲刷一次再弃。
describe('R50-A-4: splitLines exit 冲刷（纯函数直测）', () => {
  it('半行残留经 flush() 出行；幂等（二次冲刷无产出）；冲后正常行口径不变', async () => {
    const out = new PassThrough()
    const lines: string[] = []
    const splitter = splitLines(out, (l) => lines.push(l))
    out.write('half line without newline') // 无换行：data 到达但不出行
    await flushStreams()
    expect(lines).toHaveLength(0)
    splitter.flush()
    expect(lines).toEqual(['half line without newline'])
    splitter.flush() // 幂等：缓冲已清，不重复出行
    expect(lines).toHaveLength(1)
    out.write('next\n') // 冲刷后正常换行行照常切分
    await flushStreams()
    expect(lines).toEqual(['half line without newline', 'next'])
  })
})

describe('R50-A-4: exit 冲刷接线（manager 全链路）', () => {
  it('主动停机（stopChild → kill → exit）：stdout/stderr 两路无换行尾行仍进日志', async () => {
    const cap = mkLogCapture()
    const { forkRecords, manager } = mkHarness({ logger: cap.logger })
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 1 })
    await p
    child.stdout.write(JSON.stringify({ level: 'error', tag: 'boot', msg: 'half json line no newline' }))
    child.stderr.write('FATAL: heap out of memory') // 崩溃取证主线索形态：stderr 无换行尾行
    await flushStreams() // data 已入切分缓冲（无换行未出行）
    expect(cap.lines).toHaveLength(0) // 修复前形态锚定：无换行不出行
    await manager.stopChild() // kill → exit → 两路 flush
    const errLine = cap.lines.find((l) => l.level === 'error' && l.tag === 'boot')
    expect(errLine?.msg).toBe('half json line no newline') // stdout 半行 JSON 照常按 level 重发
    const stderrLine = cap.lines.find((l) => l.level === 'warn' && l.tag === 'server-proc')
    expect(stderrLine?.msg).toBe('FATAL: heap out of memory') // stderr 半行整行 warn 进档（修复前随进程死亡丢弃）
  })

  it('子进程崩溃（非主动 exit）：残留半行仍进日志；挂起重启被收口取消', async () => {
    const cap = mkLogCapture()
    // 大退避防 0ms 立即重启 fork 干扰断言（收尾 stopChild 取消挂起重启）
    const { forkRecords, manager } = mkHarness({ logger: cap.logger, backoffMs: [999_000, 999_000, 999_000] })
    const p = manager.start({ workDir: null, userDataPath: mkUserData() })
    const child = forkRecords[0]!.child
    child.emit('message', { type: 'ready', port: 1 })
    await p
    child.stderr.write('(node:4242) FATAL: segmentation fault')
    await flushStreams()
    child.emit('exit', 1) // 崩溃退出：exit 处理路径 flush
    await flushMicrotasks()
    expect(cap.lines.some((l) => l.level === 'warn' && l.tag === 'server-proc' && l.msg === '(node:4242) FATAL: segmentation fault')).toBe(true)
    await manager.stopChild() // 取消挂起重启（timer unref 不拖 worker，显式收口保净）
  })
})

describe('批 U3：崩溃退避自动重启（U-2/S-1/S-5/S-9）', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  /** 重审-18（2026-09-07 全量代码重审 §四.18）：墙钟越过危险窗的轮询等待——定长
   *  sleep 与真实定时竞速（慢机/事件循环停滞下排程定时迟到即漏检）；小步 poll 持续
   *  让出事件循环，迟到的定时一到期即被处理。since = 危险窗起点（崩溃/排程时刻），
   *  越过 windowMs 后由调用方断言——forkRecords 只增不减，窗内任何时刻落地的多余
   *  fork 都会被终检抓到（语义不弱化）；deadline 5s 到点未越窗即红（防假绿）。 */
  function elapseBeyond(since: number, windowMs: number): Promise<void> {
    return vi.waitFor(() => expect(Date.now() - since).toBeGreaterThanOrEqual(windowMs), { timeout: 5_000, interval: 10 })
  }

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
    // backoff[1]=2000ms：若计数未清零，第二次崩溃后的重启要等 2s（用例 1000ms 内必超时）
    const { forkRecords, manager } = mkHarness({ backoffMs: [10, 2000, 3000], stabilityResetMs: 40 })
    await bootAt(manager, forkRecords, 1)
    forkRecords[0]!.child.emit('exit', 1)
    await vi.waitFor(() => expect(forkRecords.length).toBe(2), { timeout: 300 })
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 1 })
    await flushMicrotasks()
    // R63-16：80ms 是「越过 40ms 稳定窗口」的下界等待——停顿只会更稳（定时器不早
    // 触发），无需加宽；判别力在下方 waitFor：预期 10ms 档重启，若误用第 2 档
    // 2000ms 则 1000ms 内必红（原 300ms 停顿余量薄，放至 1000ms 仍保有判别）
    await sleep(80) // 稳定窗口 40ms 已过（child 存活）
    forkRecords[1]!.child.emit('exit', 1) // 计数已清零 → 仍按第 1 档 10ms 重启
    await vi.waitFor(() => expect(forkRecords.length).toBe(3), { timeout: 1000 })
  })

  it('退避等待窗口内 shutdown：挂起重启作废（退出途中不 fork 孤儿）', async () => {
    const { forkRecords, manager } = mkHarness({ backoffMs: [80, 80, 80] })
    await bootAt(manager, forkRecords, 1)
    const crashAt = Date.now() // 危险窗起点：挂起重启自此 80ms 后触发
    forkRecords[0]!.child.emit('exit', 1)
    await flushMicrotasks(2) // 排程已挂（80ms 后）
    await manager.shutdown() // active 已空：置门 + 取消挂起重启直通
    // 重审-18（2026-09-07 全量代码重审 §四.18）：原 sleep(200) 定长越过 80ms 退避窗
    // ——改轮询越过危险窗；若作废失效，窗内 fork 会被终检抓到
    await elapseBeyond(crashAt, 200)
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
    const crashAt = Date.now() // 危险窗起点：挂起重启自此 80ms 后触发
    forkRecords[0]!.child.emit('exit', 1)
    await flushMicrotasks(2) // 挂起 80ms 重启
    const p2 = manager.start({ workDir: '/w2', userDataPath: mkUserData() })
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 9 })
    await expect(p2).resolves.toBe(9)
    expect(argValue(forkRecords[1]!.args, '--port')).toBe('0') // 显式 start 永远 OS 分配
    expect(argValue(forkRecords[1]!.args, '--dir')).toBe('/w2')
    // 重审-18（2026-09-07 全量代码重审 §四.18）：原 sleep(200) 定长越过 80ms 退避窗
    // ——改轮询越过危险窗；挂起重启若未被作废，窗内 fork 会被终检抓到
    await elapseBeyond(crashAt, 200)
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
    const crashAt = Date.now() // 危险窗起点：挂起重启自此 80ms 后触发
    forkRecords[0]!.child.emit('exit', 1) // 崩溃：child 没了但重启已排程（80ms 后）
    await flushMicrotasks(2)
    expect(manager.isRunning()).toBe(false) // 原判据在此返 null → 漏关漏取消
    expect(manager.hasPendingRestart()).toBe(true)
    await manager.stopChild() // 无 active child：直通但必须取消挂起重启
    expect(manager.hasPendingRestart()).toBe(false)
    // 重审-18（2026-09-07 全量代码重审 §四.18）：原 sleep(200) 定长越过 80ms 退避窗
    // ——改轮询越过危险窗；若取消失效，孤儿 fork 会被终检抓到
    await elapseBeyond(crashAt, 200)
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

// R44-12（四十四轮）：shutdown 等 settleStarting 的短预算——裸 await 在握手挂起时
// 最坏 30s 握手超时 + kill 升级 2s×2 才收口（用户点退出 ~41s「关不掉」）。修复后
// 预算内未收口即放弃等握手、对在途 fork 就地 kill（握手期 server 未 ready、无在途
// 编排可丢，硬杀无语义损失）；正常路径语义不变（S1 既有用例覆盖）。
describe('R44-12: shutdown 短预算放弃挂起握手', () => {
  it('握手挂起 + 预算耗尽 → 就地 kill 在途 fork（不等 30s 握手超时），无优雅指令面', async () => {
    const { forkRecords, manager } = mkHarness({
      shutdownSettleBudgetMs: 50,
      killWaitMs: 50,
      shutdownTotalMs: 200,
    })
    const ud = mkUserData()
    const starting = manager.start({ workDir: '/w', userDataPath: ud })
    const child = forkRecords[0]!.child
    // ready 永不到达（握手挂起）时触发 shutdown——修复前裸 await settleStarting 卡满
    const t0 = Date.now()
    await manager.shutdown()
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(5_000) // 修复前 ≥ HANDSHAKE_TIMEOUT_MS(30s)
    expect(child.killed).toBeGreaterThanOrEqual(1) // 在途 fork 被 kill 收口（不成孤儿）
    expect(child.posted).not.toContainEqual({ type: 'shutdown' }) // 握手未完成，无优雅指令面
    // kill 后 start 链经 exit 落定（启动途中 exit reject 形态）：接住防未处理拒绝
    await expect(starting).rejects.toThrow()
    expect(forkRecords.length).toBe(1) // 停机门置位，无重启 fork
  })

  it('对照：握手在预算内收口 → 语义不变，对 active child 走优雅停机链', async () => {
    const { forkRecords, manager } = mkHarness({
      shutdownSettleBudgetMs: 5_000,
      shutdownTotalMs: 200,
      killWaitMs: 50,
    })
    const ud = mkUserData()
    const starting = manager.start({ workDir: '/w', userDataPath: ud })
    const child = forkRecords[0]!.child
    const shuttingDown = manager.shutdown()
    child.emit('message', { type: 'ready', port: 46010 })
    await expect(starting).resolves.toBe(46010)
    await flushMicrotasks()
    expect(child.posted).toContainEqual({ type: 'shutdown' }) // 优雅指令（非 kill）
    child.emit('message', { type: 'shutdown-done' })
    child.emit('exit', 0)
    await shuttingDown
    expect(child.killed).toBe(0) // 回执路径不 kill
  })
})

// 重评-P3-8（2026-09-09 全量代码重评）：start 换轮路径的第二次 shutdownStarted = false
// 原为无条件清零——并发 shutdown 恰落在 stopActiveChild 的 kill 等待窗（置 shuttingDown +
// shutdownStarted）时门被拆，launch 的 fork 后检查失守，退出链上 fork 出存活新 child。
// 修复后复位改条件式（if (!shuttingDown)）：停机在途则保持门置位，fork 后检查即杀新
// child 按启动失败收口（S1 同款）。「shutdown 开始后绝不 fork 出存活 child」锁定。
describe('重评-P3-8: 换轮 stopActiveChild 窗口内并发 shutdown 不清停机门', () => {
  it('start-with-active 的 kill 等待窗内并发 shutdown → 新 child fork 即杀（SHUTDOWN reject），停机链上无存活 child', async () => {
    const { forkRecords, manager } = mkHarness({ shutdownSettleBudgetMs: 5_000, shutdownTotalMs: 5_000, killWaitMs: 200 })
    const ud = mkUserData()
    // 1) 首启建 active child
    const first = manager.start({ workDir: '/w', userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 46100 })
    await first
    // 2) 换轮 start：IIFE 走到 await stopActiveChild（kill 已调，exit 待微任务）
    const second = manager.start({ workDir: '/w2', userDataPath: ud })
    expect(forkRecords).toHaveLength(1) // 尚未 fork 新 child（先停旧）
    expect(forkRecords[0]!.child.killed).toBe(1)
    // 3) 并发 shutdown 落在 kill 等待窗内（exit 尚未让渡）——置 shuttingDown + 门
    const shuttingDown = manager.shutdown()
    // 4) 旧 child 退出 → 换轮 IIFE 恢复：修复前此处无条件清门 → child2 存活挂握手，
    //    直到 shutdown 预算兜底才以 EXIT 形态收场（≥5s）；修复后 fork 后检查命中即杀，
    //    SHUTDOWN 信封微任务级 reject
    const t0 = Date.now()
    forkRecords[0]!.child.emit('exit', 0)
    await expect(second).rejects.toThrow(/停机指令/)
    expect(Date.now() - t0).toBeLessThan(2_000) // 快速收口（修复前 ≥ settle 预算 5s）
    await flushMicrotasks()
    expect(forkRecords).toHaveLength(2) // 仅换轮 fork 一次
    expect(forkRecords[1]!.child.killed).toBeGreaterThanOrEqual(1) // 新 child fork 即杀（修复前存活）
    expect(manager.isRunning()).toBe(false)
    // 5) 停机链正常收口，无重启 fork（退出链上无第三个 child）
    await expect(shuttingDown).resolves.toBeUndefined()
    await flushMicrotasks()
    expect(forkRecords).toHaveLength(2)
  })

  it('对照：无并发 shutdown 的换轮（stopChild 后 start）停机门照常复位，新 child 正常握手', async () => {
    const { forkRecords, manager } = mkHarness()
    const ud = mkUserData()
    const first = manager.start({ workDir: '/w', userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 46101 })
    await first
    await manager.stopChild() // 主动停机门置位（无 shuttingDown 生命周期门）
    const second = manager.start({ workDir: '/w2', userDataPath: ud }) // 换轮放行（kill 标记 ≠ 停机门）
    forkRecords[1]!.child.emit('message', { type: 'ready', port: 46102 })
    await expect(second).resolves.toBe(46102) // 门已复位：fork 后检查不误杀
    expect(manager.isRunning()).toBe(true)
    await manager.stopChild()
  })
})

// R49-4（评审四十九轮）：stopChild 等 settleStarting 的短预算——与 shutdown 的 R44-12
// 形态对齐。病理链：崩溃自动重启（doRestart）的握手挂起时 bootstrap 重试触发
// stopChild，原裸 await 最坏 HANDSHAKE_TIMEOUT_MS(30s) + kill 升级 2s×2 ≈ 34s 无响应。
// 修复后预算内未收口即放弃等握手、对在途 fork 就地 kill（同 shutdown 收口原语）；
// 正常路径（握手毫秒级）语义不变（S1 既有用例覆盖）。
describe('R49-4: stopChild 短预算放弃挂起握手', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('崩溃重启链：重启握手挂起时 stopChild 在预算内收口（kill 在途 fork，不排程新重启）', async () => {
    const { forkRecords, manager } = mkHarness({
      shutdownSettleBudgetMs: 50,
      killWaitMs: 50,
      backoffMs: [0, 5000, 15000],
    })
    const ud = mkUserData()
    // 第一轮正常起来（后续崩溃走自动重启链）
    const first = manager.start({ workDir: '/w', userDataPath: ud })
    const c1 = forkRecords[0]!.child
    c1.emit('message', { type: 'ready', port: 46100 })
    await first
    // 崩溃 → backoff[0]=0 立即 doRestart：第二轮 fork 握手挂起（ready 永不到达）
    c1.emit('exit', 1)
    await vi.waitFor(() => expect(forkRecords.length).toBe(2), { timeout: 300 })
    const c2 = forkRecords[1]!.child
    // 修复前：此处裸 await settleStarting 卡满 30s 握手超时 + kill 升级 ≈ 34s
    const t0 = Date.now()
    await manager.stopChild()
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(5_000) // 预算(50ms) + kill 收口窗内返回
    expect(c2.killed).toBeGreaterThanOrEqual(1) // 在途重启 fork 被 kill 收口（不成孤儿）
    expect(c2.posted).not.toContainEqual({ type: 'shutdown' }) // 握手未完成，无优雅指令面
    // 主动停机门（同 shutdown 先置位）：kill 的 exit 不误触新重启（封 fork 数锚定）
    await sleep(40)
    expect(forkRecords.length).toBe(2)
    expect(manager.isRunning()).toBe(false)
    expect(manager.hasPendingRestart()).toBe(false) // 挂起重启不作废外溢
  })

  it('预算耗尽 kill 在途 fork → start 链按「启动途中退出」落定（reject 可接住，无未处理拒绝面）', async () => {
    const { forkRecords, manager } = mkHarness({ shutdownSettleBudgetMs: 50, killWaitMs: 50 })
    const ud = mkUserData()
    const starting = manager.start({ workDir: '/w', userDataPath: ud })
    const child = forkRecords[0]!.child
    // 握手挂起（ready 未发）时 stopChild：预算耗尽就地 kill
    await manager.stopChild()
    expect(child.killed).toBeGreaterThanOrEqual(1)
    // kill → exit → 启动途中退出 reject 形态（settleStarting 输掉分支后台 catch，双收口）
    await expect(starting).rejects.toThrow(ServerBootError)
    expect(forkRecords.length).toBe(1) // 停机门置位，无重启 fork
  })
})

// ── 重评2-P3-①（2026-09-09 全量重评 GLM-5.3）：restartPinned 复用在途 start 的
// reject 逃逸 ──
// 原实现 `if (starting) return starting` 把在途 start 的 rejection 原样透传——违反
// restartPinned「失败 resolve null」契约（其余路径均 catch 返 null），main 调用点无
// .catch 即落全局兜底日志。修复：复用值包一层 catch，失败 warn 留痕后 resolve null；
// 成功值原样透传（X-3 复用语义不变）。
describe('重评2-P3-①: restartPinned 复用在途 start 失败不逃逸 reject', () => {
  it('在途 start 握手失败（boot-error）→ restartPinned resolve null + warn 留痕（在途轮自身照常 reject）', async () => {
    const cap = mkLogCapture()
    // 大退避：start 失败后的自动重启排程不干扰断言（收尾 stopChild 一并取消）
    const { forkRecords, manager } = mkHarness({ logger: cap.logger, backoffMs: [999_000, 999_000, 999_000] })
    const ud = mkUserData()
    // 首启成功：建立钉住端口面（restartPinned 的复刻前提）
    const first = manager.start({ workDir: '/w', userDataPath: ud })
    forkRecords[0]!.child.emit('message', { type: 'ready', port: 45200 })
    await first
    // 二次 start 在途（ready 未发）：starting 通道被占用
    const second = manager.start({ workDir: '/w', userDataPath: ud })
    await vi.waitFor(() => expect(forkRecords.length).toBe(2))
    // 自愈恢复落在在途窗口内：复用在途轮（X-3 语义）——修复前 rp 会跟着在途轮 reject
    const rp = manager.restartPinned()
    // 在途轮握手失败（boot-error 信封 reject）
    forkRecords[1]!.child.emit('message', { type: 'boot-error', code: 'EADDRINUSE', message: 'x' })
    await expect(rp).resolves.toBeNull() // 修复后：对齐「失败 resolve null」契约
    await expect(second).rejects.toBeInstanceOf(ServerBootError) // 在途轮自身 reject 语义不变
    // 失败留痕：warn 一条含「自愈恢复在途 start 失败」（reject 不静默吞没）
    const warns = cap.lines.filter((l) => l.level === 'warn' && l.msg.includes('自愈恢复在途 start 失败'))
    expect(warns).toHaveLength(1)
    // 收尾：取消失败后排程的挂起重启（timer unref 不拖 worker，显式收口保净）
    await manager.stopChild()
  })
})

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})
