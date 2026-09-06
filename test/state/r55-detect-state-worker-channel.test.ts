/**
 * R55-B-N（五十五轮）回归：detectState 的 rebuild 通道分流（sync 缺省 / worker HTTP 专用）。
 *
 * 修复前：detectState 在布线书分支内联同步调 rebuild(bookRoot, cachePath)（readChapter×N
 * + countWords + 全量重写的同步内核）——HTTP 消费点（/api/state、/api/overview）在大书
 * index.db 缺失/损坏首进门时秒级冻结 utilityProcess 事件循环。修复：detectState 增
 * opts.rebuildChannel——'worker' 走 R48-11 worker 通道（runRebuildAsync，summary.ts
 * 先例同款），缺省 'sync' 进程内同步（CLI enter/库形态/既有测试零变更）；异常路径共
 * 用既有 catch → 降级态 2 报文语义，结果结构同构（RebuildResult）。
 *
 * 手法：vi.mock importOriginal 委托（既有 detectState mock 先例同款）——worker 通道用
 * 例经委托真跑 worker 线程（vitest 下 tsx loader 可直跑，已实测）；失败用例
 * mockRejectedValueOnce 钉降级语义；sync 通道用例钉「不经 worker、行为零变更」。
 */
import { existsSync } from 'node:fs'

import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/cache/run-rebuild-async.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cache/run-rebuild-async.js')>()
  return { ...actual, runRebuildAsync: vi.fn(actual.runRebuildAsync) }
})

import { runRebuildAsync } from '../../src/cache/run-rebuild-async.js'
import { detectState } from '../../src/state/state.js'
import { makeGitBook } from '../helpers/book.js'
import { trackTempDir } from '../helpers/temp-dir.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'

const runRebuildAsyncMock = vi.mocked(runRebuildAsync)

afterEach(() => {
  runRebuildAsyncMock.mockClear()
})

/** 布线长篇书（makeGitBook：布线/悬念 1 条 + .cache/ 目录、无 index.db——首进门形态；
 *  正文区保持为空：未登记草稿会让判定合理落入态 4，干扰通道断言的态锚） */
function makeBook(): string {
  return trackTempDir(makeGitBook())
}

describe('R55-B-N：detectState rebuild 通道分流', () => {
  it('worker 通道：真实 worker 建库，结果结构与 sync 等价 + job 参数钉（bookRoot/cachePath）', async () => {
    const rootW = makeBook()
    const rootS = makeBook()
    const cachePath = join(rootW, '.cache', 'index.db')

    const dWorker = await detectState(rootW, DEFAULT_CONFIG, undefined, { rebuildChannel: 'worker' })
    expect(existsSync(cachePath)).toBe(true) // worker 真建了库
    expect(dWorker.state).toBe(7)

    // 结果结构等价：同一形态书走缺省 sync 通道，判定结果逐字段一致
    const dSync = await detectState(rootS, DEFAULT_CONFIG)
    expect(dWorker).toEqual(dSync)

    // job 参数钉：worker 收到与同步版 rebuild 同参的作业（summary.ts 先例同形）
    expect(runRebuildAsyncMock).toHaveBeenCalledWith({ bookRoot: rootW, cachePath })
  }, 30_000)

  it('worker 通道失败 → 既有 catch 降级态 2 报文不变（缓存重建失败：…）', async () => {
    const root = makeBook()
    runRebuildAsyncMock.mockRejectedValueOnce(new Error('R55-B-N 注入：worker 爆炸'))

    const d = await detectState(root, DEFAULT_CONFIG, undefined, { rebuildChannel: 'worker' })
    expect(d.state).toBe(2)
    if (d.state !== 2) return
    expect(d.parseErrors).toHaveLength(1)
    expect(d.parseErrors[0]!.message).toContain('缓存重建失败')
    expect(d.parseErrors[0]!.message).toContain('R55-B-N 注入：worker 爆炸')
  })

  it('缺省与显式 sync 通道不经 worker（调用数不增）——同步调用方行为零变更', async () => {
    const callsBefore = runRebuildAsyncMock.mock.calls.length

    const rootDefault = makeBook()
    const d1 = await detectState(rootDefault, DEFAULT_CONFIG)
    expect(d1.state).toBe(7)
    expect(runRebuildAsyncMock.mock.calls.length).toBe(callsBefore)

    const rootExplicit = makeBook()
    const d2 = await detectState(rootExplicit, DEFAULT_CONFIG, undefined, { rebuildChannel: 'sync' })
    expect(d2.state).toBe(7)
    expect(runRebuildAsyncMock.mock.calls.length).toBe(callsBefore)
  })
})
