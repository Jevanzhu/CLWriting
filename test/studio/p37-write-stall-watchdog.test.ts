/**
 * 重评-P3-7（2026-09-09 全量代码重评）回归：self-heal（/auto-write）与 spawn 长任务闸
 * 静默挂死兜底 watchdog（进度复位式 + 两段式处置）。
 *
 * 修复前：编排器内部 await 永不 settle → isSelfHealRunning / isSpawnRunning 永真 →
 * 本书全部写端点 + 删书/改名永久 409，仅重启可解（范式参照 rag.ts R46-15 watchdog，
 * 但改进度复位式计时，批量连写合法长跑不误伤）。
 *
 * 用例矩阵（全部 vi.useFakeTimers 推进，不真实等待）：
 * ① 闸占用 + 无事件推进至阈值 → 自动中止被调用；宽限内闸释放 → 无强释放；
 * ② 宽限期满闸仍占 → 强释放（清登记 + warn 留痕）+ 重试不再 409；
 * ③ 进度事件复位——事件间隔小于阈值时连续推进不触发，静默超阈值才触发；
 * ④ 正常完成 → 计时器清理无泄漏（多次连续任务后旧 timer 不再触发）。
 *
 * self-heal 走端点级（vi.mock 假编排器，经 HTTP 触发真实 handler 接线）；
 * spawn 走 runWriterSpawn 直调（vi.mock 假 runSpec，闸用真实 spawn-registry）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServerSafe } from '../helpers/safe-port.js'
import { log } from '../../src/log/index.js'
import type { StudioDriver, Session, DriverEvent } from '../../src/driver/index.js'
import {
  ORCH_STALL_WATCHDOG_MS,
  ORCH_STALL_GRACE_MS,
  runWriterSpawn,
} from '../../src/studio/server/api/stream.js'
import { holdSpawnGate, releaseSpawnGate, isSpawnRunning } from '../../src/ai/orchestrate/spawn-registry.js'
// 被测模块的 mock 面（下方 vi.mock 生效后，这些导入即假件）
// R1010c-SRV-P3-1：stream.ts 强释放改调生产命名导出 forceReleaseSelfHealRunning，
// 本测试的观测面随之从测试别名 __setSelfHealRunningForTest 切到新导出
import {
  abortSelfHeal,
  isSelfHealRunning,
  forceReleaseSelfHealRunning,
} from '../../src/ai/orchestrate/self-heal.js'

// ---- 假 self-heal 编排器状态（vi.hoisted 保证 mock 工厂先行可用）----
const shFake = vi.hoisted(() => {
  return {
    /** never = 挂死不收尾；settle-on-abort = 中止即正常收尾放闸；immediate = 立即收尾 */
    mode: 'never' as 'never' | 'settle-on-abort' | 'immediate',
    running: new Map<string, true>(),
    settleFns: [] as Array<() => void>,
    /** 强释放观测：forceReleaseSelfHealRunning(name) 的 name 列表 */
    forced: [] as string[],
    /** 端点传入的 opts（断言 driver 包装 / mainSession 用） */
    lastOpts: null as {
      driver: { emit?: (s: unknown, ev: unknown) => void }
      mainSession: unknown
      register?: (c: AbortController) => void
    } | null,
  }
})

vi.mock('../../src/ai/orchestrate/self-heal.js', () => ({
  runSelfHeal: vi.fn((opts: NonNullable<typeof shFake.lastOpts> & { bookName: string; chapter: number }) => {
    shFake.lastOpts = opts
    shFake.running.set(opts.bookName, true)
    return new Promise((resolve) => {
      const settle = (): void => {
        shFake.running.delete(opts.bookName)
        resolve({ outcome: 'aborted', chapter: opts.chapter, docId: 'd', path: 'p', attempts: 0 })
      }
      shFake.settleFns.push(settle)
      if (shFake.mode === 'immediate') settle()
    })
  }),
  abortSelfHeal: vi.fn((name: string): boolean => {
    if (!shFake.running.has(name)) return false
    if (shFake.mode === 'settle-on-abort') {
      for (const s of shFake.settleFns.splice(0)) s()
    }
    return true
  }),
  isSelfHealRunning: (name: string): boolean => shFake.running.has(name),
  isChatEmbeddedSelfHealRunning: (): boolean => false,
  waitSelfHealSettled: async (): Promise<void> => {},
  // R1010c-SRV-P3-1：生产命名导出（stream.ts 强释放消费点）；测试别名 __setSelfHealRunningForTest
  // 在真实模块里 off 分支转调本函数，假件同语义（清登记 + 观测）保留一份防其他消费方回引
  forceReleaseSelfHealRunning: vi.fn((name: string): void => {
    shFake.running.delete(name)
    shFake.forced.push(name)
  }),
  __setSelfHealRunningForTest: vi.fn((name: string, on: boolean): void => {
    if (on) shFake.running.set(name, true)
    else {
      shFake.running.delete(name)
      shFake.forced.push(name)
    }
  }),
}))

