/**
 * 重评2-P2-2（2026-09-09 全量重评 GLM-5.3）回归：withManifestLockAsync 重入分支
 * 对 async fn 的同进程互斥机制化。
 *
 * - 修复前（R43-10 注释纪律形态）：重入命中直接执行 fn 不排队——fn 一旦含 await，
 *   同进程同 key 的并发调用在首个 fn 的 await 间隙交错执行，同进程互斥静默失效
 *   （跨进程锁仍覆盖，R35-25）。
 * - 修复后：重入分支分道——async fn 排队到持锁者执行链尾（held.tail）串行化、
 *   持锁 finally 释放跨进程锁前排空；同步 fn 维持 depth++ 立即执行（零语义变更、
 *   零额外微任务跳数）。
 * - 防真递归死锁边界（有意不钉死锁形态）：同一次 fn 执行体内再次重入同 key 且
 *   await 其结果（真递归）会排队自等死锁——现有生产调用方（service/trash/state/
 *   finalize/draft-pipeline）经 grep 核实全为同步 fn、无递归形态；真递归调用方须
 *   维持同步 fn 形态（声明处：manifest.ts withManifestLockAsync 函数头注）。
 */
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { acquireCrossProcessLockAsync } from '../../src/fs/cross-process-lock.js'
import { withManifestLock, withManifestLockAsync } from '../../src/document/manifest.js'

let dir = ''
let manifestPath = ''
beforeEach(() => {
  dir = mkdtempTracked('clw-re2-manifest-reentry-')
  manifestPath = join(dir, '项目', '文档清单.jsonl')
})

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('重评2-P2-2①：重入 async fn 同进程排队串行化', () => {
  it('外层持锁、首个 fn await 在途时发起的重入 async 调用排队至其完成后执行——共享日志不交错；排队者执行期间跨进程锁仍被持有', async () => {
    const events: string[] = []
    const a = withManifestLockAsync(manifestPath, async () => {
      events.push('A-start')
      await sleep(80)
      events.push('A-end')
      return 'A'
    })
    await sleep(20) // 外层 fn 已进入 await 在途（held 在册）——此刻发起重入
    const b = withManifestLockAsync(manifestPath, async () => {
      events.push('B-start')
      await sleep(80)
      events.push('B-end')
      return 'B'
    })
    // 修复前 B 在 A 的 await 间隙立即执行（events 已含 B-start）；修复后排队未启动
    expect(events).toEqual(['A-start'])
    // ~120ms：A 已完（80ms）、B 在途（~80→160ms）——排空期跨进程锁不释放
    await sleep(100)
    const probeDuringB = await acquireCrossProcessLockAsync(`${manifestPath}.lock`, 30)
    expect(probeDuringB).toBeNull()
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
    const a = withManifestLockAsync(manifestPath, async () => {
      await sleep(30)
      events.push('A-end')
    })
    await sleep(10)
    const b = withManifestLockAsync(manifestPath, async () => {
      throw new Error('B-boom')
    })
    const c = withManifestLockAsync(manifestPath, async () => {
      events.push('C-run')
    })
    await a
    await expect(b).rejects.toThrow('B-boom')
    await c
    expect(events).toEqual(['A-end', 'C-run'])
    const probe = await acquireCrossProcessLockAsync(`${manifestPath}.lock`, 60)
    expect(probe).not.toBeNull()
    probe?.()
  })
})

describe('重评2-P2-2②：重入同步 fn 行为不变（现状钉死）', () => {
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
    const a = withManifestLockAsync(manifestPath, async () => {
      await sleep(60)
    })
    await sleep(15) // 外层 fn await 在途
    // 不 await：同步快道要求调用返回前 fn 已执行（零额外微任务跳数）
    void withManifestLockAsync(manifestPath, () => {
      executed = true
    })
    expect(executed).toBe(true)
    await a
  })

  it('同步版 withManifestLock 的重入登记（无排队链）仍放行嵌套获取，不自锁', () => {
    const v = withManifestLock(manifestPath, () => withManifestLock(manifestPath, () => 'nested-ok'))
    expect(v).toBe('nested-ok')
  })
})
