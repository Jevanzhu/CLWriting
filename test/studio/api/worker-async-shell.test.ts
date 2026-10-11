/**
 * R0912-ds41（重评-deepseek-v4.1-flash P3-5）回归：三份 Worker 运行器抽公共壳
 * （src/worker-async.ts：fork + settle 分流 + 超时/退出结算）。
 *
 * 重构红线＝行为逐字节等价，本文件钉两类易碎面：
 *  - 用户可见文案逐字节保真：三域超时/退出文案此前仅子串/正则级钉值
 *   （io-export-worker『导出超时』、r57 与 run-async-exit /已退出/），这里以
 *    message 全等钉死，防壳内参数化拼接悄悄改字；
 *  - 域差异语义在壳外原样保留：style-scan 的 server 在途登记（R0910-W：扫描
 *    在途 __getInFlightWorkCount=1、settle 清零——壳化前无直测，此处补钉）；
 *    rebuild 单飞（R57-A-1）已有 r57-rebuild-async-inflight 详测，不重复。
 * 手法对齐 r57/run-async-exit：RunnerOptions.workerUrl 注入临时 .mjs worker
 * （非 .ts 不挂 tsx loader，壳的 execArgv 判定对 .mjs 零干预）。
 *
 * P1-3（工程门修复批）：补三域 **worker 入口**（*-worker.ts）的消息分支直测——
 * 入口只在 spawn 侧真线程里被加载，vitest 主线程直跑零执行（v8 报 0%，入口改动
 * 零守护）。三入口与上方三运行器同族同域，故并入本档不另开碎片档。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runExportBookAsync } from '../../../src/export/run-async.js'
import { runRebuildAsync } from '../../../src/cache/run-rebuild-async.js'
import { runStyleScanAsync } from '../../../src/studio/server/api/style-scan-async.js'
import { runWorkerJob } from '../../../src/worker-async.js'
import { __getInFlightWorkCount } from '../../../src/studio/server/api/in-flight-work.js'
import { mkdtempTracked } from '../../helpers/temp-dir.js'
import type { StyleScanJob, StyleScanResult } from '../../../src/studio/server/api/analysis-worker.js'
import type { RebuildResult } from '../../../src/cache/rebuild.js'
import type { ExportResult } from '../../../src/export/index.js'

// ── P1-3：worker 入口消息分支的 parentPort 桩 ─────────────────────────────
// 以真模块为底、只换 parentPort（真 Worker 类保留——上方壳面用例仍开真线程）；
// 入口 import 时对自己注册的 message 处理器被捕获在 handlers，测试驱动之。
// parentPort 走 getter 读 port 槽：置 null 即主线程形态（入口 `if (port)` 假分支）。
const portStub = vi.hoisted(() => {
  const handlers: Array<(job: unknown) => void> = []
  const posted: unknown[] = []
  const fakePort = {
    once: (ev: string, fn: (job: unknown) => void) => {
      if (ev === 'message') handlers.push(fn)
    },
    on: (ev: string, fn: (job: unknown) => void) => {
      if (ev === 'message') handlers.push(fn)
    },
    postMessage: (m: unknown) => posted.push(m),
  }
  return { handlers, posted, fakePort, port: fakePort as null | typeof fakePort }
})
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>()
  return {
    ...actual,
    get parentPort() {
      return portStub.port
    },
  }
})

/** 慢 worker：收 job 300ms 后回包（timeoutMs 20 → 走超时拒绝路径） */
const SLOW_WORKER = `
import { parentPort } from 'node:worker_threads'
parentPort.once('message', () => setTimeout(() => parentPort.postMessage({ ok: true }), 300))
`
/** 立即退出 worker：走 'exit' 兜底拒绝路径（R65-29：非错误退出不触发 'error'） */
const EXIT_WORKER = `
process.exit(0)
`
/** 回声 worker：job 原样回传（壳的 message 透传面） */
const ECHO_WORKER = `
import { parentPort } from 'node:worker_threads'
parentPort.once('message', (job) => parentPort.postMessage({ echo: job }))
`
/** 抛错 worker：走 'error' 事件路径（错误对象原样上抛） */
const THROW_WORKER = `
throw new Error('boom')
`

