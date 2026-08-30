/**
 * CC-P1-3 回归：collectTreeIssues 预扫提升——readChapterDir 调用次数与章数解耦。
 *
 * 修复前：每章 checkWithDb 内重扫 大纲/章纲 全量（readChapterDir），大书数百章
 * O(N²) 文件读单请求阻塞事件循环秒级；P5-管线（第七轮）双扫合并后全书固定 2 次（正文×1 + 预扫×1）
 * （正文×2：聚合循环 + maxWritten 基准；章纲×1：循环外预扫）。
 * 另验证 batch 上下文传参后 targetWords（章纲 字数目标）接线不回归（W-P2-11 口径）。
 *
 * A1（批 1）增量缓存断言：二次请求正文整读次数（readDraft）= 变更章数——
 * 章级 (mtime,size)+verdict 指纹全中的章直接取缓存聚合，零机检零重读。
 */
import { describe, it, expect, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/format/chapters.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/format/chapters.js')>()
  return { ...actual, readChapterDir: vi.fn(actual.readChapterDir) }
})

vi.mock('../../src/format/draft.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/format/draft.js')>()
  return { ...actual, readDraft: vi.fn(actual.readDraft) }
})

// 二轮复审 #6 回归锚：published 判定不得回到 deriveStatusFull → readPublished 的
// 每章整读路径（成熟书 O(final 章数) 整读/请求）——collectTreeIssues 应走 probeCache
vi.mock('../../src/document/status.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/document/status.js')>()
  return { ...actual, readPublished: vi.fn(actual.readPublished) }
})

