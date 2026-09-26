/**
 * chat 相位 d 的回合三段 ——（全项目源码质量与优雅度评审）：
 * runAgentTurns 原为 306 行 / 圈复杂度 79 的单函数（轮首三出口 + 血缘登记 + 发送面预切 +
 * 首发与两类重试 + 出口分流 + 无工具完成面 + 工具轮全链 + 触顶收尾）。本件承载三段实现体，
 * turns.ts 只留「for turn → 三段接力」的骨架。
 *
 * 三段与顺序不变量（改此件前先读）：
 * - 阶段一 initiateAgentTurn（单轮发起）：轮首中止/超时 → 血缘事件登记 → chat_turn →
 * history 消毒与预算保尾预切 → 首发 +超窗收缩重试 + switch-provider 换网重试 →
 *   llm/call 注入抽样校验。血缘登记（recorder.add）**先于**任何发送：注入面事件序与
 *   llm/call 的先后是审计链的既定形状（模型可见 ⟺ 已记录）。
 * - 阶段二 runToolTurn（工具调用派发与结果回填）：assistant 消息入 history → assistant/
 *   tool_call 事件 → 工具串行派发（abort 短路 / 未知工具 / 写风险确认闸 / 执行）→
 *   tool_result blocks 组成 user 消息入 history → tool/result 事件 → turnEnd → 落库。
 *   history 的 push 顺序（assistant → user(tool_result)）是跨协议回放契约，不得调换。
 * - 阶段三 closeAgentTurn（轮次收尾与终止判定）+ closeByTurnLimit（轮数触顶收尾）：
 *   失败面 mask 分流（ABORTED→interrupted / TIMEOUT_TOTAL→timeout / 其余 error）→ 回滚
 *   与遮蔽全在 finishTurn；无工具完成面自己发 chat_done（先广播后压缩：finalizeHistory
 *   的摘要调用不得拖住 done）。判定与副作用分家：judgeTurnTermination 是纯判定。
 *
 * 拆出两件（turns-tools / turns-visibility）为既有导出面，本件经 turns.ts re-export 消费
 * 方零改动。
 */
import type { ChatMsg, ContentBlock, TokenUsage } from '../../provider/types.js'
// 最小版：GenError 随 generate 同源导入——run 回调边界捕获超窗 code
import { generate, GenError } from '../../gen.js'
// resolveProvider 复用既有 resolve 路径取档位模型 conf（只读
// contextWindow；provider 实例本身仍由 runTask 自行 resolve）——本件只用其发送面常量
import { runTask, type TaskResult } from '../../runner.js'
import { loadProviders, tierFromStore } from '../../provider/store.js'
import { resolveAdapter } from '../../provider/registry.js'
import { failureAction } from '../../provider/failure.js'
import { redactSecret } from '../../provider/redact.js' // SSE 错误事件脱敏第二层
import { chatTools, TOOL_RISK } from '../../contract/chat.js'
import { waitConfirm, executeChatTool } from './turns-tools.js'
import { verifyVisibleSampled } from './turns-visibility.js'
import { sanitizeHistory } from '../../prompts/chat.js'
// 发送前体量防线——保尾预切与 trimHistory 回落分支同口径（单源 budgetTailCut）
// 预算按模型 contextWindow 显式 resolve（resolveChatSendBudget），
// system prompt 计入预算（历史可用 = 预算 − sys 点数，下限 CHAT_HISTORY_MIN_BUDGET_POINTS）
import {
  budgetTailCut,
  measureHistoryPoints,
  measureTextPoints,
  CHAT_HISTORY_MIN_BUDGET_POINTS,
} from '../../prompts/chat.js'
import { log } from '../../../log/index.js'
import type { SessionRecorder } from '../../../events/chat-bridge.js'
import {
  turnStartEvent,
  turnEndEvent,
  assistantMessageEvent,
  toolCallEvent,
  toolResultEvent,
} from '../../../events/chat-bridge.js'
// 最小版：llm/retry 留痕——超窗收缩重试复用 runner 重试留痕事件
// 形态（events/types.ts LlmRetryData；落 chat 会话库，runner 链路库的 llm/retry 不变）
import {
  settingsSnapshotEvent,
  revisionRefEvent,
  skillsSnapshotEvent,
  llmRetryEvent,
} from '../../../events/chain-bridge.js'
import type { NewEvent } from '../../../events/store.js'
import type { ChatOpts } from '../chat.js'
import { emit, activeBranchByBook, type ChatRunState } from './state.js'
import { finishTurn, finalizeHistory } from './finish.js'
import type { ChatSeqLedger } from './restore.js'

// 5 → 20——原保守值使多工具任务（多章检查/批量整理等）即触顶收尾，
// 工具任务完成率受损。护栏不依赖本上限：deadline 总时长闸（轮首检查）、写风险工具确认闸、
// book.yaml budget.chat_max_calls 次数预算闸（runner checkAiTaskCallBudget，未配不设）
// 各自独立兜底，轮数上限只作最后防线。
export const MAX_AGENT_TURNS = 20

/** 工具名清单模块级常量化——chatTools 表模块级不可变，promptTools 登记
 *  （铁律②「模型可见 ⟺ 已记录」工具面）每轮循环不必重算 map。（finish.ts 收尾压缩
 *  同口径各持一份本文件常量——共享导出需改 contract/chat.ts 公共面，取最小改。） */
export const CHAT_TOOL_NAMES = chatTools.map((t) => t.name)

/** 当轮末条消息指纹——多轮 agent 循环每轮实际发送的末条消息
 *  （首轮 user 文本 / 工具轮 tool_result blocks），序列化后进 llm/call promptMeta 哈希。
 *  此前恒用 opts.message（首轮 user 文本），同组多轮 hash 全同，「本次实际输入指纹」审计失义 */
export function lastMessageFingerprint(history: ChatMsg[]): string {
  const last = history[history.length - 1]
  if (!last) return ''
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
}

