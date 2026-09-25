/**
 * withManifestLockAsync（清单跨进程锁的异步孪生）——互斥覆盖期、重入分道与 fail-loud。
 *
 * 三条口径：
 * - 锁覆盖 async fn 整个执行期（R35-25）：修复前执行器 `return fn()` 在 fn 返回 promise
 *   即触发 finally 释放跨进程锁，传 async fn 时互斥静默失效。同步 fn 行为不变。
 * - 重入键归一（R35-26）：异步版重入键与同步版同走 manifestLockKey，等价路径变体再入
 *   命中重入计数，不再误抢同一物理锁自锁至超时。
 * - 重入分支分道（重评2-P2-2）：async fn 排队到持锁者执行链尾串行化、持锁 finally 释放
 *   跨进程锁前排空；同步 fn 维持 depth++ 立即执行（零额外微任务跳数）。真递归（执行体内
 *   再入同 key 且 await 其结果）会排队自等——R0916-6-P3-15 起该形态经 AsyncLocalStorage
 *   携带 lockKey 在排队前即抛错 fail-loud，外部并发调用与嵌套同步 fn（sanctioned 真递归
 *   通道）不受防御影响。真递归调用方须维持同步 fn 形态（声明处：manifest.ts 函数头注）。
 *
 * 时序确定性：在途窗口一律由 deferred 闸门控制（resolve 才继续），不用定长实睡——
 * 「锁在途时探测」的断言不依赖墙钟。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { waitFor } from '../helpers/wait-for.js'
import { acquireCrossProcessLockAsync } from '../../src/fs/cross-process-lock.js'
import {
  MANIFEST_LOCK_TIMEOUT_MS,
  withManifestLock,
  withManifestLockAsync,
  __setManifestLockTimeoutForTest,
} from '../../src/document/manifest.js'

/** 手动放行的闸门（精确编排「持锁在途」窗口）。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

let dir = ''
let manifestPath = ''

beforeEach(() => {
  dir = mkdtempTracked('clw-manifest-lock-async-')
  manifestPath = join(dir, '项目', '文档清单.jsonl')
})

afterEach(() => {
  __setManifestLockTimeoutForTest(MANIFEST_LOCK_TIMEOUT_MS)
})

describe('R35-25：async fn 的锁覆盖期', () => {
  it('fn 内部 await 期间跨进程锁仍被持有；fn 完成后才释放（同步 fn 行为不变）', async () => {
    const events: string[] = []
    const gate = deferred()
    const p = withManifestLockAsync(manifestPath, async () => {
      events.push('fn-start')
      await gate.promise // fn 在途（修复前锁已在此让渡出去）
      events.push('fn-end')
      return 'A'
    })
    await waitFor(() => events.includes('fn-start'))
    // fn 尚在执行（闸门未放行）：修复前锁已被提前释放，探测能拿到
    const probeDuring = await acquireCrossProcessLockAsync(`${manifestPath}.lock`, 60)
    expect(probeDuring).toBeNull()
    gate.resolve()
    expect(await p).toBe('A')
    expect(events).toEqual(['fn-start', 'fn-end'])
    // fn 完成后锁已释放：探测可拿到
    const probeAfter = await acquireCrossProcessLockAsync(`${manifestPath}.lock`, 60)
    expect(probeAfter).not.toBeNull()
    probeAfter?.()
  })
})

describe('R35-26：重入键 manifestLockKey 归一（与同步版对齐）', () => {
  it('归一等价路径变体再入命中重入计数，不再误抢同一物理锁自锁至超时', async () => {
    __setManifestLockTimeoutForTest(80) // 修复前：内层会自锁等满 2×80ms 后 fail-closed 抛错
    const variant = join(dir, '项目', '..', '项目', '文档清单.jsonl') // resolve 后与 manifestPath 等价
    const inner = await withManifestLockAsync(manifestPath, async () =>
      withManifestLockAsync(variant, () => 'inner-ok'),
    )
    expect(inner).toBe('inner-ok')
  })
})

describe('重入 async fn 同进程排队串行化（重评2-P2-2①）', () => {
  it('外层持锁、首个 fn await 在途时发起的重入 async 调用排队至其完成后执行——共享日志不交错；排队者执行期间跨进程锁仍被持有', async () => {
    const events: string[] = []
    const gateA = deferred()
    const a = withManifestLockAsync(manifestPath, async () => {
      events.push('A-start')
      await gateA.promise
      events.push('A-end')
      return 'A'
    })
    await waitFor(() => events.includes('A-start'))
    const gateB = deferred()
    const b = withManifestLockAsync(manifestPath, async () => {
      events.push('B-start')
      await gateB.promise
      events.push('B-end')
      return 'B'
    })
    // 修复前 B 在 A 的 await 间隙立即执行（events 已含 B-start）；修复后排队未启动
    expect(events).toEqual(['A-start'])

    gateA.resolve()
    // 排空期跨进程锁不释放——等 B 真正开跑再探测（原定点实睡在机器负载下可漂过执行窗）
    await waitFor(() => events.includes('B-start'))
    const probeDuringB = await acquireCrossProcessLockAsync(`${manifestPath}.lock`, 30)
    expect(probeDuringB).toBeNull()

    gateB.resolve()
    const [va, vb] = await Promise.all([a, b])
    expect(va).toBe('A')
    expect(vb).toBe('B')
    // 串行且不交错
    expect(events).toEqual(['A-start', 'A-end', 'B-start', 'B-end'])
    // 全部完成后（含排空）跨进程锁已释放
    const probeAfter = await acquireCrossProcessLockAsync(`${manifestPath}.lock`, 60)
    expect(probeAfter).not.toBeNull()
    probeAfter?.()
  })

  it('前序排队 async fn 抛错不阻断后续排队者，也不阻断释放', async () => {
    const events: string[] = []
    const started = deferred()
    const gateA = deferred()
    const a = withManifestLockAsync(manifestPath, async () => {
      started.resolve()
      await gateA.promise
      events.push('A-end')
    })
    await started.promise
    const b = withManifestLockAsync(manifestPath, async () => {
      throw new Error('B-boom')
    })
    const c = withManifestLockAsync(manifestPath, async () => {
      events.push('C-run')
    })
    gateA.resolve()
    await a
    await expect(b).rejects.toThrow('B-boom')
    await c
    expect(events).toEqual(['A-end', 'C-run'])
    const probe = await acquireCrossProcessLockAsync(`${manifestPath}.lock`, 60)
    expect(probe).not.toBeNull()
    probe?.()
  })
})

describe('重入同步 fn 行为不变（现状钉死，重评2-P2-2②）', () => {
  it('嵌套同步 fn 重入立即执行（不排队、零额外微任务跳数），depth 计数放行不自锁', async () => {
    const order: string[] = []
    const r = await withManifestLockAsync(manifestPath, async () => {
      order.push('outer-before')
      const inner = withManifestLockAsync(manifestPath, () => {
        order.push('inner-sync-exec') // 同步 fn：调用点立即执行（若被排队则此行将晚于下一行）
        return 'inner'
      })
      order.push('outer-after-call')
      const v = await inner
      order.push('outer-after-await')
      return v
    })
    expect(r).toBe('inner')
    expect(order).toEqual(['outer-before', 'inner-sync-exec', 'outer-after-call', 'outer-after-await'])
  })

  it('持锁 async fn 在途时到达的并发同步 fn 重入：立即执行——调用返回时 fn 已执行完（零延迟）', async () => {
    let executed = false
    const started = deferred()
    const gateA = deferred()
    const a = withManifestLockAsync(manifestPath, async () => {
      started.resolve()
      await gateA.promise
    })
    await started.promise // 外层 fn await 在途
    // 不 await：同步快道要求调用返回前 fn 已执行（零额外微任务跳数）
    void withManifestLockAsync(manifestPath, () => {
      executed = true
    })
    expect(executed).toBe(true)
    gateA.resolve()
    await a
  })

  it('同步版 withManifestLock 的重入登记（无排队链）仍放行嵌套获取，不自锁', () => {
    const v = withManifestLock(manifestPath, () => withManifestLock(manifestPath, () => 'nested-ok'))
    expect(v).toBe('nested-ok')
  })
})

describe('R0916-6-P3-15：清单锁 async 同 key 重入自等死锁 fail-loud', () => {
  it('持锁 async fn 体内 await 同 key async 重入 → 排队前即抛错（修复前无限挂死）', async () => {
    await expect(
      withManifestLockAsync(manifestPath, async () => {
        await withManifestLockAsync(manifestPath, async () => 'nested')
      }),
    ).rejects.toThrow(/异步重入自等死锁/)
  })

  it('外部并发 async 调用（非嵌套）不受防御影响：照常排队串行完成', async () => {
    const events: string[] = []
    const started = deferred()
    const gateA = deferred()
    const a = withManifestLockAsync(manifestPath, async () => {
      events.push('A-start')
      started.resolve()
      await gateA.promise
      events.push('A-end')
    })
    await started.promise // 外层 fn 已进入 await 在途——此刻外部第二调用（测试上下文，非嵌套）
    const b = withManifestLockAsync(manifestPath, async () => {
      events.push('B-run')
    })
    expect(events).toEqual(['A-start']) // B 排队未启动
    gateA.resolve()
    await Promise.all([a, b])
    expect(events).toEqual(['A-start', 'A-end', 'B-run'])
  })

  it('嵌套同步 fn 重入（sanctioned 真递归通道）不受防御影响', async () => {
    const r = await withManifestLockAsync(manifestPath, async () =>
      withManifestLockAsync(manifestPath, () => 'sync-nested'),
    )
    expect(r).toBe('sync-nested')
  })
})
