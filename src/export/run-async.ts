/**
 * B-24（第六十轮补修）：导出内核 worker 卸载层。
 *
 * exportBook 为全同步 IO（S4 留档：异步化改动面大）——此前服务进程直调，大书
 * 导出期间事件循环被独占，该书与**其余所有书**的 SSE 心跳/保存请求全部停摆
 * （S3 的 task-gate 只闸每书并发数，闸不住单次导出的事件循环阻塞）。本模块把
 * 同步内核搬进 worker_threads 线程执行（内核零改动），服务进程只等 worker 消息：
 *  - task-gate 仍留在服务进程持闸跨 await（io.ts，并发语义不变）；
 *  - 超时看护（默认 120s；前端 apiJson 超时 60s 先到，服务端兜底防 worker 悬挂）
 *    terminate 后拒绝；
 *  - worker 崩溃/入口加载失败 → error 事件上抛（route 包装层回 500 信封）。
 *
 * 入口解析：src 形态（tsx dev / vitest）取 .ts 同伴；tsup 打包后本模块被内联进
 * dist/desktop/*.js bundle，import.meta.url 即 bundle 文件，同伴为独立 entry 产出
 * 的 export-worker.js（tsup.config entry 列表；electron-builder files: dist 已含）。
 */
import { Worker } from 'node:worker_threads'
import type { ExportOptions, ExportResult } from './index.js'

/** 测试注入口（生产不传）：timeoutMs 直测超时拒绝；workerUrl 指向慢 worker 测竞态 */
export interface ExportRunnerOptions {
  timeoutMs?: number
  workerUrl?: URL
}

const DEFAULT_TIMEOUT_MS = 120_000

function resolveWorkerUrl(): URL {
  const self = new URL(import.meta.url)
  // src 形态以 .ts 运行；打包态本模块内联进 dist/desktop/*.js → 同伴为 tsup
  // 独立 entry 的 export-worker.js
  const ext = self.pathname.endsWith('.ts') ? 'ts' : 'js'
  return new URL(`./export-worker.${ext}`, self)
}

/** src 形态（tsx dev / vitest）worker 必须显式挂 tsx loader：内核 import 图全用
 *  `.js` 说明符指向 `.ts` 源（仓库 ESM 约定），Node 24 原生 type-stripping 能执行
 *  .ts 入口但**不做 .js→.ts 重映射**（依赖图一跳即断）；tsx loader（项目
 *  node_modules 解析）补上重映射。打包态 bundle 自含内核（esbuild 已解析全部
 *  import），无需 loader 也不依赖 node_modules（asar 内无 devDependencies） */
function workerExecArgv(url: URL): string[] | undefined {
  return url.pathname.endsWith('.ts') ? ['--import', 'tsx'] : undefined
}

export function runExportBookAsync(
  job: ExportOptions,
  opts: ExportRunnerOptions = {},
): Promise<ExportResult> {
  return new Promise<ExportResult>((resolve, reject) => {
    let settled = false
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const workerUrl = opts.workerUrl ?? resolveWorkerUrl()
    const w = new Worker(workerUrl, {
      execArgv: workerExecArgv(workerUrl),
      // 内存闸（2026-08-24 审计 A1）：worker 堆上限——不设时继承默认（64 位 ≈4GB），
      // 导出内核的全书中转失控也只会把 worker 顶到 OOM 终止（按既有 error 路径回
      // 500 信封），不再把主进程 RSS 顶到系统爆内存；1GB 对导出峰值（流式化后单章
      // 级）+ tsx loader 基线余量充足。
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
      () =>
        settle(() =>
          reject(new Error(`导出超时（上限 ${timeoutMs}ms），已终止导出工作线程`)),
        ),
      timeoutMs,
    )
    w.once('message', (r: ExportResult) => settle(() => resolve(r)))
    w.once('error', (e: Error) => settle(() => reject(e)))
    // R65-29（第六十五轮）：worker 非错误退出（resourceLimits abort / 入口显式
    // process.exit / 致命信号）不触发 'error' 事件——Promise 原先悬挂至 120s 超时
    // 才拒；补 'exit' 监听直接拒绝（settle 幂等：成功/失败先到者生效，此路径仅兜底）。
    w.once('exit', (code) =>
      settle(() => reject(new Error(`导出工作线程已退出（exit code=${code}），未返回导出结果`))),
    )
    w.postMessage(job)
  })
}
