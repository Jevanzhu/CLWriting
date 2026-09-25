/**
 * R0916-7-P3-2（2026-09-25 全项目源码质量与优雅度评审 P3-2）：exportBook 拆成阶段管线
 * 后的分段直测——收集（collectExportUnits）/ 过滤（filterFinalizedUnits）/ 编号
 * （orderAndNumberUnits）/ 逐章现读（readUnitBody）/ 备目录（prepareExportLayout）/
 * 写出（writeExportProducts）/ 投稿视图（writeSubmissionView）。
 *
 * 分层：端到端行为（错误信封、流式写、编码防线、归档口径、平台模板）仍由
 * export*.test.ts 各族覆盖；本件只钉阶段单元自身的契约与本文件里显式写下的不变量
 * ——尤其「同名归档 + 序号兜底」两处（上一批刚修的 R0916-7-P3-10 行为，全本与投稿
 * 视图各一处）在此单段直测。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  collectExportUnits,
  filterFinalizedUnits,
  orderAndNumberUnits,
  prepareExportLayout,
  readUnitBody,
  writeExportProducts,
  writeSubmissionView,
} from '../../src/export/index.js'
import type { ExportPlan, ExportRun, ExportUnit } from '../../src/export/index.js'
import { readBookConfig } from '../../src/format/yaml.js'
import { readManifest, upsertEntry, writeManifest } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { computeRevision } from '../../src/document/revision.js'
import { scaffoldBook } from '../helpers/book.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const LONG_CFG = ['spec_version: 1', 'book:', '  title: 分段书', '  genre: 玄幻'].join('\n')
const SHORT_CFG = ['spec_version: 1', 'kind: short', '', 'book:', '  title: 短篇分段', '  genre: 悬疑'].join('\n')

function makeBook(cfg: string, dirs: string[] = ['写作/正文']): string {
  const { root } = scaffoldBook({ name: '分段书', dirs, config: cfg })
  roots.push(root)
  return root
}

/** 写一章正文（fm 可带扩展键），返回相对书根路径 */
function writeChapter(root: string, no: number, title: string, body: string, fmExtra = ''): string {
  const rel = `写作/正文/${String(no).padStart(4, '0')}-${title}.md`
  writeFileSync(join(root, rel), `---\n章号: ${no}\n标题: ${title}\n${fmExtra}---\n\n${body}\n`, 'utf-8')
  return rel
}

/** 把一个正文路径登记为已定稿（manifest 基线） */
function markFinalized(root: string, rel: string): void {
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  mkdirSync(join(root, '项目'), { recursive: true })
  const m = readManifest(manifestPath)
  upsertEntry(m, {
    id: generateDocId(),
    nodeType: 'document',
    path: rel,
    parentId: null,
    finalizedRevision: computeRevision(join(root, rel)),
    finalizedAt: new Date().toISOString(),
  })
  writeManifest(manifestPath, m)
}

const unit = (num: number, title: string, path: string, sortKey = num, published = false): ExportUnit => ({
  num,
  title,
  path,
  sortKey,
  published,
})

describe('R0916-7-P3-2 阶段一·收集（collectExportUnits）', () => {
  it('缺正文区 / 空正文区 → 同一文案「没有定稿正文可导出。」', () => {
    const noBody = makeBook(LONG_CFG, [])
    expect(collectExportUnits(noBody, [])).toEqual({ ok: false, error: '没有定稿正文可导出。' })
    const empty = makeBook(LONG_CFG)
    expect(collectExportUnits(empty, [])).toEqual({ ok: false, error: '没有定稿正文可导出。' })
  })

  it('单元带出章号/标题/路径/sortKey（序 ?? 章号）/published（fm 已发布）', () => {
    const root = makeBook(LONG_CFG)
    writeChapter(root, 1, '甲', '正文甲')
    writeChapter(root, 4, '丁', '正文丁', '序: 2.5\n已发布: true\n')
    const r = collectExportUnits(root, [])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.units.map((u) => [u.num, u.title, u.sortKey, u.published])).toEqual([
      [1, '甲', 1, false],
      [4, '丁', 2.5, true],
    ])
    expect(r.value.units[0]!.path.endsWith(join('写作', '正文', '0001-甲.md'))).toBe(true)
  })

  it('坏 fm 章：记 warnings 且零可导章时按解析失败收口（错误文案含逐章留痕）', () => {
    const root = makeBook(LONG_CFG)
    writeFileSync(join(root, '写作', '正文', '0001-坏.md'), '---\n章号: 1\n标题: 坏\n\n未闭合 fm 的正文\n', 'utf-8')
    const warnings: string[] = []
    const r = collectExportUnits(root, warnings)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.startsWith('章解析失败：')).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('0001-坏.md')
  })
})

