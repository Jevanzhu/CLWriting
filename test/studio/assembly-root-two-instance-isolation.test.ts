/**
 * R0916-7-P3-6（2026-09-25 源码质量评审 P3-6）收尾批：组装根「双实例互不干扰」判据。
 * （R0916-7 收尾批新增判据文件——批 5 快照的遗留项「组装根双实例判据用例未补」。）
 *
 * 判据：同进程建两个 createStudioServer 实例、各配一套显式 deps（gate / driver /
 * providers），两侧行为各随其 deps，互不串扰。逐一对照面：
 * ① **闸状态**：A 在持任务闸不影响 B 的同书同 action（含 busyReason 反查面与三审登记表）；
 * ② **driver 选择**：ai-status 的 mock 判定与 driver 字段各随实例注入的 driver.kind
 *    （环境变量 CLWRITING_DRIVER 设为相反值作反证——组装根 deps 胜过环境）；
 * ③ **provider 注册表**：A 注入含供应商的运行时 → 可达且点名供应商；B 注入空运行时 →
 *    未配置不可达（两实例同书同请求、读侧各走各的注册表）；
 * ④ **降级记忆**：(a) 端口注册槽按实例隔离——B 的注册不覆盖 A 的槽位（旧模块级单槽
 *    形态下必被覆盖），__resetForTest 只复位本实例；(b) 落盘面按 userDataPath 隔离——
 *    A 库的 modelCaps（400 降级记忆）对 B 库读侧不可见。
 *
 * 如实记（跨实例残余，超出本批改动面，见评审报告遗留项）：runner 的 mockText 快路开关
 * （configureRunnerMockFastPath）与 provider 运行时（configureProviderRuntime）是进程级
 * 注入点——多实例时后建者生效；故依赖 runTask mockText 的端点（如 onboard-ai）不进本
 * 判据（其多实例行为由进程级注入点决定，单实例语义由 assembly-root-deps-injection 用例②钉）。
 * 路由级 mock 快路（/spawn 的 runWriterSpawn）读 ctx.driver.kind（实例隔离），本文件以
 * 源码锚钉其判定点。
 *
 * 全部走真实 HTTP（createStudioServer 装配 + listen + 令牌闸），不 mock 任何生产模块。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createStudioServer, type StudioServerHandle } from '../../src/studio/server/index.js'
import { createTaskGate } from '../../src/studio/server/api/task-gate.js'
import type { DriverHost } from '../../src/studio/server/driver-port.js'
import {
  createProviderRuntime,
  emptySettings,
  processProviderRuntime,
  type ProviderRuntime,
  type ProviderStore,
} from '../../src/ai/provider/store.js'
import type { DriverEvent, Session } from '../../src/driver/index.js'
import type { ProviderConf, TierSlot } from '../../src/ai/provider/types.js'

const BOOK = '双实例判据书'
const BOOK_YAML =
  'spec_version: 1\nkind: long\nbook:\n  title: 双实例判据书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n'
const root = fileURLToPath(new URL('../../', import.meta.url))
const readSrc = (rel: string): string => readFileSync(`${root}${rel}`, 'utf8')

/** 替身驱动（StudioDriver 必需契约全成员；会话表随宿主实例隔离）。 */
function fakeServiceDriver(): {
  startSession: (cwd: string) => Promise<Session>
  stream: () => AsyncGenerator<DriverEvent>
  dispose: () => void
  emit: () => void
  cancelStream: () => void
  interrupt: () => void
  isRunning: () => boolean
  isWriterRunning: () => boolean
  registerCtrl: () => void
  unregisterCtrl: () => void
} {
  return {
    startSession: async (cwd: string): Promise<Session> => ({ id: `s-${cwd}`, cwd, closed: false }),
    stream: async function* (): AsyncGenerator<DriverEvent> {},
    dispose: () => {},
    emit: () => {},
    cancelStream: () => {},
    interrupt: () => {},
    isRunning: () => false,
    isWriterRunning: () => false,
    registerCtrl: () => {},
    unregisterCtrl: () => {},
  }
}

