/**
 * 0918独立重评修复批（B002）回归：undo 盘面降级定位 locateMergeByDisk 择「最近一次
 * 合并」而非 max(并入)。
 *
 * 修复前降级路径（事件副录缺失，userDataPath null）取 sourceChapterNo = max(并入)——
 * 与事件主路径（最近一条未撤销 structure.merge = 最近一次合并）口径漂移：乱序合并
 * （先并 20 入 10 再并 5 入 10）时 max=20 撤销的是**首并**而非最近并。修复后对齐
 * 0915 拍板「择最新」：候选 = 回收站中章号 ∈ 并入 的条目，按 trashedAt 取最新者
 * 反推源章号（主路径既有用例口径见 merge-undo-newest.test.ts 同章号择最新）。
 *
 * 服务级建账（API 造章/合并）+ 直调 undoChapterMerge、userDataPath = null 确定性走
 * 盘面降级；首并条目 trashedAt 由测试直改 trash-manifest 回拨到 2000 年，时序差
 * 确定性钉死。锚：0918独立重评修复批 B002。
 */
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { chapterContent, bindStructureHelpers } from '../helpers/structure.js'
import { undoChapterMerge, applyChapterMerge, type StructureRagPort } from '../../src/document/structure.js'
import { DocumentService } from '../../src/document/service.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'

const BOOK = '撤销择最近并测试书'
let studio: StudioHarness
let userDataPath = ''

const { createChapter } = bindStructureHelpers({
  studio: () => studio,
  book: BOOK,
  userDataPath: () => userDataPath,
})

const ragStub: StructureRagPort = {
  estimateRagChunkCount: () => 0,
  cleanupRagAfterMerge: () => {},
}

beforeAll(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-undo-latest-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-undo-latest-',
    userDataPath,
    dirs: ['写作/正文/第一卷', '工作区'],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: 撤销择最近并测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
  })
})

