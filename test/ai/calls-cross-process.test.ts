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
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, it, expect, afterAll } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'clwriting-calls-xproc-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const callsPath = fileURLToPath(new URL('../../src/ai/calls.ts', import.meta.url))

/** 起一个子进程并发记账 N 次，resolve 退出码 */
function spawnWorker(bookRoot: string, n: number): Promise<number> {
  const script = `
import { recordAiCall } from ${JSON.stringify(pathToFileURL(callsPath).href)}
for (let i = 0; i < ${n}; i++) {
  recordAiCall(${JSON.stringify(bookRoot)}, 5, { inputTokens: 10, outputTokens: 20 })
}
`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script], { stdio: 'pipe' })
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += c.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`worker 退出码 ${code}：${stderr.slice(0, 500)}`))
      else resolve(code ?? 0)
    })
  })
}

describe('ai-calls 跨进程互斥（J7 真锁）', () => {
  it('双进程并发各记 40 次 → 终态 used 恒 80（零丢账）且锁文件无残留', async () => {
    const bookRoot = join(root, 'bookA')
    const codes = await Promise.all([spawnWorker(bookRoot, 40), spawnWorker(bookRoot, 40)])
    expect(codes).toEqual([0, 0])
    const rec = JSON.parse(readFileSync(join(bookRoot, '.cache', 'ai-calls.json'), 'utf8'))
    expect(rec.chapter.num).toBe(5)
    expect(rec.chapter.used).toBe(80)
    expect(rec.chapter.inputTokens).toBe(800)
    expect(rec.chapter.outputTokens).toBe(1600)
    expect(existsSync(join(bookRoot, '.cache', 'ai-calls.json.lock'))).toBe(false)
  }, 120_000)
})
