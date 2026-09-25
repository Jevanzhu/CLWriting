/**
 * C1（批 2）章摘要生成器测试：落盘形状（纯数字文件名 + fm sourceHash 绑定）/
 * 预算硬截断 / fresh 跳过 / 失败降级不落盘 / 过期重生成 / auto 开关 /
 * 自愈补漏（仅已定稿章 + 计入预算路径）/ prepare 注入登记（fm 剥离 + visible 清单）。
 *
 * AI 侧走 mock 快路（CLWRITING_DRIVER=mock + SUMMARY_CHAPTER_SPEC.mockText），
 * 失败路径走「无 provider 且非 mock」的真实解析错误。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import {
  generateChapterSummary,
  chapterSummaryState,
  chapterSummaryPath,
  selfHealRecentChapterSummaries,
  afterFinalizeGenerateSummary,
  afterFinalizeGenerateSummaryBatch,
  readChapterSummaryBody,
  effectiveConfig,
  SUMMARY_CHAPTER_MAX_FALLBACK,
  SUMMARY_VOLUME_MAX_FALLBACK,
} from '../../src/process/summary.js'
import { SUMMARY_CHAPTER_SPEC } from '../../src/ai/tasks/specs.js'
import { denyRead } from '../helpers/fs-deny.js'

// win 臂 EACCES 注入的模块包装（posix 臂走 chmod 不依赖）——见 helpers/fs-deny.ts 头注
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { armFsNamespace } = await import('../helpers/fs-deny.js')
  return armFsNamespace('fs', actual)
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const { armFsNamespace } = await import('../helpers/fs-deny.js')
  return armFsNamespace('fsp', actual)
})

import { waitBackgroundTasks, hasBackgroundTasks } from '../../src/ai/orchestrate/background.js'
import { computeRevision } from '../../src/document/revision.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { finalizeRevision } from '../../src/document/finalize.js'
import { prepare } from '../../src/process/prepare.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { log } from '../../src/log/index.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/index.js'
import type { BookConfig } from '../../src/format/types.js'
// R0916-7-P3-6（并发批次）：mock 快路选择点收归组装根，测试侧同点注入（见 beforeEach）
import { configureRunnerMockFastPath } from '../../src/ai/runner.js'

const dirs: string[] = []

beforeEach(() => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  // R0916-7-P3-6（并发批次）：mock 快路选择点收归组装根，测试侧同点注入
  configureRunnerMockFastPath(true)
})

afterEach(() => {
  configureRunnerMockFastPath(false)
  delete process.env['CLWRITING_DRIVER']
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 造书：N 章（每章有 fm 正文）+ 布线 + 清单登记；finalized=true 时给前 n 章落定稿基线 */
function makeBook(chapters: number, finalized = 0): string {
  const root = mkdtempTracked(join(tmpdir(), 'clw-summary-'))
  dirs.push(root)
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 摘要测试书\nhost: cc\nleads:\n  enabled: []\n', 'utf-8')
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (let no = 1; no <= chapters; no++) {
    const pad = String(no).padStart(3, '0')
    const p = join(root, '写作', '正文', `${pad}-第${no}章.md`)
    writeFileSync(p, `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第${no}章正文：山门外的玉佩在雨夜里连响了三下。\n`, 'utf-8')
    const id = generateDocId()
    upsertEntry(m, { id, nodeType: 'document', path: `写作/正文/${pad}-第${no}章.md`, parentId: null })
    if (no <= finalized) {
      const e = m.entries.get(id)!
      e.finalizedRevision = computeRevision(p)
      e.finalizedAt = new Date().toISOString()
    }
  }
  writeManifest(manifestPath, m)
  return root
}

const bodyOf = (root: string, no: number): string => join(root, '写作', '正文', `${String(no).padStart(3, '0')}-第${no}章.md`)

