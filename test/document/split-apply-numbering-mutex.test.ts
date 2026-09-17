/**
 * 0918独立重评修复批（B001）回归：拆分取号 per-bookRoot 串行互斥。
 *
 * 修复前 applyChapterSplit 的「状态重读→取号→planHash 复核→截断→新章落位」段无
 * 跨请求互斥——两个拆分 apply 并发重叠时各算得同一章号、目标文件名不同，
 * createDocument 双双成功 → 章号复用（「篇号永不复用」被破坏）。修复后临界段整段
 * 置于模块级 per-bookRoot 串行链内：并发第二个 apply 锁内重读取号得新号 →
 * planHash 失配 → PLAN_STALE fail-loud（期望行为），盘面永不出现重复章号。
 *
 * 直调模块函数（绕开 api 层 enqueueStructureOp 串行链——正是无互斥裸露面）；
 * 服务级建账（API 造章）+ planChapterSplit 干跑同基线；userDataPath = null 隔离
 * 事件副录（取号行为与其无关）。锚：0918独立重评修复批 B001。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { chapterContent, bindStructureHelpers } from '../helpers/structure.js'
import { planChapterSplit, applyChapterSplit, type StructureRagPort } from '../../src/document/structure.js'
import { DocumentService } from '../../src/document/service.js'
import { splitFrontMatter, parseFlat } from '../../src/format/frontmatter.js'

const BOOK = '拆分取号互斥测试书'
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
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-split-mutex-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-split-mutex-',
    userDataPath,
    dirs: ['写作/正文/第一卷', '工作区'],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: 拆分取号互斥测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
  })
})

afterAll(async () => {
  await studio.close()
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

/** 直调形态的拆分 apply 入参组装（干跑取指纹）。 */
async function planDirect(docId: string, content: string, marker: string): Promise<{ planHash: string; cursorOffset: number }> {
  const cursorOffset = content.indexOf(marker)
  const plan = await planChapterSplit(studio.bookRoot, new DocumentService({ bookRoot: studio.bookRoot }), docId, cursorOffset)
  if (!plan.ok) throw new Error(`干跑失败：${JSON.stringify(plan)}`)
  return { planHash: plan.planHash, cursorOffset }
}

/** 读全书正文区各章 fm 章号（递归卷目录），断言唯一性用。 */
function chapterNosOnDisk(): Array<{ no: number; file: string }> {
  const root = join(studio.bookRoot, '写作', '正文')
  const out: Array<{ no: number; file: string }> = []
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const fp = join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(fp)
        continue
      }
      if (!ent.name.endsWith('.md')) continue
      const raw = readFileSync(fp, 'utf8')
      const sp = splitFrontMatter(raw)
      if (!sp) continue
      const no = parseFlat(sp.fmRaw).get('章号')
      if (typeof no === 'number') out.push({ no, file: ent.name })
    }
  }
  walk(root)
  return out
}

describe('0918独立重评修复批 B001: 拆分取号并发互斥', () => {
  it('同一书根并发两个 applyChapterSplit（不同源章、同 plan 基线）→ 恰一成功一 PLAN_STALE，盘面无重复章号', async () => {
    const relA = '写作/正文/第一卷/0020-甲章.md'
    const relB = '写作/正文/第一卷/0021-乙章.md'
    const contentA = chapterContent(20, '甲章', '甲章前半段保留。\n\n甲章后半段迁出标记。')
    const contentB = chapterContent(21, '乙章', '乙章前半段保留。\n\n乙章后半段迁出标记。')
    const dA = await createChapter(relA, contentA)
    const dB = await createChapter(relB, contentB)
    // 同基线干跑：两 plan 都在 max=21 时点算出 newChapterNo=22
    const pA = await planDirect(dA, contentA, '甲章后半段迁出标记')
    const pB = await planDirect(dB, contentB, '乙章后半段迁出标记')
    const svc = new DocumentService({ bookRoot: studio.bookRoot })
    const apply = (docId: string, p: { planHash: string; cursorOffset: number }, title: string) =>
      applyChapterSplit(studio.bookRoot, svc, null, { docId, title, cursorOffset: p.cursorOffset, planHash: p.planHash }, ragStub)

    // 并发重叠（Promise.all 同拍入队；互斥使其串行过临界段）
    const [rA, rB] = await Promise.all([apply(dA, pA, '甲拆分新章'), apply(dB, pB, '乙拆分新章')])

    // 期望行为：先过临界段者成功，后者锁内重读（max 已被前者推进）→ PLAN_STALE fail-loud
    const results = [rA, rB]
    const okCount = results.filter((r) => r.ok).length
    expect(okCount).toBe(1)
    for (const r of results) {
      if (!r.ok) expect(r.code).toBe('PLAN_STALE')
    }
    const okResult = results.find((r) => r.ok)!
    if (!('newChapterNo' in okResult)) throw new Error('unreachable')
    expect(okResult.newChapterNo).toBe(22)

    // 盘面断言：全书 fm 章号无重复（双章未产生）
    const onDisk = chapterNosOnDisk()
    const nos = onDisk.map((e) => e.no)
    expect(new Set(nos).size).toBe(nos.length)
    expect(nos.sort((a, b) => a - b)).toEqual([20, 21, 22])
  })

  it('串行重放同 plan（取号基线已被另一次拆分推进）→ 第二个 PLAN_STALE，盘面无重复章号', async () => {
    // 场景：0041 先拆（成功，max 推进到 42）→ 0040 的同基线旧 plan 重放——源章内容
    // 未变（光标仍合法），但锁内重读取号 42→43 → 指纹失配 → PLAN_STALE fail-loud
    const rel40 = '写作/正文/第一卷/0040-丁章.md'
    const rel41 = '写作/正文/第一卷/0041-戊章.md'
    const content40 = chapterContent(40, '丁章', '丁章前半段保留。\n\n丁章后半段迁出标记。')
    const content41 = chapterContent(41, '戊章', '戊章前半段保留。\n\n戊章后半段迁出标记。')
    const d40 = await createChapter(rel40, content40)
    const d41 = await createChapter(rel41, content41)
    const stalePlan = await planDirect(d40, content40, '丁章后半段迁出标记')
    const freshPlan = await planDirect(d41, content41, '戊章后半段迁出标记')
    const svc = new DocumentService({ bookRoot: studio.bookRoot })
    const first = await applyChapterSplit(studio.bookRoot, svc, null, { docId: d41, title: '戊拆分新章', cursorOffset: freshPlan.cursorOffset, planHash: freshPlan.planHash }, ragStub)
    expect(first.ok).toBe(true)
    const replayed = await applyChapterSplit(studio.bookRoot, svc, null, { docId: d40, title: '丁拆分新章', cursorOffset: stalePlan.cursorOffset, planHash: stalePlan.planHash }, ragStub)
    expect(replayed.ok).toBe(false)
    if (!replayed.ok) expect(replayed.code).toBe('PLAN_STALE')
    // 盘面无重复章号（同书累积：含上一用例的 20/21/22）
    const onDisk = chapterNosOnDisk()
    const nos = onDisk.map((e) => e.no)
    expect(new Set(nos).size).toBe(nos.length)
    expect(nos.sort((a, b) => a - b)).toEqual([20, 21, 22, 40, 41, 42])
    expect(existsSync(join(studio.bookRoot, '写作/正文/第一卷/0042-戊拆分新章.md'))).toBe(true)
  })
})
