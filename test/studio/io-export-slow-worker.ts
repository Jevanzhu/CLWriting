/**
 * B-24 回归件：慢导出 worker（io-export-worker.test.ts 注入用）。
 * 收到 job 后延迟 300ms 回固定结果——配合 timeoutMs 20 测超时拒绝、
 * 配合在途定时器测非阻塞语义（服务线程不被同步内核占住）。
 */
import { parentPort } from 'node:worker_threads'

const port = parentPort
if (port) {
  port.on('message', () => {
    setTimeout(() => port.postMessage({ ok: true, via: 'slow-worker' }), 300)
  })
}
