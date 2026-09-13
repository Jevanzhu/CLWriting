/**
 * 阶段 24（S3+S4）批 B 回归：合并三端点端点级——structure-plan / structure-apply /
 * merge-undo（src/document/structure.ts 编排 + documents.ts 三路由）。
 *
 * 锁的行为面（执行方案 §四）：
 * - 干跑指纹 TOCTOU：apply 锁前重算比对，干跑后正文变化 → 409 PLAN_STALE；
 * - 定稿章可写：目标/源章 final 均不拦（六态回落到 revision，须重定稿）；
 * - 并入 同笔：目标章 fm 并入 与拼接正文一次原子写（external-merge 强制留底）；
 * - fm 保形：patchFlatFm 只增 并入 行，其余键行（含 _raw/已发布）逐字节保形；
 * - 软删登记：TrashEntry.id = 源 docId，originalPath = 原路径；
 * - 事件副录：structure.merge / structure.merge-undo 载荷（workspace 事件库）；
 * - RAG 清理：源章块成对删 + 目标章指纹失效（best-effort 事务）；
 * - 撤销一键：版本回滚 → 还原源章 → 事件三级（hints / 事件主路径）；
 * - 幂等续跑：①后崩溃半成态（并入 已含源 + 回收站在档 + 源文件复活）重跑收敛
 *   且不二次拼接；S5 口径：fm 已含源 + 源章存活正文 = ①后形态重跑续跑收敛，
 *   源章被人工清理 → 404 NOT_FOUND；
 * - GBK 存量：干跑 encodingSuspect 预警 + apply 400 NOT_UTF8_TARGET（盘上字节不动）。
 *
 * 测试精简批口径：bootStudio 组合 harness；userDataPath 本文件自建自清。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { chapterContent, bindStructureHelpers } from '../helpers/structure.js'
import { openRagDb, storeChunk, setRagMeta, getRagMeta, countChunksByChapter } from '../../src/rag/store.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'

const BOOK = '结构合并测试书'
let studio: StudioHarness
let userDataPath = ''

// 复审-0913-结构 P2-2 收编：三件套 helper 单源（bind 工厂 thunk 延迟取 beforeAll 后的模块态）
const { createChapter, structureEvents } = bindStructureHelpers({
  studio: () => studio,
  book: BOOK,
  userDataPath: () => userDataPath,
})

/** 干跑 → plan 视图（字段断言用）。 */
async function planMerge(targetDocId: string, sourceDocId: string): Promise<Record<string, unknown>> {
  const r = await studio.req(
    'POST',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(targetDocId)}/structure-plan`,
    { op: 'merge', sourceDocId },
  )
  expect(r.status).toBe(200)
  return (r.json as { plan: Record<string, unknown> }).plan
}

async function applyMerge(
  targetDocId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await studio.req(
    'POST',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(targetDocId)}/structure-apply`,
    body,
  )
  return { status: r.status, json: r.json as Record<string, unknown> }
}

async function trashEntries(): Promise<Array<{ id: string; originalPath?: string }>> {
  const r = await studio.req('GET', `/api/books/${encodeURIComponent(BOOK)}/trash`)
  expect(r.status).toBe(200)
  return (r.json as { entries: Array<{ id: string; originalPath?: string }> }).entries ?? []
}

/** GET /tree 递归找 path 节点的六态（status）。 */
async function treeStatus(path: string): Promise<string | undefined> {
  const r = await studio.req('GET', `/api/books/${encodeURIComponent(BOOK)}/tree`)
  expect(r.status).toBe(200)
  const nodes = (r.json as { nodes: Array<{ path: string; status?: string; children: unknown[] }> }).nodes
  const walk = (ns: typeof nodes): { path: string; status?: string } | undefined => {
    for (const n of ns) {
      if (n.path === path) return n
      const hit = walk(n.children as typeof nodes)
      if (hit) return hit
    }
    return undefined
  }
  const node = walk(nodes)
  expect(node, `树中应存在 ${path}`).toBeDefined()
  return node!.status
}

