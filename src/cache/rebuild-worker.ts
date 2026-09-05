/**
 * R48-11（四十八轮）：rebuild 内核 worker 线程入口（由 run-rebuild-async.ts spawn，
 * 范式对齐 export/export-worker.ts——B-24 同款）。
 *
 * rebuild 为全同步 IO + 同步 SQLite（node:sqlite 无异步面）——摘要自愈路径此前在
 * 服务进程直调全量重建，清库重扫全书期间事件循环秒级冻结（SSE 心跳/保存停摆）。
 * 本入口把同步内核原样搬进线程执行（内核零改动），服务进程只等消息。
 *
 * 单作业线程：收到 job → 同步执行 rebuild → postMessage 结果；任务完成由 spawn 侧
 * terminate（本入口保持消息监听不自然退出）。独立 tsup entry——打包态与 server
 * bundle 同目录成伴（解析见 run-rebuild-async.ts 头注）。
 */
import { parentPort } from 'node:worker_threads'
import { rebuild } from './rebuild.js'
import type { RebuildJob } from './run-rebuild-async.js'

const port = parentPort
if (port) {
  port.on('message', (job: RebuildJob) => {
    port.postMessage(rebuild(job.bookRoot, job.cachePath, job.opts))
  })
}
