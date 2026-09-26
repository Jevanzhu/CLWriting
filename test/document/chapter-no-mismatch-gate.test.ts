/**
 * 0918三拍板批（B004）回归：结构操作入口章号一致性闸。
 *
 * 现状（拍板改法）：章号两轨口径混用——取号（maxUsedChapter）/违规检测
 *（detectStructureViolations）/定稿集合（finalizedChapterNumbers）按文件名前缀号
 * 派生，fm「章号」只服务被操作章（readChapterState）——作者外部改名后两轨失配，
 * 并入 登记/违规检测/取号互相矛盾（静默重号/错定位）。拍板：结构操作入口全书对账
 * fail-loud（CHAPTER_NO_MISMATCH → HTTP 409），文件名号为正、报文指明修复方向；
 * 存量失配书结构操作被拦须先修书（作者拍板接受）。
 *
 * 断言面（端点级，五入口全覆盖）：
 * ① 健康书零误报——plan merge 200 照常；
 * ② fm ≡ 文件名失配 → 五入口（plan/apply merge、plan/apply split、merge-undo）
 *    全部 409 CHAPTER_NO_MISMATCH，报文含失配文件与修复方向；
 * ③ fm 缺失/无 frontmatter 不拦（杂散占位文件不得堵死 B105 恢复路径；被操作章
 *    自身 readChapterState 已 fail-loud；对账扫描仍登记 fmNo=null 条目）；
 * ④ 无文件名号的 .md 不入闸面（另有命名规范检测面，不在此拦）；
 * ⑤ 单元面：chapterNumberMismatches 返回形态（path 正斜杠相对路径 / nameNo / fmNo）。
 *
 * 独立书根；bootStudio + userDataPath 自建自清；失配盘面用盘上直写构造
 *（闸读盘不读缓存副本，readMdTextCached 指纹缓存变更即重读）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { chapterContent, bindStructureHelpers } from '../helpers/structure.js'
import { chapterNumberMismatches } from '../../src/document/structure-core.js'

const BOOK = '章号一致性闸测试书'
let studio: StudioHarness
let userDataPath = ''

const { createChapter } = bindStructureHelpers({
  studio: () => studio,
  book: BOOK,
  userDataPath: () => userDataPath,
})

/** 直写盘面构造失配（绕过 API——外部改名/手改 fm 正是本闸的目标形态） */
function corruptFm(rel: string, content: string): void {
  writeFileSync(join(studio.bookRoot, rel), content)
}

async function planMerge(
  targetDocId: string,
  sourceDocId: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await studio.req(
    'POST',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(targetDocId)}/structure-plan`,
    { op: 'merge', sourceDocId },
  )
  return { status: r.status, json: r.json as Record<string, unknown> }
}

async function applyMerge(
  targetDocId: string,
  sourceDocId: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await studio.req(
    'POST',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(targetDocId)}/structure-apply`,
    { op: 'merge', targetDocId, sourceDocId, planHash: 'gate-test' },
  )
  return { status: r.status, json: r.json as Record<string, unknown> }
}

async function planSplit(
  docId: string,
  cursorOffset = 999,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await studio.req(
    'POST',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(docId)}/structure-plan`,
    { op: 'split', cursorOffset },
  )
  return { status: r.status, json: r.json as Record<string, unknown> }
}

const planSplitAt = planSplit

async function applySplit(docId: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await studio.req(
    'POST',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(docId)}/structure-apply`,
    { op: 'split', docId, title: '闸测试新章', cursorOffset: 999, planHash: 'gate-test' },
  )
  return { status: r.status, json: r.json as Record<string, unknown> }
}

