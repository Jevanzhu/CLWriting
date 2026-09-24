/**
 * 全自动写章 · 生成入口族（缝 B）—— R0916-5g（2026-09-16，⑤④产品巨件拆分波3）
 * 自 self-heal.ts 纯移动拆出：runGenerate 生成入口（genFn 单测替身与 provider +
 * tool_use 双路、accountUsage 计价单源闭包、assembleChapter 拼装与自由文本降级、
 * max_tokens 截断告警）、emitMockPreview（mock 快路码点流式补发）、emit 事件发射
 * 助手（生成族系 emit 最重消费方，助手随族迁此单源，残核回引保持单向边）。
 * 依赖方向单向（运行时无环）：残核 self-heal.ts import 本文件（runGenerate/emit）；
 * 本文件对残核与登记件 self-heal-registry.ts 仅 import type（SelfHealOpts/
 * RunState），经 verbatimModuleSyntax 擦除不落运行时边，自身零顶层求值常量。
 * 运行登记族见 self-heal-registry.ts（缝 A）；编排主流程残核与 re-export 桥在
 * self-heal.ts（全库消费方 import 面零改动）。注释全部原样随迁；行为零改动。
 * 原私有而残核消费项（runGenerate/emit）就此导出，SpawnResult/emitMockPreview
 * 保持私有。
 */

import { assembleChapter } from '../contract/index.js'
import { runSpec } from '../tasks/spec.js'
import { selfHealSpec } from '../tasks/specs.js'
import { redactSecret } from '../provider/redact.js' // R43-19（四十三轮）：SSE 错误事件脱敏第二层
import { resolveModelPricing, computeCallCost } from '../pricing.js'
import { preserveStructureFmForChapter } from '../../format/chapter-lookup.js'
import { errMsg } from '../../log/index.js'
import type { DriverEvent } from '../../driver/index.js'
import type { TokenUsage } from '../provider/types.js'
import type { SelfHealOpts } from './self-heal.js'
import type { RunState } from './self-heal-registry.js'

type SpawnResult =
  | { status: 'ok'; text: string }
  | { status: 'aborted' }
  | { status: 'error'; error: string }

/**
 * 生成入口：优先用注入的 genFn（单测），否则用 provider + tool_use。
 * text 逐字转发主 session（前端实时见产出）。
 */
