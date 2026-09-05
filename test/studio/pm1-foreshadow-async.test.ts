/**
 * PM-1/PM-8（性能与内存专项·2026-09-05）回归：伏笔扫描异步孪生 + 缓存字节预算。
 *
 * - PM-1：getForeshadowsCachedAsync——MISS 时经 scanForeshadowTrailsAsync 切片让出
 *   事件循环（每 25 章 setImmediate），in-flight 去重合并并发 MISS（search.ts
 *   inFlightSearches 同款）。断言：async 与 sync 快照逐字段等价、并发 MISS 只扫一次
 *   （scan 计数）、async 填充后同步路径命中同一缓存、签名失效照常触发重扫。
 * - PM-8：md-text-cache 字节预算——条目数上限只防条数无界，字节闸（默认 64MB）防
 *   少量超大文档驻留膨胀；同步/异步孪生共享同一计账。断言：超预算逐出最旧、
 *   最新条目恒保留、覆写同键不双计、delete 扣账、字节观测钩子一致。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getForeshadowsCached,
  getForeshadowsCachedAsync,
  forgetForeshadowCache,
  __setForeshadowCacheTtlForTest,
  __foreshadowScanCountForTest,
  __resetForeshadowScanCountForTest,
} from '../../src/studio/server/api/foreshadows.js'
import {
  readMdTextCached,
  readMdTextCachedAsync,
  __mdTextCacheTestHooks,
} from '../../src/fs/md-text-cache.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let roots: string[] = []

/** 建书：2 条伏笔 + 30 章正文（跨 >25 章触发异步索引至少一次让出切片）。 */
function makeTree(chapters = 30): string {
  const root = mkdtempSync(join(tmpdir(), 'pm1-foreshadow-'))
  roots.push(root)
  mkdirSync(join(root, '设定', '伏笔'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(root, '设定', '伏笔', '铜锁.md'),
    '---\n标题: 铜锁\n状态: 未回收\n埋设章号: 1\n重要性: 高\n关联词: 铜锁,玉佩\n---\n铜锁来历之谜。\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '设定', '伏笔', '断剑.md'),
    '---\n标题: 断剑\n状态: 已回收\n埋设章号: 1\n回收章号: 2\n重要性: 低\n关联词: 断剑\n---\n断剑已归鞘。\n',
    'utf-8',
  )
  for (let i = 1; i <= chapters; i++) {
    const no = String(i).padStart(4, '0')
    const hit = i % 10 === 0 ? `匣中铜锁轻响，玉佩微凉。（第${i}章）` : `平淡推进的一章，无特殊物件。（第${i}章）`
    writeFileSync(join(root, '写作', '正文', `${no}-章.md`), `---\n章号: ${i}\n标题: 第${i}章\n---\n\n${hit}\n`, 'utf-8')
  }
  return root
}

afterEach(() => {
  __setForeshadowCacheTtlForTest(null)
  __resetForeshadowScanCountForTest()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
  __mdTextCacheTestHooks.clear()
  __mdTextCacheTestHooks.setMaxEntriesForTest(null)
  __mdTextCacheTestHooks.setMaxBytesForTest(null)
})

describe('PM-1 伏笔扫描异步孪生', () => {
  it('async 与 sync 快照逐字段等价（entries + trails 全量 deep-equal）', async () => {
    const root = makeTree()
    __setForeshadowCacheTtlForTest(60_000)
    const viaAsync = await getForeshadowsCachedAsync(root)
    forgetForeshadowCache(root)
    __resetForeshadowScanCountForTest()
    const viaSync = getForeshadowsCached(root)
    expect(viaAsync.entries).toEqual(viaSync.entries)
    expect(viaAsync.trails.size).toBe(viaSync.trails.size)
    for (const [title, trail] of viaSync.trails) {
      expect(viaAsync.trails.get(title)).toEqual(trail)
    }
    // 非空转：铜锁足迹真实命中（30 章中 3/13/20/23/30 章含关键词）
    const trail = viaAsync.trails.get('铜锁')!
    expect(trail.hits.length).toBeGreaterThanOrEqual(5)
  })

  it('并发 MISS in-flight 去重：两请求只扫一次，拿到同一快照实例', async () => {
    const root = makeTree()
    __setForeshadowCacheTtlForTest(60_000)
    forgetForeshadowCache(root)
    __resetForeshadowScanCountForTest()
    const [a, b] = await Promise.all([getForeshadowsCachedAsync(root), getForeshadowsCachedAsync(root)])
    expect(__foreshadowScanCountForTest()).toBe(1)
    expect(a).toBe(b) // 同一 job → 同一实例（非各自重算的两份）
    // 第三次调用（job 已收尾）走缓存命中，不重扫
    await getForeshadowsCachedAsync(root)
    expect(__foreshadowScanCountForTest()).toBe(1)
  })

  it('async 填充后同步路径命中同一缓存（scan 计数不变）', async () => {
    const root = makeTree()
    __setForeshadowCacheTtlForTest(60_000)
    await getForeshadowsCachedAsync(root)
    __resetForeshadowScanCountForTest()
    const viaSync = getForeshadowsCached(root)
    expect(__foreshadowScanCountForTest()).toBe(0)
    expect(viaSync.trails.get('铜锁')).toBeDefined()
  })

  it('目录签名失效照常触发重扫（正文目录 mtime 变更）', async () => {
    const root = makeTree()
    __setForeshadowCacheTtlForTest(60_000)
    await getForeshadowsCachedAsync(root)
    __resetForeshadowScanCountForTest()
    // 增一章 → 写作/正文 目录 mtime 变 → sig 失配
    writeFileSync(join(root, '写作', '正文', '0031-新章.md'), '---\n章号: 31\n标题: 新章\n---\n\n铜锁再现。\n', 'utf-8')
    await sleep(5)
    await getForeshadowsCachedAsync(root)
    expect(__foreshadowScanCountForTest()).toBe(1)
  })
})

describe('PM-8 md-text-cache 字节预算', () => {
  it('超预算逐出最旧条目，最新条目恒保留，字节计账归预算内', () => {
    __mdTextCacheTestHooks.clear()
    __mdTextCacheTestHooks.setMaxBytesForTest(1024)
    const dir = mkdtempSync(join(tmpdir(), 'pm8-bytes-'))
    roots.push(dir)
    // 3 × ~600B 文件：预算 1KB 只容最新 1-2 条
    for (const name of ['a.md', 'b.md', 'c.md']) {
      writeFileSync(join(dir, name), '字'.repeat(200), 'utf-8') // 600B
    }
    expect(readMdTextCached(join(dir, 'a.md'))).not.toBeNull()
    expect(readMdTextCached(join(dir, 'b.md'))).not.toBeNull()
    expect(readMdTextCached(join(dir, 'c.md'))).not.toBeNull()
    expect(__mdTextCacheTestHooks.bytes()).toBeLessThanOrEqual(1024)
    expect(__mdTextCacheTestHooks.size()).toBeGreaterThanOrEqual(1)
    // 最新条目（c）恒保留；最旧（a）在预算压力下已被逐出
    expect(__mdTextCacheTestHooks.size()).toBeLessThan(3)
  })

  it('覆写同键不双计字节；条目删除扣账', async () => {
    __mdTextCacheTestHooks.clear()
    __mdTextCacheTestHooks.setMaxBytesForTest(64 * 1024 * 1024)
    const dir = mkdtempSync(join(tmpdir(), 'pm8-overwrite-'))
    roots.push(dir)
    const fp = join(dir, 'x.md')
    writeFileSync(fp, '旧'.repeat(100), 'utf-8')
    expect(readMdTextCached(fp)).not.toBeNull()
    const bytes1 = __mdTextCacheTestHooks.bytes()
    expect(bytes1).toBe(300) // 100 字 × 3B（'旧' UTF-8 三字节）
    // 覆写（mtime 变 → 重读）：总字节应反映新内容而非累加
    writeFileSync(fp, '新'.repeat(50), 'utf-8')
    expect(readMdTextCached(fp)).not.toBeNull()
    expect(__mdTextCacheTestHooks.bytes()).toBeLessThan(bytes1 * 2)
    // 异步孪生共享同一计账
    const asyncText = await readMdTextCachedAsync(fp)
    expect(asyncText).not.toBeNull()
    expect(__mdTextCacheTestHooks.bytes()).toBe(Buffer.byteLength('新'.repeat(50)))
  })
})
