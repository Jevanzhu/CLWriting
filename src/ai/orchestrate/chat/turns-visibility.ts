/**
 * chat 相位 d 可见性诊断族 —— 自 src/ai/orchestrate/chat/turns.ts 缝拆出。
 *
 * （⑤④产品巨件拆分波3）：turns.ts 纯移动拆分。本文件承载
 * 可见性诊断缝：CLW_VERIFY_VISIBLE=1 开关的注入清单抽样校验 verifyVisibleSampled
 * 原样随迁（visibleInjectionsFromDigests 单源组装 + 违约 log.warn 留痕）。
 * 轮循环残核留 turns.ts 并 re-export 本函数（原既有导出面，消费方 import 零改动）。
 * 依赖方向单向（无环回引）：本文件只 import 上游（prompts/chat、events/lineage、
 * events/types、events/store、log），不 import turns.ts。无顶层求值常量。
 * 注释全部原样随迁；行为零变化（纯移动，差异仅 import 行/本头注）。
 */
import { visibleInjectionsFromDigests } from '../../prompts/chat.js'
// 可见性诊断开关直接消费 lineage 校验器（lineage 只依赖 node:crypto 与
// 自身 types，无环）；NewEvent→ChatEvent 形状补齐仅供校验器读取 type/data
import { verifyVisibleRecorded, type VisibleInjection } from '../../../events/lineage.js'
import type { ChatEvent } from '../../../events/types.js'
import type { NewEvent } from '../../../events/store.js'
import { log } from '../../../log/index.js'

/** CLW_VERIFY_VISIBLE=1 诊断开关——llm/call 落库后对本回合
 *  注入清单抽样跑 verifyVisibleRecorded（「模型可见 ⟺ 已记录」生产侧抽查）。可见清单
 * 经 visibleInjectionsFromDigests 单源组装（revision→chapter、skills→skills
 *  的字段映射在本函数）：
 *  recorded 传本回合已登记的三种血缘事件（settings/snapshot + revision/ref +
 *  skills/snapshot，与 recorder 收到的同物）。违约只 warn 留痕（不抛、不进事件库、
 * 不影响主流程；GLM-5.：console.warn 改
 *  log.warn 统一日志通道——与 rag recall 三降级出口同口径，诊断输出落 app-*.jsonl
 *  可回溯）；flag 关闭首行即返回，零开销。 */
export function verifyVisibleSampled(
  digests: { settings: string; revision?: string; skills?: string; knowledge?: string },
  recorded: NewEvent[],
): void {
  if (process.env['CLW_VERIFY_VISIBLE'] !== '1') return
  try {
    // 可见清单改由 visibleInjectionsFromDigests 单源组装（此前手工
    // 镜像 visibleInjections 形状——两侧改拼接源即失配，恰是本开关要抓的漂移）
    // 签名补 knowledge 透传——扩登记面（knowledge 血缘
    // 事件）时本校验面未同步，TS 结构化类型对多余属性不报错，knowledge 在此静默蒸发、
    // 抽样校验对该通道永远 silent-pass
    const visible: VisibleInjection[] = visibleInjectionsFromDigests({
      settings: digests.settings,
      ...(digests.revision !== undefined ? { chapter: digests.revision } : {}),
      ...(digests.skills !== undefined ? { skills: digests.skills } : {}),
      ...(digests.knowledge !== undefined ? { knowledge: digests.knowledge } : {}),
    })
    // 校验器只读 type/data——NewEvent 补齐 ChatEvent 必填字段（seq 用批内序号占位）
    const events: ChatEvent[] = recorded.map((ev, i) => ({
      seq: i,
      sessionId: '',
      type: ev.type,
      data: ev.data,
      replaceGeneration: 0,
      createdAt: 0,
    }))
    const check = verifyVisibleRecorded(visible, events)
    if (check.missing.length > 0) {
      // console.warn → log.warn（统一日志通道，文案不变）
      log.warn(
        'chat',
        `[CLW_VERIFY_VISIBLE] 模型可见注入未登记（${check.missing.length}/${visible.length}）：` +
          check.missing.map((m) => `${m.scope}:${m.digest}`).join(', '),
      )
    }
  } catch {
    /* 诊断通道自身异常不外溢——不影响主流程是开关的硬约束 */
  }
}
