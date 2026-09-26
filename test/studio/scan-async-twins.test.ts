/**
 * R37-3（三十七轮批 D）回归：api 层全书扫描 async 孪生（progress.ts）。
 *
 * - computeProgressAsync / computeBookSummaryAsync 与同步版结果等价（同步版保留为
 *   等价性对照基准——生产调用方 overview.ts / books.ts 已切 async 路径）；
 * - 双版本共享同一 summaryCache：TTL 命中与写侧 invalidateBookSummary 失效互通
 *  （books.ts 切 async 后书架卡「保存后即时反映新字数」的 V-P2-27 语义不变）；
 * - computeBookSummaryAsync 的 mtime 扫描循环让出期间事件循环可响应（心跳插队）。
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeProgress,
  computeProgressAsync,
  computeBookSummary,
  computeBookSummaryAsync,
  invalidateBookSummary,
} from '../../src/studio/server/api/progress.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 造一本 N 章正文的书（progress 系函数只扫 写作/正文，无需 manifest/布线）。 */
function makeBook(chapterCount: number): string {
  const root = mkdtempTracked(join(tmpdir(), 'r37-prog-async-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  for (let no = 1; no <= chapterCount; no++) {
    const pad = String(no).padStart(3, '0')
    writeFileSync(
      join(root, '写作', '正文', `${pad}-第${no}章.md`),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第${no}章正文内容，共十个字。\n`,
      'utf-8',
    )
  }
  return root
}

describe('R37-3 progress.ts async 孪生', () => {
  it('computeProgressAsync 与同步版结果等价（60 章）', async () => {
    const root = makeBook(60)
    const sync = computeProgress(root)
    expect(sync.chapters).toBe(60)
    expect(sync.words).toBeGreaterThan(0)
    await expect(computeProgressAsync(root)).resolves.toEqual(sync)
  })

  it('computeBookSummaryAsync 与同步版结果等价（60 章）', async () => {
    const root = makeBook(60)
    const sync = computeBookSummary(root)
    expect(sync.chapters).toBe(60)
    expect(sync.latestChapter).toBe('第60章')
    expect(sync.lastEdited).not.toBeNull()
    await expect(computeBookSummaryAsync(root)).resolves.toEqual(sync)
  })

  it('双版本共享 summaryCache：invalidate 后重算见新章数（V-P2-27 失效语义互通）', async () => {
    const root = makeBook(60)
    await computeBookSummaryAsync(root) // 落缓存（async 侧写入）
    expect(computeBookSummary(root)).toEqual({ chapters: 60, words: expect.any(Number), lastEdited: expect.any(String), latestChapter: '第60章' }) // 同步侧读同一缓存
    invalidateBookSummary(root)
    writeFileSync(
      join(root, '写作', '正文', '061-第61章.md'),
      '---\n章号: 61\n标题: 第61章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n新章。\n',
      'utf-8',
    )
    const fresh = await computeBookSummaryAsync(root)
    expect(fresh.chapters).toBe(61)
    expect(fresh.latestChapter).toBe('第61章')
  })

  it('computeBookSummaryAsync 扫描期间事件循环可响应：setImmediate 心跳至少插队一次', async () => {
    const root = makeBook(60)
    let beats = 0
    const probe = (): void => {
      if (beats < 64) {
        beats++
        setImmediate(probe)
      }
    }
    const p = computeBookSummaryAsync(root)
    setImmediate(probe)
    const r = await p
    expect(r.chapters).toBe(60)
    expect(beats).toBeGreaterThan(0) // 「至少一次」：不脆断言次数
  })
})
