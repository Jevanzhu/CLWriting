/**
 * R37-16（三十七轮）：rebuild 章读 mtime+size 指纹缓存回归测试。
 *
 * 覆盖：
 * 1. 首次 rebuild 全量 miss 入缓存；
 * 2. 改一章内容再 rebuild → 改章重读（新内容生效入库）、未改章命中缓存（stats 钩子断言）；
 * 3. 容量上限逐出（注入 max=1，两章后 entries ≤ 1）；
 * 4. __testHooks.clearChapterCache 重置（防用例间污染）。
 *
 * 注意：第二次 rebuild 必须绕开 W-P2-4 增量跳过（改章同时改 size/mtime 保证走全量），
 * 否则 readChapterCached 根本不被调用，命中断言无从谈起。
 */

import { test, expect } from 'vitest'
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { rebuild, __testHooks } from '../../src/cache/rebuild.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'

/** 造最小书仓库：book.yaml + 两章正文（无账本/摘要——rebuild 容忍目录缺失） */
function makeTwoChapterBook(): string {
  const root = mkdtempTracked(join(tmpdir(), '指纹缓存-'))
  writeBookConfig(join(root, 'book.yaml'), { ...DEFAULT_CONFIG, book: { title: '测试书', genre: '玄幻' } })
  const dir = join(root, '写作', '正文')
  mkdirSync(dir, { recursive: true })
  writeChapter(dir, 1, '初雪', '北境下雪了。')
  writeChapter(dir, 2, '旧约', '林晚与故人重逢，谈起旧日约定。')
  return root
}

/** 写一章（body 可指定——改章用不同长度正文保证 word_count 可区分） */
function writeChapter(dir: string, no: number, title: string, body: string): void {
  writeFileSync(
    join(dir, `${no}-${title}.md`),
    `---\n章号: ${no}\n标题: ${title}\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 转折\n---\n\n${body}\n`,
    'utf-8',
  )
}

/** 读 db 里两章的 word_count（断言改章新内容生效 / 未改章一致的口径） */
function wordCounts(cachePath: string): Map<number, number> {
  const db = new DatabaseSync(cachePath, { readOnly: true })
  try {
    const rows = db.prepare('SELECT number, word_count FROM chapters').all() as { number: number; word_count: number }[]
    return new Map(rows.map((r) => [r.number, r.word_count]))
  } finally {
    db.close()
  }
}

test('R37-16: 未改章第二次 rebuild 命中指纹缓存，改章新内容生效', () => {
  __testHooks.clearChapterCache()
  const root = makeTwoChapterBook()
  const cachePath = join(root, '.cache', 'index.db')
  const ch1 = join(root, '写作', '正文', '1-初雪.md')

  // 第一次 rebuild：两章全 miss 入缓存
  const first = rebuild(root, cachePath)
  expect(first.chapterCount).toBe(2)
  let stats = __testHooks.chapterCacheStats()
  expect(stats.misses).toBe(2)
  expect(stats.hits).toBe(0)
  expect(stats.entries).toBe(2)
  const firstCounts = wordCounts(cachePath)
  expect(firstCounts.get(1)).toBeGreaterThan(0)
  expect(firstCounts.get(2)).toBeGreaterThan(0)

  // 改第 1 章正文（更长内容 → word_count 必变）；显式推 mtime 防同毫秒指纹碰撞
  writeChapter(join(root, '写作', '正文'), 1, '初雪', '北境下了三天三夜的雪，林晚在城头远眺，想起当年旧事，心中百感交集，久久不能平息。')
  const later = new Date(Date.now() + 60_000)
  utimesSync(ch1, later, later)

  // 第二次 rebuild：走全量（size/mtime 已变）——第 1 章 miss 重读，第 2 章命中缓存
  const second = rebuild(root, cachePath)
  expect(second.chapterCount).toBe(2)
  stats = __testHooks.chapterCacheStats()
  expect(stats.misses).toBe(3) // 本次仅第 1 章 miss
  expect(stats.hits).toBe(1) // 第 2 章命中，未整读

  // 改章新内容生效（word_count 变大），未改章一致
  const secondCounts = wordCounts(cachePath)
  expect(secondCounts.get(1)!).toBeGreaterThan(firstCounts.get(1)!)
  expect(secondCounts.get(2)).toBe(firstCounts.get(2))
})

test('R37-16: 容量上限逐出最旧（注入 max=1，两章后 entries ≤ 1）', () => {
  __testHooks.clearChapterCache()
  __testHooks.setChapterCacheMaxForTest(1)
  try {
    const root = makeTwoChapterBook()
    const cachePath = join(root, '.cache', 'index.db')
    const r = rebuild(root, cachePath)
    expect(r.chapterCount).toBe(2)
    // 两章全量扫描，但容量 1 → 先入的第 1 章被逐出
    expect(__testHooks.chapterCacheStats().entries).toBe(1)
  } finally {
    __testHooks.setChapterCacheMaxForTest(null) // 还原默认，防污染其它用例
  }
})

test('R37-16: clearChapterCache 清空缓存与计数（跨用例隔离口）', () => {
  const root = makeTwoChapterBook()
  const cachePath = join(root, '.cache', 'index.db')
  rebuild(root, cachePath)
  expect(__testHooks.chapterCacheStats().entries).toBeGreaterThan(0)
  __testHooks.clearChapterCache()
  const stats = __testHooks.chapterCacheStats()
  expect(stats.entries).toBe(0)
  expect(stats.hits).toBe(0)
  expect(stats.misses).toBe(0)
})
