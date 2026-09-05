/**
 * R46-2（四十六轮）：analyze-style 全书扫描的 worker 卸载层（export/run-async.ts
 * B-24 同款范式）——服务进程只等 worker 消息，扫描期间的同步 IO/CPU 全部离开事件
 * 循环。超时看护（默认 60s：全书扫描秒级、留大余量）terminate 后拒绝，由调用方
 * （analysis.ts）回落进程内同步路径保可用性——worker 失败的退化形态即旧行为，
 * 不产生新的失败面。worker 堆上限对齐 export（1024MB）。
 *
 * 入口解析：src 形态（tsx dev / vitest）取 .ts 同伴 + 显式挂 tsx loader（内核
 * import 图全用 .js 说明符指向 .ts 源，Node 24 原生 type-stripping 不做重映射）；
 * tsup 打包后本模块内联进 dist/desktop bundle，同伴为独立 entry 产出的
 * analysis-worker.js。
 */
import { Worker } from 'node:worker_threads'
import type { StyleScanJob, StyleScanResult } from './analysis-worker.js'

export type { StyleScanJob, StyleScanResult } from './analysis-worker.js'

/** 测试注入口（生产不传）：timeoutMs 直测超时拒绝；workerUrl 指向慢 worker 测竞态。 */
export interface StyleScanRunnerOptions {
  timeoutMs?: number
  workerUrl?: URL
}

const DEFAULT_TIMEOUT_MS = 60_000

function resolveWorkerUrl(): URL {
  const self = new URL(import.meta.url)
  const ext = self.pathname.endsWith('.ts') ? 'ts' : 'js'
  return new URL(`./analysis-worker.${ext}`, self)
}

/** src 形态 worker 必须显式挂 tsx loader（.js→.ts 重映射），打包态无需（见文件头）。 */
function workerExecArgv(url: URL): string[] | undefined {
  return url.pathname.endsWith('.ts') ? ['--import', 'tsx'] : undefined
}

export function runStyleScanAsync(
  job: StyleScanJob,
  opts: StyleScanRunnerOptions = {},
): Promise<StyleScanResult> {
  return new Promise<StyleScanResult>((resolve, reject) => {
    let settled = false
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const workerUrl = opts.workerUrl ?? resolveWorkerUrl()
    const w = new Worker(workerUrl, {
      execArgv: workerExecArgv(workerUrl),
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
    })
    // 单作业单 settle：成功/失败/超时任一先到，其余路径幂等跳过并 terminate 收线程
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
      void w.terminate()
    }
    const timer = setTimeout(
      () => settle(() => reject(new Error(`文风全书扫描超时（上限 ${timeoutMs}ms），已终止扫描工作线程`))),
      timeoutMs,
    )
    w.once('message', (r: StyleScanResult) => settle(() => resolve(r)))
    w.once('error', (e: Error) => settle(() => reject(e)))
    // R65-29 同款：worker 非错误退出（resourceLimits abort / 致命信号）不触发 'error'
    // 事件——补 'exit' 监听直接拒绝（settle 幂等兜底）。
    w.once('exit', (code) =>
      settle(() => reject(new Error(`文风扫描工作线程已退出（exit code=${code}），未返回扫描结果`))),
    )
    w.postMessage(job)
  })
}