beforeAll(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-struct-merge-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-struct-merge-',
    userDataPath,
    dirs: ['写作/正文/第一卷', '工作区'],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: 结构合并测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
  })
})

afterAll(async () => {
  await studio.close()
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('阶段 24 S3: 合并干跑（structure-plan）', () => {
  it('干跑基本面：视图字段 + 折叠 并入 + 指纹；无 RAG 库时预估 0', async () => {
    const t = await createChapter(
      '写作/正文/第一卷/0001-第1章.md',
      chapterContent(1, '第1章', '目标章正文，第一段完整。\n\n目标章第二段。'),
    )
    const s = await createChapter(
      '写作/正文/第一卷/0002-第2章.md',
      chapterContent(2, '第2章', '源章正文首段，带足够文字。\n\n源章第二段。'),
    )
    const plan = await planMerge(t, s)
    expect(plan['targetChapterNo']).toBe(1)
    expect(plan['sourceChapterNo']).toBe(2)
    expect(plan['targetTitle']).toBe('第1章')
    expect(plan['sourceTitle']).toBe('第2章')
    expect(plan['mergedInto']).toEqual([2])
    expect(plan['encodingSuspect']).toBe(false)
    expect(plan['sourceWords']).toBeGreaterThan(0)
    expect(plan['ragChunksToClear']).toBe(0)
    expect(typeof plan['planHash']).toBe('string')
    expect((plan['planHash'] as string).length).toBeGreaterThan(0)
  })

  it('同章 / 跨卷重号章 → 400 BAD_INPUT', async () => {
    const a = await createChapter('写作/正文/第一卷/0003-第3章.md', chapterContent(3, '第3章', '第三章正文。'))
    const same = await studio.req(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(a)}/structure-plan`,
      { op: 'merge', sourceDocId: a },
    )
    expect(same.status).toBe(400)
    // 跨卷重号：第二卷同章号 3
    const b = await createChapter('写作/正文/第二卷/0003-重号章.md', chapterContent(3, '重号章', '重号章正文。'))
    const dup = await studio.req(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(a)}/structure-plan`,
      { op: 'merge', sourceDocId: b },
    )
    expect(dup.status).toBe(400)
    expect((dup.json as { error: string }).error).toContain('重号')
  })

  it('GBK 存量章：干跑 encodingSuspect 预警；apply 400 NOT_UTF8_TARGET 且盘上字节逐位不变', async () => {
    const rel = '写作/正文/第一卷/0004-GBK章.md'
    const t = await createChapter('写作/正文/第一卷/0005-第5章.md', chapterContent(5, '第5章', '目标章正文。'))
    const s = await createChapter(rel, chapterContent(4, 'GBK章', 'placeholder'))
    // fm 段保持 ASCII（章号可解析），正文换成 GBK 字节（「你好」）——非 UTF-8 存量形态
    const gbk = Buffer.concat([
      Buffer.from('---\n章号: 4\n标题: GBK章\n---\n\n', 'utf8'),
      Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a]),
    ])
    writeFileSync(join(studio.bookRoot, rel), gbk)
    const plan = await planMerge(t, s)
    expect(plan['encodingSuspect']).toBe(true)
    const apply = await applyMerge(t, { op: 'merge', sourceDocId: s, planHash: plan['planHash'] })
    expect(apply.status).toBe(400)
    expect(apply.json['code']).toBe('NOT_UTF8_TARGET')
    // 拒写：盘上字节原样、源章未进回收站
    expect(readFileSync(join(studio.bookRoot, rel))).toEqual(gbk)
    expect(await trashEntries()).toEqual([])
  })
})

