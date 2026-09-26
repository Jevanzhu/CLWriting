/**
 * rebuild 内核 worker 卸载层（范式对齐 export/run-async.ts——
 * 同款：同步内核零改动搬线程，服务进程只等 worker 消息）。
 *
 * 动因：摘要自愈路径（process/summary.ts）补生成摘要后同步调全量 rebuild（清库重扫
 * 全书），服务事件循环秒级冻结——SSE 心跳/保存请求停摆，与导出同型。超时看护
 * （默认 120s，对齐导出档）terminate 后拒绝；worker 崩溃/入口加载失败 → error 上抛
 *（调用方既有 catch 降级留痕，不阻断备料）。
 *
 * 入口解析与 src 形态 loader 挂载对齐 run-async.ts 头注：src 形态（tsx dev /
 * vitest）取 .ts 同伴 + 显式挂 tsx loader；tsup 打包后本模块被内联进 dist/desktop/
 * server bundle，同伴为独立 entry 产出的 rebuild-worker.js（tsup.config entry 列表；
 * electron-builder files: dist 已含）。
 *
 * （-deepseek-v4.1-flash ）：fork/settle/超时/退出同构段抽入公共
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

/** 测试注入口（生产不传，缺省走 env 逃生口解析档）：timeoutMs 直测超时拒绝；
 *  workerUrl 指向慢 worker 测竞态 */
export interface RebuildRunnerOptions extends WorkerJobOptions {}

/** 0918二轮修复批（D104）：超时档缺省 120s 的启动期逃生口——大书（200 万字级）首次
 *  全量 rebuild 在慢盘/网盘卷可能触顶 120s 被 terminate（下次进门自愈重试，但每次都
 *  顶）。不做书级配置面，仅环境变量 CLWRITING_REBUILD_TIMEOUT_MS（与 CLWRITING_PORT
 *  等既有 env 同风格：模块加载读一次、未设/非法忽略回默认、不 fatal——逃生口配错不
 *  阻断启动，回默认档照跑）。慢盘/网盘场景按需调大：如
 *  `CLWRITING_REBUILD_TIMEOUT_MS=600000 npm start`。 */
export const DEFAULT_REBUILD_TIMEOUT_MS = 120_000

/** 0918二轮修复批（D104）：env 解析单源（导出供直测）：未设/空白/非有限数/非正数一律
 *  回缺省档。生产调用方（state.ts detectState、process/summary.ts 摘要自愈）均不传
 *  opts——本缺省档即 env 到生产链的贯穿点。 */
export function resolveRebuildTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env['CLWRITING_REBUILD_TIMEOUT_MS']
  if (raw === undefined || raw.trim() === '') return DEFAULT_REBUILD_TIMEOUT_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REBUILD_TIMEOUT_MS
  return Math.floor(n)
}

const DEFAULT_TIMEOUT_MS = resolveRebuildTimeoutMs()

/**
 * 同 cachePath 进程内 in-flight 合并。同步时代 rebuild 阻塞
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