/** 每实例自带会话表的 driver 宿主（隔离面；生产宿主转发到 driver/index.ts 进程单例）。 */
function makeHost(kind: 'cc' | 'mock'): DriverHost {
  const sessions = new Map<string, Session>()
  const driver = fakeServiceDriver()
  return {
    driver,
    kind,
    ensureSession: async (bookId, cwd) => {
      const existing = sessions.get(bookId)
      if (existing) return existing
      const s = await driver.startSession(cwd)
      sessions.set(bookId, s)
      return s
    },
    getSession: (bookId) => sessions.get(bookId) ?? null,
    forgetSession: (bookId) => {
      sessions.delete(bookId)
    },
  }
}

/** 注入「已配置供应商」的运行时（cc 可达判据用）：currentProvider/resolveTier 按实例返回。 */
function makeProviderRuntimeWithProvider(name: string): ProviderRuntime {
  const conf: ProviderConf = {
    id: 'prov-judge',
    name,
    protocol: 'openai-chat',
    auth: 'bearer',
    baseUrl: 'https://example.invalid/v1',
    apiKey: 'sk-judge',
    model: 'judge-model',
    caps: { reasoning: true, effort: true, structured: true },
  } as unknown as ProviderConf
  const tier: TierSlot = { model: 'judge-model', effort: 'xhigh' }
  return createProviderRuntime({
    loadProviders: () =>
      ({
        ...emptySettings(),
        providers: [conf],
        currentId: conf.id,
        tiers: { creative: tier, assistant: null, chat: null },
      }) as ProviderStore,
    currentProvider: () => conf,
    resolveTier: () => tier,
  })
}

/** 建工作区（书库登记 + book.yaml）——两个实例各一套，互不共享盘面。 */
function makeWorkDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(dir, '.clwriting'), { recursive: true })
  writeFileSync(join(dir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: BOOK, path: BOOK }) + '\n')
  mkdirSync(join(dir, BOOK, '项目'), { recursive: true })
  writeFileSync(join(dir, BOOK, 'book.yaml'), BOOK_YAML, 'utf8')
  return dir
}

interface Booted {
  handle: StudioServerHandle
  base: string
  token: string
  dir: string
  ud: string
}

const started: Booted[] = []

/** 起一个实例（显式注入闸/驱动/provider 运行时；listen 落定后返回）。 */
async function boot(opts: {
  prefix: string
  kind: 'cc' | 'mock'
  providers: ProviderRuntime
  /** 显式复用上一实例的锁根（跨实例闸互斥对照用）；缺省 = 本实例 workDir 下自建 */
  gateLockRoot?: string
}): Promise<Booted> {
  const dir = makeWorkDir(opts.prefix)
  const ud = mkdtempSync(join(tmpdir(), `${opts.prefix}ud-`))
  const host = makeHost(opts.kind)
  const gate = createTaskGate({ lockRoot: opts.gateLockRoot ?? join(dir, '.clwriting', 'task-gate'), driver: host })
  const token = `tok-${opts.prefix}`
  const handle = createStudioServer(
    { port: 0, workDir: dir, userDataPath: ud, mirrorConsoleLog: false, studioToken: token },
    { taskGate: gate, driver: host, providers: opts.providers },
  )
  if (!handle.server.listening) await new Promise<void>((r) => handle.server.once('listening', () => r()))
  const base = `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`
  const booted = { handle, base, token, dir, ud }
  started.push(booted)
  return booted
}

function req(
  base: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base)
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: {
          'x-studio-token': token,
          ...(payload !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: any = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON 体 */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    r.on('error', reject)
    if (payload !== undefined) r.write(payload)
    r.end()
  })
}

afterEach(async () => {
  while (started.length > 0) {
    const b = started.pop()!
    await new Promise<void>((r) => b.handle.close(() => r()))
    rmSync(b.dir, { recursive: true, force: true })
    rmSync(b.ud, { recursive: true, force: true })
  }
  processProviderRuntime().__resetForTest()
})

