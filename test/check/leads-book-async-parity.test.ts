/**
 * 阶段 52 批 1（P3-12）切片验收：`checkLeadsBookItemsCore` 双驱动等价（A1）+ 让出计数（A2）。
 *
 * 账本全书性红项是树聚合里唯一「跨章输入」的检查（引文 grep 按履历章号直读任意章正文），
 * 履历深/章多的大书上它独占一段同步长跑：取线索 → 惰性建「章号→路径」表（walk 全正文
 * 目录）→ 逐条履历核验（含逐章正文整读 + 引文 grep）。切片后两个循环各有每 25 项的
 * 让出点（preludeYieldStats.leadsBook）。
 *
 * A1：同一 db 双跑（同步先=冷 / async 后=热）与另一本书反序（async 先=冷 / 同步后=热）
 *     结果 deep equal——冷径经 readMdText 真读，热径走 fs/md-text-cache 指纹命中，
 *     两条路径都被两种驱动覆盖。
 * A2：分别把「建表段」（60 章）与「履历段」（30 条）喂大 → leadsBook ≥ ⌊N/K⌋；两例
 *     互喂小对方段，故计数归属可判（其余计数器恒 0：本核不碰纪元指纹/目录整扫）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { yieldToEventLoop } from '../../src/async.js'
import { openCheckDb } from '../../src/check/run.js'
import { checkLeadsBookItems, checkLeadsBookItemsCore, LEADS_BOOK_YIELD_EVERY } from '../../src/check/leads.js'
import { preludeYieldStats, __resetPreludeYieldStatsForTest } from '../../src/shared/yield-stats.js'
import { readManifest, writeManifest, upsertEntry, type ManifestEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const EVIDENCE = '密室尽头的青铜灯'

/** async 驱动（测试本地复刻生产口径）：每个悬停点 await 让出事件循环。 */
async function driveAsync<T>(it: Generator<unknown, T, unknown>): Promise<T> {
  for (;;) {
    const r = it.next()
    if (r.done) return r.value
    await yieldToEventLoop()
  }
}

/**
 * 造书：chapters 章正文（第 2 章按 evidenceInCh2 决定是否含引文）+ 悬念-001 履历
 * historyEntries 行（全为「第2章 埋下」）+ 末章定稿（撑起 maxWritten 基准，
 * currentChapter 取 chapters，履历第 2 章不成未来章）。
 */
function makeBook(chapters: number, historyEntries: number, evidenceInCh2: boolean): string {
  const root = mkdtempTracked(join(tmpdir(), 'leads-book-parity-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  const history = Array.from({ length: historyEntries }, () => `- 第2章 埋下：「${EVIDENCE}」`).join('\n')
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-密室之主.md'),
    `---\n编号: 悬念-001\n标题: 密室之主\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n${history}\n`,
    'utf-8',
  )
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (let no = 1; no <= chapters; no++) {
    const pad = String(no).padStart(3, '0')
    const rel = `写作/正文/${pad}-第${no}章.md`
    const body =
      no === 2 && evidenceInCh2
        ? `夜色里，${EVIDENCE}忽然亮了一下。\n`
        : `第${no}章的叙述文本，山门外落了整夜的雨。\n`
    writeFileSync(
      join(root, rel),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n${body}`,
      'utf-8',
    )
    const entry: ManifestEntry = { id: generateDocId(), nodeType: 'document', path: rel, parentId: null }
    // 末章定稿：manifest 基线 = 当前内容指纹 → deriveStatus 判 final，maxWrittenChapterOf 取末章
    if (no === chapters) {
      entry.finalizedRevision =
        'sha256:' + createHash('sha256').update(readFileSync(join(root, rel))).digest('hex')
    }
    upsertEntry(m, entry)
  }
  writeManifest(manifestPath, m)
  return root
}

/** 建库（rebuild 前奏口径同树聚合：不节流 + fail-open）并返回句柄。 */
function openDb(root: string): DatabaseSync {
  const opened = openCheckDb(root, true, { throttleSourceProbe: false, failMode: 'fail-open' })
  expect(opened.rebuildFailed).toBe(false)
  expect(opened.db).not.toBeNull()
  return opened.db!
}

beforeEach(() => __resetPreludeYieldStatsForTest())

describe('checkLeadsBookItemsCore 双驱动等价（A1）', () => {
  it('同步先（冷）→ async 后（热）：结果 deep equal 且红项非空', async () => {
    const root = makeBook(3, 30, false) // 证据不在正文 → 每条履历一条 lead-evidence-miss 红
    const db = openDb(root)
    try {
      const sync = checkLeadsBookItems(db, root, 3, ['悬念'])
      const asyncResult = await driveAsync(checkLeadsBookItemsCore(db, root, 3, ['悬念']))
      expect(sync.some((i) => i.checkId === 'lead-evidence-miss')).toBe(true) // 非空基：等价断言不得假绿
      expect(asyncResult).toEqual(sync)
    } finally {
      db.close()
    }
  })

  it('async 先（冷）→ 同步后（热）：结果 deep equal 且引文命中后无红项', async () => {
    const root = makeBook(3, 4, true) // 证据在正文 → 引文核验全命中，红项清零
    const db = openDb(root)
    try {
      const asyncResult = await driveAsync(checkLeadsBookItemsCore(db, root, 3, ['悬念']))
      const sync = checkLeadsBookItems(db, root, 3, ['悬念'])
      expect(asyncResult.some((i) => i.checkId === 'lead-evidence-miss')).toBe(false)
      expect(sync).toEqual(asyncResult)
    } finally {
      db.close()
    }
  })
})

describe('checkLeadsBookItemsCore 让出计数（A2）', () => {
  it('建表段：60 章 × 1 条履历 → 章号表 walk 让出达标（履历段只 1 条不产让出）', async () => {
    const root = makeBook(60, 1, false)
    const db = openDb(root)
    try {
      const items = await driveAsync(checkLeadsBookItemsCore(db, root, 60, ['悬念']))
      expect(items.length).toBeGreaterThan(0)
      expect(preludeYieldStats.leadsBook).toBeGreaterThanOrEqual(Math.floor(60 / LEADS_BOOK_YIELD_EVERY))
      expect(preludeYieldStats.dirFp).toBe(0) // 隔离：本核不碰纪元指纹计数器
      expect(preludeYieldStats.chapterScan).toBe(0) // 隔离：正文读取走 md-text-cache 直读，非目录整扫
    } finally {
      db.close()
    }
  })

  it('履历段：30 条履历 × 3 章 → 逐条核验让出达标（章号表只 3 项不产让出）', async () => {
    const root = makeBook(3, 30, false)
    const db = openDb(root)
    try {
      const items = await driveAsync(checkLeadsBookItemsCore(db, root, 3, ['悬念']))
      expect(items.filter((i) => i.checkId === 'lead-evidence-miss')).toHaveLength(30) // 30 条履历真的逐条过核
      expect(preludeYieldStats.leadsBook).toBeGreaterThanOrEqual(Math.floor(30 / LEADS_BOOK_YIELD_EVERY))
      expect(preludeYieldStats.dirFp).toBe(0)
      expect(preludeYieldStats.chapterScan).toBe(0)
    } finally {
      db.close()
    }
  })
})
