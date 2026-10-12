/**
 * 导出端点（#8.4）：内核 exportBook 经 worker 线程执行。
 *
 * - POST /api/books/:name/export    body {format, platform?} → 干净导出定稿（剥 front matter）
 *
 * 确定性操作（不涉大模型）。（补修）：内核为全同步 IO（留档），
 * 直调会独占服务进程事件循环（大书导出期间全部书的 SSE 心跳/保存停摆）——改经
 * run-async.ts 卸载 worker 线程，服务进程只等消息（内核零改动）。
 * 写闸承担 session token 校验（defense-in-depth）：index.ts isWrite 的 safeTokenCompare
 * 在路由分派前拦一切 POST—— 删 handler 内冗余复核
 * 随之删 ctx.token 死字段（注入后零读取）。
 * 取消：handler 为每次导出建一枚 AbortController，两路触发——①客户端断连
 * （res 'close' 且响应未写完，判据与 task-gate 的 attachClientGoneAbort 同源）；
 * ②组装根级在途取消登记（服务关停时 abort 全部在途，见 createExportCancelRegistry）。
 * abort → worker 立刻 terminate + promise 以取消语义拒绝 → 本 handler 的 finally 随即
 * 释放 task-gate 槽与全局导出名额（取消后的主要收益：槽不再被占满至 120s 超时）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { resolveBookOrReply } from '../book-context.js'
import { isWorkerJobAborted, WorkerJobAbortedError } from '../../../worker-async.js'
import { runExportBookAsync } from '../../../export/run-async.js'
import { trackInFlightWork } from './in-flight-work.js' // 导出 Worker 退出收尾登记
import type { ExportFormat, ExportOutput, ExportPlatform } from '../../../export/index.js'
import { SUBMISSION_PLATFORMS } from '../../../metrics/short-index.js'
import type { TaskGateInjected } from './task-gate.js' // export 并发闸（闸实例经组装根注入）

interface IoCtx extends TaskGateInjected {
  workDir: string | null
  /** 导出全局并发闸实例（组装根注入；同实例不再由模块级全局状态承载） */
  exportGate: ExportSlotGate
  /** 在途导出取消登记（组装根注入；服务关停时 abort 全部在途作业） */
  cancels: ExportCancelRegistry
  /** 收尾：导出排队等待超时覆盖档——组装根 RouteOverrides 注入
   * （undefined = 生产口径 10min 逐位不变） */
  exportWaitTimeoutMs?: number | null
  /** 导出作业 worker 入口覆盖档——组装根 RouteOverrides 注入（undefined = 生产同伴 entry）。
   *  测试注入慢 worker，断言取消后闸槽立即归位。 */
  exportWorkerUrl?: URL | null
}

const EXPORT_FORMATS = new Set(['merged', 'split', 'both'])
// 输出形态（txt 导出批）：md = 现口径（落 导出/），txt = 纯文本（落 导出/纯文本/）
const EXPORT_OUTPUTS = new Set(['md', 'txt'])
const PLATFORMS = new Set(SUBMISSION_PLATFORMS)

// 内存闸（审计）：全局导出 worker 并发闸——task-gate 只按书限并发，
// 跨书同时导出会各自 spawn worker（src 形态每线程还独立挂 tsx loader + 内核模块图），
// 峰值线性叠加（19GB 事故的乘法项之一）。全局同时在跑 export worker ≤2，超出排队
//（不 409——跨书导出可等，用户无感；单书并发仍走 task-gate 409 语义不变）。
// acquireExportSlot 导出仅供测试断言排队/放行。
const MAX_EXPORT_WORKERS = 2
/** 排队/在途任务被取消（客户端断开 / 服务关停）时的统一文案——
 *  与 worker 侧 abortMessage 同口径（无接收方，仅服务端日志与直测面判别用）。 */
const EXPORT_CANCEL_TEXT = '导出已取消，已终止导出工作线程'
// 等待面封顶——此前 FIFO 队列无界、等待无超时：队首 worker 挂死
// 时全体 waiter 无限滞留（前端转圈、全局导出不可用且无出口）。排队上限防请求堆积
// 雪崩；单 waiter 超时给滞留者明确出口（导出是分钟级任务，10min 足够宽）。超限/
// 超时回 503 BUSY（可重试语义），与单书 task-gate 409 口径区分。
const MAX_EXPORT_WAITERS = 8
/** 单 waiter 等待超时（生产口径 10min）。 收尾：
 * __setExportWaitTimeoutForTest / getExportWaitTimeoutMs 模块级覆盖档删除——改
 * acquireExportSlot 尾参（组装根 RouteOverrides 经 handler / 直测面显式传入，
 * undefined = 10min 逐位不变）。 */
