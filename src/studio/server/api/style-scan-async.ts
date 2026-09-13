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
 *
 * R0912-ds41（重评-deepseek-v4.1-flash P3-5）：fork/settle/超时/退出同构段抽入公共
 * 壳 src/worker-async.ts（与 export、rebuild 三域单源）；trackInFlightWork 在途登记
 * 是本域独有组合（R0910-W），留在调用方不入壳。
 */
import type { StyleScanJob, StyleScanResult } from './analysis-worker.js'
// R0910-W：扫描 Worker 登记进 server 在途工作表——退出收尾有界等待，防 close 后
// 线程仍持 index.db 句柄（Windows rmSync ENOTEMPTY）
import { trackInFlightWork } from './in-flight-work.js'
import { runWorkerJob, resolveSiblingWorkerUrl, type WorkerJobOptions } from '../../../worker-async.js'

export type { StyleScanJob, StyleScanResult } from './analysis-worker.js'

/** 测试注入口（生产不传）：timeoutMs 直测超时拒绝；workerUrl 指向慢 worker 测竞态。 */
interface StyleScanRunnerOptions extends WorkerJobOptions {}

const DEFAULT_TIMEOUT_MS = 60_000

function resolveWorkerUrl(): URL {
  return resolveSiblingWorkerUrl(import.meta.url, 'analysis')
}

export function runStyleScanAsync(
  job: StyleScanJob,
  opts: StyleScanRunnerOptions = {},
): Promise<StyleScanResult> {
  return trackInFlightWork(runWorkerJob<StyleScanResult>({
    job,
    workerUrl: opts.workerUrl ?? resolveWorkerUrl(),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    timeoutMessage: (t) => `文风全书扫描超时（上限 ${t}ms），已终止扫描工作线程`,
    exitMessage: (code) => `文风扫描工作线程已退出（exit code=${code}），未返回扫描结果`,
  }))
}