import { readChapterDir } from '../../src/format/chapters.js'
import { readDraft } from '../../src/format/draft.js'
import { readPublished } from '../../src/document/status.js'
import { createHash } from 'node:crypto'
import { collectTreeIssues, checkWithDb, type BatchCheckContext } from '../../src/check/run.js'
import { readBookConfig } from '../../src/format/yaml.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { readAnalysis, writeAnalysis } from '../../src/document/analysis.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/** 造一本 N 章正文书；wiring=true 加布线（测 maxWritten/账本路径），每章带禁词「玉佩」制造确定红源 */
function makeBook(chapterCount: number, wiring = true): string {
  const root = mkdtempTracked(join(tmpdir(), 'scan-count-'))
  if (wiring) mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  // 禁词红源：每章正文命中「玉佩」→ issues 必非空（证明逐章 checkWithDb 真的跑了）
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n', 'utf-8')
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  if (wiring) {
    writeFileSync(
      join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
      '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
      'utf-8',
    )
  }
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (let no = 1; no <= chapterCount; no++) {
    const pad = String(no).padStart(3, '0')
    writeFileSync(
      join(root, '写作', '正文', `${pad}-第${no}章.md`),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的雨夜里，玉佩，连响了三下。\n`,
      'utf-8',
    )
    upsertEntry(m, {
      id: generateDocId(),
      nodeType: 'document',
      path: `写作/正文/${pad}-第${no}章.md`,
      parentId: null,
    })
  }
  // 章纲（带 字数目标，供 targetWords 接线断言）
  writeFileSync(
    join(root, '大纲', '章纲', '001-第1章.md'),
    '---\n章号: 1\n标题: 第1章\n字数目标: 50000\n---\n\n## 反转线索表\n- 核心反转：x\n',
    'utf-8',
  )
  writeManifest(manifestPath, m)
  return root
}

const readChapterDirMock = vi.mocked(readChapterDir)

function callCount(): number {
  return readChapterDirMock.mock.calls.length
}

describe('collectTreeIssues 预扫提升（CC-P1-3）', () => {
  it('readChapterDir 调用次数与章数解耦：3 章 → 全书固定 2 次（修复前 2+N 次）', () => {
    const root = makeBook(3)
    try {
      readChapterDirMock.mockClear()
      const { issues } = collectTreeIssues(root, () => undefined)
      expect(Object.keys(issues)).toHaveLength(3) // 全部未定稿 → 逐章受检
      // 正文×1（聚合循环，maxWritten 基准复用同列表——P5-管线第七轮消双扫）+ 章纲×1（循环外预扫）
      expect(callCount()).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('章数翻倍 → 调用次数不变（O(N²) → O(N)）', () => {
    const root = makeBook(6)
    try {
        readChapterDirMock.mockClear()
        const { issues } = collectTreeIssues(root, () => undefined)
        expect(Object.keys(issues)).toHaveLength(6)
        expect(callCount()).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('batch 传参后 targetWords 接线不回归：章纲 字数目标 经预扫列表进入 word-count 检查', () => {
    const root = makeBook(1, false) // 无布线 → db 传 null 合法（对齐 v 轮回归测口径）
    try {
      const { config } = readBookConfig(join(root, 'book.yaml'))
      // 与 collectTreeIssues 同口径构造 batch 上下文
      const batch: BatchCheckContext = {
        outlineChapters: readChapterDir(join(root, '大纲', '章纲')).chapters,
        leadUpdatesForChapter: () => [],
      }
      const outcome = checkWithDb(root, join(root, '写作', '正文', '001-第1章.md'), null, config, batch)
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      const items = outcome.report.sections.flatMap((s) => s.items)
      // 正文 ~15 字 vs 目标 50000 → 大幅偏离，word-count 黄项应出现（targetWords 已接线）
      expect(items.some((i) => i.checkId === 'word-count')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('collectTreeIssues 增量缓存（A1 批 1）', () => {
  const readDraftMock = vi.mocked(readDraft)

  /** 触碰文件 mtime（不改内容也足以破指纹） */
  function touch(p: string): void {
    const t = new Date()
    utimesSync(p, t, t)
  }

  it('二次请求零整读；改 1 章只整读那 1 章（O(全书) → O(变更章)）', () => {
    const root = makeBook(5)
    try {
      // 首次：全量（5 章各一次 readDraft）+ 建缓存
      readDraftMock.mockClear()
      const first = collectTreeIssues(root, () => undefined)
      expect(Object.keys(first.issues)).toHaveLength(5)
      expect(readDraftMock.mock.calls.length).toBe(5)
      // 二次：指纹全中 → 0 次正文整读
      readDraftMock.mockClear()
      const second = collectTreeIssues(root, () => undefined)
      expect(second.issues).toEqual(first.issues) // 缓存与全量重算同构
      expect(readDraftMock.mock.calls.length).toBe(0)
      // 改 1 章（触碰 mtime）→ 只重查那章
      touch(join(root, '写作', '正文', '003-第3章.md'))
      readDraftMock.mockClear()
      const third = collectTreeIssues(root, () => undefined)
      expect(readDraftMock.mock.calls.length).toBe(1)
      expect(readDraftMock.mock.calls[0]![0]).toContain('003-第3章.md')
      expect(third.issues).toEqual(first.issues) // 内容没变 → 结果不变
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('verdict 信封变化 → 该章指纹失效重查（驳回升红点，零正文整读以外的开销）', () => {
    const root = makeBook(3)
    try {
      const m = readManifest(join(root, '项目', '文档清单.jsonl'))
      const docIds = [...m.entries.entries()]
        .filter(([, e]) => e.nodeType === 'document')
        .map(([id]) => id)
      // 与 api/check.ts tree-issues 端点同款回线：verdict 来自 review 信封
      const verdictOf = (docId: string): { approved: boolean } | undefined => {
        const env = readAnalysis(root, docId, 'review')
        const v = (env?.payload as { verdict?: { approved: boolean } } | undefined)?.verdict
        return v ?? undefined
      }
      collectTreeIssues(root, verdictOf) // 建缓存（无信封 → verdict_fp NULL）
      // 驳回第 2 章：写信封（生产链路 = review-verdict 端点），信封 stat 变 → 指纹破
      writeAnalysis(root, docIds[1]!, 'review', {
        generatedAt: new Date().toISOString(),
        model: 'author',
        sourceHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        payload: { verdict: { approved: false, at: new Date().toISOString() } },
      })
      readDraftMock.mockClear()
      const r = collectTreeIssues(root, verdictOf)
      expect(r.issues[docIds[1]!]).toEqual({ hasRed: true, verdictRejected: true })
      // 信封变化只破一章：其余两章命中缓存零整读，被驳章重查 1 次
      expect(readDraftMock.mock.calls.length).toBe(1)
      expect(readDraftMock.mock.calls[0]![0]).toContain('002-第2章.md')
      // 再跑一次：新指纹（含信封）全中 → 驳回红点来自缓存
      readDraftMock.mockClear()
      const again = collectTreeIssues(root, verdictOf)
      expect(readDraftMock.mock.calls.length).toBe(0)
      expect(again.issues[docIds[1]!]).toEqual({ hasRed: true, verdictRejected: true })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('章外全局输入变化 → 纪元失效整表重查（book.yaml 触碰）', () => {
    const root = makeBook(4)
    try {
      collectTreeIssues(root, () => undefined)
      touch(join(root, 'book.yaml'))
      readDraftMock.mockClear()
      collectTreeIssues(root, () => undefined)
      expect(readDraftMock.mock.calls.length).toBe(4) // 纪元变化 → 全书重查
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('collectTreeIssues 缺陷修复回归（二轮复审）', () => {
  const readDraftMock = vi.mocked(readDraft)
  const readPublishedMock = vi.mocked(readPublished)

  /** manifest 里 path → docId 的查表（issues 以 docId 为键） */
  function docIdOf(root: string, path: string): string {
    const m = readManifest(join(root, '项目', '文档清单.jsonl'))
    const hit = [...m.entries.entries()].find(([, e]) => e.nodeType === 'document' && e.path === path)
    if (!hit) throw new Error(`manifest 无 ${path}`)
    return hit[0]
  }

  it('检查瞬态失败不落缓存：失败章下轮重查红点恢复（此前固化为 hasRed=false 假阴性）', () => {
    const root = makeBook(5)
    try {
      const orig = readDraftMock.getMockImplementation()!
      // 第一轮：003 章读稿瞬态失败（模拟 SQLITE_BUSY/ENOENT 竞态类异常出口）——
      // issues 不含 003（可见的临时缺失），且关键是不写它的缓存
      readDraftMock.mockImplementation((p: string) =>
        p.includes('003')
          ? ({ ok: false, reason: '瞬态读稿失败' } as ReturnType<typeof readDraft>)
          : orig(p),
      )
      const first = collectTreeIssues(root, () => undefined)
      expect(Object.keys(first.issues)).toHaveLength(4)
      expect(first.issues[docIdOf(root, '写作/正文/003-第3章.md')]).toBeUndefined()
      // 第二轮：读稿恢复 → 003 未入缓存 → 恰重查它 1 次（其余 4 章命中缓存零整读）
      readDraftMock.mockImplementation(orig)
      readDraftMock.mockClear()
      const second = collectTreeIssues(root, () => undefined)
      expect(readDraftMock.mock.calls.length).toBe(1)
      expect(readDraftMock.mock.calls[0]![0]).toContain('003-第3章.md')
      // 修复前：003 命中投毒缓存（hasRed=false 固化）→ 红点永久消失；修复后恢复
      expect(second.issues[docIdOf(root, '写作/正文/003-第3章.md')]).toEqual({ hasRed: true, verdictRejected: false })
    } finally {
      readDraftMock.mockImplementation(readDraftMock.getMockImplementation()!) // 还原兜底
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('#6：published 章跳过且零 readPublished 整读（走 probeCache，不再 deriveStatusFull）', () => {
    const root = makeBook(2)
    try {
      // 第 1 章定稿 + 已发布：fm 加 已发布: true 后按最终字节算指纹，写入 manifest 基线
      const chPath = join(root, '写作', '正文', '001-第1章.md')
      const raw = readFileSync(chPath, 'utf8').replace('---\n', '---\n已发布: true\n')
      writeFileSync(chPath, raw, 'utf8')
      const rev = 'sha256:' + createHash('sha256').update(readFileSync(chPath)).digest('hex')
      const m = readManifest(join(root, '项目', '文档清单.jsonl'))
      const id = docIdOf(root, '写作/正文/001-第1章.md')
      upsertEntry(m, { ...m.entries.get(id)!, finalizedRevision: rev })
      writeManifest(join(root, '项目', '文档清单.jsonl'), m)

      readPublishedMock.mockClear()
      const r = collectTreeIssues(root, () => undefined)
      // published 章（= 作者已确认）不进聚合；第 2 章照常受检（禁词红源）
      expect(Object.keys(r.issues)).toHaveLength(1)
      expect(r.issues[docIdOf(root, '写作/正文/002-第2章.md')]).toEqual({ hasRed: true, verdictRejected: false })
      // 回归锚：published 判定未走 readPublished 整读路径（修复前每 final 章一整读）
      expect(readPublishedMock.mock.calls.length).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