async function undoMerge(docId: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await studio.req(
    'POST',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(docId)}/merge-undo`,
    {},
  )
  return { status: r.status, json: r.json as Record<string, unknown> }
}

beforeAll(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-chapterno-gate-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-chapterno-gate-',
    userDataPath,
    dirs: ['写作/正文/第一卷', '工作区'],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: 章号一致性闸测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
  })
})

afterAll(async () => {
  await studio.close()
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('B004: 结构操作入口章号一致性闸', () => {
  it('① 健康书零误报：plan merge / plan split 照常 200', async () => {
    const content = chapterContent(1, '第1章', '目标章正文，第一段完整。\n\n目标章第二段。')
    const t = await createChapter('写作/正文/第一卷/0001-第1章.md', content)
    const s = await createChapter(
      '写作/正文/第一卷/0002-第2章.md',
      chapterContent(2, '第2章', '源章正文首段，带足够文字。\n\n源章第二段。'),
    )
    const merge = await planMerge(t, s)
    expect(merge.status).toBe(200)
    // 合法拆分点（正文内、迁出段非空）——健康书闸不拦
    const split = await planSplitAt(t, content.indexOf('目标章第二段'))
    expect(split.status).toBe(200)
  })

  it('② fm ≡ 文件名失配 → 五入口全部 409 CHAPTER_NO_MISMATCH + 修复方向报文', async () => {
    // 直写构造：文件名 0090，fm 章号 7（外部改名未同步 fm 的典型形态）
    corruptFm('写作/正文/第一卷/0090-第90章.md', chapterContent(7, '第90章', '第九十章正文。'))
    const gate = (r: { status: number; json: Record<string, unknown> }): void => {
      expect(r.status).toBe(409)
      expect(r.json['code']).toBe('CHAPTER_NO_MISMATCH')
      expect(String(r.json['error'])).toContain('0090-第90章.md')
      expect(String(r.json['error'])).toContain('文件名号为正')
    }
    gate(await planMerge('doc-a', 'doc-b')) // 闸在 readChapterState 之前，docId 无须真实
    gate(await applyMerge('doc-a', 'doc-b'))
    gate(await planSplit('doc-a'))
    gate(await applySplit('doc-a'))
    gate(await undoMerge('doc-a'))
    // 自洁：fm 改回与文件名一致（后续用例在净盘面上跑）
    corruptFm('写作/正文/第一卷/0090-第90章.md', chapterContent(90, '第90章', '第九十章正文。'))
  })

  it('③ fm 缺失（无 frontmatter）不拦——B105 恢复路径保持可达，被操作章自身 BAD_INPUT 兜底', async () => {
    // 杂散占位文件（B105 还原失败半完成态的典型盘面）不得堵死 undo 续跑
    corruptFm('写作/正文/第一卷/0091-第91章.md', '无 frontmatter 的裸正文\n')
    const m = chapterNumberMismatches(studio.bookRoot)
    const hit = m.find((x) => x.path.endsWith('0091-第91章.md'))
    expect(hit).toBeDefined()
    expect(hit!.nameNo).toBe(91)
    expect(hit!.fmNo).toBeNull()
    // 闸不拦（undo 入口可达；plan 同口径）
    const undo = await undoMerge('doc-a')
    expect(undo.status).not.toBe(409)
    expect((undo.json as Record<string, unknown>)['code']).not.toBe('CHAPTER_NO_MISMATCH')
  })

  it('④ 无文件名号的 .md 不入闸面（不拦命名规范问题）', async () => {
    corruptFm('写作/正文/第一卷/草稿备份.md', chapterContent(5, '草稿', '草稿正文。'))
    const m = chapterNumberMismatches(studio.bookRoot)
    expect(m.find((x) => x.path.endsWith('草稿备份.md'))).toBeUndefined()
  })

  it('⑤ 单元面：失配条目形态（相对路径正斜杠 / nameNo / fmNo 双值）+ 修好后闸消', async () => {
    // 独立构造（②已自洁，此处不留残留）：0092 fm 3
    corruptFm('写作/正文/第一卷/0092-第92章.md', chapterContent(3, '第92章', '第九十二章正文。'))
    const m = chapterNumberMismatches(studio.bookRoot)
    const m92 = m.find((x) => x.path === '写作/正文/第一卷/0092-第92章.md')
    expect(m92).toEqual({ path: '写作/正文/第一卷/0092-第92章.md', nameNo: 92, fmNo: 3 })
    // 修好 fm（改回与文件名一致）→ 该文件出闸面
    corruptFm('写作/正文/第一卷/0092-第92章.md', chapterContent(92, '第92章', '第九十二章正文。'))
    expect(chapterNumberMismatches(studio.bookRoot).find((x) => x.path.endsWith('0092-第92章.md'))).toBeUndefined()
  })
})