const EXPORT_WAIT_TIMEOUT_MS = 10 * 60_000
export class ExportSlotWaitError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'ExportSlotWaitError'
  }
}

/** 导出全局并发闸（实例态；对齐 TaskGate 模式）——原为模块级
 *  `let activeExportWorkers` + `const exportWaiters`：同进程多 server 实例共享同一份
 *  计数/队列（一族实例的占位可让另一族实例的导出排队，测试面亦跨档串扰）。
 *  现改随组装根实例化：进程内生产组装一份（语义等价——生产恒单实例），测试自建即隔离。
 *  语义（名额转移/FIFO/封顶/超时/防重复释放）逐位不变，仅状态载体由模块级改为实例闭包。 */
export interface ExportSlotGate {
  /** 取名额：满员排队（≤MAX_EXPORT_WAITERS，超出即拒）；waitTimeoutMs = 本次等待覆盖档
   *  （undefined/null = 生产口径 10min）。signal = 取消通道（客户端断开 / 服务关停）：
   *  已取消时不入队直接拒，排队中取消则立刻摘队并按取消语义拒（槽位不被占满至等待档到期）。
   *  返回 release（幂等，名额转移给队首 waiter）。 */
  acquire(waitTimeoutMs?: number | null, signal?: AbortSignal): Promise<() => void>
}

export function createExportSlotGate(): ExportSlotGate {
  let activeExportWorkers = 0
  const exportWaiters: Array<() => void> = []

  /**
   * 释放函数（批注见 acquire）：名额转移语义——release 时若有
   * waiter，不自减计数、直接 shift 队列并 resolve（名额直接转移给 waiter，waiter
   * 恢复后不再自增）；无 waiter 才自减。released 门防重复释放（二次转移/二次自减
   * 都会破坏计数不变量）。
   */
  function makeReleaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = exportWaiters.shift()
      if (next) {
        next() // 名额转移：activeExportWorkers 不变（waiter 恢复后不再自增）
        return
      }
      activeExportWorkers--
    }
  }

  const acquire = async (waitTimeoutMs?: number | null, signal?: AbortSignal): Promise<() => void> => {
    const waitMs = waitTimeoutMs ?? EXPORT_WAIT_TIMEOUT_MS
    // 取消早于取名额（客户端已断开 / 关停已下发）：不入队、不占位，直接按取消语义拒绝。
    // 与排队中取消同一收口语义——调用方的 catch 分支按取消处理并随即释放 task-gate 槽。
    if (signal?.aborted) throw new WorkerJobAbortedError(EXPORT_CANCEL_TEXT)
    if (activeExportWorkers >= MAX_EXPORT_WORKERS) {
      // 队列封顶——超限直接拒（不无限堆积）
      if (exportWaiters.length >= MAX_EXPORT_WAITERS) {
        throw new ExportSlotWaitError(`导出排队已达上限（${MAX_EXPORT_WAITERS}），请稍后重试`)
      }
      // 等待限时/取消——resolve、timeout、abort 三方竞速，先到者定局（单线程
      // 事件循环下三者互斥执行）；超时方与取消方都把自己从队列摘除再抛错，防 release
      // shift 到已废弃的 waiter 名额转移落空
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const abortWaiter = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          const idx = exportWaiters.indexOf(wrapped)
          if (idx !== -1) exportWaiters.splice(idx, 1)
          reject(new WorkerJobAbortedError(EXPORT_CANCEL_TEXT))
        }
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', abortWaiter)
          const idx = exportWaiters.indexOf(wrapped)
          if (idx !== -1) exportWaiters.splice(idx, 1)
          reject(new ExportSlotWaitError(`导出排队等待超时（${Math.round(waitMs / 60_000)} 分钟），请稍后重试`))
        }, waitMs)
        const wrapped = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', abortWaiter)
          resolve()
        }
        // 排队中取消（客户端断开 / 服务关停）：立刻摘队并拒绝——占位请求长时间排队时
        // 不取消会把 task-gate 槽连同队列位置一起占住（最长到 10min 等待档）。
        signal?.addEventListener('abort', abortWaiter, { once: true })
        exportWaiters.push(wrapped)
      })
      // 名额已由 release 直接转移（release 未自减、直接 resolve
      // 本 waiter）——此处不再自增。原「release 先自减再 resolve、waiter 微任务恢复后
      // 才自增」存在窗口：窗口内新请求查 activeExportWorkers < MAX 即插队直接放行，
      // 瞬时并发超 MAX=2（违反全局闸设计意图）。转移语义下 FIFO 不变（shift 保序）。
      return makeReleaser()
    }
    // 到这里必有空位：同步块内 check+increment 无 await，原子
    activeExportWorkers++
    return makeReleaser()
  }

  return { acquire }
}

