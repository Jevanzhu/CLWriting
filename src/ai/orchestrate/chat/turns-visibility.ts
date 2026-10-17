/**
 * chat 相位 d 可见性诊断族。
 *
 * 内容：CLW_VERIFY_VISIBLE=1 开关的注入清单抽样校验 verifyVisibleSampled
 * （visibleInjectionsFromDigests 单源组装 + 违约 log.warn 留痕）。
 * 轮循环骨架留 turns.ts 并 re-export 本函数（既有导出面，消费方 import 零改动）。
 * 校验实现（通道无关）在 events/lineage-sampling.ts——本文件只做 chat 侧清单组装。
 * 依赖方向单向（无环回引）：本文件只 import 上游（prompts/chat、events/lineage-sampling、
 * events/store），不 import turns.ts。无顶层求值常量。
 */
import { visibleInjectionsFromDigests } from '../../prompts/chat.js'
import { verifyVisibleSampled as verifySampled } from '../../../events/lineage-sampling.js'
import type { VisibleInjection } from '../../../events/lineage.js'
import type { NewEvent } from '../../../events/store.js'

/** CLW_VERIFY_VISIBLE=1 诊断开关——llm/call 落库后对本回合注入清单抽样跑
 *  verifyVisibleRecorded（「模型可见 ⟺ 已记录」生产侧抽查）。可见清单经
 *  visibleInjectionsFromDigests 单源组装（revision→chapter、skills→skills 的字段映射
 *  在本函数）：recorded 传本回合已登记的三种血缘事件（settings/snapshot + revision/ref +
 *  skills/snapshot，与 recorder 收到的同物）。违约只 warn 留痕；flag 关闭零开销。 */
export function verifyVisibleSampled(
  digests: { settings: string; revision?: string; skills?: string; knowledge?: string },
  recorded: NewEvent[],
): void {
  const visible: VisibleInjection[] = visibleInjectionsFromDigests({
    settings: digests.settings,
    ...(digests.revision !== undefined ? { chapter: digests.revision } : {}),
    ...(digests.skills !== undefined ? { skills: digests.skills } : {}),
    ...(digests.knowledge !== undefined ? { knowledge: digests.knowledge } : {}),
  })
  verifySampled('chat', visible, recorded)
}