describe('R0916-7-P3-2 阶段二·过滤（filterFinalizedUnits）', () => {
  it('清单缺失 → skipped-no-manifest：不过滤（宁多勿漏），skippedDrafts=0', () => {
    const root = makeBook(LONG_CFG)
    writeChapter(root, 1, '甲', '正文甲')
    const { units } = (() => {
      const r = collectExportUnits(root, [])
      if (!r.ok) throw new Error('收集失败')
      return r.value
    })()
    const out = filterFinalizedUnits(root, units)
    expect(out.finalizedPaths).toBeNull()
    expect(out.finalizedFilter).toBe('skipped-no-manifest')
    expect(out.filtered).toEqual(units)
    expect(out.skippedDrafts).toBe(0)
  })

  it('清单在位 → applied：未登记定稿的章被滤掉并计入 skippedDrafts', () => {
    const root = makeBook(LONG_CFG)
    const rel1 = writeChapter(root, 1, '甲', '正文甲')
    writeChapter(root, 2, '乙', '正文乙')
    markFinalized(root, rel1)
    const r = collectExportUnits(root, [])
    if (!r.ok) throw new Error('收集失败')
    const out = filterFinalizedUnits(root, r.value.units)
    expect(out.finalizedFilter).toBe('applied')
    expect(out.filtered.map((u) => u.num)).toEqual([1])
    expect(out.skippedDrafts).toBe(1)
  })
})

describe('R0916-7-P3-2 阶段三·编号（orderAndNumberUnits，表驱动）', () => {
  const mk = (rows: Array<[number, number, boolean]>, path = '/x.md'): ExportUnit[] =>
    rows.map(([num, sortKey, published]) => unit(num, `章${num}`, path, sortKey, published))

  it('排序键：按 sortKey 数值（tie 章号）重排，编号按排序后序位', () => {
    const list = mk([
      [2, 2, false],
      [1, 1, false],
      [5, 1.5, false],
    ])
    orderAndNumberUnits(list)
    expect(list.map((u) => u.num)).toEqual([1, 5, 2])
    expect(list.map((u) => u.displayNum)).toEqual([1, 2, 3])
  })

  it('章号空洞（合并留洞）在未发布段闭合成连续呈现号', () => {
    const list = mk([
      [1, 1, false],
      [2, 2, false],
      [4, 4, false],
    ])
    orderAndNumberUnits(list)
    expect(list.map((u) => u.displayNum)).toEqual([1, 2, 3])
  })

  it('D7 分流：已发布章固定本地章号；未发布段从「已发布最大章号+1」按序位连续编', () => {
    const list = mk([
      [1, 1, true],
      [6, 4.5, false],
      [3, 3, true],
      [5, 5.5, false],
    ])
    orderAndNumberUnits(list)
    expect(list.map((u) => [u.num, u.displayNum])).toEqual([
      [1, 1],
      [3, 3],
      [6, 4], // 已发布最大章号 3 → 未发布段从 4 起
      [5, 5],
    ])
  })

  it('全无已发布章 → 从 1 连续编（旧书零漂移）；全已发布 → displayNum ≡ num', () => {
    const allDraft = mk([
      [3, 3, false],
      [7, 7, false],
    ])
    orderAndNumberUnits(allDraft)
    expect(allDraft.map((u) => u.displayNum)).toEqual([1, 2])
    const allPub = mk([
      [3, 3, true],
      [7, 7, true],
    ])
    orderAndNumberUnits(allPub)
    expect(allPub.map((u) => u.displayNum)).toEqual([3, 7])
  })
})

describe('R0916-7-P3-2 逐章现读（readUnitBody）', () => {
  it('正常章 → 返回正文（剥 fm）；缺失/非 UTF-8/全空白 → 记 warning 并返 null', () => {
    const root = makeBook(LONG_CFG)
    const rel = writeChapter(root, 1, '甲', '正常正文。')
    const warnings: string[] = []
    expect(readUnitBody(root, unit(1, '甲', join(root, rel)), warnings)).toContain('正常正文。')
    expect(warnings).toEqual([])
    // 文件缺失
    expect(readUnitBody(root, unit(9, '缺', join(root, '写作', '正文', '0009-缺.md')), warnings)).toBeNull()
    expect(warnings.at(-1)).toContain('正文读取失败')
    // 非 UTF-8（GBK 字节）
    const gbk = join(root, '写作', '正文', '0010-gbk.md')
    writeFileSync(gbk, Buffer.concat([Buffer.from('---\n章号: 10\n标题: gbk\n---\n', 'utf-8'), Buffer.from([0xc7, 0xeb, 0xb4, 0xcb])]))
    expect(readUnitBody(root, unit(10, 'gbk', gbk), warnings)).toBeNull()
    expect(warnings.at(-1)).toContain('不是 UTF-8')
    // 全空白正文（trim 口径）
    const blank = writeChapter(root, 11, '空', '   \n\n  ')
    expect(readUnitBody(root, unit(11, '空', join(root, blank)), warnings)).toBeNull()
    expect(warnings.at(-1)).toContain('正文为空')
  })
})

