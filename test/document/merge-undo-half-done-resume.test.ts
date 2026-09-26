/**
 * 0918独立重评二轮修复批（B105）：撤销合并半完成态识别续跑回归。
 *
 * 机理：单次合并 undo 走到「①目标已回滚（fm 并入 随内容整体消失）+ ②还原源章失败
 * （OCCUPIED 等）」半完成态后，重试从 undoChapterMerge 函数头进来必死
 * `并入.length === 0` 门报「已撤销」——收尾失败文案承诺的「重试将自动续跑收尾」
 * 不可达，源章滞留回收站只能手工发现（链式合并回滚版本仍含前次 并入 才可过门）。
 *
 * 钉住面：
 * - 半完成态（占位文件顶住原位 → 还原 OCCUPIED 失败）后重试 undo → 识别续跑成功
 *  （目标不再二次回滚、源章还原、事件补录）；此后再次 undo → NOT_MERGE_STATE
 *  （完整撤销后事件在档，防误续跑）；
 * - 「手工摘 并入 键但目标仍是合并后内容」形态 → 版本指纹对不上 → 不误续跑
 *  （NOT_MERGE_STATE，源章仍滞留回收站交作者处置）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { chapterContent, bindStructureHelpers } from '../helpers/structure.js'

const BOOK = '合并撤销续跑测试书'
let studio: StudioHarness
let userDataPath = ''

const { createChapter, structureEvents } = bindStructureHelpers({
  studio: () => studio,
  book: BOOK,
  userDataPath: () => userDataPath,
})

async function planMerge(targetDocId: string, sourceDocId: string): Promise<string> {
  const r = await studio.req(
    'POST',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(targetDocId)}/structure-plan`,
    { op: 'merge', sourceDocId },
  )
  expect(r.status).toBe(200)
  return (r.json as { plan: Record<string, unknown> }).plan['planHash'] as string
}

async function applyMerge(targetDocId: string, sourceDocId: string, planHash: string): Promise<void> {
  const r = await studio.req(
    'POST',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(targetDocId)}/structure-apply`,
    { op: 'merge', sourceDocId, planHash },
  )
  expect(r.status).toBe(200)
}

async function undo(docId: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await studio.req(
    'POST',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(docId)}/merge-undo`,
    {},
  )
  return { status: r.status, json: r.json as Record<string, unknown> }
}

async function trashHas(id: string): Promise<boolean> {
  const r = await studio.req('GET', `/api/books/${encodeURIComponent(BOOK)}/trash`)
  expect(r.status).toBe(200)
  return ((r.json as { entries: Array<{ id: string }> }).entries ?? []).some((e) => e.id === id)
}

beforeAll(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-undo-resume-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-undo-resume-',
    userDataPath,
    dirs: ['写作/正文/第一卷', '工作区'],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: 合并撤销续跑测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
  })
})

afterAll(async () => {
  await studio.close()
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('撤销半完成态识别续跑（B105）', () => {
  it('还原失败（OCCUPIED）半完成态 → 重试识别续跑：源章还原 + 事件补录 + 不再二次回滚', async () => {
    const rel1 = '写作/正文/第一卷/0050-第50章.md'
    const rel2 = '写作/正文/第一卷/0051-第51章.md'
    const before = chapterContent(50, '第50章', '第五十章正文，撤销后应逐字节一致。')
    const srcContent = chapterContent(51, '第51章', '第五十一章正文。')
    const t = await createChapter(rel1, before)
    const s = await createChapter(rel2, srcContent)
    const planHash = await planMerge(t, s)
    await applyMerge(t, s, planHash)
    expect(existsSync(join(studio.bookRoot, rel2))).toBe(false)
    expect(await trashHas(s)).toBe(true)

    // 构造还原失败形态：源章原位被占位文件顶住（内容不同 → 真占用 OCCUPIED）
    writeFileSync(join(studio.bookRoot, rel2), '占位文件（顶住原位，非源章内容）。\n', 'utf8')
    const fail = await undo(t)
    expect(fail.status).toBe(409)
    expect((fail.json as { error: string }).error).toContain('源章还原失败')
    // 半完成态落定：目标已回滚（并入 随内容消失、逐字节 == 合并前）、源章仍在回收站
    expect(readFileSync(join(studio.bookRoot, rel1), 'utf8')).toBe(before)
    expect(await trashHas(s)).toBe(true)

    // 解除占用 → 重试 undo：此前必死「并入 已空」门（修复前红点）——现识别半完成态续跑
    rmSync(join(studio.bookRoot, rel2))
    const resume = await undo(t)
    expect(resume.status).toBe(200)
    expect(resume.json['ok']).toBe(true)
    expect(resume.json['sourceChapterNo']).toBe(51)
    expect(resume.json['sourceDocId']).toBe(s)
    // 源章还原（原路径 + 原内容逐字节），回收站条目出账
    expect(readFileSync(join(studio.bookRoot, rel2), 'utf8')).toBe(srcContent)
    expect(await trashHas(s)).toBe(false)
    // 目标保持已回滚内容（续跑不二次回滚、不重复写）
    expect(readFileSync(join(studio.bookRoot, rel1), 'utf8')).toBe(before)
    // 事件补录：structure.merge-undo 载荷（planHash 与 merge 对应）
    const undoEvs = structureEvents('structure.merge-undo').filter((e) => e.targetDocId === t)
    expect(undoEvs.length).toBe(1)
    expect(undoEvs[0]!['planHash']).toBe(planHash)

    // 完整撤销后再 undo → NOT_MERGE_STATE（merge-undo 事件在档，防误续跑）
    const again = await undo(t)
    expect(again.status).toBe(409)
    expect((again.json as Record<string, unknown>)['code']).toBe('NOT_MERGE_STATE')
  })

  it('手工摘 并入 键但目标仍是合并后内容 → 版本指纹对不上不误续跑（源章仍滞留回收站）', async () => {
    const rel1 = '写作/正文/第一卷/0052-第52章.md'
    const rel2 = '写作/正文/第一卷/0053-第53章.md'
    const srcContent = chapterContent(53, '第53章', '第五十三章正文。')
    const t = await createChapter(rel1, chapterContent(52, '第52章', '第五十二章正文。'))
    const s = await createChapter(rel2, srcContent)
    const planHash = await planMerge(t, s)
    await applyMerge(t, s, planHash)
    expect(await trashHas(s)).toBe(true)

    // 手工摘 并入：目标内容仍是合并后拼接正文，但 fm 无 并入 登记
    writeFileSync(
      join(studio.bookRoot, rel1),
      chapterContent(52, '第52章', '第五十二章正文。\n\n第五十三章正文。'),
      'utf8',
    )
    const r = await undo(t)
    expect(r.status).toBe(409)
    expect((r.json as Record<string, unknown>)['code']).toBe('NOT_MERGE_STATE')
    // fail-closed：不误还原源章（正文已双份含源内容，还原会三份）、回收站条目仍在
    expect(existsSync(join(studio.bookRoot, rel2))).toBe(false)
    expect(await trashHas(s)).toBe(true)
  })
})