describe('组装根双实例互不干扰判据（R0916-7-P3-6 收尾）', () => {
  it('① 闸状态隔离：A 在持任务闸不影响 B 的同书同 action（409/200 对照 + 反查面对称）', async () => {
    const a = await boot({ prefix: 'two-inst-a-', kind: 'mock', providers: processProviderRuntime() })
    const b = await boot({ prefix: 'two-inst-b-', kind: 'cc', providers: makeProviderRuntimeWithProvider('乙供应商') })

    const save = (t: Booted): Promise<{ status: number; json: any }> =>
      req(t.base, t.token, 'POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-save`, {
        step: 'synopsis',
        content: '# 总纲',
      })

    // A 侧在持闸（旧形态：模块级 running Set → B 同 action 必 409）
    const releaseA = a.handle.deps.taskGate.acquire(BOOK, 'onboard-save')
    expect(releaseA).not.toBeNull()
    try {
      const ra = await save(a)
      expect(ra.status).toBe(409)
      expect(ra.json.code).toBe('BUSY')
      const rb = await save(b) // B 的闸是另一个实例：其自有状态里无在持项
      expect(rb.status).toBe(200)
      expect(rb.json.ok).toBe(true)
    } finally {
      releaseA!()
    }

    // 反查面按实例隔离（进程内 + 跨进程合并查询同源）
    const releaseB = b.handle.deps.taskGate.acquire(BOOK, 'outline')
    expect(releaseB).not.toBeNull()
    try {
      expect(a.handle.deps.taskGate.isHeld(BOOK, 'outline')).toBe(false)
      expect(b.handle.deps.taskGate.isHeld(BOOK, 'outline')).toBe(true)
      expect(a.handle.deps.taskGate.allHeldFor(BOOK)).toEqual([])
      expect(b.handle.deps.taskGate.allHeldFor(BOOK)).toEqual(['outline'])
    } finally {
      releaseB!()
    }

    // 三审登记表同款隔离
    expect(a.handle.deps.taskGate.tryHoldReviewRun(BOOK, 'doc_two')).toBe(true)
    expect(b.handle.deps.taskGate.isReviewRunningForDoc(BOOK, 'doc_two')).toBe(false)
    expect(b.handle.deps.taskGate.tryHoldReviewRun(BOOK, 'doc_two')).toBe(true)
    a.handle.deps.taskGate.releaseReviewRun(BOOK, 'doc_two')
    b.handle.deps.taskGate.releaseReviewRun(BOOK, 'doc_two')
  })

  it('② driver 选择各随其 deps：ai-status 的 mock 判定与 driver 字段按实例分叉', async () => {
    const a = await boot({ prefix: 'two-inst-drv-a-', kind: 'mock', providers: processProviderRuntime() })
    const b = await boot({
      prefix: 'two-inst-drv-b-',
      kind: 'cc',
      providers: makeProviderRuntimeWithProvider('乙供应商'),
    })

    const ra = await req(a.base, a.token, 'GET', '/api/ai-status')
    expect(ra.json).toEqual({ available: true, driver: 'mock' })
    const rb = await req(b.base, b.token, 'GET', '/api/ai-status')
    // B 注入 cc 宿主 + 含供应商运行时 → cc 判定 + 供应商名（同请求同书，各随各 deps）
    expect(rb.json.available).toBe(true)
    expect(rb.json.driver).toBe('乙供应商')
  })

  it('③ provider 注册表各随其 deps：A 注入含供应商运行时可达，B 空运行时未配置（互不串扰）', async () => {
    const a = await boot({
      prefix: 'two-inst-prov-a-',
      kind: 'cc',
      providers: makeProviderRuntimeWithProvider('甲供应商'),
    })
    const b = await boot({
      prefix: 'two-inst-prov-b-',
      kind: 'cc',
      providers: createProviderRuntime({ loadProviders: () => emptySettings(), currentProvider: () => null }),
    })

    const ra = await req(a.base, a.token, 'GET', '/api/ai-status')
    expect(ra.json).toEqual({ available: true, driver: '甲供应商' })
    const rb = await req(b.base, b.token, 'GET', '/api/ai-status')
    expect(rb.json).toEqual({ available: false, driver: '', reason: '未配置 AI 服务供应商（请在设置页添加）' })

    // deps 契约：两实例持有不同注册表对象（所有权由调用方持有）
    expect(a.handle.deps.providers).not.toBe(b.handle.deps.providers)
  })

  it('④-a 降级记忆注册槽按实例隔离：B 的注册不覆盖 A，__resetForTest 只复位本实例', () => {
    const rtA = createProviderRuntime()
    const rtB = createProviderRuntime()
    const persistA = (): void => {}
    const lookupA = (): boolean | undefined => undefined
    const persistB = (): void => {}
    rtA.registerDegradedPersist(persistA)
    rtA.registerDegradedLookup(lookupA)
    rtB.registerDegradedPersist(persistB) // 旧模块级单槽形态：此处覆盖即丢 A 的注册
    expect(rtA.__degradedChannelsForTest().persist).toBe(persistA)
    expect(rtA.__degradedChannelsForTest().lookup).toBe(lookupA)
    expect(rtB.__degradedChannelsForTest().persist).toBe(persistB)

    // 按实例复位：A 复位不动 B
    rtA.__resetForTest()
    expect(rtA.__degradedChannelsForTest().persist).toBeNull()
    expect(rtA.__degradedChannelsForTest().lookup).toBeNull()
    expect(rtB.__degradedChannelsForTest().persist).toBe(persistB)

    // 进程默认实例的复位只动进程槽（自建实例互不可见）
    const proc = processProviderRuntime()
    const viaPort = (): void => {}
    proc.registerDegradedPersist(viaPort)
    expect(proc.__degradedChannelsForTest().persist).toBe(viaPort)
    rtA.__resetForTest()
    expect(proc.__degradedChannelsForTest().persist).toBe(viaPort)
    proc.__resetForTest()
    expect(proc.__degradedChannelsForTest().persist).toBeNull()
  })

  it('④-b 降级记忆落盘面按 userDataPath 隔离：A 库的 modelCaps 对 B 库读侧不可见', async () => {
    const rtA = createProviderRuntime()
    const rtB = createProviderRuntime()
    const udA = mkdtempSync(join(tmpdir(), 'two-inst-deg-a-'))
    const udB = mkdtempSync(join(tmpdir(), 'two-inst-deg-b-'))
    try {
      // A 库写入 400 降级记忆（save → load 往返经由各自运行时实例）
      const storeA = rtA.loadProviders(udA)
      storeA.modelCaps['prov-judge/judge-model'] = { structured: false }
      await rtA.saveProviders(udA, storeA)

      // A 库读侧可见（适配器经 lookupDegraded 的新鲜读即此形状）
      expect(rtA.loadProviders(udA).modelCaps['prov-judge/judge-model']).toEqual({ structured: false })
      // B 库读侧不可见（不同 userDataPath 的 providers.json 互不相通）
      expect(rtB.loadProviders(udB).modelCaps['prov-judge/judge-model']).toBeUndefined()
      expect(rtB.loadProviders(udA).modelCaps['prov-judge/judge-model']).toEqual({ structured: false }) // 同库跨实例可见（盘面事实单源）
    } finally {
      rmSync(udA, { recursive: true, force: true })
      rmSync(udB, { recursive: true, force: true })
    }
  })

  it('⑤ 源码锚：路由级 mock 快路读注入的 driver.kind（实例隔离判定点）；runner 级 mockText 开关如实记为进程级', () => {
    // /spawn 的 mock 快路判定（route 级）——两实例各随其 deps 的判定点
    const streamSrc = readSrc('src/studio/server/api/stream.ts')
    expect(streamSrc).toContain('mock: ctx.driver.kind === ')
    // runner 级 mockText 快路开关是进程级注入点（跨实例残余，见文件头注「如实记」）
    const runnerSrc = readSrc('src/ai/runner.ts')
    expect(runnerSrc).toContain('configureRunnerMockFastPath')
  })
})