describe('阶段 24 S3: 合并执行（structure-apply）', () => {
  it('基本面：并入 与拼接正文同笔落盘 + fm 其余键逐字节保形 + 软删登记 + 事件载荷 + 留底版本', async () => {
    const rel1 = '写作/正文/第一卷/0006-第6章.md'
    const rel2 = '写作/正文/第一卷/0007-第7章.md'
    const body1 = '目标章正文第一段。\n\n目标章第二段。'
    const body2 = '源章正文第一段。\n\n源章第二段。'
    const t = await createChapter(
      rel1,
      chapterContent(6, '第6章', body1, '状态: 草稿\n已发布: 起点中文网\n_raw: \'{"k":1}\'\n'),
    )
    const s = await createChapter(rel2, chapterContent(7, '第7章', body2))
    const plan = await planMerge(t, s)
    const apply = await applyMerge(t, { op: 'merge', sourceDocId: s, planHash: plan['planHash'] })
    expect(apply.status).toBe(200)
    expect(apply.json['ok']).toBe(true)
    expect(apply.json['mergedInto']).toEqual([7])
    expect(apply.json['trashEntryId']).toBe(s)
    expect(typeof apply.json['rollbackSnapshotId']).toBe('string')

    const merged = readFileSync(join(studio.bookRoot, rel1), 'utf8')
    // 拼接规范形：目标 trimEnd + 空行 + 源 trimStart
    expect(merged).toContain(`${body1}\n\n${body2}`)
    // fm 保形：并入 行新增，其余键行逐字节保留
    expect(merged).toContain('并入: [7]')
    for (const line of ['章号: 6', '标题: 第6章', '状态: 草稿', '已发布: 起点中文网', '_raw: \'{"k":1}\'']) {
      expect(merged).toContain(line)
    }
    expect(merged.startsWith('---\n')).toBe(true)
    // 源章软删：正文区消失，回收站在档（id=源 docId，originalPath=原路径）
    expect(existsSync(join(studio.bookRoot, rel2))).toBe(false)
    const entry = (await trashEntries()).find((e) => e.id === s)
    expect(entry).toBeDefined()
    expect(entry!.originalPath).toBe(rel2)
    // 事件副录：structure.merge 载荷
    const evs = structureEvents('structure.merge')
    const ev = evs.find((e) => e.targetDocId === t && e.sourceDocId === s)
    expect(ev).toBeDefined()
    expect(ev!['mergedInto']).toEqual([7])
    expect(ev!['trashEntryId']).toBe(s)
    expect(ev!['targetChapterNo']).toBe(6)
    expect(ev!['sourceChapterNo']).toBe(7)
    expect(ev!['planHash']).toBe(plan['planHash'])
  })

  it('链式折叠单跳化：先并 9 再并 10 → 并入: [9, 10]（不嵌套）', async () => {
    const t = await createChapter('写作/正文/第一卷/0008-第8章.md', chapterContent(8, '第8章', '第八章正文。'))
    const s1 = await createChapter('写作/正文/第一卷/0009-第9章.md', chapterContent(9, '第9章', '第九章正文。'))
    const s2 = await createChapter('写作/正文/第一卷/0010-第10章.md', chapterContent(10, '第10章', '第十章正文。'))
    const p1 = await planMerge(t, s1)
    expect((await applyMerge(t, { op: 'merge', sourceDocId: s1, planHash: p1['planHash'] })).status).toBe(200)
    const p2 = await planMerge(t, s2)
    expect((await applyMerge(t, { op: 'merge', sourceDocId: s2, planHash: p2['planHash'] })).status).toBe(200)
    const merged = readFileSync(join(studio.bookRoot, '写作/正文/第一卷/0008-第8章.md'), 'utf8')
    expect(merged).toContain('并入: [9, 10]')
    expect(merged).not.toContain('并入: [9]\n')
  })

  it('TOCTOU：干跑后目标章被改 → apply 409 PLAN_STALE，盘面不动', async () => {
    const rel1 = '写作/正文/第一卷/0011-第11章.md'
    const t = await createChapter(rel1, chapterContent(11, '第11章', '目标章正文。'))
    const s = await createChapter('写作/正文/第一卷/0012-第12章.md', chapterContent(12, '第12章', '源章正文。'))
    const before = readFileSync(join(studio.bookRoot, rel1), 'utf8')
    const plan = await planMerge(t, s)
    // 干跑确认窗口内他保存（内容变化）
    const after = before + '确认窗口内的新增一行。\n'
    writeFileSync(join(studio.bookRoot, rel1), after, 'utf8')
    const apply = await applyMerge(t, { op: 'merge', sourceDocId: s, planHash: plan['planHash'] })
    expect(apply.status).toBe(409)
    expect(apply.json['code']).toBe('PLAN_STALE')
    // 盘面不动：目标未被并入、源章未软删
    expect(readFileSync(join(studio.bookRoot, rel1), 'utf8')).toBe(after)
    expect(existsSync(join(studio.bookRoot, '写作/正文/第一卷/0012-第12章.md'))).toBe(true)
  })

  it('定稿章可写：目标/源均 final 不拦；目标合并后六态回落 revision（须重定稿）', async () => {
    const rel1 = '写作/正文/第一卷/0013-第13章.md'
    const rel2 = '写作/正文/第一卷/0014-第14章.md'
    const t = await createChapter(rel1, chapterContent(13, '第13章', '第十三章正文。'))
    const s = await createChapter(rel2, chapterContent(14, '第14章', '第十四章正文。'))
    for (const id of [t, s]) {
      const f = await studio.req(
        'POST',
        `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(id)}/finalize`,
      )
      expect(f.status).toBe(200)
    }
    expect(await treeStatus(rel1)).toBe('final')
    const plan = await planMerge(t, s)
    const apply = await applyMerge(t, { op: 'merge', sourceDocId: s, planHash: plan['planHash'] })
    expect(apply.status).toBe(200)
    // 六态回落：哈希与 finalizedRevision 失配 → revision（预期行为，重定稿即回 final）
    expect(await treeStatus(rel1)).toBe('revision')
    expect(existsSync(join(studio.bookRoot, rel2))).toBe(false)
  })

  it('幂等续跑（①后崩溃半成态）：并入 已含源 + 回收站在档 + 源文件复活 → 重跑只收尾不二次拼接', async () => {
    const rel1 = '写作/正文/第一卷/0015-第15章.md'
    const rel2 = '写作/正文/第一卷/0016-第16章.md'
    const srcContent = chapterContent(16, '第16章', '源章正文。')
    const t = await createChapter(rel1, chapterContent(15, '第15章', '目标章正文。'))
    const s = await createChapter(rel2, srcContent)
    const plan = await planMerge(t, s)
    expect((await applyMerge(t, { op: 'merge', sourceDocId: s, planHash: plan['planHash'] })).status).toBe(200)
    const mergedOnce = readFileSync(join(studio.bookRoot, rel1), 'utf8')
    // 构造崩溃半成态（①后、②半途）：①已落定（fm 并入 在）+ trash 登记在账但源章
    // 「未搬走」——源文件放回原路径 + 清单补登源章条目（真合并会摘条目，崩溃点在
    // 摘除之前；doTrash「登记后、搬移/摘账前」中断的镜像）
    writeFileSync(join(studio.bookRoot, rel2), srcContent, 'utf8')
    const mp = join(studio.bookRoot, '项目', '文档清单.jsonl')
    const m = readManifest(mp)
    upsertEntry(m, { id: s, nodeType: 'document', path: rel2, parentId: null })
    writeManifest(mp, m)
    expect((await trashEntries()).some((e) => e.id === s)).toBe(true)

    const resume = await applyMerge(t, { op: 'merge', sourceDocId: s, planHash: plan['planHash'] })
    expect(resume.status).toBe(200)
    expect(resume.json['mergedInto']).toEqual([16])
    // 关键断言：不二次拼接——目标内容与首次合并落定后逐字节一致
    expect(readFileSync(join(studio.bookRoot, rel1), 'utf8')).toBe(mergedOnce)
    // 收尾收敛：源文件再次消失（软删完成）、条目在账、清单条目再摘
    expect(existsSync(join(studio.bookRoot, rel2))).toBe(false)
    expect((await trashEntries()).some((e) => e.id === s)).toBe(true)
    // 续跑也记审计：同对章的 structure.merge 事件补到两条
    const evs = structureEvents('structure.merge').filter((e) => e.targetDocId === t && e.sourceDocId === s)
    expect(evs.length).toBe(2)
  })

  it('S5 口径：fm 已含源 + 源章存活正文（①后崩溃同形态）→ 重跑幂等续跑收敛（不再拒收）', async () => {
    const rel1 = '写作/正文/第一卷/0017-第17章.md'
    const rel2 = '写作/正文/第一卷/0018-第18章.md'
    const srcContent = chapterContent(18, '第18章', '第十八章正文。')
    const t = await createChapter(rel1, chapterContent(17, '第17章', '第十七章正文。'))
    const s = await createChapter(rel2, srcContent)
    const plan = await planMerge(t, s)
    // ①后崩溃同形态：fm 已写 并入（无回收站条目）+ 源章存活正文——S5 起重跑 =
    // 幂等续跑收敛（detectState structurePending 报文指引的路径），不再 409 拒收
    writeFileSync(join(studio.bookRoot, rel1), chapterContent(17, '第17章', '第十七章正文。', '并入: [18]\n'), 'utf8')
    const apply = await applyMerge(t, { op: 'merge', sourceDocId: s, planHash: plan['planHash'] })
    expect(apply.status).toBe(200)
    expect(apply.json['mergedInto']).toEqual([18])
    // 收尾补完：源章软删进回收站、拼接未二次执行（fm 已含 并入，正文保持①落定内容）
    expect(existsSync(join(studio.bookRoot, rel2))).toBe(false)
    expect((await trashEntries()).some((e) => e.id === s)).toBe(true)
  })

  it('人工清理形态：fm 已含源但源章文件被删（清单在册）→ 404 NOT_FOUND（无续跑面）', async () => {
    const rel1 = '写作/正文/第一卷/0031-第31章.md'
    const rel2 = '写作/正文/第一卷/0032-第32章.md'
    const t = await createChapter(rel1, chapterContent(31, '第31章', '第三十一章正文。'))
    const s = await createChapter(rel2, chapterContent(32, '第32章', '第三十二章正文。'))
    const plan = await planMerge(t, s)
    // 人工清理：fm 写 并入 + 源章文件直接删除（清单条目仍在册）——既无回收站条目
    // 可续跑、也无源章可读，收敛只能走版本面板手工恢复或手工改 fm
    writeFileSync(join(studio.bookRoot, rel1), chapterContent(31, '第31章', '第三十一章正文。', '并入: [32]\n'), 'utf8')
    rmSync(join(studio.bookRoot, rel2))
    const apply = await applyMerge(t, { op: 'merge', sourceDocId: s, planHash: plan['planHash'] })
    expect(apply.status).toBe(404)
    expect(apply.json['code']).toBe('NOT_FOUND')
  })
})

