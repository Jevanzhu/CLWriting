/**
 * 树红点聚合的纪元指纹：遍数收敛 / 计算时机 / 与章数解耦 / 输入域 / 精度。
 *
 * 档源（5 档并 1，按被测行为合并；断言逐条保留、去重 1 条——r47 的「全缓存命中
 * 仅首遍 1 次」与 r71-20 第三例同语义，保留带「零正文整读」旁证的后者；另三份同款
 * 造书夹具收编为一份 makeBook）：
 * - r47-tree-issues-epoch.test.ts（R47-30 遍数消重 + precomputedFp 复用 + 语义零回归）
 * - r52-epoch-fp-before-rebuild.test.ts（R52-E-1 基线先于 rebuild）
 * - r71-tree-issues-epoch-fp-count.test.ts（R71-20 调用次数与章数解耦）
 * - r51-en4-dirfp-md-only.test.ts（R51-E-N4 dirFp 只计 .md）
 * - r29-check-machine-correctness.test.ts 的 B-8 组（指纹 µs 精度）
 *
 * 演进脉络：R70-14 写前纪元复核（每 miss 章 1 次全树遍历）→ R71-20 轮内缓存
 * （基线 + 轮内缓存，O(1)/请求）→ R32-14 终核（窗口内全局输入变更不落陈旧行）→
 * R47-30 中间两遍消重（epochFp0 前移传入 syncTreeIssuesEpoch 复用、轮前复核遍删除，
 * 首 + 尾固定 2 遍）→ R52-E-1 fp0 前移到 rebuild 之前（头窗收编进终核防护）。
 * 阶段 52 批 1：断言缝统一改挂生成器核（…Core），断言值一律不改。
 */
import { describe, it, expect, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, utimesSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

vi.mock('../../src/check/tree-issues-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/check/tree-issues-cache.js')>()
  // 阶段 52 批 1：改挂新核（computeTreeIssuesGlobalFp → …Core）——聚合内首尾两遍走
  // 核（yield* 委托），同步包装不再被核心调用；断言值一律不改。
  return { ...actual, computeTreeIssuesGlobalFpCore: vi.fn(actual.computeTreeIssuesGlobalFpCore) }
})

vi.mock('../../src/cache/rebuild.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cache/rebuild.js')>()
  return { ...actual, rebuild: vi.fn(actual.rebuild) }
})

vi.mock('../../src/format/draft.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/format/draft.js')>()
  return { ...actual, readDraft: vi.fn(actual.readDraft) }
})

import { computeTreeIssuesGlobalFpCore, syncTreeIssuesEpoch, computeTreeIssuesGlobalFp, computeLeadsBookFp } from '../../src/check/tree-issues-cache.js'
import { rebuild } from '../../src/cache/rebuild.js'
import { readDraft } from '../../src/format/draft.js'
import { collectTreeIssues } from '../../src/check/run.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { driveToEnd } from '../../src/async.js'

const fpMock = vi.mocked(computeTreeIssuesGlobalFpCore)
const rebuildMock = vi.mocked(rebuild)
const readDraftMock = vi.mocked(readDraft)

