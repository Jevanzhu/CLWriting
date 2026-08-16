/**
 * 编排层统一执行器（方案 §三 / 审查 §八③）。
 *
 * 收敛每条 AI 端点各自手抄的骨架：
 *   mock 快路 → 取 provider（统一错误文案）→ 建可中断 ctrl → 生成 → 错误打包。
 *
 * 收益（审查 §三 的三条症状）：
 *   1. 「未配置供应商」文案集中一处，不再 6 文件 6 份手抄（改文案只改这里）；
 *   2. mock 快路统一（tryMockTool / mockText 两形态）——self-heal 补上后六条路径齐备；
 *   3. AbortController 统一创建，register 可交给 driver（interrupt / isRunning 据此生效，
 *      P1-2：/spawn 等 fire-and-forget 链路可真正中断）。
 */
import { createProvider, loadProviders, saveProviders, registerDegradedPersist, registerDegradedLookup, tierFromStore, type ModelProvider, type TierSlot, type TokenUsage } from './provider/index.js'
import { tryMockTool } from './mock-tool.js'
import { GenError } from './gen.js'
import { newRunId, promptMeta, toTraceUsage } from './trace.js'
import { recordAiCall, recordTaskUsage } from './calls.js'
import { openSessionStore, bookHash } from '../events/store.js'
import { ChainRecorder, layerForTask, stepStartEvent, stepEndEvent, llmCallEvent, llmRetryEvent } from '../events/chain-bridge.js'
import type { StepEndReason } from '../events/types.js'
import { DEFAULT_RETRY_POLICY, backoffDelayMs, shouldRetryError } from './retry-policy.js'

/** AA-P3-5：降级记忆「已写一次」per-key 内存标记（userDataPath 维度隔离，防跨库/跨测试污染）。
 *  同 path 同 key 只写一次（load→改→save 是读改写三段——写频越低，「多书并发 400 时互相覆盖
 *  丢他键」的窗口越小）；失败不标记，下次 persistDegraded 自动重试。 */
const degradedPersistedKeys = new Set<string>()

/** 未定位到应用数据目录（统一文案） */
export const NO_USERDATA_MSG = '未定位到应用数据目录'
/** 未配置 AI 服务供应商（统一文案） */
export const NO_PROVIDER_MSG = '未配置 AI 服务供应商。请在设置 → AI 中添加并启用。'
/** 未选择模型（统一文案） */
export const NO_MODEL_MSG = '请先在设置 → AI 中配置模型档位。'

export type TaskCode = 'NO_USERDATA' | 'NO_PROVIDER' | 'NO_MODEL' | 'GEN_FAIL' | 'ABORTED' | 'TIMEOUT_TOTAL'

export interface TaskErr {
  ok: false
  code: TaskCode
  error: string
}

export interface TaskOk<T> {
  ok: true
  data: T
  ctrl: AbortController
  /** 本次生成的 token 用量（run 回调返回值含 usage 字段时自动提取；mock 快路为 null） */
  usage: TokenUsage | null
  /** 本次调用的唯一标识（贯穿 trace/SSE/记账三路） */
  runId: string
}

export type TaskResult<T> = TaskOk<T> | TaskErr

/** B-1/B4：可重试错误的退避重试（策略集中在 retry-policy.ts：指数退避+对称抖动+Retry-After 封顶） */
const RETRY_POLICY = DEFAULT_RETRY_POLICY
/** B-2：整体超时默认上限（档位 timeoutMs 可覆盖） */
const DEFAULT_TIMEOUT_MS = 600_000 // 10 min

/** 可中断 sleep（abort 到达立即 resolve，不继续等退避）。
 *  超时 resolve 后主动移除 abort listener，防重试循环累积孤儿 listener。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const onAbort = (): void => { clearTimeout(t); resolve() }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 从 run 回调返回值提取 usage（如有 { usage: TokenUsage } 字段） */
function extractUsage(data: unknown): TokenUsage | null {
  if (typeof data === 'object' && data !== null && 'usage' in data) {
    const u = (data as Record<string, unknown>)['usage']
    if (u && typeof u === 'object' && 'inputTokens' in u && 'outputTokens' in u) {
      return u as TokenUsage
    }
  }
  return null
}