export interface TurnDeps {
  opts: ChatOpts
  state: ChatRunState
  confirmTimeout: number
  history: ChatMsg[]
  baseLen: number
  recorder: SessionRecorder
  sys: string
  /** 本回合分支元数据（来自 restore 相位） */
  turnBranch: { parentSeq?: number; branchId?: string } | undefined
  /** 血缘：注入快照指纹（来自 restore 相位）；增 knowledge（方法论注入） */
  digests: { settings: string; revision?: string; skills?: string; knowledge?: string }
  /** prompt 注入文件清单（来自 restore 相位）——llm/call promptMeta.files 登记 */
  promptFiles: string[]
  /** 章正文注入路径（来自 restore 相位）——revision/ref 的 path 字段 */
  revisionPath: string | undefined
  seqs: ChatSeqLedger
  /** chat_done 发出当口回调置 completedOk——此后 finalizeHistory 若抛异常，
   *  续链口径与拆分前一致（正常完成已广播，队列照常消费，不因收尾压缩失败丢弃） */
  markCompleted: () => void
}

/** 落库收编口（轮循环内定义：三处 commit 点共用，回滚 + 遮蔽 + chat_error 同口径）。
 *  返回 false = 事件库故障，本回合须终止。 */
export type FlushTurnEvents = () => boolean

/** chat 主模型发送的 run 回调返回形状（runTask 泛型入参；/Responses 缺口 11 字段）。 */
export interface ChatGeneration {
  text: string
  toolCalls: { id: string; name: string; input: unknown }[]
  stopReason: string
  usage: TokenUsage
  reasoning: string
  /** resolve 后上线输出上限——runner 提取落 llm/call */
  resolvedMaxTokens?: number
  /** 适配器降级标记透传——runner extractDegraded 落 llm/call。
   * 回调已返回而泛型未声明，
   *  类型面对调用方不可见，现补齐（finish.ts 摘要壳同款） */
  degraded?: boolean
  /** Responses 线缺口 11：加密推理项随 reasoning 块入历史，下轮回传维持推理状态 */
  reasoningEncrypted?: string
  reasoningItemId?: string
}

/** 单轮发送结果（阶段一产出）。 */
export type ChatSendOut = TaskResult<ChatGeneration>

/** 阶段一产物：轮首已终结（中止/超时，finishTurn 已收口）或已拿到发送结果。 */
export type TurnSend = { kind: 'ended' } | { kind: 'sent'; out: ChatSendOut; lineageIdx: number[] }

// ── 阶段一：单轮发起 ─────────────────────────────────────────────────────────

/**
 * 单轮发起：轮首中止三出口→ 血缘登记 → chat_turn →
 * history 消毒 + 预算保尾预切→ 发送（首发 +
 * 超窗收缩重试 + switch-provider 换网重试）→ llm/call 注入抽样校验。
 *
 * @param sendBudget 发送预算（按档位模型 contextWindow 显式 resolve 上提出
 *   轮循环——本段只消费，不重复解析 providers 表）
 */