/** 进程默认导出闸实例——不接组装根的直调面（测试/脚本）取用；生产经组装根注入实例。 */
export const processExportSlotGate: ExportSlotGate = createExportSlotGate()

/**
 * 在途导出作业的取消登记（组装根实例态，随 server 实例）。
 *
 * 为什么需要：导出取消要有两路触发（客户端断连 = 单请求级；服务关停 = 全实例级），
 * 后者没有请求对象可挂——组装根 close 收尾时须能枚举本实例全部在途导出并 abort。
 * 与 task-gate/exportGate 同口径：状态归实例，进程内多实例互不牵连（生产恒单实例）。
 * 登记/注销成对（handler finally 必调注销），abortAll 幂等（已 abort 的 controller
 * 再 abort 是 no-op；cancel() 清除登记后重复调用零副作用）。
 */
export interface ExportCancelRegistry {
  /** 登记一枚在途作业的 controller，返回注销函数（handler finally 必调） */
  register(ctrl: AbortController): () => void
  /** 关停收尾：abort 全部在途作业（不等待 settle——调用方随后的在途等待收口） */
  abortAll(): void
}

export function createExportCancelRegistry(): ExportCancelRegistry {
  const inFlight = new Set<AbortController>()
  return {
    register: (ctrl) => {
      inFlight.add(ctrl)
      return () => {
        inFlight.delete(ctrl)
      }
    },
    abortAll: () => {
      for (const ctrl of [...inFlight]) ctrl.abort()
    },
  }
}

/** 模块级委托壳（对齐 task-gate 的 acquireTaskGate 先例）：直调面沿用旧名——
 *  收尾：waitTimeoutMs = 本次等待的超时覆盖档（undefined = 生产口径 10min 逐位不变）。
 *  生产路径不经此壳（组装根注入实例），仅为存量直测面保持名与语义。 */
export function acquireExportSlot(waitTimeoutMs?: number | null, signal?: AbortSignal): Promise<() => void> {
  return processExportSlotGate.acquire(waitTimeoutMs, signal)
}