afterAll(async () => {
  await studio.close()
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

/** 指定源章条目 trashedAt 回拨到 2000 年——与后并条目的时序差确定性钉死。 */
function backdateTrashEntry(bookRoot: string, originalPathSuffix: string): void {
  const p = join(bookRoot, '工作区', '.trash', '.trash-manifest.jsonl')
  const lines = readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
  const out = lines.map((l) => {
    const e = JSON.parse(l) as { originalPath?: string; trashedAt?: string }
    if (e.originalPath?.endsWith(originalPathSuffix)) {
      return JSON.stringify({ ...e, trashedAt: '2000-01-01T00:00:00.000Z' })
    }
    return l
  })
  writeFileSync(p, out.join('\n') + '\n', 'utf8')
}

/** 合并干跑 + 施行（直调 apply，userDataPath = null：事件副录全程缺形态）。 */
async function planAndApplyDirect(targetDocId: string, sourceDocId: string): Promise<void> {
  const svc = new DocumentService({ bookRoot: studio.bookRoot })
  const plan = await studio.req(
    'POST',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(targetDocId)}/structure-plan`,
    { op: 'merge', sourceDocId },
  )
  expect(plan.status).toBe(200)
  const planHash = (plan.json as { plan: { planHash: string } }).plan.planHash
  const apply = await applyChapterMerge(studio.bookRoot, svc, null, { targetDocId, sourceDocId, planHash }, ragStub)
  expect(apply.ok).toBe(true)
}

// ── 0918独立重评修复批（B002 尾项）①后形态构造工具 ──────────────────────

interface TrashLine {
  id: string
  originalPath?: string
  trashedPath?: string
  trashedAt?: string
}

function readTrashLines(bookRoot: string): TrashLine[] {
  const p = join(bookRoot, '工作区', '.trash', '.trash-manifest.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as TrashLine)
}

/** 摘除指定源章回收站条目（模拟「条目被人工清除」——body 定位的触达形态）。 */
function stripTrashEntry(bookRoot: string, id: string): void {
  const p = join(bookRoot, '工作区', '.trash', '.trash-manifest.jsonl')
  const rest = readTrashLines(bookRoot).filter((e) => e.id !== id)
  writeFileSync(p, rest.map((e) => JSON.stringify(e)).join('\n') + (rest.length ? '\n' : ''), 'utf8')
}

/** ①后形态构造：真合并完成后把源文件放回正文原位 + 清单补登（对齐
 *  structure-crash.test.ts 形态②手法），可选再摘其条目（=①后中断签名）。 */
function restoreSourceToBody(bookRoot: string, sourceDocId: string, sourceRel: string): void {
  const entry = readTrashLines(bookRoot).find((e) => e.id === sourceDocId)
  expect(entry).toBeDefined()
  renameSync(join(bookRoot, entry!.trashedPath!), join(bookRoot, sourceRel))
  const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  upsertEntry(m, { id: sourceDocId, nodeType: 'document', path: sourceRel, parentId: null })
  writeManifest(join(bookRoot, '项目', '文档清单.jsonl'), m)
}

describe('0918独立重评修复批 B002: undo 盘面降级择最近并', () => {
  it('乱序合并（先并 61 入 60 再并 59 入 60）+ 事件缺失 → undo 撤销 59（最近）而非 61（max）', async () => {
    const relTarget = '写作/正文/第一卷/0060-目标章.md'
    const relFirst = '写作/正文/第一卷/0061-先并章.md'
    const relLast = '写作/正文/第一卷/0059-后并章.md'
    const t = await createChapter(relTarget, chapterContent(60, '目标章', '目标章自身正文。\n\n目标章第二段。'))
    const first = await createChapter(relFirst, chapterContent(61, '先并章', '先并章独有正文句子甲。'))
    const last = await createChapter(relLast, chapterContent(59, '后并章', '后并章独有正文句子乙。'))

    // 先并 61 → 60；其回收站条目回拨到 2000 年（时序钉死为「旧」）
    await planAndApplyDirect(t, first)
    backdateTrashEntry(studio.bookRoot, relFirst)
    // 再并 59 → 60（最近一次合并；trashedAt = 当前）
    await planAndApplyDirect(t, last)

    // userDataPath = null：事件主路径缺形态，确定性走盘面降级（修复对象）
    const svc = new DocumentService({ bookRoot: studio.bookRoot })
    const r = await undoChapterMerge(studio.bookRoot, svc, null, t, ragStub)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 择最近并：源章号 = 59（后并），非 max(并入)=61
    expect(r.sourceChapterNo).toBe(59)
    expect(r.sourceDocId).toBe(last)

    // 目标章回滚到「合并 59 之前」的留底（含先并章正文、并入 只剩 61）
    const targetText = readFileSync(join(studio.bookRoot, relTarget), 'utf8')
    expect(targetText).toContain('先并章独有正文句子甲')
    expect(targetText).not.toContain('后并章独有正文句子乙')
    expect(targetText).toContain('并入: [61]')
    // 源章还原（后并章回正文）；先并章保持回收站形态（不在正文）
    expect(existsSync(join(studio.bookRoot, relLast))).toBe(true)
    expect(existsSync(join(studio.bookRoot, relFirst))).toBe(false)
  })

  it('回收站无并入对应条目 → 降级定位返回 null 交上层 NOT_MERGE_STATE（口径不变）', async () => {
    const relTarget = '写作/正文/第一卷/0070-孤目标.md'
    // 手工伪造 并入 登记（回收站无任何对应条目，事件库亦缺形态）
    const t = await createChapter(relTarget, chapterContent(70, '孤目标', '正文。', '并入: [71]\n'))
    const svc = new DocumentService({ bookRoot: studio.bookRoot })
    const r = await undoChapterMerge(studio.bookRoot, svc, null, t, ragStub)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_MERGE_STATE')
  })

  // ── 0918独立重评修复批（B002 尾项）：locateMergeByBody 存活源判定 + 定位前置 ──

  it('乱序合并①后中断（事件缺、当前源无条目、历史源条目在档）→ undo 撤唯一存活源，不再被 disk 历史条目抢先错选', async () => {
    const relTarget = '写作/正文/第一卷/0100-序目标.md'
    const relFirst = '写作/正文/第一卷/0101-序先并章.md'
    const relLast = '写作/正文/第一卷/0099-序后并章.md'
    const t = await createChapter(relTarget, chapterContent(100, '序目标', '序目标自身正文。\n\n第二段。'))
    const first = await createChapter(relFirst, chapterContent(101, '序先并章', '序先并章独有正文句子甲。'))
    const last = await createChapter(relLast, chapterContent(99, '序后并章', '序后并章独有正文句子乙。'))
    // 先并 101（完成，条目在档）→ 再并 99 完整落账后人工放回 + 摘条目 = ①后中断形态
    //（fm 已写 并入 [99,101]、99 存活正文、回收站无 99 条目；101 历史条目保留）
    await planAndApplyDirect(t, first)
    await planAndApplyDirect(t, last)
    restoreSourceToBody(studio.bookRoot, last, relLast)
    stripTrashEntry(studio.bookRoot, last)

    // 修复前路径：body max=101（101 不存活 → null）→ disk 被 101 历史条目抢先 →
    // 静默错撤首并；修复后 body 存活源判定前置 → 撤唯一存活源 99
    const svc = new DocumentService({ bookRoot: studio.bookRoot })
    const r = await undoChapterMerge(studio.bookRoot, svc, null, t, ragStub)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sourceChapterNo).toBe(99)
    expect(r.sourceDocId).toBe(last)
    expect(r.trashEntryId).toBe('') // ①后形态：源章存活正文，还原段跳过
    // 目标章回滚到「并 99 之前」留底（v2：含先并章正文、并入 只剩 101）
    const targetText = readFileSync(join(studio.bookRoot, relTarget), 'utf8')
    expect(targetText).toContain('序先并章独有正文句子甲')
    expect(targetText).not.toContain('序后并章独有正文句子乙')
    expect(targetText).toContain('并入: [101]')
    // 99 保持存活（随后可 apply 重跑幂等续跑收尾——不在本用例）
    expect(existsSync(join(studio.bookRoot, relLast))).toBe(true)
  })

  it('双源均被放回正文且条目清空（歧义态）→ NOT_MERGE_STATE fail-loud，不再静默取首个存活', async () => {
    const relTarget = '写作/正文/第一卷/0110-歧义目标.md'
    const relA = '写作/正文/第一卷/0111-歧义源甲.md'
    const relB = '写作/正文/第一卷/0109-歧义源乙.md'
    const t = await createChapter(relTarget, chapterContent(110, '歧义目标', '目标正文。'))
    const a = await createChapter(relA, chapterContent(111, '歧义源甲', '歧义源甲正文。'))
    const b = await createChapter(relB, chapterContent(109, '歧义源乙', '歧义源乙正文。'))
    await planAndApplyDirect(t, a)
    await planAndApplyDirect(t, b)
    // 双源均放回 + 补登 + 摘条目：并入 [109,111] 双存活且回收站无候选 → 歧义
    restoreSourceToBody(studio.bookRoot, a, relA)
    restoreSourceToBody(studio.bookRoot, b, relB)
    stripTrashEntry(studio.bookRoot, a)
    stripTrashEntry(studio.bookRoot, b)

    const before = readFileSync(join(studio.bookRoot, relTarget), 'utf8')
    const svc = new DocumentService({ bookRoot: studio.bookRoot })
    const r = await undoChapterMerge(studio.bookRoot, svc, null, t, ragStub)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NOT_MERGE_STATE')
    // fail-loud：定位失败发生在任何写入前，盘面零改动
    expect(readFileSync(join(studio.bookRoot, relTarget), 'utf8')).toBe(before)
    expect(existsSync(join(studio.bookRoot, relA))).toBe(true)
    expect(existsSync(join(studio.bookRoot, relB))).toBe(true)
  })
})
