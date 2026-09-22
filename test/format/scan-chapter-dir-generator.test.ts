/**
 * 阶段 52 批 1（P3-12）切片验收：`scanChapterDirCore` 双驱动等价 + 让出计数 + 缓存语义。
 *
 * A1（等价，硬门）：同目录两序双跑——「同步先（冷）→ async 后（热）」与「async 先
 *（冷）→ 同步后（热）」结果 deep equal。首跑者经 readChapter 真解析填 (mtimeNs,size)
 * 缓存（冷径），次跑者走命中克隆支路（热径），两条路径都被两种驱动覆盖（同目录双跑
 * 才能 deep equal：章元数据含绝对路径 _path）。
 * A2（让出计数，硬门）：喂 N 个 .md 目录项 → preludeYieldStats.chapterScan ≥ ⌊N/K⌋；
 *  少于 K 项恒 0（下界锚——只增不减的观察口本身不证明让出真落在本段，防「计数与
 *  让出点脱钩」的假绿）。
 * 缓存语义不变（红线）：同 (mtimeNs,size) 不重读——以 frontmatter.readFile 调用次数
 *  计（冷扫 N → 热扫不增 → 触碰 1 章恰 +1）。切片前该口径由 r52/r70 系测试间接守，
 *  这里直接锁到调用次数。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { appendFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 缓存语义用例要数「真整读了几个文件」——readFile 是 readChapter 的唯一整读入口，
// 只在本模块包一层计数（parseFlat 等其余导出走 importOriginal 原样透出）
vi.mock('../../src/format/frontmatter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/format/frontmatter.js')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

import { readFile } from '../../src/format/frontmatter.js'
import { driveToEnd, yieldToEventLoop } from '../../src/async.js'
import { CHAPTER_SCAN_YIELD_EVERY, readChapterDir, scanChapterDirCore } from '../../src/format/chapters.js'
import { preludeYieldStats, __resetPreludeYieldStatsForTest } from '../../src/shared/yield-stats.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** async 驱动（测试本地复刻生产口径）：每个悬停点 await 让出事件循环。 */
async function driveAsync<T>(it: Generator<unknown, T, unknown>): Promise<T> {
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
    await yieldToEventLoop()
  }
}

/** 造一个扁平章目录（n 章，front matter 齐全——错误数组为空才证明解析真跑通）。 */
function makeChapterDir(n: number): string {
  const dir = mkdtempTracked(join(tmpdir(), 'scan-chapter-gen-'))
  for (let no = 1; no <= n; no++) {
    const pad = String(no).padStart(3, '0')
    writeFileSync(
      join(dir, `${pad}-第${no}章.md`),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的雨夜里，第${no}章的叙述文本。\n`,
      'utf-8',
    )
  }
  return dir
}

/** 显式前移 mtime（同秒写入的指纹保险），并追加内容改变 size。 */
function touchChapter(dir: string, no: number): void {
  const fp = join(dir, `${String(no).padStart(3, '0')}-第${no}章.md`)
  appendFileSync(fp, '又补了一句。\n', 'utf-8')
  const t = new Date(Date.now() + 10_000)
  utimesSync(fp, t, t)
}

beforeEach(() => __resetPreludeYieldStatsForTest())

describe('scanChapterDirCore 双驱动等价与让出计数', () => {
  it('同一目录两序双跑：同步/async 结果 deep equal（同步冷→async 热、async 冷→同步热）', async () => {
    const dirA = makeChapterDir(3)
    const syncCold = driveToEnd(scanChapterDirCore(dirA))
    const asyncHot = await driveAsync(scanChapterDirCore(dirA))
    // 非空断言先行：解析失败时两跑都是「空章 + 同形错误」，等价断言会假绿
    expect(syncCold.errors).toEqual([])
    expect(syncCold.chapters.map((c) => c.章号)).toEqual([1, 2, 3])
    expect(asyncHot).toEqual(syncCold)

    const dirB = makeChapterDir(3)
    const asyncCold = await driveAsync(scanChapterDirCore(dirB))
    const syncHot = driveToEnd(scanChapterDirCore(dirB))
    expect(asyncCold.errors).toEqual([])
    expect(asyncCold.chapters.map((c) => c.章号)).toEqual([1, 2, 3])
    expect(syncHot).toEqual(asyncCold)
  })

  it('同步包装 readChapterDir 走同一核：章数与核结果一致（外部调用方零感知）', () => {
    const dir = makeChapterDir(4)
    const core = driveToEnd(scanChapterDirCore(dir))
    const wrapped = readChapterDir(dir)
    expect(wrapped.errors).toEqual([])
    expect(wrapped.chapters).toEqual(core.chapters)
  })

  it(`A2：喂 ${CHAPTER_SCAN_YIELD_EVERY} 的倍数项 → chapterScan ≥ ⌊N/K⌋`, async () => {
    const n = CHAPTER_SCAN_YIELD_EVERY * 2 + 10 // 60 项 → ⌊60/25⌋ = 2
    const dir = makeChapterDir(n)
    const r = await driveAsync(scanChapterDirCore(dir))
    expect(r.chapters).toHaveLength(n)
    expect(preludeYieldStats.chapterScan).toBeGreaterThanOrEqual(Math.floor(n / CHAPTER_SCAN_YIELD_EVERY))
    expect(preludeYieldStats.dirFp).toBe(0) // 隔离：本段不碰纪元指纹计数器
  })

  it('A2 下界锚：不足 K 项的目录恒 0（计数不得凭空自增）', async () => {
    const dir = makeChapterDir(CHAPTER_SCAN_YIELD_EVERY - 1) // 24 项
    const r = await driveAsync(scanChapterDirCore(dir))
    expect(r.chapters).toHaveLength(CHAPTER_SCAN_YIELD_EVERY - 1)
    expect(preludeYieldStats.chapterScan).toBe(0)
  })

  it('缓存语义不变：同 (mtimeNs,size) 不重读，仅被改的章重读一次', () => {
    const dir = makeChapterDir(6)
    const reader = vi.mocked(readFile)
    reader.mockClear()

    driveToEnd(scanChapterDirCore(dir))
    expect(reader).toHaveBeenCalledTimes(6) // 冷扫：6 章各整读一次

    driveToEnd(scanChapterDirCore(dir))
    expect(reader).toHaveBeenCalledTimes(6) // 热扫：全命中，零整读

    touchChapter(dir, 3)
    const hot = driveToEnd(scanChapterDirCore(dir))
    expect(reader).toHaveBeenCalledTimes(7) // 恰重读被改的 1 章
    expect(hot.chapters).toHaveLength(6) // 其余章照常来自缓存
  })
})