describe('generateChapterSummary（C1 批 2）', () => {
  it('生成落盘：纯数字文件名 + fm {chapter, generatedAt, model, sourceHash 绑定正文指纹}', async () => {
    const root = makeBook(1)
    const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root, 1) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.skipped).toBe(false)
    const fp = chapterSummaryPath(root, 1)
    expect(fp.endsWith(join('定稿', '摘要', '章摘要', '1.md'))).toBe(true) // scanSummaries 的 Number() 归集口径
    const raw = readFileSync(fp, 'utf-8')
    expect(raw).toContain(`chapter: 1`)
    expect(raw).toContain(`sourceHash: ${computeRevision(bodyOf(root, 1))}`)
    // 低级项（第六轮）：model 落实际值（mock 快路无模型 → 'unknown'，不再是占位符）
    expect(raw).toContain('model: unknown')
    expect(raw).toContain('情节推进') // mock 产出三行结构
  })

  it('预算硬截断：产出超 summary_chapter_max → 落盘 ≤ 上限（R53-B-2：省略号计入预算）', async () => {
    const root = makeBook(1)
    const cfg: BookConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, summary_chapter_max: 10 } }
    const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: cfg, chapter: 1, bodyAbsPath: bodyOf(root, 1) })
    expect(r.ok).toBe(true)
    const body = readChapterSummaryBody(root, 1)!
    // 修复前：10 码位 + '…' = 11 超预算；修复后 9 + '…' = 10 恰在预算内
    expect([...body].length).toBeLessThanOrEqual(10)
    expect(body.endsWith('…')).toBe(true)
  })

  it('fresh 跳过：已有且 sourceHash 相符 → skipped 不调 AI', async () => {
    const root = makeBook(1)
    const first = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root, 1) })
    expect(first.ok && !first.skipped).toBe(true)
    const again = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root, 1) })
    expect(again.ok && again.skipped).toBe(true)
  })

  it('失败降级：无 provider 且非 mock → ok:false 且不落盘', async () => {
    const root = makeBook(1)
    delete process.env['CLWRITING_DRIVER']
    configureRunnerMockFastPath(false) // mock 快路随环境变量一并关（选择点在组装根）
    const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root, 1) })
    expect(r.ok).toBe(false)
    expect(existsSync(chapterSummaryPath(root, 1))).toBe(false)
  })

  it('sourceHash 过期判定：正文后改 → stale → 重新生成绑新指纹', async () => {
    const root = makeBook(1)
    await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root, 1) })
    appendFileSync(bodyOf(root, 1), '\n新一段剧情。\n')
    expect(chapterSummaryState(root, 1, bodyOf(root, 1))).toBe('stale')
    const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root, 1) })
    expect(r.ok && !r.skipped).toBe(true)
    expect(readChapterSummaryBody(root, 1)).toBeTruthy()
    expect(chapterSummaryState(root, 1, bodyOf(root, 1))).toBe('fresh')
  })

  // Q-14（第十五轮）：带 BOM/CRLF 毛边的摘要文件 → fm 仍可提取（手写正则曾整段丢失，
  // 过期检测永久失灵 + fm 漏进注入正文）
  it('Q-14: BOM + CRLF 摘要 → sourceHash 过期判定与剥 fm 注入照常', async () => {
    const root = makeBook(1)
    const hash = computeRevision(bodyOf(root, 1))
    mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
    writeFileSync(chapterSummaryPath(root, 1), `\ufeff---\r\nchapter: 1\r\nsourceHash: ${hash}\r\n---\r\n\r\nBOM 摘要正文。\r\n`)
    expect(chapterSummaryState(root, 1, bodyOf(root, 1))).toBe('fresh')
    appendFileSync(bodyOf(root, 1), '\n正文后改。\n')
    expect(chapterSummaryState(root, 1, bodyOf(root, 1))).toBe('stale')
    // 剥 fm 注入：正文不含 fm 键（BOM 不再漏进内容）
    expect(readChapterSummaryBody(root, 1)).toBe('BOM 摘要正文。')
  })

  // R32-20（三十二轮）：正文 TOCTOU 消失 → 状态判定按 missing 降级不抛（此前
  // computeRevision 裸抛 ENOENT 穿出自愈循环被 materials 静默吞掉，补漏断链零痕迹）
  it('R32-20: 正文消失（TOCTOU）→ chapterSummaryState 返回 missing 不抛', async () => {
    const root = makeBook(1)
    await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root, 1) })
    // 变体 a：路径已不存在（定稿章在扫描与判定间被移删）
    const gone = join(root, '写作', '正文', '999-消失.md')
    expect(chapterSummaryState(root, 1, gone)).toBe('missing')
    // 变体 b：正文读失败（同路径文件变目录占位 → EISDIR）
    rmSync(bodyOf(root, 1))
    mkdirSync(bodyOf(root, 1), { recursive: true })
    expect(chapterSummaryState(root, 1, bodyOf(root, 1))).toBe('missing')
  })

  it('R-11（十五轮登记销账）：硬截断按码位——边界处增补平面字符不切成半个代理对', async () => {
    const root = makeBook(1)
    const spec = SUMMARY_CHAPTER_SPEC as unknown as { mock: { kind: 'text'; text: string } }
    const orig = spec.mock
    try {
      // 预算 3：码位截断得「ab…」（2 码位 + 省略号，总长恰 3）；UTF-16 slice 会
      // 在 𠮷（U+20BB7，两个码元）中间切一刀，留下孤立高代理 \ud867 落盘
      spec.mock = { kind: 'text', text: 'ab𠮷cd' }
      const cfg = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, summary_chapter_max: 3 } }
      const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: cfg, chapter: 1, bodyAbsPath: bodyOf(root, 1) })
      expect(r.ok && !r.skipped).toBe(true)
      const body = readChapterSummaryBody(root, 1)!
      expect(body).toBe('ab\u2026')
      expect(body).not.toContain('\u{D867}')
    } finally {
      spec.mock = orig
    }
  })

  it('E-9e（第五十三轮）：预算比较按码位——码位数未超预算时不因 UTF-16 length 偏大误截断', async () => {
    const root = makeBook(1)
    const spec = SUMMARY_CHAPTER_SPEC as unknown as { mock: { kind: 'text'; text: string } }
    const orig = spec.mock
    try {
      // 「ab𠮷cd」= 5 码位但 6 个 UTF-16 码元：旧口径 length(6) > 预算(5) 会多此一举
      // 追加省略号；码位口径 5 ≤ 5 不截断
      spec.mock = { kind: 'text', text: 'ab\u{20BB7}cd' }
      const cfg = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, summary_chapter_max: 5 } }
      const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: cfg, chapter: 1, bodyAbsPath: bodyOf(root, 1) })
      expect(r.ok && !r.skipped).toBe(true)
      const body = readChapterSummaryBody(root, 1)!
      expect(body).toBe('ab\u{20BB7}cd')
    } finally {
      spec.mock = orig
    }
  })

  // N-7（第五十四轮）：预算兜底显式 resolve——书级未设 summary_chapter_max 时走具名
  // 具名回落常量（不再内联硬编码 200），且回落值与 yaml 脚手架缺省同源一致
  it('N-7: 书级未设 summary_chapter_max → 按具名回落常量截断（与 yaml 脚手架缺省同源）', async () => {
    expect(SUMMARY_CHAPTER_MAX_FALLBACK).toBe(200)
    expect(SUMMARY_VOLUME_MAX_FALLBACK).toBe(500)
    expect(DEFAULT_CONFIG.budget.summary_chapter_max).toBe(SUMMARY_CHAPTER_MAX_FALLBACK)
    expect(DEFAULT_CONFIG.budget.summary_volume_max).toBe(SUMMARY_VOLUME_MAX_FALLBACK)

    const root = makeBook(1)
    const spec = SUMMARY_CHAPTER_SPEC as unknown as { mock: { kind: 'text'; text: string } }
    const orig = spec.mock
    try {
      // 产出超回落预算（200）→ 硬截断 199 + '…'（R53-B-2：省略号计入预算，总长恰 200）
      spec.mock = { kind: 'text', text: '字'.repeat(SUMMARY_CHAPTER_MAX_FALLBACK + 50) }
      const cfg: BookConfig = { ...DEFAULT_CONFIG, budget: { calls_per_chapter: 3 } } // 摘要预算未设
      const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: cfg, chapter: 1, bodyAbsPath: bodyOf(root, 1) })
      expect(r.ok && !r.skipped).toBe(true)
      const body = readChapterSummaryBody(root, 1)!
      expect([...body].length).toBe(SUMMARY_CHAPTER_MAX_FALLBACK)
    } finally {
      spec.mock = orig
    }
  })

  it('手写摘要（无 fm）按 fresh 对待——作者产物优先，程序不覆盖', async () => {
    const root = makeBook(1)
    mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
    writeFileSync(chapterSummaryPath(root, 1), '作者手写的第 1 章小结。\n', 'utf-8')
    expect(chapterSummaryState(root, 1, bodyOf(root, 1))).toBe('fresh')
    const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root, 1) })
    expect(r.ok && r.skipped).toBe(true)
    expect(readFileSync(chapterSummaryPath(root, 1), 'utf-8')).toContain('作者手写')
  })

  it('sourceHash 绑 readDraft 时点（第五轮）：AI 调用期间正文被并发改写 → 绑旧指纹并标 stale', async () => {
    const root = makeBook(1)
    const oldRev = computeRevision(bodyOf(root, 1))
    // mock.text 在 runSpec 调用时才取值（readDraft 之后）——用 getter 模拟「AI 生成期间
    // 外部并发改写正文」：修复前 sourceHash 在落盘时才计算，会绑到新指纹 → 明明摘要
    // 描述的是旧正文却被判 fresh；修复后绑 readDraft 时点，state 正确报 stale 留待重生成
    const spec = SUMMARY_CHAPTER_SPEC as unknown as { mock: { kind: 'text'; text: string } }
    const orig = spec.mock
    try {
      spec.mock = {
        kind: 'text',
        get text() {
          appendFileSync(bodyOf(root, 1), '\n生成期间的并发改写段落。\n')
          return orig.text
        },
      }
      const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root, 1) })
      expect(r.ok).toBe(true)
    } finally {
      spec.mock = orig
    }
    const raw = readFileSync(chapterSummaryPath(root, 1), 'utf-8')
    expect(raw).toContain(`sourceHash: ${oldRev}`)
    expect(chapterSummaryState(root, 1, bodyOf(root, 1))).toBe('stale')
  })
})

