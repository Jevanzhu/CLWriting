/**
 * 阶段 24 S5：崩溃注入两形态 + detectState 结构不变量挂点回归。
 *
 * 崩溃不变量（设计方案 §5.5）：`并入` 所指章不得存活于正文——violation 即合并半成态。
 * 两形态构造：
 * - 形态①（①②间中断）：占源章 save 锁 + 结构锁超时收短 → apply#1 在 trash 段超时
 *   失败，盘面留在「fm 已写并入、源章存活正文、回收站无条目」的确定性窗口（= kill 后
 *   盘面）；detectState 报 structurePending（态 1），随后验证两条既有收敛路径——
 *   apply 重跑幂等续跑收敛 / merge-undo 整体回退收敛（正文盘面定位 + 还原段跳过）。
 * - 形态②（②后崩溃终态）：真合并半途后把源文件放回正文 + 清单补登（scaffoldBook 式
 *   终态构造）→ detectState 报 structurePending → apply 重跑走「回收站条目形态」续跑
 *   收敛（finishMerge 内部 alreadyTrashed 自查跳过二次软删）。
 * 不误报三态对照：正常完成态 / 撤销还原态 / ②后真回收站形态（源文件在 .trash）零
 * structurePending。detectState 直调（绕开 api 层 stateCache），readBookConfig 读盘。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { detectState } from '../../src/state/state.js'
import { readBookConfig } from '../../src/format/yaml.js'
import {
  __setStructSaveLockTimeoutForTest,
} from '../../src/document/service.js'
import { acquireCrossProcessLockWithTimeout } from '../../src/fs/cross-process-lock.js'
import { encodeDocDirName } from '../../src/document/version.js'
import { listTrash } from '../../src/document/trash.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'

const BOOK = '结构崩溃书'
let studio: StudioHarness
let userDataPath = ''

beforeAll(async () => {
  userDataPath = join(await import('node:os').then((m) => m.tmpdir()), `clw-struct-crash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(userDataPath, { recursive: true })
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-struct-crash-',
    userDataPath,
    dirs: ['写作/正文/第一卷', '工作区', '布线'],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 结构崩溃书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
  })
})

afterAll(async () => {
  studio.close()
  const { rmSync } = await import('node:fs')
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
  __setStructSaveLockTimeoutForTest(5_000)
})

const ENC = encodeURIComponent(BOOK)

async function createChapter(rel: string, content: string): Promise<string> {
  const mk = await studio.req('POST', `/api/books/${ENC}/documents`, { relPath: rel, content })
  expect(mk.status).toBe(201)
  return (mk.json as { docId: string }).docId
}

function saveLockPath(docId: string): string {
  return join(studio.bookRoot, '工作区', '.journal', `${encodeDocDirName(docId)}.jsonl.save.lock`)
}

function structureEvents(type: string): Array<Record<string, unknown>> {
  const store = openSessionStore(userDataPath, studio.bookRoot)
  if (!store) return []
  try {
    const out: Array<Record<string, unknown>> = []
    for (const ev of store.iterateEvents(bookHash(studio.bookRoot), undefined, type as never)) {
      out.push(ev.data as Record<string, unknown>)
    }
    return out
  } finally {
    store.close()
  }
}

async function detect(): Promise<Awaited<ReturnType<typeof detectState>>> {
  const parsed = readBookConfig(join(studio.bookRoot, 'book.yaml'))
  if (!parsed.ok) throw new Error(`book.yaml 解析失败：${parsed.error.message}`)
  return detectState(studio.bookRoot, parsed.config)
}

function structurePendingCount(d: Awaited<ReturnType<typeof detect>>): number {
  return d.state === 1 ? d.issues.filter((i) => i.kind === 'structurePending').length : 0
}

/** 占源章 save 锁 + 收短结构锁超时后发起 apply——trash 段超时失败，盘面留在①后形态。 */
async function crashAfterStep1(
  targetDocId: string,
  sourceDocId: string,
  sourceRel: string,
): Promise<void> {
  const planRes = await studio.req(
    'POST',
    `/api/books/${ENC}/documents/${encodeURIComponent(targetDocId)}/structure-plan`,
    { op: 'merge', sourceDocId },
  )
  expect(planRes.status).toBe(200)
  const planHash = (planRes.json as { plan: { planHash: string } }).plan.planHash

  __setStructSaveLockTimeoutForTest(300)
  const release = acquireCrossProcessLockWithTimeout(saveLockPath(sourceDocId), 0)
  expect(release).not.toBeNull()
  try {
    const r1 = await studio.req(
      'POST',
      `/api/books/${ENC}/documents/${encodeURIComponent(targetDocId)}/structure-apply`,
      { op: 'merge', sourceDocId, planHash },
    )
    // trash 段 save 锁等待超时 → fail-closed 信封（目标已并入、源章未进回收站）
    expect(r1.status).toBe(409)
    expect((r1.json as { code: string }).code).toBe('WRITE_ERROR')
    expect(String((r1.json as { error: string }).error)).toContain('源章进回收站失败')
  } finally {
    release!()
  }
  // ①后崩溃盘面：fm 已含 并入、源章存活正文、回收站无条目
  expect(readFileSync(join(studio.bookRoot, sourceRel), 'utf8')).not.toBe('')
  expect(listTrash(studio.bookRoot).some((e) => e.id === sourceDocId)).toBe(false)
}