// ---- 假 runSpec（spawn 挂死控制；self-heal 已整体 mock，不触达）----
const specFake = vi.hoisted(() => ({
  mode: 'never' as 'never' | 'settle-on-abort' | 'immediate',
  registeredCtrl: null as AbortController | null,
}))
vi.mock('../../src/ai/tasks/spec.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/tasks/spec.js')>()
  return {
    ...orig,
    runSpec: (_spec: unknown, opts: { register?: (c: AbortController) => void }) => {
      const ctrl = new AbortController()
      specFake.registeredCtrl = ctrl
      opts.register?.(ctrl)
      return new Promise((resolve) => {
        const failAborted = (): void => resolve({ ok: false, error: '已中断', code: 'ABORTED' })
        if (specFake.mode === 'immediate') {
          failAborted()
          return
        }
        if (specFake.mode === 'settle-on-abort') {
          ctrl.signal.addEventListener('abort', failAborted, { once: true })
        }
        // never：不观察 abort 信号 → 真挂死（中止也无法使其 settle）
      })
    },
  }
})

const BOOK = 'P3挂起书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
const prevDriver = process.env['CLWRITING_DRIVER']
let warnSpy: ReturnType<typeof vi.spyOn>

/** node:http 请求（fetch/undici 的超时定时器在假 timer 下不可控，用裸 http 规避） */
function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const u = new URL(baseUrl)
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: 'POST',
        headers: {
          'x-studio-token': token,
          origin: baseUrl,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
        res.on('end', () => {
          let json: Record<string, unknown> = {}
          try {
            json = JSON.parse(data) as Record<string, unknown>
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

beforeAll(async () => {
  process.env['CLWRITING_DRIVER'] = 'mock' // ensureSession 无 provider 可建会话
  workDir = mkdtempSync(join(tmpdir(), 'clw-p37-watchdog-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    ['spec_version: 1', 'book:', `  title: ${BOOK}`, '  genre: 玄幻'].join('\n') + '\n',
    'utf-8',
  )
  mkdirSync(join(workDir, 'userData'), { recursive: true })
  server = await startServerSafe({ port: 0, workDir, userDataPath: join(workDir, 'userData') })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await (await fetch(`${baseUrl}/api/boot`)).json()
  token = (boot as { token: string }).token
})

afterAll(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((r) => server!.close(() => r()))
  }
  rmSync(workDir, { recursive: true, force: true })
  if (prevDriver === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = prevDriver
})

beforeEach(() => {
  shFake.mode = 'never'
  shFake.running.clear()
  shFake.settleFns.length = 0
  shFake.forced.length = 0
  shFake.lastOpts = null
  specFake.mode = 'never'
  specFake.registeredCtrl = null
  vi.mocked(abortSelfHeal).mockClear()
  vi.mocked(forceReleaseSelfHealRunning).mockClear()
  warnSpy = vi.spyOn(log, 'warn')
})

afterEach(() => {
  vi.useRealTimers()
  releaseSpawnGate(BOOK) // 兜底（幂等）
  warnSpy.mockRestore()
})

const hadWarn = (frag: string): boolean => warnSpy.mock.calls.some((c) => String(c[1]).includes(frag))

describe('重评-P3-7：/auto-write（self-heal）静默挂死 watchdog', () => {
  it('① 静默至阈值 → 自动中止被调用；宽限内闸释放 → 无强释放', async () => {
    shFake.mode = 'settle-on-abort'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/auto-write`, { chapter: 1 })
    expect(r.status).toBe(200)

    await vi.advanceTimersByTimeAsync(ORCH_STALL_WATCHDOG_MS)
    expect(vi.mocked(abortSelfHeal)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(abortSelfHeal)).toHaveBeenCalledWith(BOOK)
    expect(hadWarn('疑似编排器挂起')).toBe(true)
    expect(hadWarn('已自动中止')).toBe(true)
    // 假编排器收到中止即正常收尾放闸（真实链 = abort 信号被观察到 → finally 放闸）
    expect(isSelfHealRunning(BOOK)).toBe(false)

    await vi.advanceTimersByTimeAsync(ORCH_STALL_GRACE_MS + 5_000)
    // 宽限内已收尾 → 不强释放：登记清理导出未被调用 + 无强释放留痕（「疑似挂死」为二段专属片段）
    expect(vi.mocked(forceReleaseSelfHealRunning)).not.toHaveBeenCalled()
    expect(hadWarn('疑似挂死')).toBe(false)
  })

  it('② 宽限期满闸仍占 → 强释放（清登记 + warn 留痕）+ 重试不再 409', async () => {
    shFake.mode = 'never' // 中止也无法使其 settle（真挂死）
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const r1 = await post(`/api/books/${encodeURIComponent(BOOK)}/auto-write`, { chapter: 1 })
    expect(r1.status).toBe(200)

    await vi.advanceTimersByTimeAsync(ORCH_STALL_WATCHDOG_MS)
    expect(vi.mocked(abortSelfHeal)).toHaveBeenCalledTimes(1)
    expect(isSelfHealRunning(BOOK)).toBe(true) // 挂死：中止后闸仍被占

    await vi.advanceTimersByTimeAsync(ORCH_STALL_GRACE_MS + 5_000)
    // 二段强释放：清 ai 层登记 + warn 留痕（R1010c-SRV-P3-1：单参生产签名）
    expect(vi.mocked(forceReleaseSelfHealRunning)).toHaveBeenCalledWith(BOOK)
    expect(shFake.forced).toContain(BOOK)
    expect(hadWarn('疑似挂死')).toBe(true)

    // 行为验证：闸已放，重试不再 409（修复前此处永久 409 仅重启可解）
    const r2 = await post(`/api/books/${encodeURIComponent(BOOK)}/auto-write`, { chapter: 2 })
    expect(r2.status).toBe(200)
  })

  it('③ 进度事件复位——事件间隔小于阈值时连续推进不触发，静默超阈值才触发', async () => {
    shFake.mode = 'never'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/auto-write`, { chapter: 1 })
    expect(r.status).toBe(200)
    const opts = shFake.lastOpts!
    expect(opts.driver.emit).toBeDefined()

    // 每 15min 一个进度事件（批量连写的合法推进节奏），累计 45min 不触发（15 < 20）
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(15 * 60_000)
      opts.driver.emit!(opts.mainSession, { type: 'self_heal_phase', phase: 'drafting' } as DriverEvent)
    }
    await vi.advanceTimersByTimeAsync(ORCH_STALL_WATCHDOG_MS - 60_000) // 距上次事件 19min
    expect(vi.mocked(abortSelfHeal)).not.toHaveBeenCalled()

    // 静默跨过阈值（距上次事件 19min + 2min > 20min）→ 触发
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1_000)
    expect(vi.mocked(abortSelfHeal)).toHaveBeenCalledTimes(1)
  })

  it('④ 正常完成 → 计时器清理无泄漏（多次连续任务旧 timer 不再触发）', async () => {
    shFake.mode = 'immediate'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    for (let round = 0; round < 2; round++) {
      const r = await post(`/api/books/${encodeURIComponent(BOOK)}/auto-write`, { chapter: round + 1 })
      expect(r.status).toBe(200)
      expect(isSelfHealRunning(BOOK)).toBe(false) // 已正常收尾放闸
      await vi.advanceTimersByTimeAsync(ORCH_STALL_WATCHDOG_MS * 2)
      // 上一轮的 stall timer 已在终态 finally 撤表：两轮各 2×阈值推进均无任何触发
      expect(vi.mocked(abortSelfHeal)).not.toHaveBeenCalled()
      expect(vi.mocked(forceReleaseSelfHealRunning)).not.toHaveBeenCalled()
      expect(hadWarn('疑似编排器挂起')).toBe(false)
    }
  })
})

describe('重评-P3-7：spawn 静默挂死 watchdog（runWriterSpawn 直调，闸用真实 registry）', () => {
  function makeFakeDriver(): {
    startSession: ReturnType<typeof vi.fn>
    stream: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    emit: ReturnType<typeof vi.fn>
    registerCtrl: ReturnType<typeof vi.fn>
    unregisterCtrl: ReturnType<typeof vi.fn>
    interrupt: ReturnType<typeof vi.fn>
  } {
    return {
      startSession: vi.fn(),
      stream: vi.fn(),
      dispose: vi.fn(),
      emit: vi.fn(),
      registerCtrl: vi.fn(),
      unregisterCtrl: vi.fn(),
      interrupt: vi.fn(),
    }
  }

  /** 构造与路由同构的 fire-and-forget（闸 hold/release 归属与生产 /spawn 一致） */
  function launchSpawn(driver: StudioDriver, session: Session): Promise<void> {
    holdSpawnGate(BOOK)
    return runWriterSpawn({
      driver,
      mainSession: session,
      bookName: BOOK,
      userDataPath: null,
      bookRoot: join(workDir, BOOK),
      prompt: '写第一章',
      role: 'writer',
      promptFiles: [],
    }).finally(() => releaseSpawnGate(BOOK))
  }

  it('① 静默至阈值 → 在册 ctrl 被中止；宽限内闸释放 → 无强释放', async () => {
    // runWriterSpawn 的 mock 快路不看 driver、只在 CLWRITING_DRIVER=mock 时短路——直调须临时脱离 mock
    delete process.env['CLWRITING_DRIVER']
    specFake.mode = 'settle-on-abort'
    const driver = makeFakeDriver()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const p = launchSpawn(driver as unknown as StudioDriver, {} as Session)
    await vi.advanceTimersByTimeAsync(ORCH_STALL_WATCHDOG_MS)
    // 一段：abort 在册 ctrl（/interrupt 对 spawn 的动作）——假 runSpec 收到 abort 即收尾
    expect(specFake.registeredCtrl?.signal.aborted).toBe(true)
    expect(hadWarn('疑似编排器挂起')).toBe(true)
    await p // runSpec 收尾 → runWriterSpawn 终态 finally → 闸释放
    expect(isSpawnRunning(BOOK)).toBe(false)
    await vi.advanceTimersByTimeAsync(ORCH_STALL_GRACE_MS + 5_000)
    // 宽限内已收尾 → 无强释放
    expect(driver.emit).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'warning' }))
    expect(hadWarn('疑似挂死')).toBe(false)
  })

  it('② 宽限期满闸仍占 → 强释放（放闸 + warning 事件 + warn 留痕）', async () => {
    delete process.env['CLWRITING_DRIVER']
    specFake.mode = 'never'
    const driver = makeFakeDriver()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const p = launchSpawn(driver as unknown as StudioDriver, {} as Session)
    const guard = p.catch(() => {}) // 挂死 promise 不产生 unhandled rejection
    await vi.advanceTimersByTimeAsync(ORCH_STALL_WATCHDOG_MS)
    expect(specFake.registeredCtrl?.signal.aborted).toBe(true)
    expect(isSpawnRunning(BOOK)).toBe(true) // 挂死：闸仍被占
    await vi.advanceTimersByTimeAsync(ORCH_STALL_GRACE_MS + 5_000)
    // 二段强释放：放闸 + ctrl 注销 + 前端 warning + warn 留痕（底层任务未中断，迟到结果按迟到覆盖口径）
    expect(isSpawnRunning(BOOK)).toBe(false)
    expect(driver.unregisterCtrl).toHaveBeenCalled()
    expect(driver.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'warning', message: expect.stringContaining('强制释放') }),
    )
    expect(hadWarn('疑似挂死')).toBe(true)
    void guard
  })

  it('④ 正常完成 → 计时器清理无泄漏', async () => {
    delete process.env['CLWRITING_DRIVER']
    specFake.mode = 'immediate'
    const driver = makeFakeDriver()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const p = launchSpawn(driver as unknown as StudioDriver, {} as Session)
    await p
    expect(isSpawnRunning(BOOK)).toBe(false)
    await vi.advanceTimersByTimeAsync(ORCH_STALL_WATCHDOG_MS * 2)
    expect(specFake.registeredCtrl?.signal.aborted).not.toBe(true)
    expect(hadWarn('疑似编排器挂起')).toBe(false)
    expect(hadWarn('疑似挂死')).toBe(false)
  })
})
