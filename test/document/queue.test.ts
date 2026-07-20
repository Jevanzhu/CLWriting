import { describe, it, expect, vi } from 'vitest'
import { SaveQueue } from '../../src/document/queue.js'

/** 手动控制的 Promise（精确编排串行/并发时序）。 */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('SaveQueue', () => {
  it('同 docId 并发请求串行执行（最大并发 1）', async () => {
    const q = new SaveQueue<string>()
    let active = 0
    let maxActive = 0
    const run = async (token: number) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
      return `r${token}`
    }
    const results = await Promise.all([
      q.enqueue({ docId: 'd1', run: () => run(1) }),
      q.enqueue({ docId: 'd1', run: () => run(2) }),
      q.enqueue({ docId: 'd1', run: () => run(3) }),
    ])
    expect(maxActive).toBe(1)
    expect(results.map((r) => r.result)).toEqual(['r1', 'r2', 'r3'])
    expect(results.map((r) => r.token)).toEqual([1, 2, 3])
  })

  it('不同 docId 并行执行（互不阻塞）', async () => {
    const q = new SaveQueue<string>()
    let active = 0
    let maxActive = 0
    const run = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 20))
      active--
      return 'ok'
    }
    await Promise.all([
      q.enqueue({ docId: 'a', run }),
      q.enqueue({ docId: 'b', run }),
      q.enqueue({ docId: 'c', run }),
    ])
    expect(maxActive).toBe(3)
  })

  it('旧 token 完成时标记 superseded（旧响应不覆盖新状态）', async () => {
    const q = new SaveQueue<string>()
    const d1 = deferred<string>()
    const d2 = deferred<string>()
    const p1 = q.enqueue({ docId: 'd', run: () => d1.promise })
    const p2 = q.enqueue({ docId: 'd', run: () => d2.promise })
    // req1 在跑、req2 排队、maxToken=2
    d1.resolve('old')
    const r1 = await p1
    expect(r1.token).toBe(1)
    expect(r1.superseded).toBe(true) // 1 < 2
    d2.resolve('new')
    const r2 = await p2
    expect(r2.token).toBe(2)
    expect(r2.superseded).toBe(false) // 2 < 2 = false（最新）
  })

  it('最新请求完成后无后续 → superseded=false', async () => {
    const q = new SaveQueue<string>()
    const r = await q.enqueue({ docId: 'd', run: async () => 'only' })
    expect(r.superseded).toBe(false)
  })

  it('freeze 暂停出队，unfreeze 恢复', async () => {
    const q = new SaveQueue<string>()
    const d1 = deferred<string>()
    const d2 = deferred<string>()
    const p1 = q.enqueue({ docId: 'd', run: () => d1.promise })
    // req1 在跑时冻结
    q.freeze('d')
    expect(q.isFrozen('d')).toBe(true)
    const run2 = vi.fn(() => d2.promise)
    const p2 = q.enqueue({ docId: 'd', run: run2 })
    // req1 完成后，因冻结 req2 不应执行
    d1.resolve('r1')
    await p1
    await new Promise((r) => setTimeout(r, 10))
    expect(run2).not.toHaveBeenCalled()
    // 解冻后 req2 恢复执行
    q.unfreeze('d')
    d2.resolve('r2')
    const r2 = await p2
    expect(r2.result).toBe('r2')
  })

  it('run 抛错：reject 且不阻断后续请求', async () => {
    const q = new SaveQueue<string>()
    const p1 = q.enqueue({ docId: 'd', run: async () => {
      throw new Error('boom')
    } })
    const p2 = q.enqueue({ docId: 'd', run: async () => 'after' })
    await expect(p1).rejects.toThrow('boom')
    const r2 = await p2
    expect(r2.result).toBe('after')
  })
})
