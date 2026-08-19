/**
 * C1（批 2）章摘要生成器测试：落盘形状（纯数字文件名 + fm sourceHash 绑定）/
 * 预算硬截断 / fresh 跳过 / 失败降级不落盘 / 过期重生成 / auto 开关 /
 * 自愈补漏（仅已定稿章 + 计入预算路径）/ prepare 注入登记（fm 剥离 + visible 清单）。
 *
 * AI 侧走 mock 快路（CLWRITING_DRIVER=mock + SUMMARY_CHAPTER_SPEC.mockText），
 * 失败路径走「无 provider 且非 mock」的真实解析错误。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateChapterSummary,
  chapterSummaryState,
  chapterSummaryPath,
  selfHealRecentChapterSummaries,
  afterFinalizeGenerateSummary,
  readChapterSummaryBody,
  effectiveConfig,
} from '../../src/process/summary.js'
import { computeRevision } from '../../src/document/revision.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { finalizeRevision } from '../../src/document/finalize.js'
import { prepare } from '../../src/process/prepare.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

const dirs: string[] = []

beforeEach(() => {
  process.env['CLWRITING_DRIVER'] = 'mock'
})

afterEach(() => {
  delete process.env['CLWRITING_DRIVER']
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 造书：N 章（每章有 fm 正文）+ 布线 + 清单登记；finalized=true 时给前 n 章落定稿基线 */
function makeBook(chapters: number, finalized = 0): string {
  const root = mkdtempSync(join(tmpdir(), 'clw-summary-'))
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
    expect(raw).toContain('model: summary-chapter')
    expect(raw).toContain('情节推进') // mock 产出三行结构
  })

  it('预算硬截断：产出超 summary_chapter_max → 落盘 ≤ 上限+省略号（不信任模型自觉）', async () => {
    const root = makeBook(1)
    const cfg: BookConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, summary_chapter_max: 10 } }
    const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: cfg, chapter: 1, bodyAbsPath: bodyOf(root, 1) })
    expect(r.ok).toBe(true)
    const body = readChapterSummaryBody(root, 1)!
    expect(body.length).toBeLessThanOrEqual(11) // 10 + '…'
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

  it('手写摘要（无 fm）按 fresh 对待——作者产物优先，程序不覆盖', async () => {
    const root = makeBook(1)
    mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
    writeFileSync(chapterSummaryPath(root, 1), '作者手写的第 1 章小结。\n', 'utf-8')
    expect(chapterSummaryState(root, 1, bodyOf(root, 1))).toBe('fresh')
    const r = await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root, 1) })
    expect(r.ok && r.skipped).toBe(true)
    expect(readFileSync(chapterSummaryPath(root, 1), 'utf-8')).toContain('作者手写')
  })
})

describe('自愈补漏 selfHealRecentChapterSummaries（挂点二）', () => {
  it('近章（N-2/N-1）缺失 → 只为已定稿章补生成；再次调用全 fresh 零产出', async () => {
    const root = makeBook(3, 2) // 章 1/2 已定稿，章 3 未定稿
    const generated = await selfHealRecentChapterSummaries(root, null, DEFAULT_CONFIG, 4)
    // N=4 → 近章 [2, 3]；章 2 已定稿补生成，章 3 未定稿跳过
    expect(generated).toEqual([join('定稿', '摘要', '章摘要', '2.md')])
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

describe('prepare 注入登记（模型可见 ⟺ 已记录，C1 红线）', () => {
  it('章摘要注入剥 fm + injectedSummaryFiles 登记（visible 侧清单）', async () => {
    const root = makeBook(1)
    await generateChapterSummary({ bookRoot: root, userDataPath: null, config: DEFAULT_CONFIG, chapter: 1, bodyAbsPath: bodyOf(root, 1) })
    // rebuild 让摘要进 index.db（生成器自愈路径内部已做；这里独立走 rebuild 同口径）
    const { rebuild } = await import('../../src/cache/rebuild.js')
    rebuild(root, join(root, '.cache', 'index.db'))
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(root, '.cache', 'index.db'))
    try {
      const config = effectiveConfig(root, null)
      const r = prepare(db, config, root, [], undefined, '战斗')
      expect(r.injectedSummaryFiles).toContain(join('定稿', '摘要', '章摘要', '1.md'))
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
