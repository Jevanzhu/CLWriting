/**
 * R35-25 / R35-26（三十五轮）回归：withManifestLockAsync 的 async fn 安全与重入键归一。
 *
 * - R35-25：修复前执行器 `return fn()` 在 fn 返回 promise 即触发 finally 释放跨进程
 *   锁——传 async fn 时互斥静默失效（锁在 fn 的首个 await 处就已让渡）。修复后锁内
 *   `await fn()`，锁覆盖 fn 整个执行期（同步 fn 行为不变）。
 * - R35-26：修复前异步版重入键用原始路径串（R33-54 只修了同步版），等价路径变体
 *   再入被误判「他锁」去抢同一物理锁文件，同进程自锁等满超时 fail-closed。修复后
 *   重入键与同步版同走 manifestLockKey 归一。
 */
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { acquireCrossProcessLockAsync } from '../../src/fs/cross-process-lock.js'
import { withManifestLockAsync, __setManifestLockTimeoutForTest, MANIFEST_LOCK_TIMEOUT_MS } from '../../src/document/manifest.js'

let dir = ''
let manifestPath = ''
beforeEach(() => {
  dir = mkdtempTracked('clw-r35-manifest-lock-')
  manifestPath = join(dir, '项目', '文档清单.jsonl')
})
afterEach(() => {
  __setManifestLockTimeoutForTest(MANIFEST_LOCK_TIMEOUT_MS)
})

describe('R35-25：async fn 的锁覆盖期', () => {
  it('fn 内部 await 期间跨进程锁仍被持有；fn 完成后才释放（同步 fn 行为不变）', async () => {
    const events: string[] = []
    const p = withManifestLockAsync(manifestPath, async () => {
      events.push('fn-start')
      await new Promise<void>((resolve) => setTimeout(resolve, 80))
      events.push('fn-end')
      return 'A'
    })
    // fn 尚在执行（探测窗 60ms < fn 内 80ms）：修复前锁已被提前释放，探测能拿到
    const probeDuring = await acquireCrossProcessLockAsync(`${manifestPath}.lock`, 60)
    expect(probeDuring).toBeNull()
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