export async function runGenerate(
  opts: SelfHealOpts,
  state: RunState,
  kind: 'long' | 'short',
  userPrompt: string,
  chapter = opts.chapter, // P2-3：批量时传当前章（单章缺省 = opts.chapter 不变）
  promptFiles: string[] = [], // C1（批 2）：prompt 引用材料 → promptMeta.files 登记
): Promise<SpawnResult> {
  if (state.ctrl.signal.aborted) return { status: 'aborted' }

  // 注入的生成函数（单测替身）
  if (opts.genFn) {
    try {
      const text = await opts.genFn(userPrompt, kind, state.ctrl.signal, (delta) =>
        emit(opts, { type: 'text', text: delta }),
      )
      if (state.ctrl.signal.aborted) return { status: 'aborted' }
      if (!text.trim()) return { status: 'error', error: 'AI 产出为空' }
      return { status: 'ok', text }
    } catch (e) {
      if (state.ctrl.signal.aborted) return { status: 'aborted' }
      return { status: 'error', error: errMsg(e) }
    }
  }

  // A2（五十九轮）：mock 快路撤销本地短路，改走下方 runSpec——runTask 的 mockTool 快路
  //（selfHealSpec 已声明 mock.toolName）与真实链路同口径补链路事件（step/start + llm/call
  //  + step/end，P3-6），mock 回合不再是审计黑洞。流式预览改由成功产出后补发（见
  //  emitMockPreview），前端观感口径不变（kk-P2 按码位切片）

  // 真实 provider + tool_use —— 走 runSpec（统一编排：mock/provider/中断/错误文案）
  const out = await runSpec(selfHealSpec(kind), {
    userDataPath: opts.userDataPath,
    bookRoot: opts.bookRoot,
    chapter,
    userPrompt,
    promptFiles,
    ctrl: state.ctrl,
    // Z-P2-5：登记 ctrl → driver（/auto-write 路径传入）——生成期 isRunning() 真值（SSE
    // sync 快照不再假空闲），/interrupt 的 driver.interrupt() 也能直接 abort 在途请求
    //（与 abortSelfHeal 内存闸双保险）。同 ctrl 多轮重复登记，cc 侧幂等跳过
    register: opts.register,
    onReset: () => emit(opts, { type: 'self_heal_reset' }),
    onText: (delta) => emit(opts, { type: 'text', text: delta }),
    // Bug C：provider 重试（429/5xx）时推 warning——前端可见「响应异常，重试中」，不再静默卡死
    // R43-19（四十三轮）：error 拼接前过 redactSecret（与 stream.ts:216 R26-8 同款）——
    // provider 异常 message 可带 endpoint/Authorization 痕迹，SSE 直发前端即脱敏
    onRetry: (attempt, error) =>
      emit(opts, {
        type: 'warning',
        message: `AI 响应异常（${redactSecret(error)}），第 ${attempt + 1} 次重试中…`,
      }),
  })

  // C3（复审-0914-优化修复批）：失败/成功两路的 usage 计价块单源——outputTokens 累计 →
  // estimated 粘性置位（A-6 口径）→ 计价 → cost 累计，数值路径与置位时机逐位不变。
  // Y-15（第五十七轮）：计价用请求时刻的模型（TaskOk/TaskErr.model = resolve 时快照的
  // tier.model），不再二次 resolveTier 取当下档位——生成期间作者换档/改价时 done 事件与
  // ai-calls 账本（runTask 同口径）计价漂移；model 为空（mock 快路）→ 查价跳过
  //（与 usage 为空同后果，未配价不入账）。
  const accountUsage = (u: TokenUsage | null | undefined, model: string | null | undefined): void => {
    if (!u) return
    state.usage.outputTokens += u.outputTokens
    if (u.estimated) state.usage.estimated = true
    const pricing = model ? resolveModelPricing(opts.userDataPath, model) : null
    if (pricing) {
      state.usage.cost +=
        computeCallCost(pricing, {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {}),
          ...(u.cacheWriteTokens !== undefined ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
        }) ?? 0
    }
  }

  if (!out.ok) {
    // R35-17：abort/终态失败 attempt 的真实消耗已由 runner recordUsageSafe 按次入账
    // ai-calls；R37-7（三十七轮）收口：TaskErr 封套已携 attemptsUsage/model，失败前
    // 已消耗的 token/成本随 done 事件并入（此前纯展示面与账本口径分叉——封套取不到
    // 失败调用的用量，预算/成本统计漏记），并入写法与下方成功路径同源（C3 起字面同源）
    accountUsage(out.attemptsUsage ?? null, out.model ?? null)
    if (out.code === 'ABORTED' || state.ctrl.signal.aborted) return { status: 'aborted' }
    return { status: 'error', error: out.error }
  }
  if (state.ctrl.signal.aborted) return { status: 'aborted' }

  // 真实消耗入账（W-P2-7：done 事件不再恒 0；runSpec 已带回 usage）。
  // 金额按次现算累计（D2 同 stream.ts /spawn：写稿模型查价格表四档分计，未配价省略——
  // done 事件不再恒发 cost:0，前端成本口径与 spawn 路径一致）。
  // R73-10（二十一轮 A-10）：done 用量改取全 attempt 累计（attemptsUsage——重试/中断
  // attempt 的可得 usage 一并计入），与 ai-calls.json 按次入账口径一致；修复前只取
  // 末次成功 attempt，重试链的前置消耗在前端成本显示中缺失。runTask 未带该字段
  // （旧调用方/单测桩）时回退 out.usage（原口径）。含估计入账 attempt（R73-1）时
  // estimated 随之置位（C3 单源闭包内）。
  accountUsage(out.attemptsUsage ?? out.usage, out.model)

  // C-2：记账已下沉到 runTask（chapter + task 块自动记，避免双记）

  // B-3：max_tokens 截断 → 警告（落盘保留，但让作者知道原因）
  const { input, text, stopReason } = out.data
  if (stopReason === 'max_tokens') {
    emit(opts, { type: 'warning', message: '产出达到长度上限被截断，建议调高单次输出上限' })
  }

  // tool_use 结构化产出 → 拼装 front matter + 正文
  const assembled = assembleChapter(input, chapter)
  if (assembled.ok) {
    // A2（五十九轮）：mock 快路（out.model === null）经 runTask 短路返回，onText 未流式——
    // 成功产出后按码位切片补发预览（与原本地 mock 快路口径一致），前端/测试能见推进
    if (out.model === null) emitMockPreview(opts, assembled.content)
    // 阶段 24 结构键保形（S3）：assembleChapter 从零组 fm（不知 序/并入），重写既有章
    // 前读盘上 fm 透传结构键——否则全自动写章强覆盖会静默丢掉合并去向与显示序登记
    // （saveDraft 锁内另有 preserveStructureFmIn 兜底，两道共保）。
    return { status: 'ok', text: preserveStructureFmForChapter(opts.bookRoot, chapter, assembled.content) }
  }

  // 降级：tool_use 未命中（AI 产出自由文本）→ 直接用 text
  if (text.trim()) {
    if (out.model === null) emitMockPreview(opts, text.trim())
    return { status: 'ok', text: text.trim() }
  }
  return { status: 'error', error: 'AI 产出为空' }
}

/** A2（五十九轮）：mock 快路的流式预览补发——12 码位/段逐段 emit。
 *  kk-P2：按码位切片——String.slice 按 UTF-16 code unit 会把 emoji/
 *  扩展区字符劈成两半，前端逐字渲染出现瞬时不合法字符（turns.ts read_chapter 同做法）
 *  R58-B-5（五十八轮）：改码点流式分片——for…of 按码点迭代累积，不再 Array.from
 *  全量物化数组（输出逐段等价：每 12 码位一段，尾段不足 12 也照发） */
function emitMockPreview(opts: SelfHealOpts, body: string): void {
  let chunk = ''
  let n = 0
  for (const ch of body) {
    chunk += ch
    n++
    if (n === 12) {
      emit(opts, { type: 'text', text: chunk })
      chunk = ''
      n = 0
    }
  }
  if (chunk) emit(opts, { type: 'text', text: chunk })
}

/** 编排器事件唯一出口（一切 text / self_heal_* / warning / done 经此）。
 *  onActivity 与事件同点：调用方（/auto-write 的静默挂死 watchdog）据此复位计时，
 *  无需再包装 driver 转发 emit。 */
export function emit(opts: SelfHealOpts, ev: DriverEvent): void {
  opts.onActivity?.()
  opts.driver.emit?.(opts.mainSession, ev)
}