describe('阶段 24 S3: 撤销合并（merge-undo）', () => {
  it('事件主路径（恒发 {}）：目标回滚到合并前逐字节 + 源章还原 + 事件 + 再撤销 409', async () => {
    const rel1 = '写作/正文/第一卷/0019-第19章.md'
    const rel2 = '写作/正文/第一卷/0020-第20章.md'
    const srcContent = chapterContent(20, '第20章', '第二十章正文。')
    const before = chapterContent(19, '第19章', '第十九章正文，撤销前后应逐字节一致。')
    const t = await createChapter(rel1, before)
    const s = await createChapter(rel2, srcContent)
    const plan = await planMerge(t, s)
    expect((await applyMerge(t, { op: 'merge', sourceDocId: s, planHash: plan['planHash'] })).status).toBe(200)
    expect(readFileSync(join(studio.bookRoot, rel1), 'utf8')).not.toBe(before)

    const undo = await studio.req(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(t)}/merge-undo`,
      {},
    )
    expect(undo.status).toBe(200)
    const uj = undo.json as Record<string, unknown>
    expect(uj['ok']).toBe(true)
    expect(uj['sourceChapterNo']).toBe(20)
    expect(uj['sourceDocId']).toBe(s)
    // 目标逐字节回滚（fm 并入 随内容整体回滚消失）
    expect(readFileSync(join(studio.bookRoot, rel1), 'utf8')).toBe(before)
    // 源章从回收站还原（原路径 + 原内容），条目出账
    expect(readFileSync(join(studio.bookRoot, rel2), 'utf8')).toBe(srcContent)
    expect((await trashEntries()).some((e) => e.id === s)).toBe(false)
    // 事件副录：structure.merge-undo
    const undoEvs = structureEvents('structure.merge-undo')
    const ev = undoEvs.find((e) => e.targetDocId === t)
    expect(ev).toBeDefined()
    expect(ev!['planHash']).toBe(plan['planHash'])
    // 幂等界：再撤销 → NOT_MERGE_STATE（并入 已摘）
    const again = await studio.req(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(t)}/merge-undo`,
      {},
    )
    expect(again.status).toBe(409)
    expect((again.json as Record<string, unknown>)['code']).toBe('NOT_MERGE_STATE')
  })

  it('hints 路径：apply 响应三 id 透传直用', async () => {
    const rel1 = '写作/正文/第一卷/0021-第21章.md'
    const rel2 = '写作/正文/第一卷/0022-第22章.md'
    const before = chapterContent(21, '第21章', '第二十一章正文。')
    const t = await createChapter(rel1, before)
    const s = await createChapter(rel2, chapterContent(22, '第22章', '第二十二章正文。'))
    const plan = await planMerge(t, s)
    const apply = await applyMerge(t, { op: 'merge', sourceDocId: s, planHash: plan['planHash'] })
    expect(apply.status).toBe(200)
    const undo = await studio.req(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(t)}/merge-undo`,
      {
        sourceDocId: s,
        sourceChapterNo: 22,
        trashEntryId: apply.json['trashEntryId'],
        ...(apply.json['rollbackSnapshotId'] !== undefined
          ? { rollbackSnapshotId: apply.json['rollbackSnapshotId'] }
          : {}),
        planHash: plan['planHash'],
      },
    )
    expect(undo.status).toBe(200)
    expect(readFileSync(join(studio.bookRoot, rel1), 'utf8')).toBe(before)
    expect(existsSync(join(studio.bookRoot, rel2))).toBe(true)
  })

  it('无并入记录的章撤销 → 409 NOT_MERGE_STATE', async () => {
    const t = await createChapter('写作/正文/第一卷/0023-第23章.md', chapterContent(23, '第23章', '第二十三章正文。'))
    const r = await studio.req(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(t)}/merge-undo`,
      {},
    )
    expect(r.status).toBe(409)
    expect((r.json as Record<string, unknown>)['code']).toBe('NOT_MERGE_STATE')
  })
})

