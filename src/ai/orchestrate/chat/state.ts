/**
 * chat 域共享模块态（hh §八-16 自 chat.ts 拆出，纯搬家）。
 *
 * per-book 对话历史（内存 LRU）+ 事件 seq 映射 + 活跃分支归属——三 Map 同生命周期：
 * LRU 逐出 / clearChatHistory 一并重置。runChat 装配的运行态类型 ChatRunState 与
 * emit 辅助也在此（restore / turns / finish 三相位共用，ChatOpts 结构满足 EmitCarrier）。
 */
import type { DriverEvent, Session, StudioDriver } from '../../../driver/types.js'
import type { ChatMsg } from '../../provider/types.js'
import { openSessionStore, openSessionStoreAsync, bookHash } from '../../../events/store.js'
import { log } from '../../../log/index.js'

// ── 运行态类型（chat.ts 并发锁与 turns.ts waitConfirm 共用） ──

/** R70-12（十八轮）：对话总超时缺省值——finish.ts 超时文案同源换算（防参数化后
 *  文案与实际值漂移；测试注入 deadlineMs 覆盖运行值，文案按缺省口径展示）。 */
export const AGENT_DEADLINE_MS = 30 * 60_000

export interface ChatRunState {
  ctrl: AbortController
  deadline: number
  /** CC-P2-2：deadline 定时器已触发——ctrl.abort 的来源区分（用户中断 vs 超时） */
  timedOut?: boolean
  /** P5-AI（第七轮）：超时终局的确认 callId 集合——turn 循环据此区分「确认超时」与
   *  「作者取消」两文案（原先一律回「作者取消了该操作」，对模型归因误导） */
  confirmTimedOut?: Set<string>
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
    // 留账（第十轮 低-5）：LRU 逐出可命中「在途对话」的书（须 >8 本并发对话才触发，
    // 桌面单用户不可达）——在途 runChat 持有 history 数组引用，本轮收尾 histories.set
    // 会自愈重插，在途轮次不受影响；窗口在「逐出后～收尾写回前」的第二次 getHistory
    //（如他处读史/续链重建）会拿到空历史，在途回合的尾部消息不进其视图。不修：
    // 触发面窄（>8 本并发对话），修复需引入在途引用计数，收益不抵复杂度。
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
 * R34D-19（三十四轮）：转 async——事件库开库走 openSessionStoreAsync（首开锁等待
 * 不阻塞服务事件循环）；无 db 参的纯内存路径（books.ts 改名等）随之变异步但语义
 * 逐位不变（内存清空仍先行，事件库失败降级留痕口径不动）。测试侧未 await 的纯内存
 * 调用照旧工作（内部无 await 短路）。
 */
export async function clearChatHistory(bookName: string, userDataPath?: string, bookRoot?: string): Promise<void> {
  histories.delete(bookName)
  msgSeqMap.delete(bookName)
  activeBranchByBook.delete(bookName)
  compactionSuppressed.delete(bookName)
  if (userDataPath && bookRoot) {
    // Y-P2-7：两把钥匙都清——对话会话 book=bookName、workspace 会话 book=bookHash(bookRoot)，
    // 此前只清前者，链路事件（step/llm/check）残留；
    // 低级项（第六轮）：双键走 clearBooks 单事务（此前两次 clearBook 各自事务，一半清一半留）。
    // P5-AI（第七轮）：openSessionStore 本身可抛（库损坏/磁盘满——H-1 同型残留在清史路径），
    // 内存已清而事件库未清的半完成态若再 500，作者每次重试同样失败无从自助——降级留痕
    let store: ReturnType<typeof openSessionStore>
    try {
      store = await openSessionStoreAsync(userDataPath, bookRoot)
    } catch (e) {
      log.warn('chat', `清史打开事件库失败（内存已清、事件库待修复后重清）：${e instanceof Error ? e.message : String(e)}`)
      return
    }
    // L-A2（第八轮）：clearBooks 本身也可抛（SQLITE_BUSY 超 busy_timeout / 磁盘满）——
    // 同款降级留痕：内存已清，事件库残留待修复后重清，重试可自愈
    try {
      store?.clearBooks([bookName, bookHash(bookRoot)])
    } catch (e) {
      log.warn('chat', `清史清除事件库行失败（内存已清、事件库待修复后重清）：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      store?.close()
    }
  }
}