export async function initiateAgentTurn(args: { deps: TurnDeps; turn: number; sendBudget: number }): Promise<TurnSend> {
  const { deps, turn, sendBudget } = args
  const { opts, state, history, recorder, sys } = deps
  const {
    settings: settingsDigest,
    revision: revisionDigest,
    skills: skillsDigest,
    knowledge: knowledgeDigest,
  } = deps.digests

  if (state.ctrl.signal.aborted) {
    // 回滚 +遮蔽在 finishTurn 内；deadline 定时器触发的 abort
    // 报「超时」（含嵌套 self-heal / 确认闸期间），用户中断报「已中断」
    finishTurn(opts, history, deps.baseLen, recorder, state.timedOut ? 'timeout' : 'interrupted')
    return { kind: 'ended' }
  }
  if (Date.now() > state.deadline) {
    finishTurn(opts, history, deps.baseLen, recorder, 'timeout')
    return { kind: 'ended' }
  }

  recorder.add(turnStartEvent(turn))
  // 血缘：登记本轮注入快照（settings/snapshot + revision/ref + skills/snapshot），assistant 事件引用
  const lineageIdx: number[] = []
  // 本回合登记的血缘事件同留一份供 CLW_VERIFY_VISIBLE 抽样校验（与
  // recorder 收到的同物；flag 关时收集成本 = 数组 push，可忽略）
  const lineageRecorded: NewEvent[] = []
  const addLineage = (ev: NewEvent): number => {
    lineageRecorded.push(ev)
    return recorder.add(ev)
  }
  lineageIdx.push(addLineage(settingsSnapshotEvent({ scope: 'settings', digest: settingsDigest })))
  if (revisionDigest !== undefined) {
    // path 记章正文实际注入源（spill locator 或草稿路径），此前恒空串断链。
    // 未选章不再 `?? 0` 伪装成无效章号——章号缺省即「无章」
    // 显式语义（构造器已放宽可选，消费方只读 revision）。
    lineageIdx.push(
      addLineage(
        revisionRefEvent({
          ...(opts.chapter !== undefined ? { chapter: opts.chapter } : {}),
          revision: revisionDigest,
          path: deps.revisionPath ?? '',
        }),
      ),
    )
  }
  // 技巧包索引注入补登记——skillsIndex 非空才注入，同条件才登记
  if (skillsDigest !== undefined) {
    lineageIdx.push(addLineage(skillsSnapshotEvent({ digest: skillsDigest })))
  }
  // 知识层方法论注入补登记——同「非空才注入/才登记」条件；scope 复用
  // settings/snapshot 事件（knowledge 档），digest 与 ctx.knowledge 同源（restore 相位算好）
  if (knowledgeDigest !== undefined) {
    lineageIdx.push(addLineage(settingsSnapshotEvent({ scope: 'knowledge', digest: knowledgeDigest })))
  }
  emit(opts, { type: 'chat_turn', turn })

  // 发送前历史消毒（§6.4 第二道防线）：多轮 tool 往返/中断回滚后历史可能出现非法
  // 序列（空 content / 连续同 role / 孤儿 tool_result / 首条非 user）→ 400。
  // 消毒上提至任务前单源化——原 promptText 指纹取未消毒
  // history、generate 用消毒副本，消毒实际生效时 llm/call 审计口径与真实输入脱钩，
  // 违「模型可见⟺已记录」；消毒为确定性纯函数且 history 在任务期间不变，上提后
  // 指纹与 messages 同源同物（正常流消毒为 no-op，指纹不变）。
  const sanitized = sanitizeHistory(history)

  // 发送前体量防线——trimHistory/compaction 只在成功收尾后的
  // finalizeHistory（finish.ts）执行，单轮发送前无任何体量闸：重工具会话（大
  // tool_result 多轮累积）可一路撑到超窗 → provider 400（CONTEXT_WINDOW_EXCEEDED）。
  // 最小版起，预切后仍越线的残余形态由本段下方 shrink-prompt
  // 消费者（收缩重试恰一次）兜底——接线前此处 fail-open 原样发送、超窗即会话卡死。
  // 按「resolved 发送预算 − system prompt 点数」对消毒后历史做保尾预切，
  // 切点口径与 trimHistory 回落分支单源（budgetTailCut：只取纯文本 user 边界，永不落
  // tool_use/tool_result 配对中间）。预切只改本轮发送副本 toSend，不改累积 history
  // （中断回滚仍按 baseLen 精确）；下方 promptText 指纹取 toSend 末条（指纹与实发
  // 同源，守「模型可见 ⟺ 已记录」）。零边界病态形态照 trimHistory 先例：无法安全切
  // → 原样发送 + warn（可观测）。
  // system prompt 计入发送预算——历史可用 = resolved 预算 − sys
  // 点数（同族码点口径 measureTextPoints）；sys 超大（重设定书场景）把差额挤到下限以下时
  // clamp 到具名下限 CHAT_HISTORY_MIN_BUDGET_POINTS（约保一个回合），宁可切后总量
  // 仍超走下方复查 warn（fail-open），不把历史压成空手发送。
  // 下限补「随预算收缩」——只论证了 sys 挤负 clamp 形态，
  // 未覆盖 sendBudget 本身低于下限的形态：contextWindow < 40k 的小窗模型行
  // sendBudget = min(96k, ⌊窗/2⌋) < 20k，恒 clamp 到 20k 反而高于发送预算本身——
  // 预防线 `sendPoints > historyBudget` 对 [sendBudget, 20k] 区间永不触发，实发必超窗
  // 400；收缩重试预算 ⌊20k/2⌋ = 10k 仍可高于真实窗口预算 → 二次 400 会话死路。
  // 现下限先与 sendBudget 取 min，historyBudget 恒 ≤ sendBudget；sys 超大挤到
  //（收缩后的）下限时 fail-open warn 语义不变。
  const sysPoints = measureTextPoints(sys)
  const historyBudget = Math.max(Math.min(CHAT_HISTORY_MIN_BUDGET_POINTS, sendBudget), sendBudget - sysPoints)
  let toSend = sanitized
  const sendPoints = measureHistoryPoints(sanitized)
  if (sendPoints > historyBudget) {
    const cut = budgetTailCut(sanitized, historyBudget)
    if (cut === null) {
      log.warn(
        'chat',
        `chat 发送前体量防线：system prompt 约 ${sysPoints} + 历史 ${sanitized.length} 条约 ${sendPoints} 码点，超发送预算 ${sendBudget}（历史可用 ${historyBudget}），但无纯文本 user 边界可对齐、无法安全预切（原样发送）`,
      )
    } else {
      toSend = sanitized.slice(cut)
      log.warn(
        'chat',
        `chat 发送前体量防线：system prompt 约 ${sysPoints} + 历史 ${sanitized.length} 条约 ${sendPoints} 码点，超发送预算 ${sendBudget}（历史可用 ${historyBudget}），保尾预切 → ${toSend.length} 条约 ${measureHistoryPoints(toSend)} 码点`,
      )
    }
  }
  // 切后复查——sys 计入后仍有三形态可越线：sys 超大挤到下限、
  // 单肥回合兜底保最近一整回合、零边界病态原样发送。复查不改发送行为（fail-open
  // 语义不变），只让 warn 反映含 sys 的真实总量；越线后的超窗 400 由下方最小版
  // 收缩重试兜底（接线前仅 warn 可观测、会话卡死）。
  const sentPoints = toSend === sanitized ? sendPoints : measureHistoryPoints(toSend)
  if (sysPoints + sentPoints > sendBudget) {
    log.warn(
      'chat',
      `chat 发送前体量防线：切后复查——system prompt 约 ${sysPoints} + 实发历史 ${toSend.length} 条约 ${sentPoints} 码点，合计 ${sysPoints + sentPoints} 仍超发送预算 ${sendBudget}（fail-open 原样发送；越线超窗 400 由下方 A7 最小版收缩重试兜底）`,
    )
  }

  // ──最小版：shrink-prompt 消费者（chat 编排层主模型发送处）──
  // 发送封装为 sendTurn(send, promptText)：首发失败且 run 回调捕获到 GenError.code ===
  // 'CONTEXT_WINDOW_EXCEEDED' 时，按更紧预算（⌊首发历史预算/2⌋，依据见下）对消毒后
  // 历史保尾重切 → 重算指纹 → 再发恰一次；仍失败（或不可重切/重切无收益）落回现行
  // 终态路径（下方 !out.ok 出口与错误面零变更）。范围严控：仅 chat 主模型发送；
  // switch-provider 不接线，self-heal/spawn/rewrite 等非 chat 路径不收缩，不做多次
  // 重试与预算动态学习。
  //
  // code 捕获通道：runTask 失败封套只透出 message（结构化 code 仅落 llm/call errCode，
  // turns 层不可见），故在 run 回调边界就地置 ctxOverflow 信号。CONTEXT_WINDOW_EXCEEDED
  // 非重试族（决策表 action='shrink-prompt' ≠ 'retry'），runner 对其不退避重试——信号
  // 置位即对应该次发送的终态失败，不存在跨 attempt 的陈旧信号；每次发送前显式重置。
  //
  // 重试预算系数 = ⌊historyBudget / 2⌋——对首发「实际生效」的历史预算取半（恒 ≤
  // sendBudget/2，「约 sendBudget 一半」作为上界自动满足）。依据：① 首发已按
  // historyBudget 预切（或预算内原样发送）仍超窗，说明真实开销（15 个工具 schema、
  // 消息包装、码点≈token 粗估误差、输出预留）已吃满首发预算的全部余量，对半收缩才
  // 保证重试载荷确定性变小；小系数（如 3/4）可能仍落同一估计误差带内白烧一次调用；
  // ② sys 挤到 CHAT_HISTORY_MIN_BUDGET_POINTS 下限的越线形态（三形态之一）下
  // sendBudget/2 反而比首发预算更松、不可用——对 historyBudget 取半在任何形态下都
  // 严格更紧；③ 与 resolveChatSendBudget「≤ 半窗」的既有哲学同族。budgetTailCut 自带
  // 兜底：所有边界后缀都超重试预算时保最近一整回合（可能不严格更小 → 守卫跳过重试）、
  // 无边界返回 null（无法安全切 → 不重试），两者都直接落终态路径。
  //
  // 指纹/登记闭环（铁律「模型可见 ⟺ 已记录」）：收缩只动历史消息载荷——system prompt
  // 注入面不变，轮首已登记的 settings/snapshot + revision/ref + skills/snapshot 血缘与
  // deps.promptFiles（llm/call promptMeta.files）无需也不应重复登记（重复登记反而制造
  // 双份血缘）；变化的是 messages——重试以 lastMessageFingerprint(重切实发) 重算
  // promptText 再进 runTask，两次 llm/call 的 promptMeta 各对齐各自实发载荷（保尾切点
  // 下末条消息不变、指纹恒同，是「对齐实发」的正确形态而非漏改）。
  //
  // 双次计费口径：重试是独立的第二次 runTask——首发（失败）与重试的 usage 各由本次
  // runTask 按「失败/重试也是真实 API 消耗」口径独立入账 ai-calls/账本；
  // 外层 out.attemptsUsage 只聚合末次发送的 attempt 链，首发消耗不并入封套（与 runner
  // 内部重试链失败 attempt 不入 done 合计的既有口径一致，账本按次不丢）。
  //
  // 留痕：log.warn（前后码点数）+ chat 会话库 llm/retry（复用 runner 重试留痕事件形态
  // LlmRetryData，delayMs=0 表无退避）+ 用户面 warning（onRetry 先例）；重试前防御性
  // chat_reset 清前端缓冲（超窗 400 属建连期失败、零增量，正常为 no-op——防御流中
  // 异常形态下重复文本）。
  let ctxOverflow = false
  // switch-provider 消费者（决策表 AUTH/NOT_FOUND/UNSUPPORTED → 换网重试，
  // 此前无消费者、终态等同 author——failure.ts 自认）。code 捕获通道与 ctxOverflow
  // 同款：run 回调边界就地置码；换网判定读 failureAction 决策表，不在此处写死错误码清单
  let switchCode: GenError['code'] | undefined
  const sendTurn = (send: ChatMsg[], promptText: string, providerId?: string) =>
    runTask<ChatGeneration>({
      userDataPath: opts.userDataPath,
      // 换网重试传显式 provider id（缺省 undefined 原路径）
      providerId,
      tierKind: 'chat',
      task: 'chat',
      bookRoot: opts.bookRoot,
      // trace hash 纳入 system prompt——chat 的 system prompt 稳定（设定+职责），
      // 不带则同 user 消息不同书 hash 冲突
      systemPrompt: sys,
      // 每轮取当轮末条消息（tool_result 轮为 blocks 序列化），
      // 同组多轮 hash 各异，恢复「本次实际输入指纹」审计语义——起取消毒后
      // 历史（与 generate 实发同源）；起取预切后实际发送的 toSend 末条
      //（指纹与实发同源，预切触发时指纹随实发收窄，不再对未发送的历史记账）；
      // 最小版起收缩重试对重切实发重算同一指纹（见上方闭环注释）
      promptText,
      // 注入文件清单（章正文/spill）进 llm/call promptMeta.files——与写稿链
      //（self-heal promptFiles）同口径：记 hash+chars+files，不落 prompt 全文
      promptFiles: deps.promptFiles,
      // 清偿批本轮 generate 挂载的 chatTools（15 个工具 schema 模型
      // 可见）——工具名清单进 promptMeta.tools（铁律②「模型可见 ⟺ 已记录」工具面登记）
      // 清单收 CHAT_TOOL_NAMES 模块常量（原每轮 map 重算）
      promptTools: CHAT_TOOL_NAMES,
      ctrl: state.ctrl,
      // owner='chat:<book>'——driver 分槽防跨编排抢占（此前单槽「换新先
      // abort 旧」会掐断在途写稿）。注释校准：chat 与 self-heal/spawn 的并发
      // 由入口互斥闸管（stream.ts chat.send/regenerate 对写稿在途 409），本处不承
      // 担并发许可；下方 AI_GEN_TOOLS/write_chapter 闸是工具层二道防线。
      // owner 带书维度——sendChatMessage 锁按书分键（chat.ts running
      // map），两本书共享同一 mainSession 的形态下，后书对话注册同 owner 'chat' 触发
      // 「换新先 abort 旧」掐断前书在途 ctrl。`chat:<bookName>` 分槽后跨书并发
      // 互不抢占；同书 turns 与 finish 同槽同 ctrl，幂等 no-op 不变。
      register: (c) => opts.driver.registerCtrl?.(opts.mainSession, c, `chat:${opts.bookName}`),
      onReset: () => emit(opts, { type: 'chat_reset' }),
      // provider 429/5xx 重试时推 warning（与 self-heal.ts:496 对齐，Bug C 同类补齐）
      // error 拼接前过 redactSecret（与 stream.ts:216 同款）
      onRetry: (attempt, error) =>
        emit(opts, { type: 'warning', message: `AI 响应异常（${redactSecret(error)}），第 ${attempt + 1} 次重试中…` }),
      run: async (provider, signal, tier) => {
        // 消毒副本在 runTask 前统一产出（上提，指纹同源）；消毒产副本不污染
        // 累积的 history（回滚仍按 baseLen 精确）。实发取发送前预切后的
        // toSend（超 resolved 发送预算时保尾收窄，防超窗 400 卡死；起预算
        // 按模型窗口 resolve 且 sys 计入，见上方防线注释）；最小版起重试发送取
        // 重切后的实发（sendTurn 参数 send）。
        // 最小版：超窗 code 就地捕获（见上方 code 捕获通道注释）后原样上抛——
        // runner 侧决策与封套形状零变更
        try {
          const r = await generate(
            provider,
            {
              systemPrompt: sys,
              messages: send,
              tools: chatTools,
              toolChoice: 'auto',
              effort: tier.effort,
            },
            signal,
            (delta) => emit(opts, { type: 'chat_text', text: delta }),
          )
          return {
            text: r.text,
            toolCalls: r.toolCalls,
            stopReason: r.stopReason,
            usage: r.usage,
            reasoning: r.reasoning,
            resolvedMaxTokens: r.resolvedMaxTokens,
            // 降级参数面标记透传（extractDegraded 落 llm/call，铁律②重放口径）
            degraded: r.degraded,
            reasoningEncrypted: r.reasoningEncrypted,
            reasoningItemId: r.reasoningItemId,
          }
        } catch (e) {
          if (e instanceof GenError && e.code === 'CONTEXT_WINDOW_EXCEEDED') ctxOverflow = true
          if (e instanceof GenError && e.code) switchCode = e.code
          throw e
        }
      },
    })
  let out = await sendTurn(toSend, lastMessageFingerprint(toSend))
  // 换网重发实发载荷——收缩重发实际执行处同步收窄，
  // 「首发超窗 →收缩重发 → 重发又回 AUTH 族 → 换网重发」组合链不再误用首发
  // 未收缩载荷（修复前 :422 恒发 toSend，重放超窗形态）。本块之后 toSend 无其余
  // 读点（终态出口/成功路径均不触达），收窄面仅换网重发一处。
  let effectiveToSend = toSend
  if (!out.ok && ctxOverflow) {
    ctxOverflow = false
    const retryBudget = Math.floor(historyBudget / 2)
    const retryCut = budgetTailCut(sanitized, retryBudget)
    const retryToSend = retryCut === null ? null : sanitized.slice(retryCut)
    const retryPoints = retryToSend !== null ? measureHistoryPoints(retryToSend) : 0
    // 重试守卫：无法安全切（null）或重切未严格小于首发（单肥回合兜底保最近一整回合
    // 的病态形态）→ 重发同量载荷必再败，不白烧一次调用，直接按终态路径收口
    if (retryToSend !== null && retryPoints < sentPoints) {
      log.warn(
        'chat',
        `chat 发送超窗收缩重试（A7 最小版）：首发 ${toSend.length} 条约 ${sentPoints} 码点回 CONTEXT_WINDOW_EXCEEDED，按重试预算 ${retryBudget}（首发历史预算 ${historyBudget} 之半）保尾重切 → ${retryToSend.length} 条约 ${retryPoints} 码点，重试一次`,
      )
      recorder.add({ ...llmRetryEvent({ attempt: 1, delayMs: 0, errCode: 'CONTEXT_WINDOW_EXCEEDED' }), turn })
      emit(opts, { type: 'chat_reset' })
      emit(opts, {
        type: 'warning',
        message: `上下文超限，已自动收缩对话历史（约 ${sentPoints} → ${retryPoints} 码点）后重试。`,
      })
      // 收缩重发实际执行处同步 effectiveToSend（换网重发取此值）
      effectiveToSend = retryToSend
      out = await sendTurn(retryToSend, lastMessageFingerprint(retryToSend))
      if (!out.ok && ctxOverflow) {
        log.warn(
          'chat',
          `chat 发送收缩重试后仍超窗（A7 最小版）：重试发送 ${retryToSend.length} 条约 ${retryPoints} 码点仍回 CONTEXT_WINDOW_EXCEEDED，按现行终态路径收口（错误面不变）`,
        )
      }
    } else {
      log.warn(
        'chat',
        `chat 发送超窗且无法收缩重试（A7 最小版）：首发 ${toSend.length} 条约 ${sentPoints} 码点回 CONTEXT_WINDOW_EXCEEDED，重试预算 ${retryBudget} 下${retryCut === null ? '无纯文本 user 边界可对齐、无法安全重切' : `重切后约 ${retryPoints} 码点不严格小于首发`}，直接按终态路径收口`,
      )
    }
  }

  // ──：switch-provider 消费者（chat 编排层主模型发送处）──
  // 首发命中换网族（决策表 action='switch-provider'）且存在异于当前的供应商配置时，
  // 取第一个备用 id 换网重发恰一次（shrink 同款最小范型：一次性、不级联）；仍失败
  // 或无备用 → 落回现行终态路径（错误面零变更）。重发走 sendTurn
  // 全链（trace/记账/指纹与首发同构；起：载荷取收缩后
  // 的 effectiveToSend、备用须过 chat 档可用性预检——换的是网，输入与首发/收缩实发
  // 一致）；provider 实例由 runTask 按 providerId 解析，两次 llm/call 各自记录实际
  // 生效供应商。self-heal/spawn/rewrite 等非 chat 路径照旧终态（runner 内该动作仍同
  // 归 author，范围与 shrink 消费者同界）。
  if (!out.ok && switchCode !== undefined && failureAction({ code: switchCode }) === 'switch-provider') {
    const failedCode: GenError['code'] = switchCode
    switchCode = undefined
    let fallbackId: string | undefined
    let fromId: string | null = null
    // 备用供应商逐个校验 chat 档可用性，选第一个可解析的异
    // id 供应商；此前 find(p => p.id !== currentId) 不校验，选中无 chat 档/坏协议的
    // 备用只会白烧一次必败发送。全部不可用时按成因区分 warn 文案（无备用供应商 vs
    // 备用均无可用 chat 档），均落现行终态路径（错误面零变更）。
    // 校验从「resolveProvider 同款解析路径」改为轻量形状校验
    // ——修复前对每个候选 resolveProvider（每次 loadProviders 整 store 克隆 + vault
    // 解密、createProvider 实例入 LRU 挤占容量 8），失败路径的过滤探针代价与实例驻留
    // 面不成比例。现读一次 providers 配置做形状判定：协议在册（resolveAdapter，与
    // createProvider 未知协议拒绝同源）+ chat 档模型可解析（tierFromStore 与
    // resolveProvider 的 tier 解析同源，模型缺失对全体候选一致 = 均无 chat 档）；
    // 不实例化 provider、不进 LRU，真正实例化只发生在选定后的重发路径（runTask →
    // resolveProvider(providerId) 全量校验兜底）。预检文案语义不变。
    let hasCandidate = false
    try {
      const s = loadProviders(opts.userDataPath)
      fromId = s.currentId
      const candidates = s.providers.filter((p) => p.id !== s.currentId)
      hasCandidate = candidates.length > 0
      const chatModelOk = tierFromStore(s, 'chat').model !== ''
      fallbackId = candidates.find((p) => chatModelOk && resolveAdapter(p.protocol) !== null)?.id
    } catch {
      fallbackId = undefined
    }
    if (fallbackId) {
      log.warn(
        'chat',
        `chat 发送换网重试（0917清库修复批）：供应商${fromId ? ` ${fromId}` : ''} 回 ${failedCode}，切换备用 ${fallbackId} 重发一次`,
      )
      recorder.add({ ...llmRetryEvent({ attempt: 1, delayMs: 0, errCode: failedCode }), turn })
      // 重发前清前端对话缓冲——换网重发是独立的第二次完整
      // 发送，防异常形态下 chat_text 重复拼接（对齐上方分支同款防御；正常为 no-op）
      emit(opts, { type: 'chat_reset' })
      emit(opts, {
        type: 'warning',
        message: `AI 供应商请求失败（${redactSecret(failedCode)}），已切换备用供应商重试。`,
      })
      // 实发取 effectiveToSend（无收缩链路 = toSend 本身
      // 行为不变；收缩后换网组合 = 收缩后载荷），指纹同步按实发重算
      out = await sendTurn(effectiveToSend, lastMessageFingerprint(effectiveToSend), fallbackId)
    } else if (hasCandidate) {
      log.warn(
        'chat',
        `chat 发送回 ${failedCode} 且备用供应商均无可用 chat 档（0918独立重评修复批 A004），按现行终态路径收口`,
      )
    } else {
      log.warn('chat', `chat 发送回 ${failedCode} 且无备用供应商可切换（0917清库修复批），按现行终态路径收口`)
    }
  }

  // llm/call 已落库（成败两路都落 trace；最小版收缩重试时两次发送的链路
  // 各自成对落库）——对注入清单抽样校验（flag 开时；违约仅 warn，先于失败出口收口，
  // 失败回合的注入同样受查。收缩只动历史消息、注入清单与发送次数无关，单次校验即可）
  verifyVisibleSampled(deps.digests, lineageRecorded)

  // 阶段二（工具轮）还要用 lineageIdx 供 assistant 事件引用本回合血缘
  return { kind: 'sent', out, lineageIdx }
}

