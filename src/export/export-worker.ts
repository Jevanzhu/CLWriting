/**
 * B-24（第六十轮补修）：导出内核 worker 线程入口（由 run-async.ts spawn）。
 *
 * exportBook 为全同步 IO（S4 留档：内核异步化改动面大）——此前在服务进程直调，
 * 大书导出期间事件循环被独占，该书与其余所有书的 SSE 心跳/保存请求全部停摆。
 * 本入口把同步内核原样搬进线程执行（内核零改动），服务进程只等消息。
 *
 * 单作业线程：收到 job → 同步执行 exportBook → postMessage 结果；任务完成由
 * spawn 侧 terminate（本入口保持消息监听不自然退出）。独立 tsup entry——打包态
 * 与 server bundle 同目录成伴（解析见 run-async.ts 头注）。
 */
import { parentPort } from 'node:worker_threads'
import { exportBook } from './index.js'
import type { ExportOptions } from './index.js'

const port = parentPort
if (port) {
  port.on('message', (job: ExportOptions) => {
    port.postMessage(exportBook(job))
  })
}