describe('自愈补漏 selfHealRecentChapterSummaries（挂点二）', () => {
  it('近章（N-2/N-1）缺失 → 只为已定稿章补生成；再次调用全 fresh 零产出', async () => {
    const root = makeBook(3, 2) // 章 1/2 已定稿，章 3 未定稿
    const generated = await selfHealRecentChapterSummaries(root, null, DEFAULT_CONFIG, 4)
    // N=4 → 近章 [2, 3]；章 2 已定稿补生成，章 3 未定稿跳过
    expect(generated).toEqual(['定稿/摘要/章摘要/2.md']) // R71-15：产品侧 posix 口径（勿用 join——win 上是反斜杠）
    expect(existsSync(chapterSummaryPath(root, 2))).toBe(true)
    expect(existsSync(chapterSummaryPath(root, 3))).toBe(false)
    const again = await selfHealRecentChapterSummaries(root, null, DEFAULT_CONFIG, 4)
    expect(again).toEqual([])
  })

  it('summary.auto: false → 整体关闭（回到手写约定现状）', async () => {
    const root = makeBook(2, 2)
    const cfg: BookConfig = { ...DEFAULT_CONFIG, summary: { auto: false } }
    const generated = await selfHealRecentChapterSummaries(root, null, cfg, 3)
    expect(generated).toEqual([])
    expect(existsSync(chapterSummaryPath(root, 1))).toBe(false)
    expect(existsSync(chapterSummaryPath(root, 2))).toBe(false)
  })
})

