/**
 * R44-8（四十四轮）回归：foreshadows 端点「目录指纹 + TTL」缓存壳。
 *
 * 端点原每请求 readForeshadows（设定/伏笔 逐文件 fm 整读）+ scanForeshadowTrails
 *（写作/正文 全书正文收集 + 联合正则扫），?q= 检索同样全量重扫后过滤。R44-8 对齐
 * search.ts R35-7 手法加缓存壳：指纹 = 设定/伏笔 + 写作/正文 两目录 mtime（增删改名
 * 即时失效；就地内容改写由 TTL 5s 兜底）；?q= 过滤在缓存命中后的快照上做
 *（filterForeshadowTrails），不全量重扫。
 *
 * 断言用「全量重扫计数」观测口（__foreshadowScanCountForTest），确定性不依赖墙钟 5s
 *（先例 r35-search-cache / r36-version-stats-cache）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getForeshadowsCached,
  forgetForeshadowCache,
  __setForeshadowCacheTtlForTest,
  __foreshadowScanCountForTest,
  __resetForeshadowScanCountForTest,
} from '../../src/studio/server/api/foreshadows.js'
import { filterForeshadowTrails, searchForeshadowTrails } from '../../src/document/foreshadow.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let roots: string[] = []

/** 建书：2 条伏笔（铜锁 未回收 / 断剑 已回收）+ 2 章正文（1 章含铜锁、2 章含玉佩）。 */
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'r44-fs-cache-'))
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
  // 章文件须带 front matter（format readFile 对无 fm 文件按解析失败处理，正文为空）
  writeFileSync(join(root, '写作', '正文', '0001-雨夜.md'), '---\n章号: 1\n标题: 雨夜\n---\n\n雨夜里，铜锁在匣中轻响。\n', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '0002-晨光.md'), '---\n章号: 2\n标题: 晨光\n---\n\n晨光下，玉佩映出微光。\n', 'utf-8')
  return root
}

afterEach(() => {
  __setForeshadowCacheTtlForTest(null)
  __resetForeshadowScanCountForTest()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
})

describe('R44-8 foreshadows 缓存壳', () => {
  it('TTL 内二次调用命中不重扫（scan 计数不变），快照结果一致', () => {
    const root = makeTree()
    __setForeshadowCacheTtlForTest(60_000)
    const s1 = getForeshadowsCached(root)
    expect(__foreshadowScanCountForTest()).toBe(1)
    expect(s1.entries.map((e) => e.标题).sort()).toEqual(['断剑', '铜锁'])
    expect(s1.trails.get('铜锁')!.hits.map((h) => h.章号)).toEqual([1, 2]) // 关联词两词各命中
    const s2 = getForeshadowsCached(root)
    expect(__foreshadowScanCountForTest()).toBe(1) // 命中：未重扫
    expect(s2.entries).toEqual(s1.entries)
    expect(s2.trails).toEqual(s1.trails)
  })

  it('目录变化（指纹变）后重算：新增正文章节足迹可见；新增伏笔文件入列', async () => {
    const root = makeTree()
    __setForeshadowCacheTtlForTest(60_000)
    getForeshadowsCached(root)
    expect(__foreshadowScanCountForTest()).toBe(1)
    await sleep(5) // 让目录 mtime 跨过同毫秒档，指纹必然失配
    writeFileSync(join(root, '写作', '正文', '0003-重逢.md'), '---\n章号: 3\n标题: 重逢\n---\n\n重逢时，铜锁再次出现。\n', 'utf-8')
    const s2 = getForeshadowsCached(root)
    expect(__foreshadowScanCountForTest()).toBe(2) // 写作/正文 mtime 变 → 重扫
    expect(s2.trails.get('铜锁')!.hits.map((h) => h.章号)).toEqual([1, 2, 3]) // 新章足迹可见
    await sleep(5)
    writeFileSync(
      join(root, '设定', '伏笔', '旧信.md'),
      '---\n标题: 旧信\n状态: 未回收\n重要性: 中\n关联词: 旧信\n---\n旧信之谜。\n',
      'utf-8',
    )
    const s3 = getForeshadowsCached(root)
    expect(__foreshadowScanCountForTest()).toBe(3) // 设定/伏笔 mtime 变 → 重扫
    expect(s3.entries.map((e) => e.标题)).toContain('旧信')
  })

  it('?q= 过滤走缓存：TTL 内不同检索词均不重扫，结果按过滤维度命中', () => {
    const root = makeTree()
    __setForeshadowCacheTtlForTest(60_000)
    const snapshot = getForeshadowsCached(root)
    expect(__foreshadowScanCountForTest()).toBe(1)
    // 不同 q 各调一次：都在快照上过滤，scan 计数不增长
    const bySnippet = filterForeshadowTrails(snapshot.entries, snapshot.trails, '玉佩')
    const byTitle = filterForeshadowTrails(snapshot.entries, snapshot.trails, '断剑')
    const miss = filterForeshadowTrails(snapshot.entries, snapshot.trails, '不存在的词')
    getForeshadowsCached(root) // 再取一次快照（应命中）
    expect(__foreshadowScanCountForTest()).toBe(1)
    expect(bySnippet.map((h) => h.标题)).toEqual(['铜锁']) // 命中片段含「玉佩」
    expect(byTitle.map((h) => h.标题)).toEqual(['断剑']) // 标题命中（已回收仍可检索）
    expect(miss).toEqual([])
  })

  it('过滤体与直扫口径一致：filterForeshadowTrails(快照) 等于 searchForeshadowTrails(直扫)', () => {
    const root = makeTree()
    const snapshot = getForeshadowsCached(root)
    expect(filterForeshadowTrails(snapshot.entries, snapshot.trails, '玉佩')).toEqual(
      searchForeshadowTrails(root, '玉佩'),
    )
    expect(filterForeshadowTrails(snapshot.entries, snapshot.trails)).toEqual(searchForeshadowTrails(root))
  })

  it('TTL 到期重扫；forget 显式失效同效', () => {
    const root = makeTree()
    __setForeshadowCacheTtlForTest(60_000)
    getForeshadowsCached(root)
    expect(__foreshadowScanCountForTest()).toBe(1)
    forgetForeshadowCache(root) // 删书/改名挂点同款失效
    getForeshadowsCached(root)
    expect(__foreshadowScanCountForTest()).toBe(2)
    __setForeshadowCacheTtlForTest(0) // 即刻过期
    getForeshadowsCached(root)
    expect(__foreshadowScanCountForTest()).toBe(3)
  })
})