describe('阶段 24 S4: 合并的 RAG 清理（best-effort 事务）', () => {
  it('源章块成对删（块+指纹）+ 目标章指纹失效；目标章既有块不清（下轮重建自愈）', async () => {
    const rel1 = '写作/正文/第一卷/0024-第24章.md'
    const rel2 = '写作/正文/第一卷/0025-第25章.md'
    const t = await createChapter(rel1, chapterContent(24, '第24章', '第二十四章正文。'))
    const s = await createChapter(rel2, chapterContent(25, '第25章', '第二十五章正文。'))
    // 预置 RAG 库：源章 2 块 + 目标章 1 块，双侧指纹在档
    const db = openRagDb(studio.bookRoot)
    try {
      const embed = new Float32Array([0.1, 0.2, 0.3])
      storeChunk(db, { 章号: 25, start_offset: 0, end_offset: 10, embedding: embed, model: 'm' })
      storeChunk(db, { 章号: 25, start_offset: 10, end_offset: 20, embedding: embed, model: 'm' })
      storeChunk(db, { 章号: 24, start_offset: 0, end_offset: 10, embedding: embed, model: 'm' })
      setRagMeta(db, 'chapter_hash:25', 'h25')
      setRagMeta(db, 'chapter_hash:24', 'h24')
    } finally {
      db.close()
    }
    // 干跑预估 = 源章块数
    const plan = await planMerge(t, s)
    expect(plan['ragChunksToClear']).toBe(2)
    const apply = await applyMerge(t, { op: 'merge', sourceDocId: s, planHash: plan['planHash'] })
    expect(apply.status).toBe(200)
    const db2 = openRagDb(studio.bookRoot)
    try {
      expect(countChunksByChapter(db2, 25)).toBe(0) // 源章块清
      expect(getRagMeta(db2, 'chapter_hash:25')).toBeNull() // 源章指纹清（成对）
      expect(getRagMeta(db2, 'chapter_hash:24')).toBeNull() // 目标章指纹失效
      expect(countChunksByChapter(db2, 24)).toBe(1) // 目标块不清（指纹失效驱动下轮重嵌）
    } finally {
      db2.close()
    }
  })
})

