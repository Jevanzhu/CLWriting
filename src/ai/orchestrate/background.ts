/**
 * M-2：per-book 后台任务登记——fire-and-forget 逃生口收编。
 *
 * 两处刻意不 await 的后台 AI 任务（失败自留痕、不阻塞触发端点）：
 * - 定稿即生成章摘要（api/documents.ts → afterFinalizeGenerateSummary）；
 * - 自愈 pass 后的账本推进草稿（self-heal exitPass → generateLeadUpdateDraft）。
 *
 * 此前它们逃逸出 books.ts 删/改名与优雅退出的 settle 等待：请求返回后任务仍在途，
 * 若期间书被删除/搬移，任务的落盘会对旧路径重建孤儿目录。本表把它们纳入与
 * chat/self-heal settling 同款的收尾等待（等待方：awaitOrchestrationsSettled /
 * shutdownStudio，均有超时上限兜底，登记本身不改变 fire-and-forget 语义）。
 */
const background = new Map<string, Set<Promise<unknown>>>()

/** 登记一本书的后台任务（任务应为自留痕 promise——不 reject 到本层；幂等清理） */
export function registerBackgroundTask(bookName: string, p: Promise<unknown>): void {
  let set = background.get(bookName)
  if (!set) {
    set = new Set()
    background.set(bookName, set)
  }
  set.add(p)
  const cleanup = (): void => {
    const s = background.get(bookName)
    if (!s) return
    s.delete(p)
    if (s.size === 0) background.delete(bookName)
  }
  p.then(cleanup, cleanup)
}

/** 是否有在途后台任务（诊断/测试用） */
export function hasBackgroundTasks(bookName: string): boolean {
  const s = background.get(bookName)
  return s !== undefined && s.size > 0
}

/** 等本书全部后台任务收尾（无在途立即返回）。与 waitChatSettled 同构的循环：
 * 后台任务收尾前再登记新任务（如批量定稿连发）也能被追上。 */
export async function waitBackgroundTasks(bookName: string): Promise<void> {
  for (;;) {
    const s = background.get(bookName)
    if (!s || s.size === 0) return
    await Promise.allSettled([...s])
  }
}
