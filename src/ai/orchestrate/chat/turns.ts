/**
 * chat 相位 d：agent 轮循环（hh §八-16 自 chat.ts runChat 拆出，纯搬家）。
 *
 * 轮首中止三出口 / 快照血缘登记 / generate 流式回调 / !ok 与 max_tokens 出口 /
 * 无工具完成路径 / 工具路径 / 轮数触顶收尾。返回 completedOk（E1a：正常完成才续链消费队列）。
 *
 * 拆分沿革（R0916-5g，2026-09-16 ⑤④产品巨件拆分波3）：本单件（958 行）纯移动
 * 拆分——工具执行族（waitConfirm/executeChatTool + formatHealResult/formatCheckResult
 * + 模块级常量六组）→ chat/turns-tools.ts；可见性诊断族（verifyVisibleSampled）→
 * chat/turns-visibility.ts。本残核留轮循环主流程（runAgentTurns/
 * lastMessageFingerprint/TurnDeps/MAX_AGENT_TURNS/CHAT_TOOL_NAMES），并按原导出面
 * 逐名 re-export 拆出两件，消费方 import 面零改动。
 * R0916-7-P3-2（2026-09-24 评审 P3-2）：runAgentTurns 的三段实现体（单轮发起 /
 * 工具轮次 / 轮次收尾与终止判定）与上列四个模块级符号迁 turns-phases.ts——本文件只留
 * 「for turn → 阶段一 → 阶段三 → （未终结）阶段二」骨架与落库收编口，段内顺序不变量
 * 见该件头注；导出面照旧逐名 re-export（lastMessageFingerprint/TurnDeps 等）零改动。
 */
import { resolveProvider } from '../../runner.js'
// R57-B-2（五十七轮）：models 行 contextWindow 读取（与 finish.ts:124
// clampCheckpointOutputTokens(modelConfOf(provider.conf)?.contextWindow) 同款先例）
import { modelConfOf } from '../../provider/store.js'
// R57-B-1/B-2（五十七轮）：预算按模型 contextWindow 显式 resolve（resolveChatSendBudget），
// system prompt 计入预算（历史可用 = 预算 − sys 点数，下限 CHAT_HISTORY_MIN_BUDGET_POINTS）
import { resolveChatSendBudget } from '../../prompts/chat.js'
import { errMsg } from '../../../log/index.js'
import { finishTurn } from './finish.js'
import {
  MAX_AGENT_TURNS,
  initiateAgentTurn,
  runToolTurn,
  closeAgentTurn,
  closeByTurnLimit,
  type FlushTurnEvents,
  type TurnDeps,
} from './turns-phases.js'

// R0916-5g re-export 桥：拆出件的既有导出面逐名透传，消费方 import 面零改动。
export { lastMessageFingerprint, type TurnDeps } from './turns-phases.js'
export { waitConfirm, executeChatTool } from './turns-tools.js'
export { verifyVisibleSampled } from './turns-visibility.js'

// ── 轮循环 ────────────────────────────────────────

/** 相位 d：轮循环 + 轮数触顶收尾。返回 completedOk（E1a 续链口径：正常完成才 true）。 */
export async function runAgentTurns(deps: TurnDeps): Promise<boolean> {
  const { opts, recorder, history, baseLen, seqs } = deps

  /** M-1（第十一轮）：回合 commit 点 flush 异常收编 finishTurn——磁盘满/血缘校验越界时
   *  recorder.flush() 抛错直穿 runAgentTurns（chat.ts 只有 try/finally 无 catch），既无
   *  历史回滚也无 surface 遮蔽，已 push 消息留驻内存 histories 而事件未落库，下次对话
   *  模型可见但不可回溯（restore 仅内存空才读库）——DB 故障路径破铁律①。三处 commit
   *  点统一经本助手收编为失败出口（回滚 + 遮蔽 + chat_error，与六失败出口同口径），
   *  返回 false 终止轮循环。 */
  const flushTurnEvents: FlushTurnEvents = (): boolean => {
    try {
      seqs.commitPendingMsgSeqs(recorder.flush())
      return true
    } catch (e) {
      finishTurn(opts, history, baseLen, recorder, {
        error: `事件记录落库失败，本回合已回滚（检查磁盘/事件库后重发）：${errMsg(e)}`,
      })
      return false
    }
  }

  // R48-27（四十八轮）：最近一轮用量快照——轮数触顶收尾的 chat_done 同无工具路径带上
  // usage（触顶场景整场对话原本没有任何带用量的 done，SSE 侧用量统计恒缺）
  let lastTurnUsage: { inputTokens: number; outputTokens: number } | undefined
  // R0912-D-P3-2：provider 档位与发送预算 resolve 上提出轮循环（原每轮重复 resolve：
  // loadProviders 虽有 mtime 缓存仍是重复读表；预算只依赖档位模型 contextWindow）。
  // 语义边界：agent 轮循环中途改 providers 配置不再即时生效（轮循环场次分钟级、单场
  // 对话内换档场景可忽略）；runTask 内 provider 实例仍走自身 resolve 路径，发送面
  // 与实际发送用同一预切预算的不变量（R57-B-2「预算先于 runTask 定型」）不受影响。
  const prov = resolveProvider(opts.userDataPath, 'chat')
  const sendBudget = resolveChatSendBudget(prov.ok ? modelConfOf(prov.provider.conf)?.contextWindow : undefined)

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    // 阶段一（单轮发起）：轮首中止三出口 → 血缘登记 → chat_turn → 发送面预切 →
    // 首发 + A7 超窗收缩重试 + switch-provider 换网重试 → 注入抽样校验
    const sent = await initiateAgentTurn({ deps, turn, sendBudget })
    if (sent.kind === 'ended') return false
    const { out, lineageIdx } = sent
    // R48-27（四十八轮）：逐轮保存合并口径用量（attemptsUsage 优先，同 R27-3），触顶收尾透出
    if (out.ok) lastTurnUsage = (out.attemptsUsage ?? out.usage) ?? undefined

    // 阶段三（轮次收尾与终止判定）：失败面 mask 分流 / max_tokens / 无工具完成面；
    // 工具轮不终结，把成功封套交阶段二
    const closure = await closeAgentTurn({ deps, turn, out, lineageIdx, flushTurnEvents })
    if (closure.ended) return closure.completedOk

    // 阶段二（工具调用派发与结果回填）：assistant 消息入历史 → 工具串行派发 →
    // tool_result 回填 → tool/result 事件 → turnEnd → 落库
    const toolTurnOk = await runToolTurn({ deps, turn, out: closure.out, lineageIdx, flushTurnEvents })
    if (!toolTurnOk) return false
  }

  // 轮数触顶收尾（补固定收尾文案 + 带用量 done）
  return closeByTurnLimit({ deps, lastTurnUsage, flushTurnEvents })
}