describe('定稿即生成 afterFinalizeGenerateSummary（挂点一，best-effort）', () => {
  it('finalize 成功后摘要文件异步出现（fire-and-forget 轮询等待）', async () => {
    const root = makeBook(1)
    const m = readManifest(join(root, '项目', '文档清单.jsonl'))
    const docId = [...m.entries.keys()][0]!
    const outcome = finalizeRevision(root, docId)
    expect(outcome.ok).toBe(true)
    afterFinalizeGenerateSummary(root, null, docId)
    let found = false
    for (let i = 0; i < 100 && !found; i++) {
      await new Promise((r) => setTimeout(r, 20))
      found = existsSync(chapterSummaryPath(root, 1))
    }
    expect(found).toBe(true)
    expect(chapterSummaryState(root, 1, bodyOf(root, 1))).toBe('fresh')
  })

  it('非正文章文档（设定等）不触发生成', async () => {
    const root = makeBook(0)
    mkdirSync(join(root, '设定'), { recursive: true })
    writeFileSync(join(root, '设定', '世界观.md'), '---\n标题: 世界观\n---\n设定内容。', 'utf-8')
    const manifestPath = join(root, '项目', '文档清单.jsonl')
    const m = readManifest(manifestPath)
    const id = generateDocId()
    upsertEntry(m, { id, nodeType: 'document', path: '设定/世界观.md', parentId: null })
    writeManifest(manifestPath, m)
    afterFinalizeGenerateSummary(root, null, id)
    await new Promise((r) => setTimeout(r, 150))
    expect(existsSync(join(root, '定稿', '摘要', '章摘要'))).toBe(false)
  })
})