/** 从 run 回调返回值提取 stopReason（如有 { stopReason: string } 字段） */
function extractStopReason(data: unknown): string {
  if (typeof data === 'object' && data !== null && 'stopReason' in data) {
    return String((data as Record<string, unknown>)['stopReason'])
  }
  return 'end_turn'
}

/**
 * 解析当前供应商 provider（统一错误文案）。
 * `ok:false` 时 code 恒为 NO_USERDATA / NO_PROVIDER / NO_MODEL。
 */
export function resolveProvider(
  userDataPath: string | null,
  tierKind: 'creative' | 'assistant' | 'chat' = 'creative',
): { ok: true; provider: ModelProvider; tier: TierSlot } | { ok: false; code: 'NO_USERDATA' | 'NO_PROVIDER' | 'NO_MODEL'; error: string } {
  if (!userDataPath) return { ok: false, code: 'NO_USERDATA', error: NO_USERDATA_MSG }
  // 注册降级记忆落盘回调（适配器只改内存 clone，落盘经 store 模块转发；
  // 同 path 重复注册无害）
  registerDegradedPersist((key) => {
    // AA-P3-5：W-P2-9 的「只写一次」升为 per-key 内存标记——同 path 同 key 只写一次
    // （load→改→save 的读改写窗口在多书并发 400 时可互相覆盖丢他键；标记命中即跳过，
    //  写频降到每 key 一次）。失败不标记 → 下次 persistDegraded 自动重试。
    const memoKey = `${userDataPath}\u0000${key}`
    if (degradedPersistedKeys.has(memoKey)) return
    const s = loadProviders(userDataPath)
    if (s.modelCaps[key]?.structured === false) {
      // 读盘已含（他进程/他处写过）→ 也标（防重复 load 扫描）
      degradedPersistedKeys.add(memoKey)
      return
    }
    s.modelCaps[key] = { structured: false }
    saveProviders(userDataPath, s)
    degradedPersistedKeys.add(memoKey)
  })
  // D2：降级记忆新鲜读——适配器实例缓存（registry settings hash）后不再依赖
  // 创建时捕获的 store 快照；loadProviders 有 mtime 缓存，高频 stream 代价可忽略
  registerDegradedLookup((key) => {
    const s = loadProviders(userDataPath)
    return s.modelCaps[key]?.structured === false ? true : undefined
  })
  // 只 loadProviders 一次（含 vault 解密），后续 conf / tier 全从同一 store 派生
  const s = loadProviders(userDataPath)
  const conf = s.currentId ? (s.providers.find((p) => p.id === s.currentId) ?? null) : null
  if (!conf) return { ok: false, code: 'NO_PROVIDER', error: NO_PROVIDER_MSG }
  // D 档：模型从任务档位取（creative/assistant），档位未配模型时回落 currentModel
  const tier = tierFromStore(s, tierKind)
  if (!tier.model) return { ok: false, code: 'NO_MODEL', error: NO_MODEL_MSG }
  // 表驱动重构（§6.3）：modelCaps 探测退役——能力由静态表判定；
  // store 传入适配器供降级记忆读写（§6.5）
  return { ok: true, provider: createProvider({ ...conf, model: tier.model }, s), tier }
}

/**
 * 跑一次 AI 任务。
 *
 * @param opts.mockTool  mock 快路（工具型）：CLWRITING_DRIVER=mock 时先试 tryMockTool(toolName)，
 *                       命中则 data = {input, text, usage}（调用方按真实生成同款 decode，mock/真实代码路径一致）。
 * @param opts.mockText  mock 快路（文本型）：CLWRITING_DRIVER=mock 时直接返回该值（如 outline 的固定细纲）。
 * @param opts.tierKind  任务档位（决定取用哪个模型）；缺省 creative。
 * @param opts.register  登记 ctrl → driver（interrupt / isRunning 生效）。生成结束不自动注销——
 *                        isRunning 设 true 表示「本 session 有生成在途」，由下次 role_spawn/新任务刷新或 dispose 兜底。
 * @param opts.run        真实生成。异常统一包成 GEN_FAIL（abort 导致的异常 → ABORTED）。
 * @param opts.onReset    重试前回调——调用方在此推 reset 事件清前端缓冲（B-1：流式重试防重复产出）。
 */
