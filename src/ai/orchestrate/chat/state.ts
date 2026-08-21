/**
 * chat 域共享模块态（hh §八-16 自 chat.ts 拆出，纯搬家）。
 *
 * per-book 对话历史（内存 LRU）+ 事件 seq 映射 + 活跃分支归属——三 Map 同生命周期：
 * LRU 逐出 / clearChatHistory 一并重置。runChat 装配的运行态类型 ChatRunState 与
 * emit 辅助也在此（restore / turns / finish 三相位共用，ChatOpts 结构满足 EmitCarrier）。
 */
import type { DriverEvent, Session, StudioDriver } from '../../../driver/types.js'
import type { ChatMsg } from '../../provider/types.js'
import { openSessionStore, bookHash } from '../../../events/store.js'

// ── 运行态类型（chat.ts 并发锁与 turns.ts waitConfirm 共用） ──

export interface ChatRunState {
  ctrl: AbortController
  deadline: number
  /** CC-P2-2：deadline 定时器已触发——ctrl.abort 的来源区分（用户中断 vs 超时） */
  timedOut?: boolean
  /** 挂起中的工具确认：callId → resolve */
  pending: Map<string, (ok: boolean) => void>
}

// ── emit 辅助（各相位统一走 driver.emit） ──────────

/** emit 所需的最小结构契约——ChatOpts 满足之，避免本模块反向依赖 chat.ts */
export interface EmitCarrier {
  driver: StudioDriver
  mainSession: Session
}

export function emit(opts: EmitCarrier, ev: DriverEvent): void {
  opts.driver.emit?.(opts.mainSession, ev)
}

// ── 内存级对话历史（per-book，LRU 上限防多书累积） ────

export const histories = new Map<string, ChatMsg[]>()
// F1-P1：与 histories 并行维护「每条消息 → 事件 seq」映射（压缩遮蔽用，跨 runChat 持久）
export const msgSeqMap = new Map<string, number[][]>()
// Z-P1-2（G1 写侧谱系）：本书活跃分支 = 最近一次成功 regenerate 的 branchId——
// 其后的普通回合事件带该 branchId 进组（续聊归属明确，不摊给所有变体视图）；
// 仅成功回合激活（失败/中断的半截组已被遮蔽，激活会把续聊归因到幽灵组）；
// 与 histories 同生命周期：LRU 逐出 / clearChatHistory 一并重置
export const activeBranchByBook = new Map<string, string>()
// B2：压缩失败一次的书 → 下次溢出直接硬截断（防「每次溢出白打一次摘要」级联，学 cherry E10 抑制）。
// 低级项（第六轮）：从 finish.ts 挪入并纳入同生命周期——原进程级 Set 无 LRU/清空挂钩，
// 删书/换书后 suppress 标记残留（进程级无界，且幽灵标记会让复活书第一次溢出跳过摘要）
export const compactionSuppressed = new Set<string>()
const MAX_HISTORY_BOOKS = 8

/** 取（或建）本书对话历史——命中重插（真 LRU，X-P2-24）。 */
export function getHistory(bookName: string): ChatMsg[] {
  // X-P2-24：命中重插实现真 LRU——Map 按插入序淘汰，get 不重插的话
  // 热点书历史会被只碰过一次的冷书逐出
  const hit = histories.get(bookName)
  if (hit) {
    histories.delete(bookName)
    histories.set(bookName, hit)
    return hit
  }
  if (histories.size >= MAX_HISTORY_BOOKS) {
    // 删最旧（Map 保留插入顺序）
    const oldest = histories.keys().next().value
    if (oldest !== undefined) {
      histories.delete(oldest)
      msgSeqMap.delete(oldest)
      activeBranchByBook.delete(oldest)
      compactionSuppressed.delete(oldest)
    }
  }
  const fresh: ChatMsg[] = []
  histories.set(bookName, fresh)
  return fresh
}

/**
 * 清空本书对话历史（前端"清空对话"时调）。
 * F1-P1：可选传 userDataPath + bookRoot 一并清事件库（无参时只清内存，保持测试兼容）。
 */
export function clearChatHistory(bookName: string, userDataPath?: string, bookRoot?: string): void {
  histories.delete(bookName)
  msgSeqMap.delete(bookName)
  activeBranchByBook.delete(bookName)
  compactionSuppressed.delete(bookName)
  if (userDataPath && bookRoot) {
    // Y-P2-7：两把钥匙都清——对话会话 book=bookName、workspace 会话 book=bookHash(bookRoot)，
    // 此前只清前者，链路事件（step/llm/check）残留；
    // 低级项（第六轮）：双键走 clearBooks 单事务（此前两次 clearBook 各自事务，一半清一半留）
    const store = openSessionStore(userDataPath, bookRoot)
    try {
      store?.clearBooks([bookName, bookHash(bookRoot)])
    } finally {
      store?.close()
    }
  }
}
