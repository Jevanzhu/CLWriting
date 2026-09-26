/**
 * 0918独立重评修复批（B005 尾项，主审裁定随批修）回归：定稿章号集认裸数字名。
 *
 * finalizedChapterNumbers 双实现同根盲区收编 chapterNoFromName 单源（isMdFileName
 * 剥 .md 茎后判定）：
 * - structure-core.ts 版（拆分取号 skipFinalized 面）：定稿清单条目「0012.md」此前带
 *   扩展直判失明 → skipFinalized 漏跳 → applyChapterSplit 取号撞定稿章号（篇号永不
 *   复用被破坏）；
 * - manifest.ts 版（state.ts/recap.ts 的 nextChapter 与 assembleStatus currentChapter
 *   的 skip 口径）：原窄正则 `/^(\d+)-/` 同盲区，双实现口径漂移一并收编（R43-13
 *   isSafeInteger 守卫保留，见 manifest.test.ts 既有钉）。
 *
 * 用例形态：定稿条目 0012.md 文件不在盘（定稿章经并入/回收后的既有形态，对齐
 * structure-split.test.ts skipFinalized 用例造态）→ 盘面 max=11，拆分取号须跳过
 * 已定稿的 12 取 13。锚：0918独立重评修复批 B005 尾项。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { chapterContent, bindStructureHelpers } from '../helpers/structure.js'
import { finalizedChapterNumbers } from '../../src/document/structure-core.js'
import {
  readManifest,
  writeManifest,
  upsertEntry,
  finalizedChapterNumbers as finalizedChapterNumbersFromManifest,
} from '../../src/document/manifest.js'

const BOOK = '定稿裸名跳号测试书'
const REL11 = '写作/正文/第一卷/0011-第11章.md'
let studio: StudioHarness
let userDataPath = ''
let d11 = ''

const { createChapter } = bindStructureHelpers({
  studio: () => studio,
  book: BOOK,
  userDataPath: () => userDataPath,
})

beforeAll(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-fin-bare-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-fin-bare-',
    userDataPath,
    dirs: ['写作/正文/第一卷', '工作区'],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: 定稿裸名跳号测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
  })
  // 盘面唯一在盘章 0011（max=11）+ 定稿裸名条目 0012.md（文件不在盘，finalizedRevision 在档）
  d11 = await createChapter(REL11, chapterContent(11, '第11章', '第十一章前半段。\n\n第十一章后半段迁出标记。'))
  const mp = join(studio.bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(mp)
  upsertEntry(m, {
    id: 'doc_bare12',
    nodeType: 'document',
    path: '写作/正文/0012.md',
    parentId: null,
    finalizedRevision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  })
  writeManifest(mp, m)
})

afterAll(async () => {
  await studio.close()
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('0918独立重评修复批 B005 尾项: 定稿章号集认裸数字名', () => {
  it('双实现均把裸数字定稿条目（0012.md）计入章号集（口径一致）', () => {
    // structure-core 版（拆分取号 skipFinalized 面）
    expect(finalizedChapterNumbers(studio.bookRoot).has(12)).toBe(true)
    // manifest 版（state.ts/recap.ts nextChapter 与 assembleStatus 面）
    expect(
      finalizedChapterNumbersFromManifest(readManifest(join(studio.bookRoot, '项目', '文档清单.jsonl'))).has(12),
    ).toBe(true)
  })

  it('拆分取号跳过定稿裸名 12 取 13（plan+apply 全链，落盘 0013 不落 0012）', async () => {
    const content = chapterContent(11, '第11章', '第十一章前半段。\n\n第十一章后半段迁出标记。')
    const cursor = content.indexOf('第十一章后半段迁出标记')
    const plan = await studio.req(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(d11)}/structure-plan`,
      { op: 'split', cursorOffset: cursor },
    )
    expect(plan.status).toBe(200)
    expect((plan.json as { plan: { newChapterNo: number } }).plan.newChapterNo).toBe(13)
    const apply = await studio.req(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(d11)}/structure-apply`,
      {
        op: 'split',
        title: '跳号新章',
        cursorOffset: cursor,
        planHash: (plan.json as { plan: { planHash: string } }).plan.planHash,
      },
    )
    expect(apply.status).toBe(200)
    expect((apply.json as { newChapterNo: number }).newChapterNo).toBe(13)
    expect(existsSync(join(studio.bookRoot, '写作/正文/第一卷/0013-跳号新章.md'))).toBe(true)
    expect(existsSync(join(studio.bookRoot, '写作/正文/第一卷/0012-跳号新章.md'))).toBe(false)
  })
})