describe('批量定稿串行摘要链 afterFinalizeGenerateSummaryBatch（第五轮 M-2）', () => {
  /** 从清单取第 no 章的 docId */
  const chapterDocId = (root: string, no: number): string => {
    const m = readManifest(join(root, '项目', '文档清单.jsonl'))
    const suffix = `${String(no).padStart(3, '0')}-第${no}章.md`
    return [...m.entries.entries()].find(([, e]) => e.path.endsWith(suffix))![0]
  }

  it('整链单条登记：waitBackgroundTasks 追上后全部章摘要在盘（串行不撞 inFlight 去重）', async () => {
    const root = makeBook(2, 2)
    afterFinalizeGenerateSummaryBatch(root, null, [chapterDocId(root, 2), chapterDocId(root, 1)], '批量书')
    await waitBackgroundTasks('批量书')
    expect(readChapterSummaryBody(root, 1)).toBeTruthy()
    expect(readChapterSummaryBody(root, 2)).toBeTruthy()
  })

  it('坏 docId 单点失败不拖链——后续章照常生成（逐章 try/catch 隔离）', async () => {
    const root = makeBook(2, 2)
    afterFinalizeGenerateSummaryBatch(root, null, ['doc_不存在', chapterDocId(root, 1)], '批量书2')
    await waitBackgroundTasks('批量书2')
    expect(readChapterSummaryBody(root, 1)).toBeTruthy()
    expect(readChapterSummaryBody(root, 2)).toBeFalsy() // 不在链上的章不生成
  })

  it('空 docIds → 直接返回（无 AI 调用无登记）', async () => {
    const root = makeBook(1)
    afterFinalizeGenerateSummaryBatch(root, null, [], '空批量')
    await new Promise((r) => setTimeout(r, 50))
    expect(existsSync(chapterSummaryPath(root, 1))).toBe(false)
  })

  // P3-⑯（2026-09-13 服务端端点/摘要簇修复批）：外层整段 try/catch 自留痕——
  // registerCtrl 同步抛错等形态此前直穿 IIFE 让 p reject（未登记时逃逸为 unhandled
  // rejection），对齐单发版 afterFinalizeGenerateSummary 同款包裹
  it('registerCtrl 同步抛错 → 整段自留痕 warn 且 p 不 reject 不悬挂', async () => {
    const root = makeBook(1, 1)
    const session: Session = { id: 'r0913-trace', cwd: root, closed: false }
    const driver: StudioDriver = {
      async startSession(cwd: string): Promise<Session> {
        return { id: 'trace', cwd, closed: false }
      },
      async *stream(): AsyncGenerator<DriverEvent> {},
      dispose(): void {},
      registerCtrl(): void {
        throw new Error('registerCtrl 同步抛错')
      },
      emit(_s: Session, _ev: DriverEvent): void {},
      unregisterCtrl(_s: Session, _c: AbortController): void {},
      cancelStream(): void {},
      interrupt(): void {},
      isRunning(): boolean { return false },
      isWriterRunning(): boolean { return false },
    }
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      afterFinalizeGenerateSummaryBatch(root, null, [chapterDocId(root, 1)], '批量自留痕书', driver, session)
      await waitBackgroundTasks('批量自留痕书')
      expect(hasBackgroundTasks('批量自留痕书')).toBe(false)
      // 留痕点名批量链异常（修复前无此 warn——p 静默 reject）
      expect(warnSpy.mock.calls.some((c) => String(c[1]).includes('批量定稿章摘要链异常'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('prepare 注入登记（模型可见 ⟺ 已记录，C1 红线）', () => {
  it('章摘要注入剥 fm + injectedSummaryFiles 登记（visible 侧清单）', async () => {
    // PL-2（第七轮）：定稿口径下清单在册零定稿 → currentChapter=0 不注入摘要——
    // 夹具对齐生产语义（章摘要随定稿生成），第 1 章定稿
    const root = makeBook(1, 1)
    await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root, 1) })
    // rebuild 让摘要进 index.db（生成器自愈路径内部已做；这里独立走 rebuild 同口径）
    const { rebuild } = await import('../../src/cache/rebuild.js')
    rebuild(root, join(root, '.cache', 'index.db'))
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(root, '.cache', 'index.db'))
    try {
      const config = effectiveConfig(root, null)
      const r = prepare(db, config, root, [], undefined, '战斗')
      expect(r.injectedSummaryFiles).toContain('定稿/摘要/章摘要/1.md')
      // 注入内容剥 fm：fm 键不进材料正文，mock 摘要正文进
      const endings = r.sections.find((s) => s.title === '近章结尾')
      expect(endings).toBeDefined()
      expect(endings!.content).toContain('情节推进')
      expect(endings!.content).not.toContain('sourceHash:')
    } finally {
      db.close()
    }
  })
})

// ── R65-31（第六十五轮）：摘要文件读失败降级（权限/TOCTOU 不直穿自愈链）────────

describe('R65-31: 摘要读失败降级', () => {
  // 重评-0914-三轮 P3-11：读失败注入改 fs-deny 平台分派（win 臂 spy 注入 EACCES），摘除 skipIf(win32)
  it('章摘要不可读（EACCES）→ chapterSummaryState 按 missing、body 按 null，均不抛', () => {
    const root = mkdtempTracked(join(tmpdir(), 'clw-r65-31-'))
    dirs.push(root)
    try {
      const bodyAbs = join(root, '写作', '正文', '1-第一章.md')
      mkdirSync(join(root, '写作', '正文'), { recursive: true })
      writeFileSync(bodyAbs, '---\n章号: 1\n标题: 第一章\n---\n正文。', 'utf-8')
      const fp = chapterSummaryPath(root, 1)
      mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
      writeFileSync(fp, '---\nchapter: 1\nsourceHash: sha256:x\n---\n\n情节推进。\n', 'utf-8')
      const deny = denyRead(fp) // 自然故障注入（非 mock）：读盘 EACCES（win 臂 spy / posix 臂 chmod）
      try {
        // 修复前：existsSync 通过后裸 readFileSync 直穿抛 EACCES
        expect(chapterSummaryState(root, 1, bodyAbs)).toBe('missing')
        expect(readChapterSummaryBody(root, 1)).toBeNull()
      } finally {
        deny.restore() // 还原供 afterEach 清理
      }
    } finally {
      // dirs 清理由 afterEach 统一做
    }
  })
})
