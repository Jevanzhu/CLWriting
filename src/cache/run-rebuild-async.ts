/**
 * R48-11（四十八轮）：rebuild 内核 worker 卸载层（范式对齐 export/run-async.ts——
 * B-24 同款：同步内核零改动搬线程，服务进程只等 worker 消息）。
 *
 * 动因：摘要自愈路径（process/summary.ts）补生成摘要后同步调全量 rebuild（清库重扫
 * 全书），服务事件循环秒级冻结——SSE 心跳/保存请求停摆，与 B-24 导出同型。超时看护
 * （默认 120s，对齐导出档）terminate 后拒绝；worker 崩溃/入口加载失败 → error 上抛
 *（调用方既有 catch 降级留痕，不阻断备料）。
 *
 * 入口解析与 src 形态 loader 挂载对齐 run-async.ts 头注：src 形态（tsx dev /
 * vitest）取 .ts 同伴 + 显式挂 tsx loader；tsup 打包后本模块被内联进 dist/desktop/
 * server bundle，同伴为独立 entry 产出的 rebuild-worker.js（tsup.config entry 列表；
 * electron-builder files: dist 已含）。
 *
 * R0912-ds41（重评-deepseek-v4.1-flash P3-5）：fork/settle/超时/退出同构段抽入公共
 * 壳 src/worker-async.ts（与 export、style-scan 三域单源）；单飞合并（下）是本域
 * 独有语义，留在调用方不入壳。
 */
import type { RebuildResult } from './rebuild.js'
import { runWorkerJob, resolveSiblingWorkerUrl, type WorkerJobOptions } from '../worker-async.js'

export interface RebuildJob {
  bookRoot: string
  cachePath: string
  opts?: { throttleSourceProbe?: boolean }
}

/** 测试注入口（生产不传）：timeoutMs 直测超时拒绝；workerUrl 指向慢 worker 测竞态 */
export interface RebuildRunnerOptions extends WorkerJobOptions {}

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * R57-A-1（五十七轮）：同 cachePath 进程内 in-flight 合并。同步时代 rebuild() 阻塞
 * 事件循环、并发 detectState 天然串行；worker 化后 await 让出事件循环，/state 与
 * /overview 同拍首进门可各起一个 Worker 并发写同一 index.db——大书全量 >busy_timeout
 * 时后到者 SQLITE_BUSY → catch 降级态 2 误报「缓存重建失败」。按 cachePath 合并为
 * 单飞：并发调用共享同一 Promise（结果/失败同享，settle 即清除、下次调用重新起跑，
 * 失败自愈语义不变）。以首调用参数为准（timeoutMs/workerUrl 仅测试态注入，合并窗内
 * 后到者的注入项不生效——测试按单飞断言即验此语义）。
 */
const inFlight = new Map<string, Promise<RebuildResult>>()

function resolveWorkerUrl(): URL {
  return resolveSiblingWorkerUrl(import.meta.url, 'rebuild')
}

function startRebuildWorker(job: RebuildJob, opts: RebuildRunnerOptions): Promise<RebuildResult> {
  return runWorkerJob<RebuildResult>({
    job,
    workerUrl: opts.workerUrl ?? resolveWorkerUrl(),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    timeoutMessage: (t) => `rebuild 超时（上限 ${t}ms），已终止重建工作线程`,
    exitMessage: (code) => `rebuild 工作线程已退出（exit code=${code}），未返回重建结果`,
  })
}

export function runRebuildAsync(job: RebuildJob, opts: RebuildRunnerOptions = {}): Promise<RebuildResult> {
  const key = job.cachePath
  const existing = inFlight.get(key)
  if (existing) return existing
  // finally 派生 promise 即对外共享 promise：拒绝随共享链传给全部共享方（各消费点
  // 均有 catch 降级），无游离未处理拒绝；settle 后清键，下次调用重新起跑
  const shared = startRebuildWorker(job, opts).finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, shared)
  return shared
}