export function registerIoRoutes(ctx: IoCtx): void {
  // 清偿-导出未过滤提示：透传定稿过滤标记——
  defineRoute('books.export', {
    method: 'POST',
    path: '/api/books/:name/export',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      if (!ctx.workDir) return replyError(res, 400, 'NO_WORKDIR', '未定位到工作目录')
      // handler 内冗余 token 复核删除——
      // 写闸（index.ts isWrite safeTokenCompare）在路由分派前已拦一切 POST，此处重复
      // 校验误导安全模型分层判断（其余写 handler 均无此行）
      const r = resolveBookOrReply(ctx.workDir, params['name'], res)
      if (!r) return
      // export 并发闸（acquireTaskGate 同款）——双击并发 exportBook 会
      // rmSync 同一导出目录互删 → ENOENT 500。同步占位（无 TOCTOU）、finally 释放，
      // 并发第二请求 409（与 analyze/batch-finalize 闸同口径）。闸留本进程持闸跨
      // await（worker 执行期间仍占闸，并发语义不变）。
      const release = ctx.gate.acquire(params['name']!, 'export')
      if (!release) return replyError(res, 409, 'BUSY', '本书已有导出任务在跑，请等待完成后再试')
      let releaseGlobal: (() => void) | null = null
      // 本请求的取消 controller：worker 在途期间两路可触发（客户端断连 / 服务关停）。
      // 建点必须在取到闸后——闸被拒的请求零在途作业，不该进关停取消面。
      const ctrl = new AbortController()
      // 客户端断连判据同 task-gate.attachClientGoneAbort：res 'close' 在
      // 「响应已正常写完」与「连接异常中断」两会触发，只有后者（writableEnded 仍假）
      // 应取消；正常写完时在途作业已 settle，此处只是避免误 abort 已落定的 controller。
      const onClientGone = (): void => {
        if (!res.writableEnded) ctrl.abort()
      }
      res.on('close', onClientGone)
      const unregisterCancel = ctx.cancels.register(ctrl)
      try {
        const body = await readJson(req)
        // 显式非法值回 400（与全域 fail-fast 口径一致）；缺省
        //（undefined）保留回落 both/generic（兼容不带参调用方）
        const formatRaw = body['format'] === undefined ? 'both' : String(body['format'])
        if (!EXPORT_FORMATS.has(formatRaw)) {
          return replyError(
            res,
            400,
            'BAD_INPUT',
            `非法导出格式「${formatRaw}」，允许：${[...EXPORT_FORMATS].join(' / ')}`,
          )
        }
        const platformRaw = body['platform'] === undefined ? 'generic' : String(body['platform'])
        if (!PLATFORMS.has(platformRaw)) {
          return replyError(
            res,
            400,
            'BAD_INPUT',
            `非法导出平台「${platformRaw}」，允许：${[...PLATFORMS].join(' / ')}`,
          )
        }
        // 输出形态同口径（缺省 md 兼容不带参调用方）
        const outputRaw = body['output'] === undefined ? 'md' : String(body['output'])
        if (!EXPORT_OUTPUTS.has(outputRaw)) {
          return replyError(
            res,
            400,
            'BAD_INPUT',
            `非法输出形态「${outputRaw}」，允许：${[...EXPORT_OUTPUTS].join(' / ')}`,
          )
        }
        const format: ExportFormat = formatRaw as ExportFormat
        const platform: ExportPlatform = platformRaw as ExportPlatform
        const output: ExportOutput = outputRaw as ExportOutput
        // 收尾：等待超时覆盖档经 ctx（组装根 RouteOverrides）传入；闸实例同源注入。
        // 取消通道一并透传：排队中取消即摘队拒（不再占着槽位等满等待档）。
        releaseGlobal = await ctx.exportGate.acquire(ctx.exportWaitTimeoutMs ?? undefined, ctrl.signal)
        const result = await trackInFlightWork(
          runExportBookAsync(
            { bookRoot: r.bookRoot, format, platform, output },
            { signal: ctrl.signal, ...(ctx.exportWorkerUrl ? { workerUrl: ctx.exportWorkerUrl } : {}) },
          ),
        )
        // （补修）：业务失败回 422 错误信封——原 200 {ok:false} 是全域
        // 错误信封唯一豁免点，旧注释「apiJson 当异常抛吞诊断信息」已被 dv-01 错误
        // 信封判别取代（有信封 → body.error 完整保留，ExportDialog catch 后原样展示）。
        // 成功负载为域形状（chapterCount/unit/files），不透传 CLI 进程信封
        if (!result.ok) return replyError(res, 422, 'EXPORT_FAILED', result.error ?? '导出失败')
        reply(res, 200, {
          ok: true,
          chapterCount: result.chapterCount,
          unit: result.unit,
          files: result.files,
          // 清偿-导出未过滤提示：透传定稿过滤标记——
          // 清单缺失兜底导出（含未定稿章）时前端据此明示
          finalizedFilter: result.finalizedFilter,
          // 透传被滤草稿章计数——内核 ExportResult 早已携带
          // 但信封漏发，前端无法提示「已跳过 N 个草稿章」
          skippedDrafts: result.skippedDrafts,
        })
      } catch (e) {
        // 排队超限/超时给 503 信封（可重试），不再直穿 500 兜底
        if (e instanceof ExportSlotWaitError) {
          return replyError(res, 503, 'BUSY', e.message)
        }
        // 取消（客户端断连 / 服务关停）：客户端已无可回之处（连接已断）或服务正在关停，
        // 回 499 信封仅为直测面与日志留痕；此处不上抛 500 兜底——取消是既定语义非故障。
        if (isWorkerJobAborted(e)) {
          return replyError(res, 499, e.code, e.message)
        }
        throw e
      } finally {
        // 释放序：先撤在途登记与断连监听（此后 abort 不再生效），再放闸——
        // 取消后的主要收益即本行：abort settle 后立即归位，不占槽等 120s 超时。
        res.off('close', onClientGone)
        unregisterCancel()
        releaseGlobal?.()
        release()
      }
    },
  })
}
