/**
 * （-deepseek-v4.1-flash ）：三份 Worker 运行器的公共壳单源
 * （export/run-async.ts · cache/run-rebuild-async.ts · studio/server/api/
 * style-scan-async.ts——评审记 259 行、两两共同行 32-34 起的大段同构）。
 *
 * 收敛面＝真正同构的核心段：同伴 worker 入口解析（src/打包双形态）+ tsx loader
 * 判定 + fork（1GB 内存闸）+ 单作业单 settle 消息分流（message/error/exit/timeout
 * 四路先到者生效，settle 即 terminate 收线程）。各域差异全部参数化留在调用方：
 *  - 默认超时档（导出/重建 120s、扫描 60s）与域内 RunnerOptions 形态；
 *  - 超时/退出的用户可见文案（逐字节保真——io-export-worker 等既有测试钉值）；
 *  - 域语义组合不入壳：rebuild 的同 cachePath 单飞合并留在
 *    runRebuildAsync、扫描的 server 在途登记留在 runStyleScanAsync。
 * 定位对齐 src/async.ts：跨域运行时原语的单源之家。
 */
import { Worker } from 'node:worker_threads'

/** 测试注入口（生产不传）：timeoutMs 直测超时拒绝；workerUrl 指向慢 worker 测竞态。
 *  三域 RunnerOptions 的共同基底（各域以空接口 extend 再导出，import 面零改动）。 */
export interface WorkerJobOptions {
  timeoutMs?: number
  workerUrl?: URL
}

/** 同伴 worker 入口解析：src 形态（tsx dev / vitest）以 .ts 运行取 .ts 同伴；打包态
 *  本壳被内联进 dist/desktop/*.js bundle，同伴为 tsup 独立 entry 产出的 *-worker.js。
 *  basename 传连字符前缀（如 'export' → export-worker.ts|js）。 */
export function resolveSiblingWorkerUrl(selfUrl: string | URL, basename: string): URL {
  const self = new URL(selfUrl)
  const ext = self.pathname.endsWith('.ts') ? 'ts' : 'js'
  return new URL(`./${basename}-worker.${ext}`, self)
}

/** src 形态（tsx dev / vitest）worker 必须显式挂 tsx loader：内核 import 图全用
 *  `.js` 说明符指向 `.ts` 源（仓库 ESM 约定），Node 24 原生 type-stripping 不做
 *  .js→.ts 重映射（依赖图一跳即断）；tsx loader 补上。打包态 bundle 自含内核
 * （esbuild 已解析全部 import），无需 loader 也不依赖 node_modules。 */
function workerExecArgv(url: URL): string[] | undefined {
  return url.pathname.endsWith('.ts') ? ['--import', 'tsx'] : undefined
}

interface WorkerJobSpec {
  /** 发给 worker 的作业负载（postMessage 原样透传，形状归各域） */
  job: unknown
  workerUrl: URL
  timeoutMs: number
  /** 超时文案（用户可见，逐字节保真，有既有测试钉值） */
  timeoutMessage: (timeoutMs: number) => string
  /** 非错误退出兜底文案（'exit' 不触发 'error'，code 为退出码） */
  exitMessage: (code: number) => string
}

/** fork Worker 并等其单条结果消息：成功/失败/超时/退出四路先到者生效（幂等 settle），
 *  其余路径跳过并 terminate 收线程。内存闸（run-async.ts 审计同款，
 *  三域同档）：worker 堆上限 1GB——失控只顶 worker OOM（按既有 error 路径上抛），
 *  不再把主进程 RSS 顶到系统爆内存。结果类型<TResult>由调用方标注（worker 回包
 *  无运行时可验形状，与壳化前各域 `(r: TResult) =>` 同口径）。 */
export function runWorkerJob<TResult>(spec: WorkerJobSpec): Promise<TResult> {
  return new Promise<TResult>((resolve, reject) => {
    let settled = false
    const w = new Worker(spec.workerUrl, {
      execArgv: workerExecArgv(spec.workerUrl),
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
      () => settle(() => reject(new Error(spec.timeoutMessage(spec.timeoutMs)))),
      spec.timeoutMs,
    )
    w.once('message', (r: TResult) => settle(() => resolve(r)))
    w.once('error', (e: Error) => settle(() => reject(e)))
    // worker 非错误退出（resourceLimits abort / 入口显式 process.exit / 致命信号）
    // 不触发 'error' 事件——Promise 原先悬挂至超时才拒；补 'exit' 监听
    // 直接拒绝（settle 幂等：成功/失败先到者生效，此路径仅兜底）。
    w.once('exit', (code) =>
      settle(() => reject(new Error(spec.exitMessage(code)))),
    )
    w.postMessage(spec.job)
  })
}
