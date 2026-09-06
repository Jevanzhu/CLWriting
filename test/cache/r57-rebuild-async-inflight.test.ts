/**
 * R57-A-1（五十七轮）回归：runRebuildAsync 同 cachePath in-flight 合并（单飞）。
 *
 * 修复前：每次调用新建 Worker，零 in-flight 去重零互斥——同步时代 rebuild() 阻塞
 * 事件循环、同进程并发 detectState 天然串行；R55-B-N worker 化后 await 让出事件循环，
 * /state 与 /overview（两套互不可见的 stateCache）同拍首进门可各起一个 Worker 并发
 * BEGIN 写同一 .cache/index.db——大书全量 >busy_timeout(5s) 时后到者 SQLITE_BUSY 抛
 * 错 → detectState catch 降级态 2「缓存重建失败：database is locked」误导用户删库。
 * 修复：按 cachePath 进程内 Map 合并，并发调用共享同一 Promise；settle 清键（下次
 * 调用重新起跑，失败自愈语义不变）；不同 cachePath 不合并（防过度合并）。
 *
 * 手法：RebuildRunnerOptions.workerUrl 注入临时 .mjs worker（run-async-exit.test.ts
 * 先例）——worker 收 job 后向 `<cachePath>.marks` 追加一行「start」再延时回包，
 * 以落盘行数作「Worker 实际起跑数」的证据（并发窗 60ms，同拍两调用必落合并窗）。
 */
import { rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runRebuildAsync } from '../../src/cache/run-rebuild-async.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 慢 worker：记录起跑（cachePath 旁路 marks 文件）→ 60ms 后回包（RebuildResult 形状自由：直测透传） */
const SLOW_WORKER = `
import { parentPort } from 'node:worker_threads'
import { appendFileSync } from 'node:fs'
parentPort.once('message', (job) => {
  appendFileSync(job.cachePath + '.marks', 'start\\n', 'utf-8')
  setTimeout(() => parentPort.postMessage({ ok: true, cachePath: job.cachePath }), 60)
})
`
/** 失败 worker：收 job 记起跑 marks 后不回包直接退出 → 走 'exit' 监听拒绝路径（R65-29 同款） */
const EXIT_WORKER = `
import { parentPort } from 'node:worker_threads'
import { appendFileSync } from 'node:fs'
parentPort.once('message', (job) => {
  appendFileSync(job.cachePath + '.marks', 'start\\n', 'utf-8')
  process.exit(1)
})
`

function makeCase(name: string, src: string): { dir: string; workerUrl: URL } {
  const dir = mkdtempTracked(join(tmpdir(), `clw-r57-a1-${name}-`))
  const workerScript = join(dir, 'worker.mjs')
  writeFileSync(workerScript, src, 'utf-8')
  return { dir, workerUrl: pathToFileURL(workerScript) }
}

describe('R57-A-1：runRebuildAsync 同 cachePath in-flight 合并', () => {
  it('同拍并发两调用同 cachePath → 只起一个 Worker，两调用共享同一结果', async () => {
    const { dir, workerUrl } = makeCase('single', SLOW_WORKER)
    try {
      const cachePath = join(dir, 'index.db')
      const p1 = runRebuildAsync({ bookRoot: dir, cachePath }, { workerUrl, timeoutMs: 5_000 })
      const p2 = runRebuildAsync({ bookRoot: dir, cachePath }, { workerUrl, timeoutMs: 5_000 })
      const [r1, r2] = await Promise.all([p1, p2])
      // 修复点：Worker 起跑数 = 1（修复前 marks 两行 = 两 Worker 并发写同一库）
      expect(readFileSync(cachePath + '.marks', 'utf-8').trim()).toBe('start')
      expect(r1).toBe(r2) // 共享同一 Promise：同一对象、同 settle
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('settle 后清键：下一拍同 cachePath 调用重新起跑（自愈面），不吞新调用', async () => {
    const { dir, workerUrl } = makeCase('recycle', SLOW_WORKER)
    try {
      const cachePath = join(dir, 'index.db')
      const r1 = await runRebuildAsync({ bookRoot: dir, cachePath }, { workerUrl, timeoutMs: 5_000 })
      const r2 = await runRebuildAsync({ bookRoot: dir, cachePath }, { workerUrl, timeoutMs: 5_000 })
      expect(readFileSync(cachePath + '.marks', 'utf-8').trim().split('\n')).toHaveLength(2)
      expect(r2).not.toBe(r1) // 新一轮起跑，非旧 Promise 复用
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不同 cachePath 不合并：并发两调用各起一个 Worker（防过度合并伤真并发）', async () => {
    const { dir, workerUrl } = makeCase('distinct', SLOW_WORKER)
    try {
      const a = join(dir, 'a.db')
      const b = join(dir, 'b.db')
      await Promise.all([
        runRebuildAsync({ bookRoot: dir, cachePath: a }, { workerUrl, timeoutMs: 5_000 }),
        runRebuildAsync({ bookRoot: dir, cachePath: b }, { workerUrl, timeoutMs: 5_000 }),
      ])
      expect(readFileSync(a + '.marks', 'utf-8').trim()).toBe('start')
      expect(readFileSync(b + '.marks', 'utf-8').trim()).toBe('start')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('失败也清键：首次拒绝后再次调用重新起跑（不共享已拒绝 Promise），失败自愈语义不变', async () => {
    const { dir, workerUrl } = makeCase('failure', EXIT_WORKER)
    try {
      const cachePath = join(dir, 'index.db')
      await expect(
        runRebuildAsync({ bookRoot: dir, cachePath }, { workerUrl, timeoutMs: 5_000 }),
      ).rejects.toThrow(/已退出/)
      await expect(
        runRebuildAsync({ bookRoot: dir, cachePath }, { workerUrl, timeoutMs: 5_000 }),
      ).rejects.toThrow(/已退出/)
      // 两次调用 = 两次 Worker 起跑（首次失败清键后第二次真起跑；修复前本就如此，
      // 钉住「合并不改变失败路径重试语义」）
      expect(readFileSync(cachePath + '.marks', 'utf-8').trim().split('\n')).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
