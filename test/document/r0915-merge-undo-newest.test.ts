/**
 * 拍板快断批（2026-09-15，作者指令「按建议顺序开工」取「择最新」档）回归——
 * undo 盘面降级定位 locateMergeByDisk 同章号多条回收站条目按 trashedAt 择最新。
 *
 * 修复前取「第一条」误认领历史软删旧条目（删章→同号重建→再合并→再撤销链：
 * 回收站首条 = 数天前软删的同章号旧章，还原旧文并标撤销成功）。修复后按
 * trashedAt 择最新 = 合并时点的软删条目。
 *
 * 服务级建账（API 造章/软删/合并）+ 直调 undoChapterMerge、userDataPath = null
 * 确定性走盘面降级（事件主路径由 structure-merge.test.ts 覆盖）；旧条目 trashedAt
 * 由测试直改 trash-manifest 回拨到 2000 年，时序差确定性钉死。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { chapterContent, bindStructureHelpers } from '../helpers/structure.js'
import {
  undoChapterMerge,
  type StructureRagPort,
} from '../../src/document/structure.js'
import { DocumentService } from '../../src/document/service.js'

const BOOK = '撤销择最新测试书'
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
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-undo-newest-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-undo-newest-',
    userDataPath,
    dirs: ['写作/正文/第一卷', '写作/正文/第二卷', '工作区'],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: 撤销择最新测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
  })
})

afterAll(async () => {
  await studio.close()
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

/** 旧软删条目 trashedAt 回拨到 2000 年——与合并新条目的时序差确定性钉死。 */
function backdateTrashEntry(bookRoot: string, originalPathSuffix: string): void {
  const p = join(bookRoot, '工作区', '.trash', '.trash-manifest.jsonl')
  const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '')
  const out = lines.map((l) => {
    const e = JSON.parse(l) as { originalPath?: string; trashedAt?: string }
    if (e.originalPath?.endsWith(originalPathSuffix)) {
      return JSON.stringify({ ...e, trashedAt: '2000-01-01T00:00:00.000Z' })
    }
    return l
  })
  writeFileSync(p, out.join('\n') + '\n', 'utf8')
}

async function trashEntries(): Promise<Array<{ id: string; originalPath?: string }>> {
  const r = await studio.req('GET', `/api/books/${encodeURIComponent(BOOK)}/trash`)
  expect(r.status).toBe(200)
  return (r.json as { entries: Array<{ id: string; originalPath?: string }> }).entries ?? []
}

async function deleteDoc(docId: string): Promise<void> {
  const r = await studio.req(
    'DELETE',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(docId)}`,
  )
  expect(r.status).toBe(200)
}

/** 合并干跑 + 施行（helper 化：两用例同链）。 */
async function planAndApply(targetDocId: string, sourceDocId: string): Promise<void> {
  const plan = await studio.req(
    'POST',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(targetDocId)}/structure-plan`,
    { op: 'merge', sourceDocId },
  )
  expect(plan.status).toBe(200)
  const apply = await studio.req(
    'POST',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(targetDocId)}/structure-apply`,
    {
      op: 'merge',
      sourceDocId,
      planHash: (plan.json as { plan: { planHash: string } }).plan.planHash,
    },
  )
  expect(apply.status).toBe(200)
}

describe('拍板快断批 2026-09-15: undo 盘面降级同章号择最新', () => {
  it('旧软删条目（同章号、trashedAt 在前）→ 择最新合并条目还原，旧条目不误认领', async () => {
    const relOld = '写作/正文/第二卷/0041-旧章.md'
    const relTarget = '写作/正文/第一卷/0040-第40章.md'
    const relSource = '写作/正文/第一卷/0041-第41章.md'
    const t = await createChapter(relTarget, chapterContent(40, '第40章', '目标章正文。\n\n第二段。'))
    const old = await createChapter(relOld, chapterContent(41, '旧章', '历史软删章正文。'))
    const s = await createChapter(relSource, chapterContent(41, '第41章', '源章正文。\n\n第二段。'))
    // 历史软删同章号旧章（回收站首条）+ 回拨时戳
    await deleteDoc(old)
    backdateTrashEntry(studio.bookRoot, relOld)
    // 合并 41 → 40（合并产生第二条 41 号回收站条目，trashedAt = 当前）
    await planAndApply(t, s)

    // userDataPath = null：事件副录缺形态，确定性走盘面降级（修复对象）
    const svc = new DocumentService({ bookRoot: studio.bookRoot })
    const r = await undoChapterMerge(studio.bookRoot, svc, null, t, ragStub)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sourceChapterNo).toBe(41)
    // 择最新 = 合并条目（id = 源 docId），非首条旧条目——修复前此处误认领 old
    expect(r.sourceDocId).toBe(s)
    // 源章还原、旧章不复活、旧条目仍在回收站
    expect(existsSync(join(studio.bookRoot, relSource))).toBe(true)
    expect(existsSync(join(studio.bookRoot, relOld))).toBe(false)
    const es = await trashEntries()
    expect(es.some((e) => e.originalPath === relOld)).toBe(true)
    expect(es.some((e) => e.id === s)).toBe(false)
  })

  it('无歧义基线（单条目）：盘面降级正常还原源章', async () => {
    const relTarget = '写作/正文/第一卷/0050-第50章.md'
    const relSource = '写作/正文/第一卷/0051-第51章.md'
    const t = await createChapter(relTarget, chapterContent(50, '第50章', '目标章正文。\n\n第二段。'))
    const s = await createChapter(relSource, chapterContent(51, '第51章', '源章正文。\n\n第二段。'))
    await planAndApply(t, s)

    const svc = new DocumentService({ bookRoot: studio.bookRoot })
    const r = await undoChapterMerge(studio.bookRoot, svc, null, t, ragStub)
    expect(r.ok).toBe(true)
    expect(existsSync(join(studio.bookRoot, relSource))).toBe(true)
  })
})
