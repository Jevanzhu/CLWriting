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
 *
 * 拆分沿革（R0916-5b，2026-09-16）：原 1430 行单体按 describe 域拆出 5 个拆分件——
 * server-manager-token（studioToken 持久化与 env 剥除面）/ server-manager-stop-shutdown
 * （stopChild·R28-21·E-1·批 U2 shutdown 指令停机基础域）/ server-manager-shutdown-races
 * （S1/B-7/R44-12/重评-P3-8/R49-4/R0912-3 #34·#35 停机竞态族）/ server-manager-restart
 * （批 U3 崩溃退避自动重启 + 重评2-P3-① restartPinned）/ server-manager-stdio（批 U2
 * stdio 转发/forwardLogLine/D1/R50-A-4 日志泵域），用例整块原样搬移、用例总数（62）
 * 与断言零变化；共享假件与装置（FakeChild/mkHarness/mkLogCapture/mkUserData/flush 族/
 * argValue/envToken/UUID_RE）抽 server-manager-fixtures.ts 供各件复用。本残核保留
 * start 入口两域（fork 参数与握手 / 并发 start 防护）——git 历史锚点文件。
 */
import { describe, it, expect, afterAll } from 'vitest'
import { ServerBootError, STUDIO_SERVICE_NAME } from '../../src/desktop/server-manager.js'
import {
  mkHarness,
  mkUserData,
  mkLogCapture,
  flushMicrotasks,
  argValue,
  envToken,
  UUID_RE,
  cleanupServerManagerTmpDirs,
} from './server-manager-fixtures.js'

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

afterAll(() => {
  cleanupServerManagerTmpDirs()
})