// ── 阶段三：轮次收尾与终止判定 ────────────────────────────────────────────────

/** 单轮终态分流（纯判定，无副作用）。 */
export type TurnTermination = 'interrupted' | 'timeout' | 'error' | 'max-tokens' | 'no-tools' | 'tools'

/**
 * 终态分流：失败面按 code/timedOut 定 mask（口径：ABORTED（用户中断）→
 * 'interrupted'、TIMEOUT_TOTAL（档位超时）→ 'timeout'，其余（GEN_FAIL/NO_* 等）走
 * { error } 透传文案）；max_tokens → 截断出口（工具入参可能被截断，绝不执行，半截
 * 文本不入 history，K12）；无工具调用 → 完成面；有工具 → 交阶段二。
 */
export function judgeTurnTermination(out: ChatSendOut, timedOut: boolean): TurnTermination {
  if (!out.ok) {
    if (timedOut || out.code === 'TIMEOUT_TOTAL') return 'timeout'
    if (out.code === 'ABORTED') return 'interrupted'
    return 'error'
  }
  if (out.data.stopReason === 'max_tokens') return 'max-tokens'
  if (out.data.toolCalls.length === 0) return 'no-tools'
  return 'tools'
}

/** 阶段三产物：本回合是否终结 + 完成口径（E1a 续链：正常完成才 true）；
 *  未终结（工具轮）时把已收窄的成功封套交给阶段二，避免调用方再判 `out.ok`。 */
