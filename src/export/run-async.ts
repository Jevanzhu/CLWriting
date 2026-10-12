/**
 * 导出内核 worker 卸载层。
 *
 * 根因：exportBook 为全同步 IO——服务进程直调时，大书导出期间事件循环被独占，该书与**其余所有书**
 * 的 SSE 心跳/保存请求全部停摆（task-gate 只闸每书并发数，闸不住单次导出的事件循环阻塞）。本模块把
 * 同步内核搬进 worker_threads 线程执行（内核零改动），服务进程只等 worker 消息：
 *  - task-gate 仍留在服务进程持闸跨 await（io.ts，并发语义不变）；
 *  - 超时看护（默认 120s；前端 apiJson 超时 60s 先到，服务端兜底防 worker 悬挂）terminate 后拒绝；
 *  - 取消看护（opts.signal）：客户端断连 / 服务关停 → 立刻 terminate 并以取消语义拒绝
 *    （见下方「取消与产物清理」段），闸槽与在途登记随 settle 即刻释放；
 *  - worker 崩溃/入口加载失败 → error 事件上抛（route 包装层回 500 信封）。
 *
 * fork/settle/超时/退出/取消的同构段抽入公共壳 src/worker-async.ts（与 rebuild、style-scan
 * 三域单源）；本文件只留域内参数（默认超时档、同伴 entry 名、用户可见文案）。
 *
 * 取消与产物清理（为什么取 terminate 为唯一路径，不设 worker 内协作检查点）：
 *  - 内核 exportBook 是**全同步**执行（阶段一到阶段六逐章读-净化-落盘，循环体内无 await 点），
 *    worker 的 message 事件在其执行期间不会被派发——「发消息请求协作退出」在这一结构上不可达；
 *  - 共享内存中止位（SharedArrayBuffer + Atomics.load）虽可让写章循环在边界查询中止，
 *    但中止点只覆盖写章段（收集/过滤/投稿视图段仍在跑），且要把共享标志穿透 exportBook
 *    全部阶段与分段直测签名（内核契约扰动），换来的只是毫秒级提前收线程；
 *  - 故取 terminate 为唯一取消路径，由壳保证「abort → 立刻 settle + 收线程」。
 * 产物清理口径（terminate 不得留半成品）：内核全部落盘一律经
 * fs/atomic.ts 的 atomicWriteFile / atomicWriteStream——同目录临时文件 + fsync + rename
 * 原子改名，terminate 打断写盘只会留下未改名的 `.<名>.<pid>.<uuid>.tmp`，**目标产物文件
 * 要么完整要么不存在**（全本合并稿另经 publish 裁定，零成功章时连空壳都不落盘）；
 * 已完整落盘的章级产物沿用既有失败口径保留（下次导出按整目录归档清位，不销毁作者手改稿），
 * 未改名的 tmp 残留交既有的崩溃残留清扫（fs/atomic.ts sweepAbandonedTmpFiles）回收。
 */
import type { ExportOptions, ExportResult } from './index.js'
import { runWorkerJob, resolveSiblingWorkerUrl, type WorkerJobOptions } from '../worker-async.js'

/** 测试注入口（生产不传）：timeoutMs 直测超时拒绝；workerUrl 指向慢 worker 测竞态；
 *  signal 取消通道（生产由导出端点 / 组装根关停注入）。 */
export interface ExportRunnerOptions extends WorkerJobOptions {}

const DEFAULT_TIMEOUT_MS = 120_000

function resolveWorkerUrl(): URL {
  // src 形态以 .ts 运行；打包态本模块内联进 dist/desktop/*.js → 同伴为 tsup
  // 独立 entry 的 export-worker.js
  return resolveSiblingWorkerUrl(import.meta.url, 'export')
}

export function runExportBookAsync(job: ExportOptions, opts: ExportRunnerOptions = {}): Promise<ExportResult> {
  return runWorkerJob<ExportResult>({
    job,
    workerUrl: opts.workerUrl ?? resolveWorkerUrl(),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    timeoutMessage: (t) => `导出超时（上限 ${t}ms），已终止导出工作线程`,
    exitMessage: (code) => `导出工作线程已退出（exit code=${code}），未返回导出结果`,
    signal: opts.signal,
    abortMessage: '导出已取消，已终止导出工作线程',
  })
}