describe('R0916-7-P3-2 阶段四·备目录（prepareExportLayout）', () => {
  const layoutArgs = (root: string, warnings: string[]) => ({
    bookRoot: root,
    bookTitle: '分段书',
    doMerged: true,
    doSplit: true,
    warnings,
  })

  it('新书：建导出目录 + 分章目录，给出全本名与分章目录名', () => {
    const root = makeBook(LONG_CFG)
    const r = prepareExportLayout(layoutArgs(root, []))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.mergedFileName).toBe('全本-分段书.md')
    expect(r.value.splitTargetDirName).toBe('分章')
    expect(existsSync(join(root, '工作区', '导出'))).toBe(true)
    expect(existsSync(join(root, '工作区', '导出', '分章'))).toBe(true)
  })

  it('清旧：同前缀其它名的旧全本被归档进 .旧版/（本次同名不在此步动）', () => {
    const root = makeBook(LONG_CFG)
    const exportDir = join(root, '工作区', '导出')
    mkdirSync(exportDir, { recursive: true })
    writeFileSync(join(exportDir, '全本-分段书.md'), '# 手改同名稿', 'utf-8')
    writeFileSync(join(exportDir, '全本-旧书名.md'), '# 旧书名稿', 'utf-8')
    const warnings: string[] = []
    const r = prepareExportLayout(layoutArgs(root, warnings))
    expect(r.ok).toBe(true)
    expect(readFileSync(join(exportDir, '全本-分段书.md'), 'utf-8')).toBe('# 手改同名稿') // 当前同名留给写出段
    expect(existsSync(join(exportDir, '.旧版', '全本-旧书名.md'))).toBe(true)
    expect(warnings).toEqual([])
  })

  it('分章目录归档失败（.旧版 被普通文件占住）→ 本次产物写「分章-2」，原目录原位保留', () => {
    const root = makeBook(LONG_CFG)
    const exportDir = join(root, '工作区', '导出')
    mkdirSync(join(exportDir, '分章'), { recursive: true })
    writeFileSync(join(exportDir, '分章', '0001-手改.md'), '# 作者手改的分章稿', 'utf-8')
    writeFileSync(join(exportDir, '.旧版'), '占位普通文件', 'utf-8')
    const warnings: string[] = []
    const r = prepareExportLayout(layoutArgs(root, warnings))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.splitTargetDirName).toBe('分章-2')
    expect(existsSync(join(exportDir, '分章', '0001-手改.md'))).toBe(true) // 不覆写原目录
    expect(existsSync(join(exportDir, '分章-2'))).toBe(true)
    expect(warnings.some((w) => w.includes('分章目录归档失败'))).toBe(true)
  })
})

