/**
 * 每文档串行保存队列（W0-1 §5.2 步骤 3 / W0-2 §5 第三层互斥）。
 *
 * - 每 docId 一条独立串行队列：同文档并发保存串行执行，结果不交错。
 * - requestToken：每 docId 单调递增；旧请求完成时若已有更新请求入队 → superseded=true，
 *   上游据此丢弃旧响应（旧响应不覆盖新文档状态）。
 * - freeze(docId) 暂停出队（当前执行中的跑完，队列剩余的等 unfreeze）。
 *
 * 只管调度，不碰保存语义——实际保存逻辑由调用方（service.ts）注入 run。
 * 泛型 R 是保存结果类型，queue 不关心其内部结构。
 */

/** 入队请求：docId + 实际保存逻辑（token 由 queue 分配，单调递增）。 */
export interface QueueSaveRequest<R> {
  docId: string
  /** 实际保存逻辑（service 注入）；token 是 queue 分配的序号。 */
  run: (token: number) => Promise<R>
}

/** 出队结果：保存结果 + token + 是否已被更新请求取代。 */
export interface QueueResult<R> {
  result: R
  /** queue 分配的单调递增 token。 */
  token: number
  /** 完成时已有更新请求入队 → 此旧响应应被上游丢弃（不覆盖新状态）。 */
  superseded: boolean
}

interface PendingItem<R> {
  token: number
  run: (token: number) => Promise<R>
  resolve: (r: QueueResult<R>) => void
  reject: (e: unknown) => void
}

interface DocQueue<R> {
  maxToken: number
  frozen: boolean
  running: boolean
  pending: PendingItem<R>[]
}

/** 每文档串行保存队列。 */
export class SaveQueue<R> {
  private docs = new Map<string, DocQueue<R>>()

  private dq(docId: string): DocQueue<R> {
    let q = this.docs.get(docId)
    if (!q) {
      q = { maxToken: 0, frozen: false, running: false, pending: [] }
      this.docs.set(docId, q)
    }
    return q
  }

  /** 入队：分配 token，串行执行；run 完成后返回结果 + superseded 标记。 */
  enqueue(req: QueueSaveRequest<R>): Promise<QueueResult<R>> {
    const q = this.dq(req.docId)
    const token = ++q.maxToken
    return new Promise<QueueResult<R>>((resolve, reject) => {
      q.pending.push({ token, run: req.run, resolve, reject })
      this.pump(q)
    })
  }

  /** 暂停该 doc 出队（当前执行中的跑完，队列剩余等 unfreeze）。 */
  freeze(docId: string): void {
    this.dq(docId).frozen = true
  }

  /** 恢复该 doc 出队。 */
  unfreeze(docId: string): void {
    const q = this.dq(docId)
    q.frozen = false
    this.pump(q)
  }

  /** 是否冻结（测试 / 状态查询用）。 */
  isFrozen(docId: string): boolean {
    return this.dq(docId).frozen
  }

  /** 派发：未在跑 + 未冻结 + 有待跑 → 取下一个执行。 */
  private pump(q: DocQueue<R>): void {
    if (q.running || q.frozen || q.pending.length === 0) return
    const item = q.pending.shift()!
    q.running = true
    Promise.resolve()
      .then(() => item.run(item.token))
      .then(
        (result) => {
          q.running = false
          item.resolve({ result, token: item.token, superseded: item.token < q.maxToken })
          this.pump(q)
        },
        (e) => {
          q.running = false
          item.reject(e)
          this.pump(q)
        },
      )
  }
}
