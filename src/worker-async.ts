/**
 * 三份 Worker 运行器的公共壳单源
 * （export/run-async.ts · cache/run-rebuild-async.ts · studio/server/api/
 * style-scan-async.ts——评审记 259 行、两两共同行 32-34 起的大段同构）。
 *
 * 收敛面＝真正同构的核心段：同伴 worker 入口解析（src/打包双形态）+ tsx loader
 * 判定 + fork（1GB 内存闸）+ 单作业单 settle 消息分流（message/error/exit/timeout
 * 四路先到者生效，settle 即 terminate 收线程）。各域差异全部参数化留在调用方：
 *  - 默认超时档（导出/重建 120s、扫描 60s）与域内 RunnerOptions 形态；
 *  - 超时/退出的用户可见文案（逐字节保真——io-export-worker 等既有测试钉值）；
 * - 域语义组合不入壳：rebuild 的同 cachePath 单飞合并留在
 * runRebuildAsync、扫描的 server 在途登记留在 runStyleScanAsync。
 * 定位对齐 src/async.ts：跨域运行时原语的单源之家。
 */
import { Worker } from 'node:worker_threads'

/** 测试注入口（生产不传）：timeoutMs 直测超时拒绝；workerUrl 指向慢 worker 测竞态。
 *  三域 RunnerOptions 的共同基底（各域以空接口 extend 再导出，import 面零改动）。
 *  signal：作业级取消通道（生产传——客户端断连/服务关停时由端点或组装根触发）。 */
export interface WorkerJobOptions {
  timeoutMs?: number
  workerUrl?: URL
  signal?: AbortSignal
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
  /** 取消通道（可选）：abort 即终止 worker 并以 WorkerJobAbortedError 拒绝。
   *  与超时/退出同走 settle 单点——先到者生效，绝不与超时文案混淆。 */
  signal?: AbortSignal
  /** 取消文案（用户可见；缺省由调用方给域内人话） */
  abortMessage?: string
}

/**
 * 作业取消（客户端断连 / 服务关停）的拒绝信封——code 复用全仓取消码惯例
 * （task-gate 的生成长任务中断亦以 ABORTED 收口、HTTP 侧映射 499），
 * 与超时/退出/内核错误三类拒绝区分：调用方据 code 回取消语义而非 500。
 * message 为域内人话（用户可能看不到——断连/关停场景无接收方，但服务端日志与
 * 直测面需要可判别文案）。
 */
export class WorkerJobAbortedError extends Error {
  readonly code = 'ABORTED'
  constructor(message: string) {
    super(message)
    this.name = 'WorkerJobAbortedError'
  }
}

/** 判定取消拒绝信封（跨模块复用原生 instanceof 面——worker 非跨进程
 *  serialization 边界，类同一性成立）。 */
export function isWorkerJobAborted(e: unknown): e is WorkerJobAbortedError {
  return e instanceof WorkerJobAbortedError
}

/** fork Worker 并等其单条结果消息：成功/失败/超时/退出/取消五路先到者生效（幂等 settle），
 * 其余路径跳过并 terminate 收线程。内存闸（run-async.ts 审计同款，
 *  三域同档）：worker 堆上限 1GB——失控只顶 worker OOM（按既有 error 路径上抛），
 *  不再把主进程 RSS 顶到系统爆内存。结果类型<TResult>由调用方标注（worker 回包
 *  无运行时可验形状，与壳化前各域 `(r: TResult) =>` 同口径）。
 *
 * 取消（spec.signal）：abort 即 settle 拒绝并 terminate——调用方（导出端点/组装根）
 *  的闸槽、在途登记、路由 handler 全在 await 该 promise 上挂，settle 越快释放越早；
 *  不等待 worker 自行收尾（域内核多为全同步循环，等它只会把闸槽多占一个作业周期）。
 *  worker 内**不设协作取消检查点**（域内取 terminate 为唯一取消路径的取舍见
 *  export/run-async.ts 头注的取消段）：壳只承诺「abort → 立刻收线程 + 取消语义拒绝」。 */
export function runWorkerJob<TResult>(spec: WorkerJobSpec): Promise<TResult> {
  return new Promise<TResult>((resolve, reject) => {
    let settled = false
    const w = new Worker(spec.workerUrl, {
      execArgv: workerExecArgv(spec.workerUrl),
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
    })
    // 单作业单 settle：成功/失败/超时/退出/取消任一先到，其余路径幂等跳过并 terminate 收线程
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
      fn()
      void w.terminate()
    }
    const timer = setTimeout(() => settle(() => reject(new Error(spec.timeoutMessage(spec.timeoutMs)))), spec.timeoutMs)
    w.once('message', (r: TResult) => settle(() => resolve(r)))
    w.once('error', (e: Error) => settle(() => reject(e)))
    // worker 非错误退出（resourceLimits abort / 入口显式 process.exit / 致命信号）
    // 不触发 'error' 事件——Promise 原先悬挂至超时才拒；补 'exit' 监听
    // 直接拒绝（settle 幂等：成功/失败先到者生效，此路径仅兜底）。
    w.once('exit', (code) => settle(() => reject(new Error(spec.exitMessage(code)))))
    // 取消早于 fork 完成（调用方在 await 前已 abort）时同路径立即收口——
    // signal.aborted 判据单点，不依赖事件派发时序。
    const onAbort = (): void =>
      settle(() => reject(new WorkerJobAbortedError(spec.abortMessage ?? '作业已取消，已终止工作线程')))
    if (spec.signal) {
      if (spec.signal.aborted) onAbort()
      else spec.signal.addEventListener('abort', onAbort, { once: true })
    }
    if (!settled) w.postMessage(spec.job)
  })
}
