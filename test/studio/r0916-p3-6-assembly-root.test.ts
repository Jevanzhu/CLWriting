/**
 * R0916-7-P3-6（2026-09-25 源码质量评审 P3-6）：组装根注入回归门。
 *
 * 三条判据（对应评审「模块级单例多 / 测试缝渗入生产代码」的收口）：
 * ① **双实例互不干扰**（核心判据）：同进程两个 createStudioServer 实例各持自己的闸/驱动/
 *    provider 运行时时，实例 A 的在持任务闸不影响实例 B 的同一书同一 action（旧形态
 *    「模块级 running Set + 模块级锁根」下 B 必 409）。
 * ② **mock driver 只在组装根选择**：mock 快路与 driver 实现都由 deps.driver 决定；
 *    环境变量 CLWRITING_DRIVER 不再参与（runner.ts 源码锚 + 行为锚两侧钉）。
 * ③ **必需能力缺失在编译期不可表达**：@ts-expect-error 探针（DriverCore 缺任一法即
 *    不可作为 deps.driver 注入；`npm run typecheck` 是判据——指令未命中会报未使用错）。
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
import { createTaskGate, type TaskGate } from '../../src/studio/server/api/task-gate.js'
import type { DriverHost, ServiceDriver } from '../../src/studio/server/driver-port.js'
import { createProviderRuntime, emptySettings, type ProviderRuntime } from '../../src/ai/provider/store.js'
import type { DriverEvent, Session } from '../../src/driver/index.js'
import { settingsCache } from '../../src/studio/server/api/settings.js'

const BOOK = '双装配书'
const BOOK_YAML = 'spec_version: 1\nkind: long\nbook:\n  title: 双装配书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n'
const root = fileURLToPath(new URL('../../', import.meta.url))
const readSrc = (rel: string): string => readFileSync(`${root}${rel}`, 'utf8')

/** 替身驱动能力面（必需能力齐全——缺能力的形态由用例③的编译期探针表达）。 */
function fakeServiceDriver(): ServiceDriver {
  return {
    startSession: async (cwd: string): Promise<Session> => ({ id: `s-${cwd}`, cwd, closed: false }),
    stream: async function* (): AsyncGenerator<DriverEvent> {},
    dispose: () => {},
    emit: () => {},
    cancelStream: () => {},
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

/** 空 provider 运行时（无供应商 → 真实路径必 NO_PROVIDER；组装根注入面契约判据）。 */
function makeProviders(): ProviderRuntime {
  return createProviderRuntime({
    loadProviders: () => emptySettings(),
    currentProvider: () => null,
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
  gate: TaskGate
  host: DriverHost
  providers: ProviderRuntime
}

const started: Booted[] = []

/** 起一个实例（显式注入闸/驱动/provider 运行时；listen 落定后返回）。 */
async function boot(kind: 'cc' | 'mock', prefix: string): Promise<Booted> {
  const dir = makeWorkDir(prefix)
  const ud = mkdtempSync(join(tmpdir(), `${prefix}ud-`))
  const host = makeHost(kind)
  const providers = makeProviders()
  const gate = createTaskGate({ lockRoot: join(dir, '.clwriting', 'task-gate'), driver: host })
  const token = `tok-${prefix}`
  const handle = createStudioServer(
    { port: 0, workDir: dir, userDataPath: ud, mirrorConsoleLog: false, studioToken: token },
    { taskGate: gate, driver: host, providers },
  )
  if (!handle.server.listening) await new Promise<void>((r) => handle.server.once('listening', () => r()))
  const base = `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`
  const booted = { handle, base, token, dir, ud, gate, host, providers }
  started.push(booted)
  return booted
}

function req(base: string, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
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
          ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
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
})

describe('R0916-7-P3-6：组装根注入（deps 契约 + 双实例隔离）', () => {
  it('① 双实例互不干扰：A 在持闸不影响 B 的同一书同一 action（核心判据）', async () => {
    const a = await boot('mock', 'p36-a-')
    const b = await boot('cc', 'p36-b-')

    // deps 契约：组装根解析结果如实回传（所有权：由调用方创建、由调用方持有）
    expect(a.handle.deps.taskGate).toBe(a.gate)
    expect(a.handle.deps.driver).toBe(a.host)
    expect(a.handle.deps.providers).toBe(a.providers)
    expect(a.handle.deps.taskGate).not.toBe(b.handle.deps.taskGate)
    expect(a.handle.deps.driver.kind).toBe('mock')
    expect(b.handle.deps.driver.kind).toBe('cc')

    const save = (t: Booted): Promise<{ status: number; json: any }> =>
      req(t.base, t.token, 'POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-save`, {
        step: 'synopsis',
        content: '# 总纲',
      })

    // A 侧在持任务闸（旧形态：模块级 running Set → B 同 action 必 409）
    const releaseA = a.gate.acquire(BOOK, 'onboard-save')
    expect(releaseA).not.toBeNull()
    try {
      const ra = await save(a)
      expect(ra.status).toBe(409)
      expect(ra.json.code).toBe('BUSY')
      const rb = await save(b) // B 的闸是另一个实例：其自有状态里无在持项
      expect(rb.status).toBe(200)
      expect(rb.json.ok).toBe(true)
      // 反查面也按实例隔离
      expect(a.gate.isHeld(BOOK, 'onboard-save')).toBe(true)
      expect(b.gate.isHeld(BOOK, 'onboard-save')).toBe(false)
    } finally {
      releaseA!()
    }

    // 反向：B 在持不影响 A（对称判据）
    const releaseB = b.gate.acquire(BOOK, 'onboard-save')
    expect(releaseB).not.toBeNull()
    try {
      expect((await save(b)).status).toBe(409)
      expect((await save(a)).status).toBe(200)
    } finally {
      releaseB!()
    }

    // review-run 登记表同款隔离（原模块级 __setReviewRunning 一族）
    expect(a.gate.tryHoldReviewRun(BOOK, 'doc_x')).toBe(true)
    expect(a.gate.isReviewRunningForDoc(BOOK, 'doc_x')).toBe(true)
    expect(b.gate.isReviewRunningForDoc(BOOK, 'doc_x')).toBe(false)
    expect(b.gate.tryHoldReviewRun(BOOK, 'doc_x')).toBe(true) // B 侧同一 doc 仍可持有
    a.gate.releaseReviewRun(BOOK, 'doc_x')
    b.gate.releaseReviewRun(BOOK, 'doc_x')
  })

  it('①-b 缺省（不传 deps）也按实例建闸：两个默认实例互不干扰', async () => {
    const a = makeWorkDir('p36-def-a-')
    const b = makeWorkDir('p36-def-b-')
    const ha = createStudioServer({ port: 0, workDir: a, mirrorConsoleLog: false, studioToken: 'tok-da' })
    const hb = createStudioServer({ port: 0, workDir: b, mirrorConsoleLog: false, studioToken: 'tok-db' })
    try {
      expect(ha.deps.taskGate).not.toBe(hb.deps.taskGate) // 默认不共享进程单例
      const release = ha.deps.taskGate.acquire(BOOK, 'rewrite')
      try {
        expect(ha.deps.taskGate.isHeld(BOOK, 'rewrite')).toBe(true)
        expect(hb.deps.taskGate.isHeld(BOOK, 'rewrite')).toBe(false)
      } finally {
        release!()
      }
    } finally {
      await new Promise<void>((r) => ha.close(() => r()))
      await new Promise<void>((r) => hb.close(() => r()))
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  it('② mock 快路由注入的 driver 决定（且生产 runner 不读 CLWRITING_DRIVER——源码锚）', async () => {
    // 源码锚：runner.ts 零环境变量读取；唯一读取点在组装根的 driver-port.ts
    const runnerSrc = readSrc('src/ai/runner.ts')
    expect(runnerSrc).not.toContain("process.env['CLWRITING_DRIVER']")
    expect(runnerSrc).not.toContain('process.env.CLWRITING_DRIVER')
    const portSrc = readSrc('src/studio/server/driver-port.ts')
    expect(portSrc).toContain("process.env['CLWRITING_DRIVER']")
    // 注入面不给任何「按调用期读环境」的通道：runner 侧只有组装期注入点
    expect(runnerSrc).toContain('configureRunnerMockFastPath')
  })

  it('②-b 行为锚：env=mock 但注入 cc 宿主 → 真实路径（NO_PROVIDER）；env 缺省但注入 mock 宿主 → mock 快路', async () => {
    const prev = process.env['CLWRITING_DRIVER']
    try {
      // 反证：环境变量声称 mock，但组装根注入的是 cc 宿主 + 空 provider → mockText 不短路
      process.env['CLWRITING_DRIVER'] = 'mock'
      const cc = await boot('cc', 'p36-cc-')
      const r1 = await req(cc.base, 'tok-p36-cc-', 'POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`, { step: 'synopsis' })
      expect(r1.status).toBe(500)
      expect(r1.json.error).toContain('未配置')

      // 正证：环境变量缺省，但注入 mock 宿主 → mock 快路生效（200 + mock 设定落盘）
      delete process.env['CLWRITING_DRIVER']
      const mock = await boot('mock', 'p36-mock-')
      const r2 = await req(mock.base, 'tok-p36-mock-', 'POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`, { step: 'synopsis' })
      expect(r2.status).toBe(200)
      expect(r2.json.ok).toBe(true)
    } finally {
      if (prev === undefined) delete process.env['CLWRITING_DRIVER']
      else process.env['CLWRITING_DRIVER'] = prev
    }
  })

  it('③ 必需能力缺失在编译期不可表达（@ts-expect-error 探针：缺 stream 不可作为 deps.driver）', async () => {
    const host = makeHost('mock')
    // 逐能力抽出替身面（可赋值基准）
    const partial = {
      startSession: host.driver.startSession,
      dispose: host.driver.dispose,
      emit: host.driver.emit,
      cancelStream: host.driver.cancelStream,
    }
    // @ts-expect-error 缺必需能力 stream：DriverCore 注入面在编译期拒绝该形态（tsc 未命中会报未使用指令）
    const missingStream: ServiceDriver = partial
    // 对照：补齐 stream 后可赋值（无指令、编译期放行）
    const complete: ServiceDriver = { ...partial, stream: host.driver.stream }
    // 注入点同款：缺能力的宿主在编译期不可表达
    // @ts-expect-error 缺必需能力 stream：DriverHost.driver 要求完整必需能力面
    const badHost: DriverHost = { ...host, driver: partial }
    expect(typeof missingStream.startSession).toBe('function') // 运行期存在；判据在编译期（typecheck 门）
    expect(typeof complete.stream).toBe('function')
    expect(badHost.kind).toBe('mock')
  })

  it('④ 钩子收敛后观测面仍可用：settings 壳 stats() 取代 __settingsScanCountForTest', async () => {
    const a = await boot('mock', 'p36-obs-')
    settingsCache.resetStats()
    const p = `/api/books/${encodeURIComponent(BOOK)}/settings`
    const r1 = await req(a.base, 'tok-p36-obs-', 'GET', p)
    expect(r1.status).toBe(200)
    const first = settingsCache.stats().misses
    expect(first).toBe(1) // MISS → 实际扫描一次
    const r2 = await req(a.base, 'tok-p36-obs-', 'GET', p)
    expect(r2.status).toBe(200)
    expect(settingsCache.stats().misses).toBe(1) // 命中不重扫
    settingsCache.resetStats()
    expect(settingsCache.stats().misses).toBe(0)
  })
})
