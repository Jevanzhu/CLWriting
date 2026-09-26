/**
 * （补修）：导出内核 worker 卸载层。
 *
 * exportBook 为全同步 IO（留档：异步化改动面大）——此前服务进程直调，大书
 * 导出期间事件循环被独占，该书与**其余所有书**的 SSE 心跳/保存请求全部停摆
 * （的 task-gate 只闸每书并发数，闸不住单次导出的事件循环阻塞）。本模块把
 * 同步内核搬进 worker_threads 线程执行（内核零改动），服务进程只等 worker 消息：
 *  - task-gate 仍留在服务进程持闸跨 await（io.ts，并发语义不变）；
 *  - 超时看护（默认 120s；前端 apiJson 超时 60s 先到，服务端兜底防 worker 悬挂）
 *    terminate 后拒绝；
 *  - worker 崩溃/入口加载失败 → error 事件上抛（route 包装层回 500 信封）。
 *
 * （-deepseek-v4.1-flash ）：fork/settle/超时/退出的同构段
 * 抽入公共壳 src/worker-async.ts（与 rebuild、style-scan 三域单源）；本文件只留
 * 域内参数（默认超时档、同伴 entry 名、用户可见文案——逐字节未动）。
 */
import type { ExportOptions, ExportResult } from './index.js'
import { runWorkerJob, resolveSiblingWorkerUrl, type WorkerJobOptions } from '../worker-async.js'

/** 测试注入口（生产不传）：timeoutMs 直测超时拒绝；workerUrl 指向慢 worker 测竞态 */
export interface ExportRunnerOptions extends WorkerJobOptions {}

const DEFAULT_TIMEOUT_MS = 120_000

function resolveWorkerUrl(): URL {
  // src 形态以 .ts 运行；打包态本模块内联进 dist/desktop/*.js → 同伴为 tsup
  // 独立 entry 的 export-worker.js
  return resolveSiblingWorkerUrl(import.meta.url, 'export')
}

export function runExportBookAsync(
  job: ExportOptions,
  opts: ExportRunnerOptions = {},
): Promise<ExportResult> {
  return runWorkerJob<ExportResult>({
    job,
    workerUrl: opts.workerUrl ?? resolveWorkerUrl(),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    timeoutMessage: (t) => `导出超时（上限 ${t}ms），已终止导出工作线程`,
    exitMessage: (code) => `导出工作线程已退出（exit code=${code}），未返回导出结果`,
  })
}