export type TurnClosure = { ended: true; completedOk: boolean } | { ended: false; out: ChatSendOut & { ok: true } }

/**
 * 轮次收尾与终止判定：失败面/截断面经 finishTurn 收口（回滚 + 遮蔽 + chat_error）；
 * 无工具完成面发 chat_done 并收尾（attemptsUsage 优先 +
 * 分支激活 +溢出压缩）；工具轮返回 { ended: false } 交阶段二。
 */
export async function closeAgentTurn(args: {
  deps: TurnDeps
  turn: number
  out: ChatSendOut
  lineageIdx: number[]
  flushTurnEvents: FlushTurnEvents
}): Promise<TurnClosure> {
  const { deps, turn, out, lineageIdx, flushTurnEvents } = args
  const { opts, state, history, baseLen, recorder, sys, turnBranch, seqs } = deps
  const kind = judgeTurnTermination(out, state.timedOut ?? false)

  if (!out.ok) {
    // deadline 定时器在 generate 期间触发 → 按超时收口（与轮首 aborted 分支同文案）
    // 终态 mask 按 out.code 分流（对齐轮首口径）——此前两类终断除
    // deadline 外一律落 { error }（mask 'error'），session/end 终态与遮蔽实参失真
    const mask: 'timeout' | 'interrupted' | { error: string } =
      kind === 'timeout' ? 'timeout' : kind === 'interrupted' ? 'interrupted' : { error: out.error }
    finishTurn(opts, history, baseLen, recorder, mask)
    return { ended: true, completedOk: false }
  }

  const { text, stopReason, reasoning, reasoningEncrypted, reasoningItemId } = out.data

  // max_tokens → 工具入参可能被截断，绝不执行；半截文本不入 history（K12）；
  // 回滚 user 消息（与 !out.ok 路径一致），防下次对话连续 user → Anthropic 400
  if (kind === 'max-tokens') {
    finishTurn(opts, history, baseLen, recorder, 'max-tokens')
    return { ended: true, completedOk: false }
  }
  if (kind !== 'no-tools') return { ended: false, out }

  // 无工具调用 → 对话结束
  // reasoning 非空时入历史（与工具路径一致——DeepSeek/Kimi 多轮带 tools 硬要求）
  let asstContent: string | ContentBlock[]
  if (reasoning) {
    const blocks: ContentBlock[] = []
    if (text) blocks.push({ type: 'text', text })
    // Responses 线缺口 11：加密推理项随 reasoning 块入历史，下轮回传维持推理状态
    blocks.push({
      type: 'reasoning',
      text: reasoning,
      ...(reasoningEncrypted
        ? { encrypted: reasoningEncrypted, ...(reasoningItemId ? { itemId: reasoningItemId } : {}) }
        : {}),
    })
    asstContent = blocks
  } else {
    asstContent = text
  }
  history.push({ role: 'assistant', content: asstContent })
  // 记录 assistant 事件 + 回合收尾 + 落库
  // assistant 事件同下方 chat_done改 attemptsUsage 优先的
  // 合并口径——重试链回合 out.usage 只是末 attempt 单次值，事件用量被系统性低估
  seqs.pendingMsgSeqs.push(
    recorder.add(
      assistantMessageEvent(
        asstContent,
        out.attemptsUsage ?? out.usage ?? undefined,
        stopReason,
        lineageIdx,
        turnBranch,
      ),
    ),
  )
  recorder.add(turnEndEvent(turn, 'completed'))
  if (!flushTurnEvents()) return { ended: true, completedOk: false }
  // attemptsUsage 优先——runTask 内部重试链（429/5xx 退避）时
  // out.usage 只是末 attempt 的单次值，前端/审计的回合用量被系统性低估；
  // self-heal 已用合并口径，chat 此前漏改
  const doneUsage = out.attemptsUsage ?? out.usage
  emit(opts, {
    type: 'chat_done',
    ...(doneUsage ? { inputTokens: doneUsage.inputTokens, outputTokens: doneUsage.outputTokens } : {}),
  })
  deps.markCompleted()
  // regenerate 成功才激活新分支（失败/中断的半截组已被遮蔽，激活会归因到幽灵组）
  if (opts.regenerate) activeBranchByBook.set(opts.bookName, opts.regenerate.branchId)
  // 溢出 → checkpoint 压缩优先（chat_done 先发，不被摘要调用拖住）
  await finalizeHistory(opts, history, seqs.msgSeqs, recorder, sys, state, deps.promptFiles)
  return { ended: true, completedOk: true }
}

