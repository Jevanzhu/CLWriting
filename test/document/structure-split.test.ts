/**
 * 阶段 24（S4）批 B 回归：拆分端点级——structure-plan / structure-apply 的 op=split
 * （src/document/structure.ts planChapterSplit / applyChapterSplit）。
 *
 * 锁的行为面（执行方案 §四）：
 * - 取号：新章号 = 全书 max+1（含 并入 在档源章号）再跳已定稿章号（篇号永不复用）；
 * - 序中值：新章显示序 = 拆分点两侧有效序中值；末章拆分 +0.5；
 * - 光标校验：拆分点须落正文内且迁出段非空（fm 内/文末/尾随空白 → 400）；
 * - 截断留版本：原章 external-merge 强制留底（截断前全文可回）；
 * - 标题必填（400，不静默兜底）；已发布章提示不硬拦（publishedWarning）；
 * - TOCTOU：干跑指纹失配 → 409 PLAN_STALE；
 * - RAG 指纹失效：原章 chapter_hash 清（下轮 buildIndex 重嵌两章）；
 * - 事件副录：structure.split 载荷；
 * - GBK 存量：apply 400 NOT_UTF8_TARGET（盘上字节不动）。
 *
 * 独立书根（与 structure-merge.test.ts 互不干扰）；bootStudio + userDataPath 自建自清。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { chapterContent, bindStructureHelpers } from '../helpers/structure.js'
import { openRagDb, setRagMeta, getRagMeta } from '../../src/rag/store.js'

const BOOK = '结构拆分测试书'
let studio: StudioHarness
let userDataPath = ''

// 复审-0913-结构 P2-2 收编：三件套 helper 单源（bind 工厂 thunk 延迟取 beforeAll 后的模块态）
const { createChapter, structureEvents } = bindStructureHelpers({
  studio: () => studio,
  book: BOOK,
  userDataPath: () => userDataPath,
})

async function planSplit(
  docId: string,
  cursorOffset: number,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await studio.req(
    'POST',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(docId)}/structure-plan`,
    { op: 'split', cursorOffset },
  )
  return { status: r.status, json: r.json as Record<string, unknown> }
}

async function applySplit(
  docId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await studio.req(
    'POST',
    `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(docId)}/structure-apply`,
    body,
  )
  return { status: r.status, json: r.json as Record<string, unknown> }
}

beforeAll(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-struct-split-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-struct-split-',
    userDataPath,
    dirs: ['写作/正文/第一卷', '工作区'],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: 结构拆分测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
  })
})

afterAll(async () => {
  await studio.close()
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('阶段 24 S4: 拆分干跑（structure-plan op=split）', () => {
  it('基本面：max+1 取号 + 末章序 +0.5 + 双侧字数 + 预览 + 指纹', async () => {
    const content = chapterContent(1, '第1章', '第一章前半段正文，光标前保留。\n\n第二段标记开头，光标后迁出。')
    const d = await createChapter('写作/正文/第一卷/0001-第1章.md', content)
    const cursor = content.indexOf('第二段标记')
    const plan = await planSplit(d, cursor)
    expect(plan.status).toBe(200)
    const p = plan.json['plan'] as Record<string, unknown>
    expect(p['chapterNo']).toBe(1)
    expect(p['newChapterNo']).toBe(2) // max=1 → 2；无定稿不跳
    expect(p['order']).toBe(1.5) // 末章拆分：序缺省=章号 1 → +0.5
    expect(p['headWords']).toBeGreaterThan(0)
    expect(p['tailWords']).toBeGreaterThan(0)
    expect(String(p['tailPreview'])).toContain('第二段标记')
    expect(p['publishedWarning']).toBe(false)
    expect(typeof p['planHash']).toBe('string')
  })

  it('光标校验：fm 内 / 文末 / 尾随空白 → 400 BAD_INPUT', async () => {
    const content = chapterContent(2, '第2章', '第二章正文一段。\n\n第二章第二段。\n')
    const d = await createChapter('写作/正文/第一卷/0002-第2章.md', content)
    const inFm = await planSplit(d, 5)
    expect(inFm.status).toBe(400)
    const atEnd = await planSplit(d, content.length)
    expect(atEnd.status).toBe(400)
    const atTrailing = await planSplit(d, content.length - 1) // 最后一个 \n 前：迁出段全空白
    expect(atTrailing.status).toBe(400)
    expect((atTrailing.json as { error: string }).error).toContain('正文内容')
  })
})

describe('阶段 24 S4: 拆分执行（structure-apply op=split）', () => {
  it('基本面：原章截断逐字节 + 新章落位（同卷/补零/序 fm）+ 事件 + RAG 指纹失效 + 截断留版本', async () => {
    const rel = '写作/正文/第一卷/0003-第3章.md'
    const headBody = '第三章前半段，保留在原章。'
    const tailBody = '第三章后半段标记，迁出到新章。'
    const content = chapterContent(3, '第3章', `${headBody}\n\n${tailBody}\n`)
    const d = await createChapter(rel, content)
    const cursor = content.indexOf(tailBody)
    // 预置 RAG 指纹（原章已索引形态）
    const db = openRagDb(studio.bookRoot)
    try {
      setRagMeta(db, 'chapter_hash:3', 'h3')
    } finally {
      db.close()
    }
    const plan = await planSplit(d, cursor)
    expect(plan.status).toBe(200)
    const apply = await applySplit(d, {
      op: 'split',
      title: '新章标题',
      cursorOffset: cursor,
      planHash: (plan.json['plan'] as Record<string, unknown>)['planHash'],
    })
    expect(apply.status).toBe(200)
    expect(apply.json['ok']).toBe(true)
    expect(apply.json['originChapterNo']).toBe(3)
    expect(apply.json['newChapterNo']).toBe(4)
    expect(typeof apply.json['newDocId']).toBe('string')

    // 原章截断：slice(0,cursor).trimEnd() + '\n' 逐字节
    const head = readFileSync(join(studio.bookRoot, rel), 'utf8')
    expect(head).toBe(`---\n章号: 3\n标题: 第3章\n---\n\n${headBody}\n`)
    // 新章落位：同目录、4 位补零、fm 章号/标题/序（末章 3 → 3.5）
    const newRel = '写作/正文/第一卷/0004-新章标题.md'
    expect(existsSync(join(studio.bookRoot, newRel))).toBe(true)
    const fresh = readFileSync(join(studio.bookRoot, newRel), 'utf8')
    expect(fresh).toBe(`---\n章号: 4\n标题: 新章标题\n序: 3.5\n---\n${tailBody}\n`)
    // 事件副录：structure.split 载荷
    const ev = structureEvents('structure.split').find((e) => e.docId === d)
    expect(ev).toBeDefined()
    expect(ev!['newDocId']).toBe(apply.json['newDocId'])
    expect(ev!['originChapterNo']).toBe(3)
    expect(ev!['newChapterNo']).toBe(4)
    expect(ev!['order']).toBe(3.5)
    expect(ev!['title']).toBe('新章标题')
    // RAG 指纹失效（原章内容已变，下轮重嵌两章）
    const db2 = openRagDb(studio.bookRoot)
    try {
      expect(getRagMeta(db2, 'chapter_hash:3')).toBeNull()
    } finally {
      db2.close()
    }
    // 截断留版本：原章 external-merge 强制留底（截断前全文可回）
    expect(readdirSync(join(studio.bookRoot, '工作区', '.版本', d)).length).toBeGreaterThan(0)
  })

  it('标题必填：空 / 空白 / 缺失 → 400', async () => {
    const content = chapterContent(5, '第5章', '第五章前半。\n\n第五章后半。')
    const d = await createChapter('写作/正文/第一卷/0005-第5章.md', content)
    const cursor = content.indexOf('第五章后半')
    const plan = await planSplit(d, cursor)
    expect(plan.status).toBe(200)
    const planHash = (plan.json['plan'] as Record<string, unknown>)['planHash']
    for (const title of ['', '   ']) {
      const r = await applySplit(d, { op: 'split', title, cursorOffset: cursor, planHash })
      expect(r.status).toBe(400)
      expect(r.json['code']).toBe('BAD_INPUT')
    }
    const missing = await applySplit(d, { op: 'split', cursorOffset: cursor, planHash })
    expect(missing.status).toBe(400)
    expect(existsSync(join(studio.bookRoot, '写作/正文/第一卷/0005-第5章.md'))).toBe(true)
  })

  it('cursorOffset 缺失 / 非整数 / 负数 → 400（端点参数校验）', async () => {
    const d = await createChapter('写作/正文/第一卷/0006-第6章.md', chapterContent(6, '第6章', '第六章正文一段。\n\n第六章第二段。'))
    for (const cursorOffset of [undefined, 1.5, -1]) {
      const r = await studio.req(
        'POST',
        `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(d)}/structure-apply`,
        { op: 'split', title: 'X', cursorOffset, planHash: 'p' },
      )
      expect(r.status).toBe(400)
    }
  })

  it('TOCTOU：干跑后正文被改 → apply 409 PLAN_STALE，原章不动', async () => {
    const rel = '写作/正文/第一卷/0007-第7章.md'
    const content = chapterContent(7, '第7章', '第七章前半。\n\n第七章后半。')
    const d = await createChapter(rel, content)
    const cursor = content.indexOf('第七章后半')
    const plan = await planSplit(d, cursor)
    expect(plan.status).toBe(200)
    const changed = content + '确认窗口内新增一行。\n'
    writeFileSync(join(studio.bookRoot, rel), changed, 'utf8')
    const apply = await applySplit(d, {
      op: 'split',
      title: '新章',
      cursorOffset: cursor,
      planHash: (plan.json['plan'] as Record<string, unknown>)['planHash'],
    })
    expect(apply.status).toBe(409)
    expect(apply.json['code']).toBe('PLAN_STALE')
    expect(readFileSync(join(studio.bookRoot, rel), 'utf8')).toBe(changed)
    // 新章未创建
    expect(existsSync(join(studio.bookRoot, '写作/正文/第一卷/0008-新章.md'))).toBe(false)
  })

  it('skipFinalized：max+1 撞已定稿章号（盘上已无文件的定稿条目）→ 跳到下一空闲号', async () => {
    // 现实场景：定稿章经并入/回收后文件不在盘上，但清单 finalizedRevision 在档——
    // 篇号永不复用（CC-P1-6），新章号必须跳过
    const d5 = await createChapter('写作/正文/第一卷/0009-第9章.md', chapterContent(9, '第9章', '第九章正文。'))
    await createChapter('写作/正文/第一卷/0010-第10章.md', chapterContent(10, '第10章', '第十章正文。'))
    const d7 = await createChapter('写作/正文/第一卷/0011-第11章.md', chapterContent(11, '第11章', '第十一章正文。'))
    const f = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(d7)}/finalize`)
    expect(f.status).toBe(200)
    // 定稿章文件移出盘面（并入/回收后的形态），清单条目保留
    rmSync(join(studio.bookRoot, '写作/正文/第一卷/0011-第11章.md'))
    // 盘面 max=10 → 候选 11 撞定稿 → 跳到 12
    const content = readFileSync(join(studio.bookRoot, '写作/正文/第一卷/0009-第9章.md'), 'utf8')
    const cursor = content.indexOf('第九章正文')
    const plan = await planSplit(d5, cursor + 2)
    expect(plan.status).toBe(200)
    expect((plan.json['plan'] as Record<string, unknown>)['newChapterNo']).toBe(12)
  })

  it('序中值：原章 序 10、后继章 序 20 → 新章 序 15', async () => {
    const c8 = chapterContent(8, '第8章', '第八章前半。\n\n第八章后半。', '序: 10\n')
    const d8 = await createChapter('写作/正文/第一卷/0008-第8章.md', c8)
    await createChapter('写作/正文/第一卷/0012-第12章.md', chapterContent(12, '第12章', '第十二章。', '序: 20\n'))
    const cursor = c8.indexOf('第八章后半')
    const plan = await planSplit(d8, cursor)
    expect(plan.status).toBe(200)
    expect((plan.json['plan'] as Record<string, unknown>)['order']).toBe(15)
    const apply = await applySplit(d8, {
      op: 'split',
      title: '中值新章',
      cursorOffset: cursor,
      planHash: (plan.json['plan'] as Record<string, unknown>)['planHash'],
    })
    expect(apply.status).toBe(200)
    expect((apply.json as Record<string, unknown>)['newChapterNo']).toBe(13)
    // fm 序 = 中值落盘
    expect(readFileSync(join(studio.bookRoot, '写作/正文/第一卷/0013-中值新章.md'), 'utf8')).toContain('序: 15')
  })

  it('已发布章：publishedWarning 提示不硬拦（apply 200）', async () => {
    const c = chapterContent(14, '第14章', '第十四章前半。\n\n第十四章后半。', '已发布: true\n')
    const d = await createChapter('写作/正文/第一卷/0014-第14章.md', c)
    const cursor = c.indexOf('第十四章后半')
    const plan = await planSplit(d, cursor)
    expect(plan.status).toBe(200)
    expect((plan.json['plan'] as Record<string, unknown>)['publishedWarning']).toBe(true)
    const apply = await applySplit(d, {
      op: 'split',
      title: '发布后新章',
      cursorOffset: cursor,
      planHash: (plan.json['plan'] as Record<string, unknown>)['planHash'],
    })
    expect(apply.status).toBe(200)
    expect(existsSync(join(studio.bookRoot, '写作/正文/第一卷/0015-发布后新章.md'))).toBe(true)
  })

  it('GBK 存量章：apply 400 NOT_UTF8_TARGET 且盘上字节逐位不变', async () => {
    const rel = '写作/正文/第一卷/0016-GBK章.md'
    // 正常建章拿 docId（清单在册），再覆写为 GBK 字节（fm 段 ASCII 可解析、正文 GBK）
    const d = await createChapter(rel, chapterContent(16, 'GBK章', '占位（将被覆写为 GBK 字节）'))
    const fm = '---\n章号: 16\n标题: GBK章\n---\n\n'
    const gbk = Buffer.concat([
      Buffer.from(fm, 'utf8'),
      Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a, 0x0a, 0xb4, 0xf3, 0xbc, 0xd2, 0xba, 0xc3, 0x0a]),
    ])
    writeFileSync(join(studio.bookRoot, rel), gbk)
    const cursor = fm.length + 2
    const plan = await planSplit(d, cursor)
    expect(plan.status).toBe(200) // 干跑不拦（SplitPlanView 无编码预警字段）
    const apply = await applySplit(d, {
      op: 'split',
      title: '新章',
      cursorOffset: cursor,
      planHash: (plan.json['plan'] as Record<string, unknown>)['planHash'],
    })
    expect(apply.status).toBe(400)
    expect(apply.json['code']).toBe('NOT_UTF8_TARGET')
    expect(readFileSync(join(studio.bookRoot, rel))).toEqual(gbk)
    expect(existsSync(join(studio.bookRoot, '写作/正文/第一卷/0017-新章.md'))).toBe(false)
  })
})

// 六轮重评 C101：tailPreview 原按码元 .slice(0, 60) 截断，第 60 码元落在增补平面
// 字符（CJK 扩展 B / emoji）内部时劈出孤立高代理——确认弹窗预览尾字符乱码。钉住
// 码位截断口径（clipByCodePoints 单源 shared/text.ts）。置于文件末尾：本文件用例
// 按执行顺序连续取号（新章号 = 全书 max+1 断言逐用例推进），高章号垫在中间会搅
// 后续用例的取号/文件名预期。
describe('六轮重评 C101: 拆分干跑预览码位截断', () => {
  it('迁出段为增补平面字符：tailPreview 按码位截断、不劈代理对', async () => {
    const ASTRAL = '\u{20BB7}' // 𠮷（CJK 扩展 B，单字符 2 码元）
    const content = chapterContent(18, '第18章', `前半段保留，光标记位。\n\n${ASTRAL.repeat(80)}`)
    const d = await createChapter('写作/正文/第一卷/0018-第18章.md', content)
    const cursor = content.indexOf(ASTRAL) // 迁出段 = 80 个 astral 字符（码元边界安全）
    const plan = await planSplit(d, cursor)
    expect(plan.status).toBe(200)
    const preview = String((plan.json['plan'] as Record<string, unknown>)['tailPreview'])
    expect(preview).toBe(ASTRAL.repeat(60)) // 60 码位整字符，旧码元口径此处会劈出孤立高代理
    expect(preview.length).toBe(120) // 60 码位 × 2 码元
  })
})