describe('阶段 24 S5：崩溃注入两形态 + detectState 结构不变量挂点', () => {
  it('形态①：①②间中断 → detectState 态 1 报 structurePending → apply 重跑幂等续跑收敛', async () => {
    const rel1 = '写作/正文/第一卷/0001-第1章.md'
    const rel2 = '写作/正文/第一卷/0002-第2章.md'
    const t = await createChapter(rel1, '---\n章号: 1\n标题: 第1章\n---\n\n第一章正文。\n')
    const s = await createChapter(rel2, '---\n章号: 2\n标题: 第2章\n---\n\n第二章正文。\n')
    await crashAfterStep1(t, s, rel2)

    // 挂点：detectState 态 1 + structurePending 报文含双方章号
    const d1 = await detect()
    expect(d1.state).toBe(1)
    expect(structurePendingCount(d1)).toBe(1)
    const issue = d1.state === 1 ? d1.issues.find((i) => i.kind === 'structurePending') : undefined
    expect(issue?.humanMsg).toContain('第1章')
    expect(issue?.humanMsg).toContain('第 2 章')
    expect(issue?.fix).toContain('并入上一章')

    // 收敛路径 A：apply 重跑（①后形态不查 planHash，同参即可）→ 幂等续跑补完收尾
    __setStructSaveLockTimeoutForTest(5_000)
    const r2 = await studio.req(
      'POST',
      `/api/books/${ENC}/documents/${encodeURIComponent(t)}/structure-apply`,
      { op: 'merge', sourceDocId: s, planHash: 'stale-hash-ignored' },
    )
    expect(r2.status).toBe(200)
    expect((r2.json as { ok: boolean }).ok).toBe(true)
    expect((r2.json as { mergedInto: number[] }).mergedInto).toEqual([2])
    expect(existsSync(join(studio.bookRoot, rel2))).toBe(false) // 源章已软删
    expect(listTrash(studio.bookRoot).some((e) => e.id === s)).toBe(true)
    expect(structureEvents('structure.merge').filter((e) => e.targetDocId === t)).toHaveLength(1)

    // 盘面收敛 → 报文自然消失（非 acknowledge 消解）
    const d2 = await detect()
    expect(structurePendingCount(d2)).toBe(0)
    expect(d2.state).not.toBe(1)
  })

  it('形态①变体：中断后走 undo 整体回退收敛（正文盘面定位 + 还原段跳过 + fm 回滚）', async () => {
    const rel3 = '写作/正文/第一卷/0003-第3章.md'
    const rel4 = '写作/正文/第一卷/0004-第4章.md'
    const before = '---\n章号: 3\n标题: 第3章\n---\n\n第三章正文，回滚后应逐字节一致。\n'
    const srcContent = '---\n章号: 4\n标题: 第4章\n---\n\n第四章正文。\n'
    const t = await createChapter(rel3, before)
    const s = await createChapter(rel4, srcContent)
    await crashAfterStep1(t, s, rel4)
    expect(await detect()).toMatchObject({ state: 1 })
    expect(structurePendingCount(await detect())).toBe(1)

    __setStructSaveLockTimeoutForTest(5_000)
    const undo = await studio.req(
      'POST',
      `/api/books/${ENC}/documents/${encodeURIComponent(t)}/merge-undo`,
      {},
    )
    expect(undo.status).toBe(200)
    const uj = undo.json as Record<string, unknown>
    expect(uj['ok']).toBe(true)
    expect(uj['sourceChapterNo']).toBe(4)
    // 目标章逐字节回滚（fm 并入 摘除）+ 源章原地未动（①后形态无需还原）
    expect(readFileSync(join(studio.bookRoot, rel3), 'utf8')).toBe(before)
    expect(readFileSync(join(studio.bookRoot, rel4), 'utf8')).toBe(srcContent)
    // 共享书：回收站断言只针对本用例源章（前序用例的条目仍在档）
    expect(listTrash(studio.bookRoot).some((e) => e.id === s)).toBe(false)
    expect(structureEvents('structure.merge-undo').filter((e) => e.targetDocId === t)).toHaveLength(1)
    expect(structurePendingCount(await detect())).toBe(0)
  })

  it('形态②：②后崩溃终态（源文件放回正文 + 清单补登）→ detectState 报 → apply 重跑走回收站形态收敛', async () => {
    const rel5 = '写作/正文/第一卷/0005-第5章.md'
    const rel6 = '写作/正文/第一卷/0006-第6章.md'
    const srcContent = '---\n章号: 6\n标题: 第6章\n---\n\n第六章正文。\n'
    const t = await createChapter(rel5, '---\n章号: 5\n标题: 第5章\n---\n\n第五章正文。\n')
    const s = await createChapter(rel6, srcContent)
    const planRes = await studio.req(
      'POST',
      `/api/books/${ENC}/documents/${encodeURIComponent(t)}/structure-plan`,
      { op: 'merge', sourceDocId: s },
    )
    const planHash = (planRes.json as { plan: { planHash: string } }).plan.planHash
    const ok1 = await studio.req(
      'POST',
      `/api/books/${ENC}/documents/${encodeURIComponent(t)}/structure-apply`,
      { op: 'merge', sourceDocId: s, planHash },
    )
    expect(ok1.status).toBe(200)
    expect(structurePendingCount(await detect())).toBe(0) // 正常完成态零报文

    // ②后崩溃终态构造：源文件放回正文原路径 + 清单补登（回收站条目保留在档）
    writeFileSync(join(studio.bookRoot, rel6), srcContent)
    const mp = join(studio.bookRoot, '项目', '文档清单.jsonl')
    const m = readManifest(mp)
    upsertEntry(m, { id: s, nodeType: 'document', path: rel6, parentId: null })
    writeManifest(mp, m)
    expect(structurePendingCount(await detect())).toBe(1) // 并入 所指章存活 = violation

    // apply 重跑 → 回收站条目形态（readChapterState(源) 前的分流）→ alreadyTrashed 跳软删
    const r2 = await studio.req(
      'POST',
      `/api/books/${ENC}/documents/${encodeURIComponent(t)}/structure-apply`,
      { op: 'merge', sourceDocId: s, planHash },
    )
    expect(r2.status).toBe(200)
    expect((r2.json as { ok: boolean }).ok).toBe(true)
    expect((r2.json as { mergedInto: number[] }).mergedInto).toEqual([6])
    expect(existsSync(join(studio.bookRoot, rel6))).toBe(false)
    expect(structureEvents('structure.merge').filter((e) => e.targetDocId === t)).toHaveLength(2)
    expect(structurePendingCount(await detect())).toBe(0)
  })

  it('不误报：撤销还原态 / ②后真回收站形态（源文件在 .trash）/ 零结构书 → 零 structurePending', async () => {
    // 撤销还原态：7/8 正常合并 → undo → 盘面回净，无 并入 无违规
    const rel7 = '写作/正文/第一卷/0007-第7章.md'
    const rel8 = '写作/正文/第一卷/0008-第8章.md'
    const t = await createChapter(rel7, '---\n章号: 7\n标题: 第7章\n---\n\n第七章。\n')
    const s = await createChapter(rel8, '---\n章号: 8\n标题: 第8章\n---\n\n第八章。\n')
    const planRes = await studio.req(
      'POST',
      `/api/books/${ENC}/documents/${encodeURIComponent(t)}/structure-plan`,
      { op: 'merge', sourceDocId: s },
    )
    const planHash = (planRes.json as { plan: { planHash: string } }).plan.planHash
    expect(
      (
        await studio.req(
          'POST',
          `/api/books/${ENC}/documents/${encodeURIComponent(t)}/structure-apply`,
          { op: 'merge', sourceDocId: s, planHash },
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await studio.req('POST', `/api/books/${ENC}/documents/${encodeURIComponent(t)}/merge-undo`, {})
      ).status,
    ).toBe(200)
    // ②后真回收站形态：9/10 合并完成（源文件在 .trash、不在正文）→ 清单条目形态核查
    const rel9 = '写作/正文/第一卷/0009-第9章.md'
    const rel10 = '写作/正文/第一卷/0010-第10章.md'
    const t9 = await createChapter(rel9, '---\n章号: 9\n标题: 第9章\n---\n\n第九章。\n')
    const s10 = await createChapter(rel10, '---\n章号: 10\n标题: 第10章\n---\n\n第十章。\n')
    const p2 = await studio.req(
      'POST',
      `/api/books/${ENC}/documents/${encodeURIComponent(t9)}/structure-plan`,
      { op: 'merge', sourceDocId: s10 },
    )
    expect(
      (
        await studio.req(
          'POST',
          `/api/books/${ENC}/documents/${encodeURIComponent(t9)}/structure-apply`,
          { op: 'merge', sourceDocId: s10, planHash: (p2.json as { plan: { planHash: string } }).plan.planHash },
        )
      ).status,
    ).toBe(200)
    expect(listTrash(studio.bookRoot).some((e) => e.id === s10)).toBe(true)
    // 三态合计：撤销还原 + 完成态源在回收站 + 零结构章 → 全程零误报
    const d = await detect()
    expect(structurePendingCount(d)).toBe(0)
    expect(d.state).not.toBe(1)
  })
})
