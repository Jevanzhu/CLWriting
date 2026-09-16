/**
 * R0916-6-P3-15（2026-09-16 五轮全库重评修复批）回归：withManifestLockAsync 的
 * async 同 key 重入自等死锁 fail-loud——此前该形态排队自等无限挂死（声明边界，
 * re2 回归有意不钉）；现持锁执行体经 AsyncLocalStorage 携带 lockKey，嵌套 async
 * 重入在排队前即抛错。外部并发调用（非嵌套）与嵌套同步 fn（sanctioned 真递归
 * 通道）不受防御影响（后两用例钉死）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { withManifestLockAsync } from '../../src/document/manifest.js'
import { sleep } from '../helpers/wait-for.js'

let manifestPath = ''
beforeEach(() => {
  manifestPath = join(mkdtempTracked('clw-manifest-lock-guard-'), '项目', '文档清单.jsonl')
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
    const a = withManifestLockAsync(manifestPath, async () => {
      events.push('A-start')
      await sleep(40)
      events.push('A-end')
    })
    await sleep(10) // 外层 fn 已进入 await 在途——此刻外部第二调用（测试上下文，非嵌套）
    const b = withManifestLockAsync(manifestPath, async () => {
      events.push('B-run')
    })
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