/** 取 promise 的拒绝错误（resolve 即测试失败——文案/错误面断言的前提不成立） */
async function rejectionOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (e) {
    return e as Error
  }
  throw new Error('预期拒绝的 promise 却 resolve 了')
}

describe('R0912-ds41：三域超时/退出文案逐字节保真（message 全等）', () => {
  // 跨测试共享 worker 脚本目录：temp-dir.ts 头注口径——登记版 mkdtempTracked 的
  // afterEach 会在首个测试后删共享目录，此处保持手工 beforeAll/afterAll 对
  let dir = ''
  const make = (name: string, src: string): URL => {
    const p = join(dir, name)
    writeFileSync(p, src, 'utf-8')
    return pathToFileURL(p)
  }
  let slow!: URL
  let exit!: URL
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'clw-r0912-ds41-shell-'))
    slow = make('slow.mjs', SLOW_WORKER)
    exit = make('exit.mjs', EXIT_WORKER)
  })

  it('export：超时与退出两条文案全等', async () => {
    const timeoutErr = await rejectionOf(
      runExportBookAsync({ bookRoot: dir, format: 'merged', platform: 'generic' }, { workerUrl: slow, timeoutMs: 20 }),
    )
    expect(timeoutErr.message).toBe('导出超时（上限 20ms），已终止导出工作线程')
    const exitErr = await rejectionOf(
      runExportBookAsync(
        { bookRoot: dir, format: 'merged', platform: 'generic' },
        { workerUrl: exit, timeoutMs: 5_000 },
      ),
    )
    expect(exitErr.message).toBe('导出工作线程已退出（exit code=0），未返回导出结果')
  })

  it('rebuild：超时与退出两条文案全等', async () => {
    const cachePath = join(dir, 'unused.db')
    const timeoutErr = await rejectionOf(
      runRebuildAsync({ bookRoot: dir, cachePath }, { workerUrl: slow, timeoutMs: 20 }),
    )
    expect(timeoutErr.message).toBe('rebuild 超时（上限 20ms），已终止重建工作线程')
    const exitErr = await rejectionOf(
      runRebuildAsync({ bookRoot: dir, cachePath }, { workerUrl: exit, timeoutMs: 5_000 }),
    )
    expect(exitErr.message).toBe('rebuild 工作线程已退出（exit code=0），未返回重建结果')
  })

  it('style-scan：超时与退出两条文案全等', async () => {
    // workerUrl 注入态 job 形状不入壳（直测透传，形状自由）
    const job = { chapters: [], rules: {} } as unknown as StyleScanJob
    const timeoutErr = await rejectionOf(runStyleScanAsync(job, { workerUrl: slow, timeoutMs: 20 }))
    expect(timeoutErr.message).toBe('文风全书扫描超时（上限 20ms），已终止扫描工作线程')
    const exitErr = await rejectionOf(runStyleScanAsync(job, { workerUrl: exit, timeoutMs: 5_000 }))
    expect(exitErr.message).toBe('文风扫描工作线程已退出（exit code=0），未返回扫描结果')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('R0912-ds41：壳面直测（runWorkerJob）', () => {
  let dir = ''
  const make = (name: string, src: string): URL => {
    const p = join(dir, name)
    writeFileSync(p, src, 'utf-8')
    return pathToFileURL(p)
  }
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'clw-r0912-ds41-core-'))
  })

  it('message 透传：worker 回包原样 resolve', async () => {
    const r = await runWorkerJob<{ echo: string[] }>({
      job: ['a', 'b'],
      workerUrl: make('echo.mjs', ECHO_WORKER),
      timeoutMs: 5_000,
      timeoutMessage: (t) => `T${t}`,
      exitMessage: (c) => `C${c}`,
    })
    expect(r.echo).toEqual(['a', 'b'])
  })

  it('error 事件：worker 抛错原样上抛（非超时/退出文案包装）', async () => {
    const err = await rejectionOf(
      runWorkerJob({
        job: {},
        workerUrl: make('throw.mjs', THROW_WORKER),
        timeoutMs: 5_000,
        timeoutMessage: (t) => `T${t}`,
        exitMessage: (c) => `C${c}`,
      }),
    )
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('boom')
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('R0912-ds41：style-scan 在途登记语义保留（R0910-W）', () => {
  it('扫描在途 __getInFlightWorkCount=1，settle 后清零', async () => {
    const dir2 = mkdtempTracked(join(tmpdir(), 'clw-r0912-ds41-track-'))
    try {
      const workerScript = join(dir2, 'gate.mjs')
      writeFileSync(
        workerScript,
        `import { parentPort } from 'node:worker_threads'
parentPort.once('message', () => setTimeout(() => parentPort.postMessage({ ok: true }), 80))`,
        'utf-8',
      )
      const job = { chapters: [], rules: {} } as unknown as StyleScanJob
      const pending = runStyleScanAsync(job, {
        workerUrl: pathToFileURL(workerScript),
        timeoutMs: 5_000,
      })
      expect(__getInFlightWorkCount()).toBe(1) // 壳化前：trackInFlightWork 包裹整段 Promise
      await pending
      await new Promise((r) => setTimeout(r, 0))
      expect(__getInFlightWorkCount()).toBe(0)
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })
})

/** 取最近一次入口 import 注册的 message 处理器（入口在 import 时对自己注册一次；
 * 桩未命中即报错——入口改成惰性注册时本档须随改的口子） */
function lastHandler(): (job: unknown) => void {
  const h = portStub.handlers.at(-1)
  if (!h) throw new Error('worker 入口未注册 message 处理器——parentPort 桩未命中')
  return h
}

describe('P1-3：三域 worker 入口消息分支（真入口 + parentPort 桩）', () => {
  beforeEach(() => {
    portStub.posted.length = 0
  })

  it('主线程形态（parentPort=null）：三入口 import 零副作用（不注册处理器、不抛）', async () => {
    const registeredBefore = portStub.handlers.length
    portStub.port = null
    vi.resetModules() // 让三入口在本例内重新求值（此前用例已 import 过，缓存态不覆盖假分支）
    try {
      await import('../../../src/cache/rebuild-worker.js')
      await import('../../../src/export/export-worker.js')
      await import('../../../src/studio/server/api/analysis-worker.js')
      expect(portStub.handlers).toHaveLength(registeredBefore)
      expect(portStub.posted).toHaveLength(0)
    } finally {
      portStub.port = portStub.fakePort
      vi.resetModules()
    }
  })

  it('analysis-worker：收 job → 回包 StyleScanResult（坏章跳过 / recent 带章头 / 非 recent 不进样）', async () => {
    await import('../../../src/studio/server/api/analysis-worker.js')
    const handle = lastHandler()
    const dir = mkdtempTracked(join(tmpdir(), 'clw-analysis-worker-'))
    const ch1 = join(dir, '001-雨夜.md')
    writeFileSync(ch1, '---\n章号: 1\n标题: 雨夜\n---\n\n山门外的雨夜，玉佩碎了。\n', 'utf-8')
    const ch2 = join(dir, '002-雪落.md')
    writeFileSync(ch2, '---\n章号: 2\n标题: 雪落\n---\n\n雪落无声。\n', 'utf-8')

    handle({
      chapters: [
        { path: ch1, 章号: 1, 标题: '雨夜', recent: true },
        { path: ch2, 章号: 2, 标题: '雪落', recent: false },
        { path: join(dir, '999-缺章.md'), 章号: 9, 标题: '缺章', recent: true }, // 读不到 → 跳过
      ],
      rules: { bannedWords: ['玉佩'] },
    })

    const r = portStub.posted.at(-1) as StyleScanResult
    // 采样正文 = recent 章 + `### 第N章 标题` 头；非 recent/坏章零贡献
    expect(r.sampleText).toContain('### 第1章 雨夜')
    expect(r.sampleText).toContain('山门外的雨夜，玉佩碎了。')
    expect(r.sampleText).not.toContain('雪落无声') // recent=false 不进样
    expect(r.sampleText).not.toContain('缺章') // 坏章跳过不炸
    // 全书 stats 在两章合并语料上算出（computeFullStats 全量面而非单章面）
    expect(r.fullStats.charCount).toBeGreaterThan(0)
    expect(typeof r.fullStats.sentenceLenVariance).toBe('number')
    expect(typeof r.fullStats.repeatRate).toBe('number')
    // 缓存宽度：非 recent 章的正文仍进合并语料（charCount 大于仅 recent 章）
    expect(r.fullStats.charCount).toBeGreaterThan('山门外的雨夜，玉佩碎了。'.length)
  })

  it('rebuild-worker：收 job → 回包 RebuildResult 且 index.db 落盘', async () => {
    await import('../../../src/cache/rebuild-worker.js')
    const handle = lastHandler()
    const root = mkdtempTracked(join(tmpdir(), 'clw-rebuild-worker-'))
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
    writeFileSync(
      join(root, 'book.yaml'),
      'spec_version: 1\nbook:\n  title: 重建入口测试\n  genre: 玄幻\nleads:\n  enabled: []\n',
      'utf-8',
    )
    writeFileSync(
      join(root, '写作', '正文', '152-北境的雪.md'),
      '---\n章号: 152\n标题: 北境的雪\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 转折\n---\n\n北境下雪了，林晚踏雪而行。\n',
      'utf-8',
    )
    writeFileSync(join(root, '定稿', '摘要', '章摘要', '152.md'), '林晚抵达北境，揭开灭门线索。', 'utf-8')
    const cachePath = join(root, '.cache', 'index.db')

    handle({ bookRoot: root, cachePath })

    const r = portStub.posted.at(-1) as RebuildResult
    expect(r).toMatchObject({ chapterCount: 1, summaryCount: 1, errors: [] })
    expect(existsSync(cachePath)).toBe(true) // 内核产物真落盘（入口只搬运，不吞不伪）
  })

  it('export-worker：收 job → 回包 ExportResult 且产物落盘；坏 job 回 ok:false 失败信封', async () => {
    await import('../../../src/export/export-worker.js')
    const handle = lastHandler()
    const root = mkdtempTracked(join(tmpdir(), 'clw-export-worker-'))
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nbook:\n  title: 入口测试\n  genre: 玄幻\n', 'utf-8')
    writeFileSync(
      join(root, '写作', '正文', '1-第一章.md'),
      '---\n章号: 1\n标题: 第一章\n---\n\n雪落在了城墙上。\n',
      'utf-8',
    )

    handle({ bookRoot: root, format: 'merged' })

    const r = portStub.posted.at(-1) as ExportResult
    expect(r).toMatchObject({ ok: true, chapterCount: 1 })
    const out = join(root, '工作区', '导出', '全本-入口测试.md')
    expect(r.files).toContain('工作区/导出/全本-入口测试.md')
    expect(readFileSync(out, 'utf-8')).toContain('雪落在了城墙上')
    // 失败信号：坏 job 不抛、以 ok:false 信封原样回包（同进程内为返回值契约）
    handle({ bookRoot: join(root, '不存在的书') })
    const bad = portStub.posted.at(-1) as ExportResult
    expect(bad.ok).toBe(false)
    expect(bad.error).toBeTruthy()
  })
})
