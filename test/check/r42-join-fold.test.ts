/**
 * R42（四十二轮）回归：join 键折叠族收口残余点。
 *
 * R41-2 已收编 tree / state(findUnfinishedChapter) / export / overview / service；
 * 本轮补残余 join（win case-only 改名 / mac NFD 文件名后精确串失配）：
 * - R42-5 check：maxWrittenChapterOf 定稿集 + 树聚合 pathToDocId/entryByPath 双侧折叠
 *   ——定稿章失配 → 账本「未来章」基准低估 → 树红点假红；
 * - R42-6 learn / metrics / book-search：finalizedPathSet 消费侧建折叠键集
 *   （overview.ts R41-2 同款范式）——定稿章被误跳「草稿」/文风样本缺章/定稿 scope 漏章；
 * - R42-8 state.unfinishedPieceNames：同文件 findUnfinishedChapter R41-2 先例对齐。
 * posix 保大小写（口径维持，R41-13）——各模块带反向腿断言不折叠。
 * 钉平台手法沿用 r41-join-keys.test.ts（Object.defineProperty(process,'platform')）。
 */
import { test, expect, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectTreeIssues } from '../../src/check/run.js'
import { learnFromBook } from '../../src/learn/index.js'
import { scanChapters, scanChaptersAsync } from '../../src/metrics/style.js'
import { searchBook, searchBookAsync } from '../../src/process/book-search.js'
import { detectState, buildRecap, type DetectedState } from '../../src/state/state.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { computeRevision } from '../../src/document/revision.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const ORIG_PLATFORM = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
})
function pinPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

const SHORT_CONFIG: BookConfig = { ...DEFAULT_CONFIG, kind: 'short', book: { title: '夜语集', genre: '悬疑' } }

/** 登记文档（finalizedRevision 传入则定稿——值由调用方从**盘上拼写**的文件算出，
 *  不经登记拼写读盘：case-variant 登记路径在大小写敏感宿主上不可读） */
function registerDoc(root: string, rel: string, finalizedRevision?: string): string {
  const mp = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(mp)
  const id = generateDocId()
  upsertEntry(m, {
    id, nodeType: 'document', path: rel, parentId: null,
    ...(finalizedRevision ? { finalizedRevision, finalizedAt: new Date().toISOString() } : {}),
  })
  writeManifest(mp, m)
  return id
}

// ── R42-5：check（maxWrittenChapterOf / pathToDocId / entryByPath 公共面 = collectTreeIssues）──

const EVIDENCE = '密室尽头的青铜灯'

/**
 * 造书：ch1 定稿（登记拼写=盘上拼写）+ ch2 定稿但登记拼写大小写异于盘上
 * （`002-Finale.md` 登记 / `002-finale.md` 在盘——外部 case-only 改名后的经典形态）
 * + ch3 在写草稿（树红点聚合的机检对象，假红观测面）+ 悬念-001 履历一行（第 2 章埋下，
 * 证据在 ch2 正文）。修复后（win32 折叠）maxWritten 基准 = 2，履历第 2 章不算未来章；
 * 修复前精确串失配 → 基准 1 → lead-chapter-future 假红挂上 ch3。
 */
