/**
 * R0912-E-P3-2（2026-09-12 独立重评修复批）回归：pruneVersions 可选 knownList——
 * writeVersion 顺带 prune 的链路复用已 listVersions 的列表（补上刚写入的新条目），
 * 跳过重复 readdir；不传（其他调用方）行为不变。
 *
 * - 写入链语义锚：maxCount=3 下连写 4 版 → 最旧版被 prune，留存恒 3
 *   （knownList 含新条目 ⇒ 与内部重扫逐位等价）；
 * - 等价性：同构双档案，传 knownList 与不传的 prune 结果（删除数/留存序）一致。
 *
 * 注：ulid() 随机后缀非进程内单调，同毫秒写入的 id 序不稳定——逐版间隔 ≥5ms
 * 写入保证 id 时间序 = 创建序（断言锚定的前提）。
 */
import { describe, it, expect } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeVersion, pruneVersions, listVersions, type VersionPolicy } from '../../src/document/version.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const POLICY_MAX3: VersionPolicy = { maxDays: 14, maxCount: 3, throttleMinutes: 0 }
const POLICY_KEEP: VersionPolicy = { maxDays: 14, maxCount: 999, throttleMinutes: 0 }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 逐版间隔 ≥5ms 写 n 版（保证 ULID 时间序 = 创建序），返回创建序 id 数组 */
async function seed(dir: string, n: number, policy: VersionPolicy = POLICY_KEEP): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    if (i > 0) await sleep(5)
    const id = writeVersion(dir, 'doc_test', `第 ${i} 版正文内容各不相同-${i}`, { origin: 'autosave' }, { policy, force: true })
    if (id) ids.push(id)
  }
  return ids
}

describe('R0912-E-P3-2: pruneVersions knownList', () => {
  it('写入链语义锚：maxCount=3 连写 4 版 → 最旧版被清，留存恒 3（不因跳过重扫漂移）', async () => {
    const dir = mkdtempTracked(join(tmpdir(), 'r0912-prune-known-'))
    try {
      const ids = await seed(dir, 4, POLICY_MAX3) // 每次写入后的顺带 prune 走 knownList（含新条目）
      expect(ids).toHaveLength(4)
      const remaining = listVersions(dir, 'doc_test')
      expect(remaining).toHaveLength(3)
      // 最旧版（首个）被清，其余按 id 降序（新在前）留存
      expect(remaining.map((s) => s.id)).toEqual([ids[3]!, ids[2]!, ids[1]!])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('等价性：同构双档案，传 knownList 与不传的 prune 结果一致（删除数/留存序）', async () => {
    const dirA = mkdtempTracked(join(tmpdir(), 'r0912-prune-a-'))
    const dirB = mkdtempTracked(join(tmpdir(), 'r0912-prune-b-'))
    try {
      const idsA = await seed(dirA, 5)
      const idsB = await seed(dirB, 5)
      const policy: VersionPolicy = { maxDays: 14, maxCount: 2, throttleMinutes: 0 }
      const removedB = pruneVersions(dirB, 'doc_test', policy, Date.now(), listVersions(dirB, 'doc_test'))
      const removedA = pruneVersions(dirA, 'doc_test', policy) // 不传 = 旧路径内部现扫
      expect(removedB).toBe(removedA)
      // 两库 ULID 不同，按「创建序下标」对齐比较留存序
      const rankA = listVersions(dirA, 'doc_test').map((s) => idsA.indexOf(s.id))
      const rankB = listVersions(dirB, 'doc_test').map((s) => idsB.indexOf(s.id))
      expect(rankB).toEqual(rankA)
      // 幂等：knownList 路径未破坏状态，二次 prune 零删除
      expect(pruneVersions(dirB, 'doc_test', policy, Date.now(), listVersions(dirB, 'doc_test'))).toBe(0)
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })
})
