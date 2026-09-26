/**
 * 0918二轮修复批（D104）：rebuild worker 超时环境变量逃生口回归——原固定 120s 无
 * 按书规模调整入口，慢盘/网盘大书首次全量 rebuild 触顶 terminate。修复：模块加载读
 * CLWRITING_REBUILD_TIMEOUT_MS 一次（未设/非法回默认 120s），生产调用方（state.ts /
 * summary.ts 均不传 opts）经缺省档贯穿到 worker 超时。
 *
 * 手法：① 解析函数纯直测（合法/非法档位表）；② 全链 wiring——vi.resetModules 后设
 * env 再动态 import（模块加载读一次的语义随之受测），配临时 .mjs worker（r57 先例）：
 * 永不回包 worker 验「env 档位到点被 terminate（拒绝文案含上限值）」，60ms 回包
 * worker 验「非法 env 回默认 120s 档、照常跑通不炸」。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempTracked } from '../helpers/temp-dir.js'

afterEach(() => {
  delete process.env['CLWRITING_REBUILD_TIMEOUT_MS']
  vi.resetModules()
})

/** 永不回包 worker：记录起跑后挂常驻定时器保活（事件循环空转会自然退出，exit 监听
 *  先于超时拒绝——须真悬到超时），拒绝走 timeout 路径，文案含档位值 */
const NEVER_WORKER = `
import { parentPort } from 'node:worker_threads'
import { appendFileSync } from 'node:fs'
parentPort.once('message', (job) => {
  appendFileSync(job.cachePath + '.marks', 'start\\n', 'utf-8')
  setInterval(() => {}, 60_000)
})
`
/** 慢 worker：60ms 后回包（r57 先例同款）——默认 120s 档下正常跑通 */
const SLOW_WORKER = `
import { parentPort } from 'node:worker_threads'
import { appendFileSync } from 'node:fs'
parentPort.once('message', (job) => {
  appendFileSync(job.cachePath + '.marks', 'start\\n', 'utf-8')
  setTimeout(() => parentPort.postMessage({ ok: true, cachePath: job.cachePath }), 60)
})
`

function makeCase(name: string, src: string): { dir: string; workerUrl: URL } {
  const dir = mkdtempTracked(join(tmpdir(), `clw-d104-${name}-`))
  const workerScript = join(dir, 'worker.mjs')
  writeFileSync(workerScript, src, 'utf8')
  return { dir, workerUrl: pathToFileURL(workerScript) }
}

describe('D104：rebuild 超时 env 逃生口（CLWRITING_REBUILD_TIMEOUT_MS）', () => {
  it('解析单源：合法档位采用，未设/空白/非数/非正数一律回默认 120s', async () => {
    const { resolveRebuildTimeoutMs, DEFAULT_REBUILD_TIMEOUT_MS } = await import('../../src/cache/run-rebuild-async.js')
    expect(DEFAULT_REBUILD_TIMEOUT_MS).toBe(120_000)
    expect(resolveRebuildTimeoutMs()).toBe(120_000) // 缺省参数 = process.env 当前未设
    expect(resolveRebuildTimeoutMs({})).toBe(120_000) // 未设
    expect(resolveRebuildTimeoutMs({ CLWRITING_REBUILD_TIMEOUT_MS: undefined })).toBe(120_000)
    expect(resolveRebuildTimeoutMs({ CLWRITING_REBUILD_TIMEOUT_MS: '  ' })).toBe(120_000) // 空白
    expect(resolveRebuildTimeoutMs({ CLWRITING_REBUILD_TIMEOUT_MS: 'abc' })).toBe(120_000) // 非数
    expect(resolveRebuildTimeoutMs({ CLWRITING_REBUILD_TIMEOUT_MS: '0' })).toBe(120_000) // 非正
    expect(resolveRebuildTimeoutMs({ CLWRITING_REBUILD_TIMEOUT_MS: '-5' })).toBe(120_000) // 负数
    expect(resolveRebuildTimeoutMs({ CLWRITING_REBUILD_TIMEOUT_MS: '300000' })).toBe(300_000)
    expect(resolveRebuildTimeoutMs({ CLWRITING_REBUILD_TIMEOUT_MS: '1500.9' })).toBe(1500) // 小数向下取整
  })

  it('全链 wiring：env 档位贯穿到 worker 超时（不传 timeoutMs，仅 stub worker）', async () => {
    process.env['CLWRITING_REBUILD_TIMEOUT_MS'] = '300' // 模块加载读一次：import 前设
    const { runRebuildAsync } = await import('../../src/cache/run-rebuild-async.js')
    const { dir, workerUrl } = makeCase('never', NEVER_WORKER)
    const cachePath = join(dir, 'index.db')
    // 永不回包 worker 在 env 档位 300ms 到点被 terminate——拒绝文案含该档位值，
    // 证明 env → 缺省档 → runWorkerJob 超时的生产贯穿（生产调用方即此形态：不传 opts）
    await expect(runRebuildAsync({ bookRoot: dir, cachePath }, { workerUrl })).rejects.toThrow(
      'rebuild 超时（上限 300ms）',
    )
    expect(readFileSync(cachePath + '.marks', 'utf8').trim()).toBe('start') // worker 真起跑过
  })

  it('非法 env 回默认档：60ms 回包 worker 在 120s 默认档下照常跑通', async () => {
    process.env['CLWRITING_REBUILD_TIMEOUT_MS'] = 'not-a-number'
    vi.resetModules() // 前一用例的模块实例读的是 '150'，须重取读 env 一次的全新实例
    const { runRebuildAsync } = await import('../../src/cache/run-rebuild-async.js')
    const { dir, workerUrl } = makeCase('slow', SLOW_WORKER)
    const r = await runRebuildAsync({ bookRoot: dir, cachePath: join(dir, 'index.db') }, { workerUrl })
    expect(r).toEqual({ ok: true, cachePath: join(dir, 'index.db') }) // 回默认 120s，不炸不悬挂
  })
})