function makeCheckBook(): { root: string; docIds: Record<number, string> } {
  const root = mkdtempTracked(join(tmpdir(), 'r42-check-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n', 'utf-8')
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-密室之主.md'),
    '---\n编号: 悬念-001\n标题: 密室之主\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第2章 埋下：「' + EVIDENCE + '」\n',
    'utf-8',
  )
  const chapterBody = (no: number): string => {
    if (no === 2) return `夜色里，${EVIDENCE}忽然亮了一下。\n`
    return `第${no}章的叙述文本，山门外落了整夜的雨。\n`
  }
  const docIds: Record<number, string> = {}
  for (const no of [1, 2, 3]) {
    const pad = String(no).padStart(3, '0')
    // ch2 盘上小写拼写（case-only 改名后），清单登记大写（见下方 registerDoc）
    const stem = no === 2 ? `${pad}-finale.md` : `${pad}-第${no}章.md`
    const rel = `写作/正文/${stem}`
    writeFileSync(
      join(root, rel),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n${chapterBody(no)}`,
      'utf-8',
    )
    // ch1/ch2 定稿（revision 从盘上拼写算出）；ch2 登记拼写与盘上仅大小写异
    if (no === 2) docIds[no] = registerDoc(root, `写作/正文/${pad}-Finale.md`, computeRevision(join(root, rel)))
    else docIds[no] = registerDoc(root, rel, no === 1 ? computeRevision(join(root, rel)) : undefined)
  }
  return { root, docIds }
}

test('R42-5: win32 钉平台——case-only 改名定稿章后 maxWritten 基准不低估，树红点无「未来章」假红', () => {
  pinPlatform('win32')
  const { root, docIds } = makeCheckBook()
  try {
    // 修复前：ch2 精确串失配 → 基准=1 → 履历声称第 2 章 > 1 → lead-chapter-future
    // 假红挂上在写草稿 ch3；修复后基准=2，全书无红
    const r = collectTreeIssues(root, () => undefined)
    expect(r.issues[docIds[3]!]).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R42-5: posix 钉平台——不折叠（口径维持）：失配仍在，基准低估形态可观测', () => {
  pinPlatform('linux')
  const { root, docIds } = makeCheckBook()
  try {
    const r = collectTreeIssues(root, () => undefined)
    expect(r.issues[docIds[3]!]?.hasRed).toBe(true) // 基准=1 → lead-chapter-future 假红（posix 保大小写）
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── R42-6：learn（learnFromBook 公共入口）──

const QUALIFYING_BODY =
  '林远踏出山门，暮色四合，青石阶尽头的灯火次第亮起。玉佩在胸前微微发烫，像一颗不肯安分的心。他抬手覆上，那温度便缓缓沉下去。\n\n他忽然感到一阵锥心之痛，仿佛有旧事在血里翻身。'

function makeLearnBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'r42-learn-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 测试书\n', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '001-finale.md'), `---\n章号: 1\n标题: 定稿章\n---\n${QUALIFYING_BODY}`, 'utf-8')
  registerDoc(root, '写作/正文/001-Finale.md', 'sha256:x') // 登记拼写与盘上仅大小写异；finalizedPathSet 只看有无基线
  return root
}

test('R42-6: learn win32 钉平台——case-variant 定稿章仍认定稿进候选池（H-1 红线不破）', async () => {
  pinPlatform('win32')
  const root = makeLearnBook()
  try {
    const r = await learnFromBook(root)
    expect(r.ok).toBe(true) // 修复前：唯一定稿章被误跳 → 「没有定稿正文可收割」
    if (r.ok) {
      expect(r.skippedDrafts).toBe(0)
      expect(r.sampleCount).toBeGreaterThan(0)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R42-6: learn posix 钉平台——不折叠：case-variant 章被误跳「草稿」（口径维持）', async () => {
  pinPlatform('linux')
  const root = makeLearnBook()
  try {
    const r = await learnFromBook(root)
    expect(r.ok).toBe(false)
    expect(r.skippedDrafts).toBe(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── R42-6：metrics（scanChapters / scanChaptersAsync 公共入口）──

function makeMetricsBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'r42-metrics-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '001-finale.md'), '---\n章号: 1\n标题: 定稿章\n---\n山门外落了整夜的雨，灯火次第亮起。', 'utf-8')
  registerDoc(root, '写作/正文/001-Finale.md', 'sha256:x')
  return root
}

test('R42-6: metrics win32 钉平台——case-variant 定稿章仍进文风样本（同步/异步两孪生）', async () => {
  pinPlatform('win32')
  const root = makeMetricsBook()
  try {
    const sync = scanChapters(root)
    const async = await scanChaptersAsync(root)
    expect(sync).toHaveLength(1) // 修复前：精确串失配 → 定稿章被误跳 → 样本缺章（草稿污染反向：样本偏少）
    expect(sync[0]?.num).toBe(1)
    expect(async).toHaveLength(1)
    expect(async[0]?.num).toBe(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R42-6: metrics posix 钉平台——不折叠：case-variant 章不进样本（口径维持，同步/异步一致）', async () => {
  pinPlatform('linux')
  const root = makeMetricsBook()
  try {
    expect(scanChapters(root)).toHaveLength(0)
    expect(await scanChaptersAsync(root)).toHaveLength(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── R42-6/R42-33：book-search（searchBook / searchBookAsync 定稿 scope）──

function makeSearchBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'r42-search-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '001-finale.md'), `---\n章号: 1\n标题: 定稿章\n---\n${EVIDENCE}忽然亮了一下。`, 'utf-8')
  writeFileSync(join(root, '写作', '正文', '002-draft.md'), `---\n章号: 2\n标题: 草稿章\n---\n草稿也提到${EVIDENCE}。`, 'utf-8')
  registerDoc(root, '写作/正文/001-Finale.md', 'sha256:x') // 定稿（登记拼写大小写异于盘上）
  registerDoc(root, '写作/正文/002-draft.md') // 草稿：定稿 scope 下必被滤（对照项）
  return root
}

test('R42-6/R42-33: book-search win32 钉平台——定稿 scope 下 case-variant 定稿章照常命中，草稿仍被滤', async () => {
  pinPlatform('win32')
  const root = makeSearchBook()
  try {
    const sync = searchBook(root, EVIDENCE, '定稿')
    expect(sync.results.map((h) => h.path)).toEqual(['写作/正文/001-finale.md']) // 修复前：定稿章漏出结果（只剩草稿被滤后的空集）
    const async = await searchBookAsync(root, EVIDENCE, '定稿')
    expect(async.results.map((h) => h.path)).toEqual(['写作/正文/001-finale.md'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R42-6/R42-33: book-search posix 钉平台——不折叠：case-variant 章按未认定稿滤除（口径维持）', async () => {
  pinPlatform('linux')
  const root = makeSearchBook()
  try {
    expect(searchBook(root, EVIDENCE, '定稿').results).toEqual([])
    expect((await searchBookAsync(root, EVIDENCE, '定稿')).results).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── R42-8：state.unfinishedPieceNames（公共面 = detectState + buildRecap 短篇分支）──
// 与 r41 同约定：状态机腿需宿主 FS 对 case-variant 路径查找宽容（mac/win 大小写不敏感），
// linux 宿主跳过（与本缺陷正交）。
function makeShortBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'r42-state-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  writeBookConfig(join(root, 'book.yaml'), SHORT_CONFIG)
  // 两篇均定稿：001 登记=盘上；002 登记拼写大小写异于盘上（case-only 改名后）
  writeFileSync(join(root, '写作', '正文', '001-第一篇.md'), '---\n章号: 1\n标题: 第一篇\n---\n第一篇正文。', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '002-finale.md'), '---\n章号: 2\n标题: 第二篇\n---\n第二篇正文。', 'utf-8')
  registerDoc(root, '写作/正文/001-第一篇.md', computeRevision(join(root, '写作', '正文', '001-第一篇.md')))
  registerDoc(root, '写作/正文/002-Finale.md', computeRevision(join(root, '写作', '正文', '002-finale.md')))
  return root
}

async function recapOf(root: string): Promise<{ currentChapter: number; state: number }> {
  const detected: DetectedState = await detectState(root, SHORT_CONFIG)
  const recap = buildRecap(root, SHORT_CONFIG, detected)
  return { currentChapter: recap.currentChapter, state: detected.state }
}

test.skipIf(process.platform === 'linux')(
  'R42-8: win32 钉平台——case-variant 定稿篇不被误列「未定稿」，recap 已写章数不低估', async () => {
    pinPlatform('win32')
    const root = makeShortBook()
    try {
      const r = await recapOf(root)
      expect(r.state).toBe(7)
      expect(r.currentChapter).toBe(2) // 修复前：002 被误列未定稿 → chapters(2) - unfinished(1) = 1
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform === 'linux')(
  'R42-8: posix 钉平台——不折叠：case-variant 篇被列「未定稿」，已写章数低估形态可观测（口径维持）', async () => {
    pinPlatform('linux')
    const root = makeShortBook()
    try {
      const r = await recapOf(root)
      expect(r.currentChapter).toBe(1) // posix 保大小写 → 002 未认定稿（与 win 腿互为反证）
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