/** 轮数触顶收尾（for 循环自然跑满后调用）：补固定收尾文案 + 事件 + 落库 + done。
 * 口径见各注；返回 completedOk。 */
export async function closeByTurnLimit(args: {
  deps: TurnDeps
  lastTurnUsage: { inputTokens: number; outputTokens: number } | undefined
  flushTurnEvents: FlushTurnEvents
}): Promise<boolean> {
  const { deps, lastTurnUsage, flushTurnEvents } = args
  const { opts, state, history, recorder, sys, turnBranch, seqs } = deps
  emit(opts, { type: 'chat_turn', turn: MAX_AGENT_TURNS })
  const closingMsg = '已达到单次对话的工具调用上限，先到这里——你可以基于以上结果继续提问。'
  emit(opts, { type: 'chat_text', text: closingMsg })
  // 收尾文案入历史（防末尾 user(tool_result) + 下次 user → 连续 user → Anthropic 400）
  history.push({ role: 'assistant', content: closingMsg })
  // 事件记录 + 落库 + trim 遮蔽（与无工具完成路径一致）
  // 收尾 assistant 也进同一变体组（regenerate 轮数触顶时整回合不丢出分支视图）
  seqs.pendingMsgSeqs.push(recorder.add(assistantMessageEvent(closingMsg, undefined, undefined, undefined, turnBranch)))
  // 触顶收尾记 turn 5 的终态（与上方 chat_turn emit 的 turn=MAX_AGENT_TURNS 同口径）——
  // 此前记 MAX_AGENT_TURNS-1 会把循环内已记 completed 的最后一轮再关一次，同轮双终态
  recorder.add(turnEndEvent(MAX_AGENT_TURNS, 'max-turns'))
  if (!flushTurnEvents()) return false
  // 触顶收尾的 chat_done 同无工具路径（口径）带用量——
  // 工具轮不 emit done，无此补齐则触顶对话整场无带用量的 done，用量统计恒缺
  emit(opts, {
    type: 'chat_done',
    ...(lastTurnUsage ? { inputTokens: lastTurnUsage.inputTokens, outputTokens: lastTurnUsage.outputTokens } : {}),
  })
  deps.markCompleted()
  // 轮数触顶收尾也属正常完成——同口径激活新分支
  if (opts.regenerate) activeBranchByBook.set(opts.bookName, opts.regenerate.branchId)
  // 溢出 → checkpoint 压缩优先（同无工具完成路径）
  await finalizeHistory(opts, history, seqs.msgSeqs, recorder, sys, state, deps.promptFiles)
  return true
}

