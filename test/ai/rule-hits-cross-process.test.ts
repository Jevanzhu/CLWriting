/**
 * rule-hits 跨进程互斥真锁回归（R63-6，十一轮修复批）——真双进程行为级验证。
 *
 * 场景：两个真实子进程（node --import tsx）对同一 bookRoot 并发 recordRuleHits 各
 * 40 次（同一 ruleId）。锁生效 → 终态 hits 恒 80（load→++→write 整段互斥，无交错
 * 覆盖丢计数）；锁失效时 CLI 机检与桌面端并发命中同书会 RMW 交错，计数概率性小于
 * 80（B3 统计失真 + B4 预防指令强度漂移）。顺带验证锁文件用后清理（终态无
 * .cache/rule-hits.json.lock 残留）。
 *
 * 配套超时降级（观测层口径）：warn 留痕跳过文件统计、不抛错（事件双写是独立路径），
 * 锁释放后恢复记录。
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, it, expect, afterAll } from 'vitest'
import { readRuleHits, recordRuleHits, __setRuleHitsLockTimeoutForTest } from '../../src/ai/rule-hits.js'
import { acquireCrossProcessLockWithTimeout } from '../../src/fs/cross-process-lock.js'
import { spawnNodeEval } from '../helpers/spawn-node.js'

const root = mkdtempSync(join(tmpdir(), 'clwriting-rule-hits-xproc-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const ruleHitsPath = fileURLToPath(new URL('../../src/ai/rule-hits.ts', import.meta.url))
// win 下 --eval 内嵌 import 的 specifier 必须是 file URL——反斜杠绝对路径是非法 ESM
// specifier（批次 A worker 修复同款；J0 实测本文件漏网）
const ruleHitsImportSpecifier = pathToFileURL(ruleHitsPath).href

/** 起一个子进程并发记录同一 ruleId 命中 N 次，resolve 退出码（R32-37：看门狗兜底） */
function spawnWorker(bookRoot: string, n: number): Promise<number> {
  const script = `
import { recordRuleHits } from ${JSON.stringify(ruleHitsImportSpecifier)}
for (let i = 0; i < ${n}; i++) {
  await recordRuleHits(${JSON.stringify(bookRoot)}, [{ ruleId: 'xproc-race', level: 'yellow', message: '并发计数回归命中' }])
}
`
  return spawnNodeEval(script).done
}

describe('rule-hits 跨进程互斥（R63-6 真锁）', () => {
  it('双进程并发各记 40 次 → 终态 hits 恒 80（零丢计数）且锁文件无残留', async () => {
    const bookRoot = join(root, 'book-race')
    const codes = await Promise.all([spawnWorker(bookRoot, 40), spawnWorker(bookRoot, 40)])
    expect(codes).toEqual([0, 0])
    const hits = readRuleHits(bookRoot)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.ruleId).toBe('xproc-race')
    expect(hits[0]!.hits).toBe(80)
    expect(existsSync(join(bookRoot, '.cache', 'rule-hits.json.lock'))).toBe(false)
  }, 120_000)

  it('锁超时降级：跳过文件统计不抛错（观测层口径），释放后恢复记录', async () => {
    const bookRoot = mkdtempSync(join(tmpdir(), 'clwriting-rule-hits-degrade-'))
    try {
      // 本进程持锁（pid 活 → 判 held）+ 注入 0ms 超时 → recordRuleHits 恒拿不到锁
      const release = acquireCrossProcessLockWithTimeout(join(bookRoot, '.cache', 'rule-hits.json.lock'), 5_000)
      if (!release) throw new Error('前置：无争用下占锁失败')
      __setRuleHitsLockTimeoutForTest(0)
      try {
        // R32-13：recordRuleHits 异步化（锁等待 acquireCrossProcessLockAsync）
        await recordRuleHits(bookRoot, [{ ruleId: 'degrade', level: 'yellow', message: '超时期间的命中' }])
      } finally {
        __setRuleHitsLockTimeoutForTest(5_000)
        release()
      }
      // 降级口径：本轮命中未落文件统计（warn 留痕，不炸流程）
      expect(existsSync(join(bookRoot, '.cache', 'rule-hits.json'))).toBe(false)
      // 释放后恢复正常记录
      await recordRuleHits(bookRoot, [{ ruleId: 'degrade', level: 'yellow', message: '恢复后的命中' }])
      const hits = readRuleHits(bookRoot)
      expect(hits).toHaveLength(1)
      expect(hits[0]!.hits).toBe(1)
      expect(existsSync(join(bookRoot, '.cache', 'rule-hits.json.lock'))).toBe(false)
    } finally {
      rmSync(bookRoot, { recursive: true, force: true })
    }
  })
})
