/**
 * 工作区互斥协调（W0-2 §5）—— 编辑器手写 vs batch 连写的并发协调。
 *
 * 三层互斥（W0-2 §5.2）：
 * - 第一层 工作区写作锁：.gui-active 的 editing_workdir（gui-active.ts 实现）；
 * - 第二层 batch 活跃性：.auto-batch.json 未完 + host_pid 探活（本文件）；
 * - 第三层 每文档保存队列：queue.ts。
 *
 * batch 活跃性选型（v2 修订）：原「复用 paused 判定」不满足 W0-2 §5.2——
 * paused 是暂停记录不是活跃信号，batch 被 kill 时无 paused 却未完，原选型误判活跃、
 * 编辑器只读锁永不解除。改为 host_pid 探活（process.kill(pid,0)）：借鉴 gui-active 的 pid
 * 标识但用探活判死活，无 STALE 窗口、零续期开销。
 * 容错：旧批次文件无 host_pid → 保守视为活跃（拒手写入口是安全方向，作者有 --resume/rollback 出路）。
 */
import { acquireEditingWorkdir, releaseEditingWorkdir } from '../process/gui-active.js'
import { readBatchProgress } from '../auto/batch.js'

export interface WorkdirMutex {
  /** 置工作区编辑锁（editing_workdir + 心跳）。 */
  acquireEditing(): boolean
  /** 清工作区编辑锁。 */
  releaseEditing(): void
  /** batch 是否活跃：.auto-batch.json 未完 + host_pid 进程存活。 */
  isBatchActive(): boolean
}

/** 绑定 bookRoot 的互斥协调器（service / 编辑器会话持有）。 */
export function createWorkdirMutex(bookRoot: string): WorkdirMutex {
  return {
    acquireEditing: () => acquireEditingWorkdir(bookRoot),
    releaseEditing: () => releaseEditingWorkdir(bookRoot),
    isBatchActive: () => isBatchActive(bookRoot),
  }
}

/** batch 活跃性：未完 + host_pid 探活；旧文件无 host_pid 保守视为活跃。 */
export function isBatchActive(bookRoot: string): boolean {
  const p = readBatchProgress(bookRoot)
  if (!p) return false
  if (p.completed.length >= p.target_count) return false // 已完成
  if (typeof p.host_pid === 'number') return isPidAlive(p.host_pid)
  // 旧批次文件无 host_pid → 保守视为活跃（安全方向，W0-2 §7）
  return true
}

/** 进程探活：signal 0 不发信号只检验存在。EPERM（存在但无权限）算 alive，ESRCH（不存在）算死。 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
