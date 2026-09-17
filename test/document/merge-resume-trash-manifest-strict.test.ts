/**
 * 0918独立重评修复批（B003）回归：合并续跑判定的回收站清单读改 strict。
 *
 * 修复前 applyChapterMerge 入口（②后崩溃形态分流）与 finishMerge（alreadyTrashed
 * 自查）走容错版 listTrash——readTrashManifest 吞瞬态读失败成空表，把「已软删」
 * 误判成「未软删」续跑（R42-7 service.ts 同款口径：容错版只供只读展示面）。修复后
 * 两处改 readTrashManifestStrict，读失败映射既有 WRITE_ERROR（未执行修改，可重试）。
 *
 * 注入形态：vi.mock 局部覆写 readTrashManifestStrict（importOriginal 展开透传真件），
 * 按调用序次可控失败——第 1 次（apply 入口）/ 第 2 次（finishMerge）分址钉死；
 * 'off' 档透传真件验证正常路径行为不变。锚：0918独立重评修复批 B003。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { chapterContent, bindStructureHelpers } from '../helpers/structure.js'
import { applyChapterMerge, type StructureRagPort } from '../../src/document/structure.js'
import { DocumentService } from '../../src/document/service.js'

// 可控失败注入：mode='all' 全部 strict 读失败；'second' 从第 2 次起失败（第 1 次
// 放行使流程推进到 finishMerge 的自查读）；'off' 透传真件
const trashMock = vi.hoisted(() => ({ mode: 'off' as 'off' | 'all' | 'second', calls: 0 }))
vi.mock('../../src/document/trash.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/document/trash.js')>()
  return {
    ...actual,
    readTrashManifestStrict: (bookRoot: string) => {
      trashMock.calls++
      if (trashMock.mode === 'all' || (trashMock.mode === 'second' && trashMock.calls >= 2)) {
        throw new Error(`注入回收站清单读失败（EIO 模拟 #${trashMock.calls}）`)
      }
      return actual.readTrashManifestStrict(bookRoot)
    },
  }
})

const BOOK = '合并续跑strict测试书'
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
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-merge-strict-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-merge-strict-',
    userDataPath,
    dirs: ['写作/正文/第一卷', '工作区'],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: 合并续跑strict测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
  })
})

beforeEach(() => {
  trashMock.mode = 'off'
  trashMock.calls = 0
})

afterAll(async () => {
  await studio.close()
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

function targetText(rel: string): string {
  return readFileSync(join(studio.bookRoot, rel), 'utf8')
}

describe('0918独立重评修复批 B003: 合并续跑判定 trash 清单 strict 读', () => {
  it('apply 入口 strict 读失败 → WRITE_ERROR 拒收，盘面零改动（不误判「未软删」续跑）', async () => {
    const relT = '写作/正文/第一卷/0080-目标章.md'
    const relS = '写作/正文/第一卷/0081-源章.md'
    const t = await createChapter(relT, chapterContent(80, '目标章', '目标章正文。\n\n第二段。'))
    const s = await createChapter(relS, chapterContent(81, '源章', '源章正文原句。'))
    const beforeT = targetText(relT)
    trashMock.mode = 'all'
    const svc = new DocumentService({ bookRoot: studio.bookRoot })
    const r = await applyChapterMerge(studio.bookRoot, svc, null, { targetDocId: t, sourceDocId: s, planHash: '任意（入口即拒）' }, ragStub)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('WRITE_ERROR')
      expect(r.reason).toContain('回收站清单读取失败')
    }
    // 盘面零改动：目标章原文未动、源章未软删（回收站清单未生成条目）
    expect(targetText(relT)).toBe(beforeT)
    expect(existsSync(join(studio.bookRoot, relS))).toBe(true)
  })

  it('①后崩溃形态续跑：finishMerge 自查 strict 读失败 → WRITE_ERROR，源章不被二次处置', async () => {
    const relT = '写作/正文/第一卷/0090-崩溃目标.md'
    const relS = '写作/正文/第一卷/0091-崩溃源章.md'
    const t = await createChapter(relT, chapterContent(90, '崩溃目标', '目标章正文。'))
    const s = await createChapter(relS, chapterContent(91, '崩溃源章', '源章存活正文。'))
    // 构造①后崩溃形态：fm 已写 并入: [91]、源章仍存活正文、回收站空
    writeFileSync(join(studio.bookRoot, relT), chapterContent(90, '崩溃目标', '目标章正文。', '并入: [91]\n'), 'utf8')
    trashMock.mode = 'second' // 第 1 次（apply 入口）放行空清单，第 2 次（finishMerge 自查）失败
    const svc = new DocumentService({ bookRoot: studio.bookRoot })
    const r = await applyChapterMerge(studio.bookRoot, svc, null, { targetDocId: t, sourceDocId: s, planHash: '任意（①后形态跳过指纹复核）' }, ragStub)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('WRITE_ERROR')
      expect(r.reason).toContain('回收站清单读取失败')
    }
    // 未误判「未软删」续跑：源章未被 trashDocument 二次处置，仍在正文原位
    expect(existsSync(join(studio.bookRoot, relS))).toBe(true)
    expect(targetText(relT)).toContain('并入: [91]')
  })

  it('正常路径（strict 透传真件）行为不变：合并照常完成、回收站条目在档', async () => {
    const relT = '写作/正文/第一卷/0095-正常目标.md'
    const relS = '写作/正文/第一卷/0096-正常源章.md'
    const t = await createChapter(relT, chapterContent(95, '正常目标', '目标章正文。'))
    const s = await createChapter(relS, chapterContent(96, '正常源章', '源章正文并入句。'))
    const svc = new DocumentService({ bookRoot: studio.bookRoot })
    const plan = await studio.req(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(t)}/structure-plan`,
      { op: 'merge', sourceDocId: s },
    )
    expect(plan.status).toBe(200)
    const planHash = (plan.json as { plan: { planHash: string } }).plan.planHash
    const r = await applyChapterMerge(studio.bookRoot, svc, null, { targetDocId: t, sourceDocId: s, planHash }, ragStub)
    expect(r.ok).toBe(true)
    // 源章已软删进 .trash（strict 读透传下续跑自查照常）
    expect(existsSync(join(studio.bookRoot, relS))).toBe(false)
    expect(existsSync(join(studio.bookRoot, '工作区', '.trash', '.trash-manifest.jsonl'))).toBe(true)
    expect(targetText(relT)).toContain('源章正文并入句')
  })
})
