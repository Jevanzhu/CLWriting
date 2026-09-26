/**
 * 阶段 52 批 2（P3-13）单章链验收：`runCheckForDocumentAsync` 与同步版等价（A1）、
 * 切片让出计数落在目标段（A2）、async 驱动期间事件循环存活（A3）。
 *
 * 链（自顶向下）：runCheckForDocumentAsync → await openCheckDbAsync（rebuild 走 worker）
 * → await driveToEndAsync(checkWithDbCore) —— 核内两处悬停：账本全书性条目
 * （yield* checkLeadsFormCore → checkLeadsBookItemsCore，冷读建章号表/逐条引文核验）与
 * 章纲目录整扫（yield* scanChapterDirCore）。本套锁的正是「切片只改悬停点」：
 * 结果逐位不变（A1），让出确实发生在目标段（A2，段计数隔离），驱动期间心跳照跳（A3）。
 *
 * A1 口径：TTL 窗在等价用例里关掉（`__setOpenCheckDbTtlForTest(0)`）——两驱动都走真
 * rebuild（async 档经 worker），比的是同一条链；窗内跳重建的语义单列
 * check-chain-source-probe-ttl.test.ts（那里才断言窗）。
 * A2 口径与批 1 同：把目标段喂大、其余段喂小，段计数归属可判（其余计数器恒 0）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  runCheckForDocument,
  runCheckForDocumentAsync,
  __setOpenCheckDbTtlForTest,
  __resetRebuildDoneAtForTest,
} from '../../src/check/run.js'
import { preludeYieldStats, __resetPreludeYieldStatsForTest } from '../../src/shared/yield-stats.js'
import { CHAPTER_SCAN_YIELD_EVERY } from '../../src/format/chapters.js'
import { LEADS_BOOK_YIELD_EVERY } from '../../src/check/leads.js'
import { readManifest, writeManifest, upsertEntry, type ManifestEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const EVIDENCE = '密室尽头的青铜灯' // 履历引文：故意不写进任何正文 → 全书性红项非空

/** 自续期 setImmediate 探针：驱动期间心跳次数（A3 存活锚；数值不做断言）。 */
function startHeartbeat(): { stop: () => number } {
  const state = { beats: 0, stopped: false }
  const tick = (): void => {
    if (state.stopped) return
    state.beats++
    setImmediate(tick)
  }
  setImmediate(tick)
  return {
    stop: (): number => {
      state.stopped = true
      return state.beats
    },
  }
}

interface FixtureOpts {
  chapters?: number
  /** 悬念履历条数（全指第 1 章） */
  historyEntries?: number
  /** 大纲/章纲 章纲文件数（喂大整扫段） */
  outlineCount?: number
  /** 短篇无布线（独立短篇路径：db 恒 null） */
  short?: boolean
}

/**
 * 造书：正文 chapters 章（含文风铁律硬禁词「玉佩」→ 被检章 banned-words 红）+
 * 悬念账本 1 条（historyEntries 行引文，正文不命中 → 每条一 lead-evidence-miss 红）+
 * 章纲 outlineCount 份（正文目录整扫之外的第二个整扫面）。末章定稿撑 maxWritten 基准。
 */
