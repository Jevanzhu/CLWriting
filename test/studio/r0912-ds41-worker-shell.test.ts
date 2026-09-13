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
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runExportBookAsync } from '../../src/export/run-async.js'
import { runRebuildAsync } from '../../src/cache/run-rebuild-async.js'
import { runStyleScanAsync } from '../../src/studio/server/api/style-scan-async.js'
import { runWorkerJob } from '../../src/worker-async.js'
import { __getInFlightWorkCount } from '../../src/studio/server/api/in-flight-work.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import type { StyleScanJob } from '../../src/studio/server/api/analysis-worker.js'

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
      runExportBookAsync({ bookRoot: dir, format: 'merged', platform: 'generic' }, { workerUrl: exit, timeoutMs: 5_000 }),
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