/**
 * P2：建链路事件录制器（userDataPath + bookRoot + task 齐备才建；失败静默 → null）。
 * workspace 会话的 book 标识 = bookHash(bookRoot)（与对话会话的 bookName 隔离，互不干扰）。
 */
function mkChain(
  userDataPath: string | null,
  bookRoot: string | undefined,
  task: string | undefined,
): ChainRecorder | null {
  if (!userDataPath || !bookRoot || !task) return null
  try {
    const store = openSessionStore(userDataPath, bookRoot)
    if (!store) return null
    const sessionId = store.workspaceSession(bookHash(bookRoot))
    return new ChainRecorder(store, sessionId)
  } catch {
    return null
  }
}

export async function runTask<T>(opts: {
  userDataPath: string | null
  mockTool?: string
  mockText?: T
  /** 任务档位（决定取用哪个模型）；缺省 creative */
  tierKind?: 'creative' | 'assistant' | 'chat'
  /** 外部传入的 ctrl（如 self-heal 的编排级 AbortController）；缺省新建 */
  ctrl?: AbortController
  register?: (ctrl: AbortController) => void
  /** 重试前调用（让调用方推 reset 事件清前端缓冲；无产出时调用亦无害） */
  onReset?: () => void
  /** 重试回调（429/5xx 等可重试错误退避前触发）——调用方推 warning 告知前端「AI 响应异常，即将重试」 */
  onRetry?: (attempt: number, error: string) => void
  run: (provider: ModelProvider, signal: AbortSignal, tier: TierSlot) => Promise<T>
  /** 任务名（trace + 记账用，如 'self-heal' / 'analysis'） */
  task?: string
  /** 书库根路径（trace + 记账用） */
  bookRoot?: string
  /** prompt 文本（trace 脱敏用；不传则 promptMeta 为空） */
  promptText?: string
  /** system prompt 文本（B-P2-2：trace hash 纳入 system prompt，防同 user prompt 不同规则状态 hash 冲突） */
  systemPrompt?: string
  /** 章号（仅 self-heal 传；记账 chapter 块 + 预算闸用） */
  chapter?: number
}): Promise<TaskResult<T>> {
  const runId = newRunId()
  const startMs = Date.now()
  const tierKind = opts.tierKind ?? 'creative'
  const bookRoot = opts.bookRoot
  const task = opts.task

  // P2：链路事件录制器——先于 mock 快路初始化（P3-6：此前 mkChain 在 mock 快路之后才建，
  // mock 命中的回合不产生任何链路事件，审计流里是黑洞；现提前建，快路也记 step/llm）
  let chain: ChainRecorder | null = null

  /** P2：llm/call 事件（替代 trace 文件落盘；bookRoot + task 齐备才记；观测层静默） */
  const trace = (p: {
    model: string
    attempt: number
    stopReason: string
    usage: TokenUsage | null
    ok: boolean
    errCode?: string
  }): void => {
    if (!bookRoot || !task) return
    chain?.add(
      llmCallEvent({
        runId,
        task,
        tierKind,
        model: p.model,
        attempt: p.attempt,
        stopReason: p.stopReason,
        usage: p.usage ? toTraceUsage(p.usage) : undefined,
        durationMs: Date.now() - startMs,
        ok: p.ok,
        ...(p.errCode ? { errCode: p.errCode } : {}),
        ...(opts.promptText
          ? { promptMeta: promptMeta(opts.systemPrompt ?? '', opts.promptText) }
          : {}),
      }),
    )
  }

  // P3-6：step/start 先落库（mock 快路 / resolveProvider 失败路径在其后各自收尾）
  chain = mkChain(opts.userDataPath, bookRoot, task)
  if (chain) chain.add(stepStartEvent(task!, layerForTask(task!)))
  let stepReason: StepEndReason | undefined

  /** mock 快路收尾：step/end + 释放 chain（防 finally 双 close；P3-6 补记链路事件） */
  const finishMock = (): void => {
    stepReason = 'completed'
    if (chain) {
      chain.add(stepEndEvent(task!, layerForTask(task!), 'completed'))
      chain.close()
      chain = null
    }
  }

  // mock 快路（工具型）：tryMockTool 命中即短路，不触 provider
  if (opts.mockTool) {
    const mock = tryMockTool(opts.mockTool)
    if (mock) {
      trace({ model: 'mock', attempt: 0, stopReason: 'mock', usage: null, ok: true })
      finishMock()
      return { ok: true, data: mock as unknown as T, ctrl: new AbortController(), usage: null, runId }
    }
  }
  // mock 快路（文本型）：CLWRITING_DRIVER=mock 时直接返回预定值（守卫位置与 tryMockTool 对称，P0-1）
  if (opts.mockText !== undefined && process.env['CLWRITING_DRIVER'] === 'mock') {
    trace({ model: 'mock', attempt: 0, stopReason: 'mock', usage: null, ok: true })
    finishMock()
    return { ok: true, data: opts.mockText, ctrl: new AbortController(), usage: null, runId }
  }

  const r = resolveProvider(opts.userDataPath, tierKind)
  if (!r.ok) {
    trace({ model: '', attempt: 0, stopReason: 'error', usage: null, ok: false, errCode: r.code })
    // P3-6：step/start 已落——失败路径也必须 step/end 收尾（防孤儿 step/start）
    stepReason = 'error'
    if (chain) {
      chain.add(stepEndEvent(task!, layerForTask(task!), 'error'))
      chain.close()
      chain = null
    }
    return r
  }

  const ctrl = opts.ctrl ?? new AbortController()
  if (opts.register) opts.register(ctrl)

  // B-2：整体超时（档位 timeoutMs 可覆盖默认 10min）——abort ctrl，由下方 catch 区分超时 vs 用户中断
  // tier 复用 resolveProvider 已算出的（不再单独调 resolveTier，省 1 次 loadProviders + vault 解密）
  const tier = r.tier
  const timeoutMs = tier.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timedOut = false
  const totalTimer = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)

  const timeoutAbort = (): TaskErr =>
    timedOut
      ? { ok: false, code: 'TIMEOUT_TOTAL', error: `生成超时（超过 ${timeoutMs / 60_000} 分钟）` }
      : { ok: false, code: 'ABORTED', error: '已中断' }

  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await opts.run(r.provider, ctrl.signal, r.tier)
        const usage = extractUsage(data)
        // T5：记账下沉（task 块全端点覆盖；chapter 块仅 self-heal 传 chapter 时记）
        if (bookRoot) {
          if (task) recordTaskUsage(bookRoot, task, usage)
          if (opts.chapter !== undefined) recordAiCall(bookRoot, opts.chapter, usage)
        }
        trace({ model: tier.model, attempt, stopReason: extractStopReason(data), usage, ok: true })
        stepReason = extractStopReason(data) === 'max_tokens' ? 'max-tokens' : 'completed'
        return { ok: true, data, ctrl, usage, runId }
      } catch (e) {
        // abort 优先——中断必须立即生效，不进退避
        if (ctrl.signal.aborted) {
          // X-P2-10：中断/超时的调用也是真实消耗——按次入账（无 usage，token 记 0），
          // 否则中断重跑可绕过预算闸（task/chapter 两块与成功/重试路径同口径）
          if (bookRoot) {
            if (task) recordTaskUsage(bookRoot, task, null)
            if (opts.chapter !== undefined) recordAiCall(bookRoot, opts.chapter, null)
          }
          trace({ model: tier.model, attempt, stopReason: timedOut ? 'timeout' : 'aborted', usage: null, ok: false, errCode: timedOut ? 'TIMEOUT_TOTAL' : 'ABORTED' })
          // AA-P3-4：step/end 终止原因不再恒等——超时按 STEP_END_REASONS 口径记
          // 'interrupted'（执行被强制中止），用户中断记 'aborted'（审计可区分两类终止）
          stepReason = timedOut ? 'interrupted' : 'aborted'
          return timeoutAbort()
        }
        // B-1/B4：可重试（429/5xx/超时/网络，code 命中或布尔兜底）且未超限 → 退避后重试
        if (e instanceof GenError && shouldRetryError(RETRY_POLICY, e) && attempt < RETRY_POLICY.maxRetries) {
          const delay = backoffDelayMs(RETRY_POLICY, attempt + 1, {
            ...(e.retryAfterMs !== undefined ? { providerRetryAfterMs: e.retryAfterMs } : {}),
          })
          // B4：服务端 Retry-After 超过封顶 → 尊重其「等多久」的判断，不重试（终态）
          if (delay === null) {
            if (bookRoot) {
              if (task) recordTaskUsage(bookRoot, task, null)
              if (opts.chapter !== undefined) recordAiCall(bookRoot, opts.chapter, null)
            }
            trace({
              model: tier.model,
              attempt,
              stopReason: 'error',
              usage: null,
              ok: false,
              errCode: 'RETRY_AFTER_OVER_CAP',
            })
            stepReason = 'error'
            return {
              ok: false,
              code: 'GEN_FAIL',
              error: `服务端要求等待 ${Math.round(e.retryAfterMs! / 1000)}s 后重试（超过 ${RETRY_POLICY.maxDelayMs / 1000}s 上限），已停止重试：${e.message}`,
            }
          }
          // W-P2-8：重试也是真实 API 消耗——按次入账（失败响应无 usage，token 记 0），
          // 否则单章最多 1+maxRetries 次调用只计 1 次，预算闸可被超限 4 倍
          if (bookRoot) {
            if (task) recordTaskUsage(bookRoot, task, null)
            if (opts.chapter !== undefined) recordAiCall(bookRoot, opts.chapter, null)
          }
          // N5：失败 attempt 入 trace（429/5xx 无 usage，但可审计重试链）
          // A5：errCode 细化——有结构化 code（RATE_LIMIT/SERVER_ERROR/TIMEOUT…）优先于笼统 RETRYABLE
          trace({ model: tier.model, attempt, stopReason: 'error', usage: null, ok: false, errCode: e.code ?? 'RETRYABLE' })
          // Bug C：重试前通知调用方（前端可见「AI 响应异常，重试中」，不再静默卡死）
          opts.onRetry?.(attempt, e.message)
          opts.onReset?.()
          // P2：llm/retry 重试记账（先落库后等待）——重试链可重放
          chain?.add(llmRetryEvent({ attempt, delayMs: delay, ...((e instanceof GenError && e.code) ? { errCode: e.code } : {}) }))
          chain?.flush() // Z-P2-7：批缓冲下显式落盘，保住「先落库后等待」语义
          await sleep(delay, ctrl.signal)
          if (ctrl.signal.aborted) {
            trace({ model: tier.model, attempt, stopReason: timedOut ? 'timeout' : 'aborted', usage: null, ok: false, errCode: timedOut ? 'TIMEOUT_TOTAL' : 'ABORTED' })
            // AA-P3-4：同第一处——超时 'interrupted' vs 用户中断 'aborted'
            stepReason = timedOut ? 'interrupted' : 'aborted'
            return timeoutAbort()
          }
          continue
        }
        // X-P2-10：终态失败的调用同样入账（成功/重试/中断/失败四路同口径，预算闸不再被失败路径绕过）
        if (bookRoot) {
          if (task) recordTaskUsage(bookRoot, task, null)
          if (opts.chapter !== undefined) recordAiCall(bookRoot, opts.chapter, null)
        }
        // A5：终态失败 errCode 细化——结构化 code 优先于笼统 GEN_FAIL（trace-stats 口径不变，仍是非空字符串）
        trace({
          model: tier.model,
          attempt,
          stopReason: 'error',
          usage: null,
          ok: false,
          errCode: (e instanceof GenError && e.code) || 'GEN_FAIL',
        })
        stepReason = 'error'
        return { ok: false, code: 'GEN_FAIL', error: e instanceof Error ? e.message : String(e) }
      }
    }
  } finally {
    clearTimeout(totalTimer)
    // P2：step/end 结构化终止原因（先落库后清理）——五层链路终止可查
    if (chain) {
      if (stepReason) chain.add(stepEndEvent(task!, layerForTask(task!), stepReason))
      chain.close()
    }
  }
}