function makeBook(opts: FixtureOpts = {}): string {
  const { chapters = 3, historyEntries = 1, outlineCount = 1, short = false } = opts
  const root = mkdtempTracked(join(tmpdir(), 'chain-parity-'))
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n', 'utf-8')
  if (!short) mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  if (outlineCount > 0) mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    `spec_version: 1\nkind: ${short ? 'short' : 'long'}\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n`,
    'utf-8',
  )
  if (!short) {
    const history = Array.from({ length: historyEntries }, () => `- 第1章 埋下：「${EVIDENCE}」`).join('\n')
    writeFileSync(
      join(root, '布线', '悬念', '悬念-001-密室之主.md'),
      `---\n编号: 悬念-001\n标题: 密室之主\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n${history}\n`,
      'utf-8',
    )
  }
  for (let no = 1; no <= outlineCount; no++) {
    const pad = String(no).padStart(3, '0')
    writeFileSync(
      join(root, '大纲', '章纲', `${pad}-第${no}章.md`),
      `---\n章号: ${no}\n标题: 第${no}章\n字数目标: 3000\n---\n\n章纲 ${no}。\n`,
      'utf-8',
    )
  }
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (let no = 1; no <= chapters; no++) {
    const pad = String(no).padStart(3, '0')
    const rel = `写作/正文/${pad}-第${no}章.md`
    writeFileSync(
      join(root, rel),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的雨夜里，玉佩，连响了三下。\n`,
      'utf-8',
    )
    const entry: ManifestEntry = { id: generateDocId(), nodeType: 'document', path: rel, parentId: null }
    // 末章定稿：maxWrittenChapterOf 取末章（否则履历第 1 章在 3 章书上不成未来章，语义无差）
    if (no === chapters) {
      entry.finalizedRevision =
        'sha256:' +
        createHash('sha256')
          .update(readFileSync(join(root, rel)))
          .digest('hex')
    }
    upsertEntry(m, entry)
  }
  writeManifest(manifestPath, m)
  return root
}

const draftOf = (root: string, no = 1): string =>
  join(root, '写作', '正文', `${String(no).padStart(3, '0')}-第${no}章.md`)

beforeEach(() => {
  __resetPreludeYieldStatsForTest()
  __resetRebuildDoneAtForTest()
  __setOpenCheckDbTtlForTest(0) // 等价用例关窗：两驱动都走真 rebuild
})

afterEach(() => __setOpenCheckDbTtlForTest(null))

describe('单章链双驱动等价（A1）', () => {
  it('有布线长篇：async 先（冷）→ 同步后（热）deep equal，且红项非空', async () => {
    const root = makeBook({ chapters: 3 })
    const asyncOutcome = await runCheckForDocumentAsync(root, draftOf(root), null)
    const syncOutcome = runCheckForDocument(root, draftOf(root), null)
    expect(asyncOutcome.ok).toBe(true)
    if (!asyncOutcome.ok || !syncOutcome.ok) throw new Error('机检未成功，等价断言无从比')
    // 非空基：禁词红 + 全书性引文 miss 红各自都在（等价断言不得假绿）
    const ids = asyncOutcome.report.sections.flatMap((s) => s.items).map((i) => i.checkId)
    expect(ids).toContain('banned-word')
    expect(ids).toContain('lead-evidence-miss')
    expect(syncOutcome).toEqual(asyncOutcome)
  })

  it('有布线长篇：同步先（冷）→ async 后（热）deep equal（缓存热径同源）', async () => {
    const root = makeBook({ chapters: 5, historyEntries: 6 })
    const syncOutcome = runCheckForDocument(root, draftOf(root, 5), null)
    const asyncOutcome = await runCheckForDocumentAsync(root, draftOf(root, 5), null)
    expect(asyncOutcome).toEqual(syncOutcome)
    expect(asyncOutcome.ok).toBe(true)
  })

  it('无布线短篇：db 恒 null 路径两驱动等价', async () => {
    const root = makeBook({ short: true, outlineCount: 0 })
    const asyncOutcome = await runCheckForDocumentAsync(root, draftOf(root), null)
    const syncOutcome = runCheckForDocument(root, draftOf(root), null)
    expect(asyncOutcome.ok).toBe(true)
    if (!asyncOutcome.ok) return
    expect(asyncOutcome.report.sections.flatMap((s) => s.items).map((i) => i.checkId)).toContain('banned-word')
    expect(syncOutcome).toEqual(asyncOutcome)
  })

  it('缺章号草稿：NOT_CHAPTER 信封两驱动同形（错路等价）', async () => {
    const root = makeBook({ chapters: 2, outlineCount: 0 })
    // 有意落在正文目录之外：正文里的坏文件会先撞 rebuild 解析错误（REBUILD_FAIL），
    // 本用例要的是 readDraft 的 NOT_CHAPTER 面
    const bad = join(root, '999-无章号.md')
    writeFileSync(bad, '既无 front matter 也无章号。\n', 'utf-8')
    const asyncOutcome = await runCheckForDocumentAsync(root, bad, null)
    const syncOutcome = runCheckForDocument(root, bad, null)
    expect(asyncOutcome).toEqual(syncOutcome)
    expect(asyncOutcome.ok).toBe(false)
    if (!asyncOutcome.ok) expect(asyncOutcome.code).toBe('NOT_CHAPTER')
  })
})

describe('单章链让出计数（A2）', () => {
  it('章纲整扫段：60 份章纲 → chapterScan ≥ ⌊N/K⌋，其余计数器恒 0', async () => {
    const root = makeBook({ chapters: 3, outlineCount: 60 })
    __resetPreludeYieldStatsForTest()
    const outcome = await runCheckForDocumentAsync(root, draftOf(root), null)
    expect(outcome.ok).toBe(true)
    expect(preludeYieldStats.chapterScan).toBeGreaterThanOrEqual(Math.floor(60 / CHAPTER_SCAN_YIELD_EVERY))
    // 隔离：本链不入树聚合面（纪元指纹/账本预扫/效应让出档都不在链上）
    expect(preludeYieldStats.dirFp).toBe(0)
    expect(preludeYieldStats.leadUpdatesScan).toBe(0)
    expect(preludeYieldStats.rebuild).toBe(0)
  })

  it('履历段：30 条履历 → leadsBook ≥ ⌊N/K⌋ 且 30 条红项真的逐条过核', async () => {
    const root = makeBook({ chapters: 3, historyEntries: 30, outlineCount: 0 })
    __resetPreludeYieldStatsForTest()
    const outcome = await runCheckForDocumentAsync(root, draftOf(root), null)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const misses = outcome.report.sections.flatMap((s) => s.items).filter((i) => i.checkId === 'lead-evidence-miss')
    expect(misses).toHaveLength(30)
    expect(preludeYieldStats.leadsBook).toBeGreaterThanOrEqual(Math.floor(30 / LEADS_BOOK_YIELD_EVERY))
    expect(preludeYieldStats.dirFp).toBe(0)
    expect(preludeYieldStats.leadUpdatesScan).toBe(0)
    expect(preludeYieldStats.rebuild).toBe(0)
  })
})

describe('async 驱动存活（A3）', () => {
  it('重前奏书上 async 链期间事件循环照跳（心跳 > 0）', async () => {
    const root = makeBook({ chapters: 5, historyEntries: 30, outlineCount: 60 })
    const hb = startHeartbeat()
    const outcome = await runCheckForDocumentAsync(root, draftOf(root, 5), null)
    const beats = hb.stop()
    expect(outcome.ok).toBe(true)
    expect(beats).toBeGreaterThan(0)
  })
})
