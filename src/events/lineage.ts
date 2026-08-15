/**
 * F1-P3 血缘 + 「模型可见 ⟺ 已记录」校验器（方案 §五 + CLAUDE.md 守则；G2-1 扩三种登记形状）。
 *
 * - verifyVisibleRecorded：断言「注入 prompt 的内容 ⊆ 事件可重建内容」——
 *   每个可见注入（scope+digest）须有对应登记事件。三种登记形状（G2-1）：
 *   settings/snapshot（scope=data.scope、digest=data.digest）、
 *   skills/snapshot（scope='skills'、digest=data.digest）、
 *   revision/ref（正文登记：scope='chapter'、digest=data.revision）。
 * - digest16：内容指纹（sha256 前 16 位），settings/snapshot 的 digest 与
 *   revision/ref 的 revision 共用。
 *
 * 用法：prompt 组装函数（buildChatContext 等）把注入段落登记为事件后，
 * 校验器检查可见注入是否都有记录。开发期 fail loud（测试断言），
 * 运行期由调用方决定告警策略。
 */
import { createHash } from 'node:crypto'
import type { ChatEvent } from './types.js'

/** 一次「模型可见」注入（prompt 组装时收集） */
export interface VisibleInjection {
  /** 注入 scope（'settings' / 'chapter' / 'skills'——与三种登记事件归一化口径一致） */
  scope: string
  /** 注入内容指纹（digest16） */
  digest: string
}

export interface LineageCheck {
  /** 有对应记录的注入数 */
  present: number
  /** 缺失（模型可见但事件库无记录）的注入 */
  missing: VisibleInjection[]
}

/** 内容指纹：sha256 前 16 位 hex（settings digest / revision 指纹共用） */
export function digest16(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16)
}

/** 登记记录归一化：三种登记事件 → 统一 {scope, digest, seq}（G2-1）
 *  - settings/snapshot / skills/snapshot：直接取 data.scope + data.digest；
 *  - revision/ref：正文登记，固定 scope='chapter'、digest=data.revision。 */
function registeredRecords(events: ChatEvent[]): { scope: string; digest: string; seq: number }[] {
  return events.flatMap((e) => {
    if (e.type === 'settings/snapshot' || e.type === 'skills/snapshot') {
      const d = e.data as { scope: string; digest: string }
      return [{ scope: d.scope, digest: d.digest, seq: e.seq }]
    }
    if (e.type === 'revision/ref') {
      const d = e.data as { revision: string }
      return [{ scope: 'chapter', digest: d.revision, seq: e.seq }]
    }
    return []
  })
}

/** 校验器：每个可见注入须有对应登记事件（三种形状归一化后 scope+digest 匹配） */
export function verifyVisibleRecorded(visible: VisibleInjection[], events: ChatEvent[]): LineageCheck {
  const records = registeredRecords(events)
  const missing: VisibleInjection[] = []
  for (const v of visible) {
    const found = records.some((r) => r.scope === v.scope && r.digest === v.digest)
    if (!found) missing.push(v)
  }
  return { present: visible.length - missing.length, missing }
}

/** 从事件流提取全部登记记录（settings/snapshot + skills/snapshot + revision/ref 归一化；血缘重建用） */
export function recordedSnapshots(events: ChatEvent[]): { scope: string; digest: string; seq: number }[] {
  return registeredRecords(events)
}

