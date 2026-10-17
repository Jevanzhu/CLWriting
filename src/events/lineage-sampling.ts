/**
 * 「模型可见 ⟺ 已记录」抽样校验的通道无关实现（AGENTS.md AI 链路守则第一条）。
 *
 * chat 轮循环、self-heal、rewrite 各链的可见注入形状不同，但校验判据同一：
 * 每条可见注入（scope+digest）须有同 scope+digest 的登记事件。本文件只做
 * 「可见清单 + 本次已登记事件」→ 违约 warn，不含任何链路的清单组装。
 * 组装侧（visible 来源与登记事件来源）留在各链路——这是抽样能抓到漂移的前提。
 */
import { verifyVisibleRecorded, type VisibleInjection } from './lineage.js'
import type { ChatEvent } from './types.js'
import type { NewEvent } from './store.js'
import { log } from '../log/index.js'

/** CLW_VERIFY_VISIBLE=1 诊断开关判定单源（各链路抽样共用） */
export function visibleVerifyEnabled(): boolean {
  return process.env['CLW_VERIFY_VISIBLE'] === '1'
}

/**
 * 抽样校验：visible 每条须有同 scope+digest 的登记事件；违约只 warn 留痕
 * （不抛、不进事件库、不影响主流程）。channel 为日志 tag（chat / self-heal / rewrite…），
 * 缺失清单随日志可定位到具体链路。开关关闭首行即返回，零开销。
 */
export function verifyVisibleSampled(
  channel: string,
  visible: readonly VisibleInjection[],
  recorded: readonly NewEvent[],
): void {
  if (!visibleVerifyEnabled()) return
  try {
    // 校验器只读 type/data——NewEvent 补齐 ChatEvent 必填字段（seq 用批内序号占位）
    const events: ChatEvent[] = recorded.map((ev, i) => ({
      seq: i,
      sessionId: '',
      type: ev.type,
      data: ev.data,
      replaceGeneration: 0,
      createdAt: 0,
    }))
    const check = verifyVisibleRecorded([...visible], events)
    if (check.missing.length > 0) {
      log.warn(
        channel,
        `[CLW_VERIFY_VISIBLE] 模型可见注入未登记（${check.missing.length}/${visible.length}）：` +
          check.missing.map((m) => `${m.scope}:${m.digest}`).join(', '),
      )
    }
  } catch {
    /* 诊断通道自身异常不外溢——不影响主流程是开关的硬约束 */
  }
}
