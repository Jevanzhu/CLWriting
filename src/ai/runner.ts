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
import { createProvider, currentProvider, type ModelProvider } from './provider/index.js'
import { tryMockTool } from './mock-tool.js'

/** 未定位到应用数据目录（统一文案） */
export const NO_USERDATA_MSG = '未定位到应用数据目录'
/** 未配置 AI 服务供应商（统一文案） */
export const NO_PROVIDER_MSG = '未配置 AI 服务供应商。请在设置 → AI 中添加并启用。'

export type TaskCode = 'NO_USERDATA' | 'NO_PROVIDER' | 'GEN_FAIL' | 'ABORTED'

export interface TaskErr {
  ok: false
  code: TaskCode
  error: string
}

export interface TaskOk<T> {
  ok: true
  data: T
  ctrl: AbortController
}

export type TaskResult<T> = TaskOk<T> | TaskErr

/**
 * 解析当前供应商 provider（统一错误文案）。
 * `ok:false` 时 code 恒为 NO_USERDATA / NO_PROVIDER。
 */
export function resolveProvider(
  userDataPath: string | null,
): { ok: true; provider: ModelProvider } | { ok: false; code: 'NO_USERDATA' | 'NO_PROVIDER'; error: string } {
  if (!userDataPath) return { ok: false, code: 'NO_USERDATA', error: NO_USERDATA_MSG }
  const conf = currentProvider(userDataPath)
  if (!conf) return { ok: false, code: 'NO_PROVIDER', error: NO_PROVIDER_MSG }
  return { ok: true, provider: createProvider(conf) }
}

/**
 * 跑一次 AI 任务。
 *
 * @param opts.mockTool  mock 快路（工具型）：CLWRITING_DRIVER=mock 时先试 tryMockTool(toolName)，
 *                       命中则 data = {input, text, usage}（调用方按真实生成同款 decode，mock/真实代码路径一致）。
 * @param opts.mockText  mock 快路（文本型）：CLWRITING_DRIVER=mock 时直接返回该值（如 outline 的固定细纲）。
 * @param opts.register   登记 ctrl → driver（interrupt / isRunning 生效）。生成结束不自动注销——
 *                        isRunning 设 true 表示「本 session 有生成在途」，由下次 role_spawn/新任务刷新或 dispose 兜底。
 * @param opts.run        真实生成。异常统一包成 GEN_FAIL（abort 导致的异常 → ABORTED）。
 */
export async function runTask<T>(opts: {
  userDataPath: string | null
  mockTool?: string
  mockText?: T
  register?: (ctrl: AbortController) => void
  run: (provider: ModelProvider, signal: AbortSignal) => Promise<T>
}): Promise<TaskResult<T>> {
  // mock 快路（工具型）：tryMockTool 命中即短路，不触 provider
  if (opts.mockTool) {
    const mock = tryMockTool(opts.mockTool)
    if (mock) return { ok: true, data: mock as unknown as T, ctrl: new AbortController() }
  }
  // mock 快路（文本型）：直接返回预定值
  if (opts.mockText !== undefined) {
    return { ok: true, data: opts.mockText, ctrl: new AbortController() }
  }

  const r = resolveProvider(opts.userDataPath)
  if (!r.ok) return r

  const ctrl = new AbortController()
  if (opts.register) opts.register(ctrl)
  try {
    return { ok: true, data: await opts.run(r.provider, ctrl.signal), ctrl }
  } catch (e) {
    if (ctrl.signal.aborted) return { ok: false, code: 'ABORTED', error: '已中断' }
    return { ok: false, code: 'GEN_FAIL', error: e instanceof Error ? e.message : String(e) }
  }
}