/**
 * 导出内核 worker 线程入口（由 run-async.ts spawn）。
 *
 * exportBook 为全同步 IO（留档：内核异步化改动面大）——在服务进程直调会让大书导出
 * 期间事件循环被独占，该书与其余所有书的 SSE 心跳/保存请求全部停摆。
 * 本入口把同步内核原样搬进线程执行（内核零改动），服务进程只等消息。
 *
 * 单作业线程：收到 job → 同步执行 exportBook → postMessage 结果；任务完成由
 * spawn 侧 terminate（本入口保持消息监听不自然退出）。独立 tsup entry——打包态
 * 与 server bundle 同目录成伴（解析见 run-async.ts 头注）。
 *
 * 取消：本入口**不注册**取消消息/共享中止位的监听——内核执行期单线程同步到底，
 * worker 消息在期间不会被派发，协作取消在这一结构上不可达；取消一律由 spawn 侧
 * terminate 承担（取舍与产物清理口径见 run-async.ts 头注「取消与产物清理」段）。
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