describe('R0916-7-P3-2 阶段五·写出（writeExportProducts）', () => {
  function stage(root: string): { run: ExportRun; plan: ExportPlan; warnings: string[] } {
    writeChapter(root, 1, '甲', '正文甲')
    writeChapter(root, 2, '乙', '正文乙')
    const warnings: string[] = []
    const layout = prepareExportLayout({ bookRoot: root, bookTitle: '分段书', doMerged: true, doSplit: true, warnings })
    if (!layout.ok) throw new Error('备目录失败')
    const filtered = [1, 2].map((n) => unit(n, n === 1 ? '甲' : '乙', join(root, '写作', '正文', `000${n}-${n === 1 ? '甲' : '乙'}.md`)))
    for (const [i, u] of filtered.entries()) u.displayNum = i + 1
    const run: ExportRun = {
      bookRoot: root,
      warnings,
      files: [],
      writtenCount: 0,
      writtenNums: new Set<number>(),
    }
    return { run, plan: { ...layout.value, filtered }, warnings }
  }

  it('merged+split：全本名在 files 首位、分章逐条登记，章号集与计数如实', () => {
    const root = makeBook(LONG_CFG)
    const { run, plan } = stage(root)
    expect(writeExportProducts(run, plan)).toEqual({ ok: true, value: null })
    expect(run.writtenCount).toBe(2)
    expect([...run.writtenNums].sort()).toEqual([1, 2])
    expect(run.files).toEqual([
      '工作区/导出/全本-分段书.md',
      '工作区/导出/分章/0001-甲.md',
      '工作区/导出/分章/0002-乙.md',
    ])
    const merged = readFileSync(join(plan.exportDir, '全本-分段书.md'), 'utf-8')
    expect(merged).toContain('# 甲')
    expect(merged).toContain('\n\n---\n\n')
    expect(run.warnings).toEqual([])
  })

  it('R0916-7-P3-10（锚）：同名全本归档不下 → 本次改序号兜底名，手改稿原位保留', () => {
    const root = makeBook(LONG_CFG)
    const { run, plan } = stage(root)
    const exportDir = plan.exportDir
    writeFileSync(join(exportDir, '全本-分段书.md'), '# 手改全本', 'utf-8')
    writeFileSync(join(exportDir, '.旧版'), '占位普通文件', 'utf-8')
    const r = writeExportProducts(run, plan)
    expect(r.ok).toBe(true)
    // 计划里的全本名就地改写为兜底名（写出段内唯一改写点）
    expect(plan.mergedFileName).toBe('全本-分段书-2.md')
    expect(readFileSync(join(exportDir, '全本-分段书.md'), 'utf-8')).toBe('# 手改全本')
    expect(readFileSync(join(exportDir, '全本-分段书-2.md'), 'utf-8')).toContain('# 甲')
    expect(run.files[0]).toBe('工作区/导出/全本-分段书-2.md')
    expect(run.warnings.some((w) => w.includes('归档失败'))).toBe(true)
    expect(run.warnings.some((w) => w.includes('全本-分段书-2.md') && w.includes('不覆写'))).toBe(true)
  })

  it('单章读取失败（缺失）跳过：不计入章数与章号集，产物无该章', () => {
    const root = makeBook(LONG_CFG)
    const { run, plan } = stage(root)
    plan.filtered[1]!.path = join(root, '写作', '正文', '不存在.md')
    expect(writeExportProducts(run, plan)).toEqual({ ok: true, value: null })
    expect(run.writtenCount).toBe(1)
    expect([...run.writtenNums]).toEqual([1])
    expect(existsSync(join(plan.exportDir, '分章', '0002-乙.md'))).toBe(false)
    expect(run.warnings.some((w) => w.includes('正文读取失败'))).toBe(true)
  })
})

describe('R0916-7-P3-2 阶段六·投稿视图（writeSubmissionView）', () => {
  function viewArgs(root: string, warnings: string[], files: string[]) {
    writeChapter(root, 1, '甲', '正文甲')
    const cfg = readBookConfig(join(root, 'book.yaml'))
    return {
      bookRoot: root,
      exportDir: join(root, '工作区', '导出'),
      cfg,
      bookTitle: '短篇分段',
      platform: 'generic' as const,
      writtenNums: new Set([1]),
      warnings,
      files,
    }
  }

  it('generic：写「投稿视图-<书名>.md」并登记产物', () => {
    const root = makeBook(SHORT_CFG)
    const warnings: string[] = []
    const files: string[] = []
    mkdirSync(join(root, '工作区', '导出'), { recursive: true })
    expect(writeSubmissionView(viewArgs(root, warnings, files))).toEqual({ ok: true, value: null })
    expect(files).toEqual(['工作区/导出/投稿视图-短篇分段.md'])
    expect(readFileSync(join(root, '工作区', '导出', '投稿视图-短篇分段.md'), 'utf-8')).toContain('甲')
    expect(warnings).toEqual([])
  })

  it('R0916-7-P3-10（锚·短篇侧）：同名投稿视图归档不下 → 改序号兜底名，手改稿原位保留', () => {
    const root = makeBook(SHORT_CFG)
    const warnings: string[] = []
    const files: string[] = []
    const exportDir = join(root, '工作区', '导出')
    mkdirSync(exportDir, { recursive: true })
    const args = viewArgs(root, warnings, files)
    writeFileSync(join(exportDir, '投稿视图-短篇分段.md'), '# 手改投稿稿', 'utf-8')
    writeFileSync(join(exportDir, '.旧版'), '占位普通文件', 'utf-8')
    expect(writeSubmissionView(args)).toEqual({ ok: true, value: null })
    expect(readFileSync(join(exportDir, '投稿视图-短篇分段.md'), 'utf-8')).toBe('# 手改投稿稿')
    expect(files).toEqual(['工作区/导出/投稿视图-短篇分段-2.md'])
    expect(warnings.some((w) => w.includes('不覆写'))).toBe(true)
  })
})
