/**
 * ai-calls 跨进程互斥真锁回归（批次 J7）——真双进程行为级验证。
 *
 * 场景：两个真实子进程（node --import tsx）对同一 bookRoot 并发 recordAiCall
 * 各 40 次。锁生效 → 终态 chapter.used 恒 80（load→mutate→write 整段互斥，
 * 无交错覆盖丢账）；锁失效时（读改写窗口交错）计数概率性小于 80。
 * 顺带验证锁文件用后清理（终态无 .lock 残留）。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, it, expect, afterAll } from 'vitest'
import { spawnNodeEval } from '../helpers/spawn-node.js'

const root = mkdtempSync(join(tmpdir(), 'clwriting-calls-xproc-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const callsPath = fileURLToPath(new URL('../../src/ai/calls.ts', import.meta.url))

/** 起一个子进程并发记账 N 次，resolve 退出码与失败计数（R32-37：看门狗兜底防孤儿进程） */
function spawnWorker(bookRoot: string, n: number): Promise<{ code: number; failures: number }> {
  const script = `
import {
  recordAiCall,
  ledgerWriteFailuresForTest,
  __setAiCallsLockTimeoutForTest,
} from ${JSON.stringify(pathToFileURL(callsPath).href)}
// 本档判据是跨进程互斥（零丢账），不是生产 5s 锁超时的降级面——后者由
// ai-calls-lock-async.test.ts 注入短超时专测。CI 的杀软/索引器瞬时锁可把单次
// 持锁拖过 5s；测试侧放到 30s，避免把「按设计少记一次」误判为互斥失效。
__setAiCallsLockTimeoutForTest(30_000)
for (let i = 0; i < ${n}; i++) {
  recordAiCall(${JSON.stringify(bookRoot)}, 5, { inputTokens: 10, outputTokens: 20 })
}
process.on('beforeExit', () => {
  console.log(JSON.stringify({ failures: ledgerWriteFailuresForTest() }))
})
`
  let stdout = ''
  const { done } = spawnNodeEval(script, { onStdout: (chunk) => (stdout += chunk) })
  return done.then((code) => {
    const m = /"failures":(\d+)/.exec(stdout)
    return { code, failures: m ? Number(m[1]) : -1 }
  })
}

describe('ai-calls 跨进程互斥（J7 真锁）', () => {
  it('双进程并发各记 40 次 → 终态 used 恒 80（零丢账）且锁文件无残留', async () => {
    const bookRoot = join(root, 'bookA')
    const results = await Promise.all([spawnWorker(bookRoot, 40), spawnWorker(bookRoot, 40)])
    expect(results.map((r) => r.code)).toEqual([0, 0])
    // 丢账若来自锁超时降级，失败计数会先于 used 断言指出；两进程都必须零失败。
    expect(results.map((r) => r.failures)).toEqual([0, 0])
    const rec = JSON.parse(readFileSync(join(bookRoot, '.cache', 'ai-calls.json'), 'utf8'))
    expect(rec.chapter.num).toBe(5)
    expect(rec.chapter.used).toBe(80)
    expect(rec.chapter.inputTokens).toBe(800)
    expect(rec.chapter.outputTokens).toBe(1600)
    expect(existsSync(join(bookRoot, '.cache', 'ai-calls.json.lock'))).toBe(false)
  }, 120_000)
})