// ── 阶段二：工具调用派发与结果回填 ────────────────────────────────────────────

/**
 * 工具轮次：assistant 消息（text/reasoning/tool_use blocks）入 history → assistant 事件
 * 与 tool_call 审计事件 → 工具串行派发与结果回填 → tool_result blocks 组成 user 消息入
 * tool_result blocks 组成 user 消息入 history → tool/result 事件 → turnEnd → 落库。
 *
 * 派发闸序（不可重排）：轮首级 abort 短路→ 未注册工具直接 isError 回填
 * （不弹确认卡）→ 写风险确认闸（TOOL_RISK='write' 才 waitConfirm，
 * 超时与人工取消分开归因）→ 执行（executeChatTool）。
 *
 * @returns completedOk：false = 落库失败（flushTurnEvents 已回滚遮蔽），轮循环须终止
 */
export async function runToolTurn(args: {
  deps: TurnDeps
  turn: number
  out: ChatSendOut & { ok: true }
  lineageIdx: number[]
  flushTurnEvents: FlushTurnEvents
}): Promise<boolean> {
  const { deps, turn, out, lineageIdx, flushTurnEvents } = args
  const { opts, state, confirmTimeout, history, recorder, turnBranch, seqs } = deps
  const { text, toolCalls, stopReason, reasoning, reasoningEncrypted, reasoningItemId } = out.data

  // 有工具调用 → assistant 消息按 block 结构入历史
  // reasoning 块保留回传（DeepSeek/Kimi 多轮带 tools 硬要求，方案 §4.2）
  const asstBlocks: ContentBlock[] = []
  if (text) asstBlocks.push({ type: 'text', text })
  if (reasoning) {
    // Responses 线缺口 11：加密推理项随 reasoning 块入历史（同无工具路径）
    asstBlocks.push({
      type: 'reasoning',
      text: reasoning,
      ...(reasoningEncrypted
        ? { encrypted: reasoningEncrypted, ...(reasoningItemId ? { itemId: reasoningItemId } : {}) }
        : {}),
    })
  }
  for (const c of toolCalls) {
    asstBlocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input })
  }
  history.push({ role: 'assistant', content: asstBlocks })
  // assistant 事件（tool_use 在载荷里）+ tool/call 审计事件
  // 与无工具路径同款 attemptsUsage 优先的合并口径——工具轮
  // 截断重试时 out.usage 只是末 attempt 单次值，事件用量与 ai-calls 按次入账分裂
  seqs.pendingMsgSeqs.push(
    recorder.add(
      assistantMessageEvent(
        asstBlocks,
        out.attemptsUsage ?? out.usage ?? undefined,
        stopReason,
        lineageIdx,
        turnBranch,
      ),
    ),
  )
  for (const c of toolCalls) recorder.add(toolCallEvent(c.id, c.name, c.input))

  // 执行工具 + 结果按 tool_result block 回填
  const results: ContentBlock[] = []
  for (const call of toolCalls) {
    // -（全量代码）：工具串行段补轮首级 abort 短路——本地只读
    // 工具不接 signal，作者中止落在前序工具处理中时剩余工具原照跑到轮末；命中即对
    // 剩余 call 逐个按既有取消口径回填后跳出（归因不扩第三态），轮终态仍由下一轮
    // 轮首 aborted 检查按 'interrupted' 收口，写类/嵌套生成既有中止语义不动。
    if (state.ctrl.signal.aborted) {
      results.push({
        type: 'tool_result',
        toolUseId: call.id,
        content: '作者取消了该操作。',
        isError: true,
      })
      emit(opts, { type: 'chat_tool_result', callId: call.id, summary: '已取消', ok: false })
      continue
    }
    // 未注册工具直接 isError 回填——TOOL_RISK 缺名时原先
    // 默认 'write' 从严弹确认卡，作者确认的却是一个必然失败的调用（executeChatTool
    // default 分支「未知工具」），确认卡失实。改为不弹卡直接回错误结果（风险面不变：
    // 未知工具本就无执行体；未知工具事件已在上方 toolCallEvent 全量登记，审计不缺）。
    // 同款 hasOwn 守卫（原型链继承键 ≠ undefined，未知工具防线被穿透）
    if (!Object.hasOwn(TOOL_RISK, call.name)) {
      results.push({
        type: 'tool_result',
        toolUseId: call.id,
        content: `未知工具：${call.name}（未注册，无法执行）`,
        isError: true,
      })
      emit(opts, { type: 'chat_tool_result', callId: call.id, summary: `未知工具 ${call.name}`, ok: false })
      continue
    }
    // 防御兜底——上方 hasOwn 守卫后此行运行时恒命中、?? 分支不可达，
    // 仅为 noUncheckedIndexedAccess 下的索引类型收窄保留（表收缩时不误弹写卡，从严口径）
    const risk = TOOL_RISK[call.name] ?? 'write'
    if (risk === 'write') {
      emit(opts, { type: 'chat_tool_pending', callId: call.id, name: call.name, input: call.input })
      const ok = await waitConfirm(state, call.id, confirmTimeout)
      if (!ok) {
        // 超时与人工取消分开归因——原先 deadline 触发的超时也回
        // 「作者取消了该操作」，对模型归因误导（随后 chat_error 才给正确文案）
        const timedOut = state.confirmTimedOut?.has(call.id) ?? false
        results.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: timedOut ? '确认超时，本次操作未执行（可重发指令）。' : '作者取消了该操作。',
          isError: true,
        })
        emit(opts, { type: 'chat_tool_result', callId: call.id, summary: timedOut ? '确认超时' : '已取消', ok: false })
        continue
      }
    }
    emit(opts, { type: 'chat_tool', callId: call.id, name: call.name, input: call.input })
    const r = await executeChatTool(call, opts, state.ctrl.signal)
    results.push({ type: 'tool_result', toolUseId: call.id, content: r.summary, isError: !r.ok })
    emit(opts, { type: 'chat_tool_result', callId: call.id, summary: r.summary, ok: r.ok })
  }
  history.push({ role: 'user', content: results })
  // tool/result 事件（每条 tool_result block 一个事件，合成一条 user 消息的 seqs）
  // regenerate 回合同样带分支元数据——否则 tool/result 无 branchId 会落在组外，
  // selectBranch 只保留组内+祖先链，带工具调用的变体在分支视图里丢工具往返
  const resultIdxs: number[] = []
  for (const rb of results) {
    if (rb.type === 'tool_result') {
      resultIdxs.push(recorder.add(toolResultEvent(rb.toolUseId, rb.content, rb.isError, turnBranch)))
    }
  }
  seqs.pendingMsgSeqs.push(resultIdxs)
  recorder.add(turnEndEvent(turn, 'completed'))
  if (!flushTurnEvents()) return false
  return true
}