describe('复审-0913-源码 P2-1: 清单路径防线（safeManifestPath 收口裸 join）', () => {
  it('源章清单 path 被篡改为越界形态 → plan/apply 400 BAD_INPUT', async () => {
    const rel1 = '写作/正文/第一卷/0033-第33章.md'
    const rel2 = '写作/正文/第一卷/0034-第34章.md'
    const t = await createChapter(rel1, chapterContent(33, '第33章', '第三十三章正文。'))
    const s = await createChapter(rel2, chapterContent(34, '第34章', '第三十四章正文。'))
    // 篡改清单（可篡改本地数据面）：越界形态带 写作/正文/ 前缀——BODY_PREFIX 前置
    // 检查与 layoutOf role 判定均拦不住，必须由 safeManifestPath 在裸 join 点拒收
    const mp = join(studio.bookRoot, '项目', '文档清单.jsonl')
    const m = readManifest(mp)
    const entry = m.entries.get(s)
    expect(entry).toBeDefined()
    entry!.path = '写作/正文/../../../任务.md'
    writeManifest(mp, m)
    const plan = await studio.req(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(t)}/structure-plan`,
      { op: 'merge', sourceDocId: s },
    )
    expect(plan.status).toBe(400)
    expect((plan.json as { code: string }).code).toBe('BAD_INPUT')
    const apply = await applyMerge(t, { op: 'merge', sourceDocId: s, planHash: 'x' })
    expect(apply.status).toBe(400)
    expect(apply.json['code']).toBe('BAD_INPUT')
    // 拒收即盘面不动：目标章未被并入
    expect(readFileSync(join(studio.bookRoot, rel1), 'utf8')).toBe(
      chapterContent(33, '第33章', '第三十三章正文。'),
    )
  })

  it('目标章清单 path 越界 → plan 400 BAD_INPUT（正常路径行为由既有用例全绿钉定）', async () => {
    const rel1 = '写作/正文/第一卷/0035-第35章.md'
    const rel2 = '写作/正文/第一卷/0036-第36章.md'
    const t = await createChapter(rel1, chapterContent(35, '第35章', '第三十五章正文。'))
    const s = await createChapter(rel2, chapterContent(36, '第36章', '第三十六章正文。'))
    const mp = join(studio.bookRoot, '项目', '文档清单.jsonl')
    const m = readManifest(mp)
    const entry = m.entries.get(t)
    expect(entry).toBeDefined()
    entry!.path = '写作/正文/../../../越界章.md'
    writeManifest(mp, m)
    const plan = await studio.req(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(t)}/structure-plan`,
      { op: 'merge', sourceDocId: s },
    )
    expect(plan.status).toBe(400)
    expect((plan.json as { code: string }).code).toBe('BAD_INPUT')
  })
})