/** 造书（含布线 + 每章禁词「玉佩」制造确定红源；原 r47/r71/r52 三份同款夹具收编） */
function makeBook(chapterCount: number): string {
  const root = mkdtempTracked(join(tmpdir(), 'epoch-fp-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n', 'utf-8')
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n', 'utf-8')
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (let no = 1; no <= chapterCount; no++) {
    const pad = String(no).padStart(3, '0')
    writeFileSync(
      join(root, '写作', '正文', `${pad}-第${no}章.md`),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的雨夜里，玉佩，连响了三下。\n`,
      'utf-8',
    )
    upsertEntry(m, { id: generateDocId(), nodeType: 'document', path: `写作/正文/${pad}-第${no}章.md`, parentId: null })
  }
  writeManifest(manifestPath, m)
  return root
}

// ── R47-30：聚合的纪元指纹遍数收敛为首尾各一遍 ───────────────────

describe('R47-30：聚合的纪元指纹遍数收敛为首尾各一遍', () => {
  it('全书 miss 的一次聚合 → 全树纪元指纹 ≤2 遍（首 + 终核；修复前 4 遍）', () => {
    const root = makeBook(4)
    try {
      fpMock.mockClear()
      const { issues } = collectTreeIssues(root, () => undefined)
      expect(Object.keys(issues)).toHaveLength(4) // 禁词红源命中证明机检真跑了
      // mock 只计 run.ts 侧调用（sync 内部遍已由 precomputedFp 消除）：首（epochFp0）
      // + 尾（epochFpEnd）= 2；R47-30 前为 3（+sync 内部未计入的第 4 遍）
      expect(fpMock.mock.calls.length).toBeLessThanOrEqual(2)
      expect(fpMock.mock.calls.length).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  // 「全缓存命中 → 仅首遍 1 次」与 R71-20 组第三例同语义（fpMock 1 + 零正文整读旁证），
  // 并档时去重 1 条，见下方 R71-20 describe。
})

describe('R47-30：语义零回归（终核口径保留）', () => {
  it('红点结果与「删 .cache 全量重算」逐字节一致（含变更后重聚合）', () => {
    const root = makeBook(4)
    try {
      collectTreeIssues(root, () => undefined) // 预热缓存
      // 变更混合面：触碰全局输入（book.yaml 纪元源）+ 改 1 章正文
      utimesSync(join(root, 'book.yaml'), new Date(), new Date())
      writeFileSync(
        join(root, '写作', '正文', '002-第2章.md'),
        '---\n章号: 2\n标题: 第2章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的旧玉在雨夜里安安静静。\n',
        'utf-8',
      )
      const cached = collectTreeIssues(root, () => undefined)
      rmSync(join(root, '.cache'), { recursive: true, force: true })
      const fresh = collectTreeIssues(root, () => undefined)
      expect(cached.issues).toEqual(fresh.issues)
      // 抽查：第 2 章红源消除（其余章禁词红照旧）
      const m = readManifest(join(root, '项目', '文档清单.jsonl'))
      const docOf = (p: string) => [...m.entries.entries()].find(([, e]) => e.path === p)![0]
      expect(cached.issues[docOf('写作/正文/002-第2章.md')]).toBeUndefined()
      expect(Object.keys(cached.issues)).toHaveLength(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('聚合窗口内纪元漂移 → 整批不落缓存（R32-14 终核闸在 R47-30 后仍生效）', () => {
    const root = makeBook(3)
    try {
      collectTreeIssues(root, () => undefined) // 建缓存（首轮全 miss + 落盘）
      // 第二轮：章循环中途触碰纪元源——通过 fp 包装在每次调用后触碰一次全局输入，
      // 使终核遍（epochFpEnd）必见漂移 → 本轮零落缓存
      // 阶段 52 批 1：改挂新核（computeTreeIssuesGlobalFp → …Core，断言值一律不改）——
      // 核为生成器，注入侧先直驱算完（等价原同步调用），再包成核产出回传
      const orig = fpMock.getMockImplementation()!
      let n = 0
      fpMock.mockImplementation((...args) => {
        const r = driveToEnd(orig(...args))
        if (++n === 1) utimesSync(join(root, 'book.yaml'), new Date(), new Date())
        return (function* () {
          return r
        })()
      })
      try {
        collectTreeIssues(root, () => undefined)
      } finally {
        fpMock.mockImplementation(orig)
      }
      // 漂移被 syncTreeIssuesEpoch 的首遍之前记录的基线 vs 终核检出（表在下一轮
      // 聚合开头会因纪元变化被清）——此处验证第三轮结果仍与全量一致（无陈旧行）
      const third = collectTreeIssues(root, () => undefined)
      rmSync(join(root, '.cache'), { recursive: true, force: true })
      const fresh = collectTreeIssues(root, () => undefined)
      expect(third.issues).toEqual(fresh.issues)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('R47-30：syncTreeIssuesEpoch precomputedFp 复用', () => {
  it('传入即复用（不再自算）：forced fp 落表、二次同值 no-op、不传则自算与真值一致', () => {
    const root = makeBook(1)
    try {
      mkdirSync(join(root, '.cache'), { recursive: true })
      const db = new DatabaseSync(join(root, '.cache', 'index.db'))
      try {
        // 传入 forced fp：首次清+记（true），同值再调 no-op（false）
        expect(syncTreeIssuesEpoch(db, root, null, 'forced-fp')).toBe(true)
        expect(syncTreeIssuesEpoch(db, root, null, 'forced-fp')).toBe(false)
        const row = db.prepare("SELECT value FROM tree_issues_meta WHERE key = 'global_fp'").get() as { value: string }
        expect(row.value).toBe('forced-fp')
        // 不传（既有调用方口径）：自算真值——与 forced 不同 → 清+记（true），随后 no-op
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(true)
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(false)
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── R52-E-1：纪元指纹基线必须先于 rebuild ────────────────────────
// 修复前：epochFp0 在 rebuild 之后（sync 前）才算——rebuild 内部扫源 stat 与 fp0
// 计算之间存在头窗：窗口内纪元输入（布线/大纲/文风/清单等）被改写时，rebuild 读到
// 旧数据，其后计算的 fp0 已是新纪元 → 陈旧红值以新纪元落缓存（指纹自洽，终核
// epochFpEnd 不再失效它，红点口径被固化到下纪元）。修复后：fp0 在 rebuild 之前算得
// 并传入 syncTreeIssuesEpoch 复用——终核窗口覆盖「fp0 → 聚合全程」。
// 锚定方式：fp 与 rebuild 的调用顺序（行为面与 R47-30 既有语义测试重合——遍数 ≤2、
// 终核闸、precomputedFp 复用由上方 describe 继续锚定，此处不重复）。

describe('R52-E-1：纪元指纹基线先于 rebuild', () => {
  it('一次聚合内 computeTreeIssuesGlobalFp 首遍调用先于 rebuild（修复后在 sync 之前、rebuild 之前）', () => {
    const root = makeBook(2)
    try {
      const order: string[] = []
      const fpOrig = fpMock.getMockImplementation()!
      const rebuildOrig = rebuildMock.getMockImplementation()!
      fpMock.mockImplementation((...args) => {
        order.push('fp')
        return fpOrig(...args)
      })
      rebuildMock.mockImplementation((...args) => {
        order.push('rebuild')
        return rebuildOrig(...args)
      })
      try {
        const { issues } = collectTreeIssues(root, () => undefined)
        // 红源命中证明机检真跑了（缓存链路真实启用，非降级路径）
        expect(Object.keys(issues)).toHaveLength(2)
        expect(order.indexOf('fp')).toBeGreaterThanOrEqual(0)
        expect(order.indexOf('rebuild')).toBeGreaterThanOrEqual(0)
        // 核心断言：fp 基线（首遍）先于 rebuild——头窗收编进终核防护的前提
        expect(order.indexOf('fp')).toBeLessThan(order.indexOf('rebuild'))
        // 遍数不变式维持（R47-30 口径）：首 + 终核 = 2（sync 复用预计算 fp 不自算）
        expect(order.filter((s) => s === 'fp')).toHaveLength(2)
      } finally {
        fpMock.mockImplementation(fpOrig)
        rebuildMock.mockImplementation(rebuildOrig)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fp0 与 rebuild 之间触碰纪元源 → 本轮零落缓存（下轮与删库全量逐字节一致）', () => {
    const root = makeBook(3)
    try {
      collectTreeIssues(root, () => undefined) // 建缓存（epoch A）
      // 第二轮：在 fp0（先于 rebuild）之后触碰纪元源（文风铁律 mtime 变化 → 纪元 A→B）
      // ——头窗场景本体：修复后 sync 记基线 A、终核见 B → 整批不落盘
      const fpOrig = fpMock.getMockImplementation()!
      let n = 0
      fpMock.mockImplementation((...args) => {
        // 阶段 52 批 1：核为生成器——注入侧先直驱算完（等价原同步调用）再触碰，最后包成核产出
        const r = driveToEnd(fpOrig(...args))
        if (++n === 1) {
          const st = JSON.stringify({ t: Date.now() })
          writeFileSync(join(root, '文风', '文风铁律.md'), `# 文风铁律\n## 硬禁词\n- 玉佩\n<!-- ${st} -->\n`, 'utf-8')
        }
        return (function* () {
          return r
        })()
      })
      try {
        collectTreeIssues(root, () => undefined)
      } finally {
        fpMock.mockImplementation(fpOrig)
      }
      // 第三轮结果与「删 .cache 全量」一致（无陈旧行）——与 r47 漂移测试同口径的语义面
      const third = collectTreeIssues(root, () => undefined)
      rmSync(join(root, '.cache'), { recursive: true, force: true })
      const fresh = collectTreeIssues(root, () => undefined)
      expect(third.issues).toEqual(fresh.issues)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── R71-20：写前纪元复核轮内缓存（调用次数与章数解耦）──────────────

describe('R71-20：写前纪元复核轮内缓存（调用次数与章数解耦）', () => {
  it('全书 miss 的一次聚合 → computeTreeIssuesGlobalFp 全书固定 2 次（R47-30 首尾口径；R71 前为 3，逐章复核时代 1+N=6）', () => {
    const root = makeBook(5)
    try {
      fpMock.mockClear()
      const { issues } = collectTreeIssues(root, () => undefined)
      // 5 章全部未定稿且缓存全 miss → 逐章走到写前复核点（红源命中证明机检真跑了）
      expect(Object.keys(issues)).toHaveLength(5)
      // 首（epochFp0，兼作 syncTreeIssuesEpoch 纪元）×1 + 循环后终核（R32-14 落盘前
      // 复核）×1；R47-30 消掉了 sync 内部遍与轮前复核遍
      expect(fpMock.mock.calls.length).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('章数翻倍 → 调用次数不变（O(N) 次全树遍历 → O(1)）', () => {
    const root = makeBook(10)
    try {
      fpMock.mockClear()
      const { issues } = collectTreeIssues(root, () => undefined)
      expect(Object.keys(issues)).toHaveLength(10)
      expect(fpMock.mock.calls.length).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('轮内缓存口径下首轮仍落缓存：二次聚合全部命中（零正文整读、issues 同构）', () => {
    const root = makeBook(4)
    try {
      const first = collectTreeIssues(root, () => undefined)
      expect(Object.keys(first.issues)).toHaveLength(4)
      readDraftMock.mockClear()
      fpMock.mockClear()
      const second = collectTreeIssues(root, () => undefined)
      // 章级缓存命中 = 首轮 epochStable 为真、行已写入（R32-14 终核口径未误伤缓存写入：
      // 二次聚合零正文整读证明行真实落盘）
      expect(readDraftMock.mock.calls.length).toBe(0)
      expect(second.issues).toEqual(first.issues)
      // 二次聚合全部缓存命中 → 无待落盘章 → R32-14 终核不触发：只剩首遍（epochFp0）×1
      expect(fpMock.mock.calls.length).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── R51-E-N4：dirFp 只计 .md——临时文件不再炸纪元 ─────────────────
// 修复前：目录混入临时文件（编辑器 swap/同步盘半写残留/手放笔记）即纪元指纹变化 →
// 整表清空，增量缓存永久失效（且每轮重扫全树）。修复后：指纹只随 .md 变化——机检
// 对这些目录（布线/章纲/文风/暂存归档/写作·正文）的消费面本就只吃 .md。
// 手法：经导出的 compute*Fp 间接驱动（dirFp 为模块私有）。

describe('R51-E-N4：dirFp 只计 .md（临时文件不炸纪元）', () => {
  it('文风/ 混入非 .md 临时文件 → 纪元指纹不变；.md 变更仍失效（含 .MD 大写）', () => {
    const root = mkdtempTracked(join(tmpdir(), 'epoch-fp-mdonly-wf-'))
    mkdirSync(join(root, '文风'), { recursive: true })
    writeFileSync(join(root, '文风', '文风铁律.md'), '# 铁律\n## 硬禁词\n- 玉佩\n', 'utf-8')
    const base = computeTreeIssuesGlobalFp(root, null)

    // 临时文件（编辑器 swap / 同步盘残留两种扩展形态）混入：修复前指纹必变（红形态）
    writeFileSync(join(root, '文风', '文风铁律.md.swp'), 'vim swap', 'utf-8')
    writeFileSync(join(root, '文风', '.~lock.铁律.ods'), 'lockfile', 'utf-8')
    writeFileSync(join(root, '文风', '随手记.txt'), '不是机检输入', 'utf-8')
    expect(computeTreeIssuesGlobalFp(root, null)).toBe(base)

    // .md 仍是机检输入：内容变更必须失效（防「收窄误伤」反向回归）
    appendFileSync(join(root, '文风', '文风铁律.md'), '- 长枪\n', 'utf-8')
    expect(computeTreeIssuesGlobalFp(root, null)).not.toBe(base)
    // R38-9：.MD 大写扩展名同属 .md 家族，不得因只计 .md 而漏
    writeFileSync(join(root, '文风', '样章.MD'), '# 样章\n', 'utf-8')
    const afterMd = computeTreeIssuesGlobalFp(root, null)
    expect(afterMd).not.toBe(base)
    writeFileSync(join(root, '文风', '样章2.MD'), '# 样章二\n', 'utf-8')
    expect(computeTreeIssuesGlobalFp(root, null)).not.toBe(afterMd)
  })

  it('computeLeadsBookFp（写作·正文 目录指纹）同口径：临时文件不失效，.md 变更失效', () => {
    const root = mkdtempTracked(join(tmpdir(), 'epoch-fp-mdonly-body-'))
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    writeFileSync(
      join(root, '写作', '正文', '0001-第一章.md'),
      '---\n章号: 1\n标题: 第一章\n---\n\n雪落在了城墙上。\n',
      'utf-8',
    )
    const base = computeLeadsBookFp(root, null)
    writeFileSync(join(root, '写作', '正文', '.0001-第一章.md.tmp'), '半写残留', 'utf-8')
    expect(computeLeadsBookFp(root, null)).toBe(base)
    appendFileSync(join(root, '写作', '正文', '0001-第一章.md'), '雪压断了枝。\n', 'utf-8')
    expect(computeLeadsBookFp(root, null)).not.toBe(base)
  })
})

// ── B-8（二十九轮批 A，并入档）：章级缓存指纹毫秒 → µs/ns 精度 ────────
// 方案升级旧行自然失效：mtime 列落 µs 级整数，与旧毫秒行值域不相交——存量毫秒行
// 一次聚合后天然整表失效重算，无脏读窗口。

describe('B-8：章级缓存行指纹 µs 精度', () => {
  it('章级缓存行指纹落 µs 级整数（旧毫秒行值域不相交，天然整表失效无脏读）', () => {
    const root = mkdtempTracked(join(tmpdir(), 'epoch-fp-precision-'))
    try {
      mkdirSync(join(root, '布线', '悬念'), { recursive: true })
      mkdirSync(join(root, '写作', '正文'), { recursive: true })
      mkdirSync(join(root, '项目'), { recursive: true })
      writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 降级书\nhost: cc\nleads:\n  enabled: []\n', 'utf8')
      writeFileSync(
        join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
        '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
        'utf-8',
      )
      const draftPath = join(root, '写作', '正文', '001-章一.md')
      writeFileSync(draftPath, '---\n章号: 1\n标题: 章一\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文一句。', 'utf8')
      const manifestPath = join(root, '项目', '文档清单.jsonl')
      const m = readManifest(manifestPath)
      upsertEntry(m, { id: generateDocId(), nodeType: 'document', path: '写作/正文/001-章一.md', parentId: null })
      writeManifest(manifestPath, m)

      // 第一轮落缓存；第二轮命中（结果同构）
      const first = collectTreeIssues(root, () => undefined)
      const second = collectTreeIssues(root, () => undefined)
      expect(second.issues).toEqual(first.issues)

      // 直查缓存行：mtime 列应为 µs 级（~1.7e15），与旧毫秒值（~1.7e12）值域隔离
      const db = new DatabaseSync(join(root, '.cache', 'index.db'))
      try {
        const row = db.prepare('SELECT mtime_ms FROM tree_issues_cache LIMIT 1').get() as { mtime_ms: number } | undefined
        expect(row).toBeDefined()
        expect(row!.mtime_ms).toBeGreaterThan(1e15) // µs since epoch
        expect(row!.mtime_ms).toBeLessThan(1e16)
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
