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
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { chapterContent, bindStructureHelpers } from '../helpers/structure.js'
import { openRagDb, setRagMeta, getRagMeta } from '../../src/rag/store.js'
import {
  planChapterSplit,
  applyChapterSplit,
  type StructureRagPort,
} from '../../src/document/structure.js'
import { DocumentService } from '../../src/document/service.js'
import { tryAcquireCrossProcessLock } from '../../src/fs/cross-process-lock.js'
import { splitFrontMatter, parseFlat } from '../../src/format/frontmatter.js'
import {
  readManifest,
  writeManifest,
  upsertEntry,
  finalizedChapterNumbers as finalizedChapterNumbersFromManifest,
} from '../../src/document/manifest.js'
import { finalizedChapterNumbers } from '../../src/document/structure-core.js'

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
    const d = await createChapter(
      '写作/正文/第一卷/0006-第6章.md',
      chapterContent(6, '第6章', '第六章正文一段。\n\n第六章第二段。'),
    )
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
    const f = await studio.req(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(d7)}/finalize`,
    )
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

// ── 拆分光标落在 UTF-16 代理对中间的劈字防线：cursorOffset 落在高低位代理之间（CJK
// 扩展 B 生僻字 𠀀 U+20000、emoji 等 astral 字符内部）时，applyChapterSplit 的 slice
// 切分把一个字符劈成两个孤立代理，落盘各编码为 U+FFFD——原章尾与新章头同时永久损坏
// 一字，且恢复重放经同一光标复现损坏。validateSplitCursor 补边界判定后：劈中间 →
// 400 BAD_INPUT；码点边界（含 astral 字符前后两侧）→ 正常干跑/执行不受影响。
// （章号取本文件未用过的 30/31/32，避免与既有用例的取号基线相撞）──

describe('拆分光标代理对边界（validateSplitCursor）', () => {
  const BODY = '前段正文。\n\n主角念出古字𠀀后天地变色。\n\n后段迁移。'

  it('光标落在 𠀀（U+20000）代理对中间 → 干跑 400 BAD_INPUT（修复前 200，apply 劈字成 U+FFFD）', async () => {
    // 𠀀 = \uD840\uDC00 高低位代理对；正文含 astral 字符夹正常段
    const content = chapterContent(30, '第30章', BODY)
    const d = await createChapter('写作/正文/第一卷/0030-第30章.md', content)
    const cp = content.indexOf('𠀀')
    expect(cp).toBeGreaterThan(0)
    // 高代理与低代理之间（cp + 1）＝字符内部
    const mid = await planSplit(d, cp + 1)
    expect(mid.status).toBe(400)
    expect(mid.json['code']).toBe('BAD_INPUT')
    expect((mid.json as { error: string }).error).toContain('代理对')
  })

  it('光标在码点边界（astral 字符前/后两侧）→ 干跑正常（防线不误伤合法拆分点）', async () => {
    const content = chapterContent(31, '第31章', BODY)
    const d = await createChapter('写作/正文/第一卷/0031-第31章.md', content)
    const cp = content.indexOf('𠀀')
    for (const cursor of [cp, cp + 2]) {
      const plan = await planSplit(d, cursor)
      expect(plan.status).toBe(200)
      const p = plan.json['plan'] as Record<string, unknown>
      expect(typeof p['planHash']).toBe('string')
      expect(p['tailWords']).toBeGreaterThan(0)
    }
  })

  it('apply 同道拒收：劈中间光标 → 400 且盘面不动（校验先于 slice 切分）', async () => {
    const content = chapterContent(32, '第32章', BODY)
    const rel = '写作/正文/第一卷/0032-第32章.md'
    const d = await createChapter(rel, content)
    const cp = content.indexOf('𠀀')
    const boundary = await planSplit(d, cp + 2)
    expect(boundary.status).toBe(200)
    const r = await studio.req(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(d)}/structure-apply`,
      {
        op: 'split',
        title: '新章',
        cursorOffset: cp + 1,
        planHash: (boundary.json['plan'] as Record<string, unknown>)['planHash'],
      },
    )
    expect(r.status).toBe(400)
    expect((r.json as Record<string, unknown>)['code']).toBe('BAD_INPUT')
    // 拒收即盘面逐字节不动（未发生任何劈字写盘）
    expect(readFileSync(join(studio.bookRoot, rel), 'utf8')).toBe(content)
  })
})

// ── 拆分取号临界区的跨进程锁：修复前 applyChapterSplit 只有进程内互斥（per-bookRoot
// 串行链）——双进程（GUI 服务 + CLI 合法并存形态）并发拆分同书时，两进程各自扫盘取得
// 同一章号、新章文件名含标题 → 路径不同 → createDocument 独占探测不拦 → 静默重号。
// 修复后临界区外层先取 per-bookRoot 跨进程锁（工作区/.structure-op.lock）：
// 他进程持锁（手动预持锁模拟，锁文件带本进程活 pid → 判 held 不误接管）→ 等满超时
// OCCUPIED fail-loud；锁在成功与失败（PLAN_STALE）两态收尾均释放（try/finally）。
// 直调模块函数；OCCUPIED 等待窗用假时钟推进（等待期唯一活动是锁轮询的 setTimeout）。
// （章号取 40/50 段，避免与既有用例的取号基线相撞）──

const splitRagStub: StructureRagPort = {
  estimateRagChunkCount: () => 0,
  cleanupRagAfterMerge: () => {},
}

const splitOpLockPath = (): string => join(studio.bookRoot, '工作区', '.structure-op.lock')

/** 直调形态的拆分 apply 入参组装（干跑取指纹）。 */
async function planDirect(
  docId: string,
  content: string,
  marker: string,
): Promise<{ planHash: string; cursorOffset: number }> {
  const cursorOffset = content.indexOf(marker)
  const plan = await planChapterSplit(
    studio.bookRoot,
    new DocumentService({ bookRoot: studio.bookRoot }),
    docId,
    cursorOffset,
  )
  if (!plan.ok) throw new Error(`干跑失败：${JSON.stringify(plan)}`)
  return { planHash: plan.planHash, cursorOffset }
}

describe('拆分取号跨进程锁', () => {
  it('他进程持锁（预持锁模拟）→ 等满 10s 超时 OCCUPIED fail-loud；释放后重试成功且锁文件收尾清零', async () => {
    const relA = '写作/正文/第一卷/0040-甲章.md'
    const contentA = chapterContent(40, '甲章', '甲章前半段保留。\n\n甲章后半段迁出标记。')
    const dA = await createChapter(relA, contentA)
    const pA = await planDirect(dA, contentA, '甲章后半段迁出标记')
    const svcA = new DocumentService({ bookRoot: studio.bookRoot })
    const input = { docId: dA, title: '甲拆分新章', cursorOffset: pA.cursorOffset, planHash: pA.planHash }

    // 预持锁 = 「另一进程正在拆分」的进程内等价物（活 pid 在位 → judgeStaleLock 判 held，
    // 不触发 stale 接管；12s 推进 < 10min 超龄门槛，不误判超龄）
    const pre = tryAcquireCrossProcessLock(splitOpLockPath())
    expect(pre).not.toBeNull()
    try {
      // 推进 12s（> 模块内 10s 等待窗，留余量）：轮询每 20ms 一拍，截止判定随假钟 Date 走
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const pending = applyChapterSplit(studio.bookRoot, svcA, null, input, splitRagStub)
      await vi.advanceTimersByTimeAsync(12_000)
      const r = await pending
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.code).toBe('OCCUPIED')
        expect(r.reason).toContain('跨进程锁')
      }
    } finally {
      vi.useRealTimers()
      pre?.()
    }

    // 释放后同 plan 重试 → 成功（锁内重读基线未变：尚无新章落盘）+ 锁文件不残留
    const retry = await applyChapterSplit(studio.bookRoot, svcA, null, input, splitRagStub)
    expect(retry.ok).toBe(true)
    if (!('newChapterNo' in retry)) throw new Error('unreachable')
    expect(retry.newChapterNo).toBe(41)
    expect(existsSync(splitOpLockPath())).toBe(false)
  }, 20_000)

  it('成功与 PLAN_STALE 两态收尾锁文件均清零（try/finally 释放面）', async () => {
    const rel40 = '写作/正文/第一卷/0050-丁章.md'
    const rel41 = '写作/正文/第一卷/0051-戊章.md'
    const content40 = chapterContent(50, '丁章', '丁章前半段保留。\n\n丁章后半段迁出标记。')
    const content41 = chapterContent(51, '戊章', '戊章前半段保留。\n\n戊章后半段迁出标记。')
    const d40 = await createChapter(rel40, content40)
    const d41 = await createChapter(rel41, content41)
    const stalePlan = await planDirect(d40, content40, '丁章后半段迁出标记')
    const freshPlan = await planDirect(d41, content41, '戊章后半段迁出标记')
    const svcB = new DocumentService({ bookRoot: studio.bookRoot })

    const fresh = await applyChapterSplit(
      studio.bookRoot,
      svcB,
      null,
      { docId: d41, title: '戊拆分新章', cursorOffset: freshPlan.cursorOffset, planHash: freshPlan.planHash },
      splitRagStub,
    )
    expect(fresh.ok).toBe(true)
    expect(existsSync(splitOpLockPath())).toBe(false) // 成功收尾释放

    const stale = await applyChapterSplit(
      studio.bookRoot,
      svcB,
      null,
      { docId: d40, title: '丁拆分新章', cursorOffset: stalePlan.cursorOffset, planHash: stalePlan.planHash },
      splitRagStub,
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.code).toBe('PLAN_STALE')
    expect(existsSync(splitOpLockPath())).toBe(false) // 失败收尾同样释放（修复面 = try/finally）
  })
})

// ── 定稿章号集认裸数字名：finalizedChapterNumbers 双实现同根盲区收编 chapterNoFromName
// 单源（isMdFileName 剥 .md 茎后判定）——structure-core 版（拆分取号 skipFinalized 面）
// 对「0061.md」这类带扩展直判失明 → skipFinalized 漏跳 → 取号撞定稿章号；manifest 版
// （state.ts/recap.ts nextChapter 与 assembleStatus 的 skip 口径）同盲区一并收编。
// 用例形态：定稿条目文件不在盘（定稿章经并入/回收后的既有形态）→ 盘面 max 落在 60 段，
// 拆分取号须跳过已定稿的 61 取 62。（章号取 60 段避免与既有用例取号基线相撞）──

describe('定稿章号集认裸数字名', () => {
  const REL60 = '写作/正文/第一卷/0060-第60章.md'
  let d60 = ''

  beforeAll(async () => {
    d60 = await createChapter(
      REL60,
      chapterContent(60, '第60章', '第六十章前半段。\n\n第六十章后半段迁出标记。'),
    )
    // 盘面唯一在盘章 0060（max=60）+ 定稿裸名条目 0061.md（文件不在盘，finalizedRevision 在档）
    const mp = join(studio.bookRoot, '项目', '文档清单.jsonl')
    const m = readManifest(mp)
    upsertEntry(m, {
      id: 'doc_bare61',
      nodeType: 'document',
      path: '写作/正文/0061.md',
      parentId: null,
      finalizedRevision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    })
    writeManifest(mp, m)
  })

  it('双实现均把裸数字定稿条目（0061.md）计入章号集（口径一致）', () => {
    const mp = join(studio.bookRoot, '项目', '文档清单.jsonl')
    // structure-core 版（拆分取号 skipFinalized 面）
    expect(finalizedChapterNumbers(studio.bookRoot).has(61)).toBe(true)
    // manifest 版（state.ts/recap.ts nextChapter 与 assembleStatus 面）
    expect(finalizedChapterNumbersFromManifest(readManifest(mp)).has(61)).toBe(true)
  })

  it('拆分取号跳过定稿裸名 61 取 62（plan+apply 全链，落盘 0062 不落 0061）', async () => {
    const content = chapterContent(60, '第60章', '第六十章前半段。\n\n第六十章后半段迁出标记。')
    const cursor = content.indexOf('第六十章后半段迁出标记')
    const plan = await planSplit(d60, cursor)
    expect(plan.status).toBe(200)
    expect((plan.json as { plan: { newChapterNo: number } }).plan.newChapterNo).toBe(62)
    const apply = await studio.req(
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(d60)}/structure-apply`,
      {
        op: 'split',
        title: '跳号新章',
        cursorOffset: cursor,
        planHash: (plan.json as { plan: { planHash: string } }).plan.planHash,
      },
    )
    expect(apply.status).toBe(200)
    expect((apply.json as { newChapterNo: number }).newChapterNo).toBe(62)
    expect(existsSync(join(studio.bookRoot, '写作/正文/第一卷/0062-跳号新章.md'))).toBe(true)
    expect(existsSync(join(studio.bookRoot, '写作/正文/第一卷/0061-跳号新章.md'))).toBe(false)
  })
})

// ── 拆分取号 per-bookRoot 串行互斥：applyChapterSplit 的「状态重读→取号→planHash 复核→
// 截断→新章落位」段此前无跨请求互斥——两个拆分 apply 并发重叠时各算得同一章号、目标文件名
// 不同，createDocument 双双成功 → 章号复用（「篇号永不复用」被破坏）。修复后临界段整段置于
// 模块级 per-bookRoot 串行链内：并发第二个 apply 锁内重读取号得新号 → planHash 失配 →
// PLAN_STALE fail-loud（期望行为），盘面永不出现重复章号。直调模块函数（绕开 api 层
// enqueueStructureOp 串行链——正是无互斥裸露面）；服务级建账（API 造章）+ planChapterSplit
// 干跑同基线；userDataPath 只作事件副录隔离（取号行为与其无关）。
// 独立书根自建自清：本组断言按「全书 fm 章号」逐位钉死，独占书根方可不与他组累积章号相扰。──

const MUTEX_BOOK = '拆分取号互斥测试书'
let mutexStudio: StudioHarness
let mutexUserDataPath = ''

const { createChapter: createMutexChapter } = bindStructureHelpers({
  studio: () => mutexStudio,
  book: MUTEX_BOOK,
  userDataPath: () => mutexUserDataPath,
})

const mutexRagStub: StructureRagPort = {
  estimateRagChunkCount: () => 0,
  cleanupRagAfterMerge: () => {},
}

/** 直调形态的拆分 apply 入参组装（干跑取指纹）。 */
async function planDirectMutex(
  docId: string,
  content: string,
  marker: string,
): Promise<{ planHash: string; cursorOffset: number }> {
  const cursorOffset = content.indexOf(marker)
  const plan = await planChapterSplit(
    mutexStudio.bookRoot,
    new DocumentService({ bookRoot: mutexStudio.bookRoot }),
    docId,
    cursorOffset,
  )
  if (!plan.ok) throw new Error(`干跑失败：${JSON.stringify(plan)}`)
  return { planHash: plan.planHash, cursorOffset }
}

/** 读全书正文区各章 fm 章号（递归卷目录），断言唯一性用。 */
function mutexChapterNosOnDisk(): Array<{ no: number; file: string }> {
  const root = join(mutexStudio.bookRoot, '写作', '正文')
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

describe('拆分取号并发互斥（per-bookRoot 串行链）', () => {
  beforeAll(async () => {
    mutexUserDataPath = mkdtempSync(join(tmpdir(), 'clw-split-mutex-ud-'))
    mutexStudio = await bootStudio({
      book: MUTEX_BOOK,
      prefix: 'clw-split-mutex-',
      userDataPath: mutexUserDataPath,
      dirs: ['写作/正文/第一卷', '工作区'],
      bookYaml:
        'spec_version: 1\nkind: long\nbook:\n  title: 拆分取号互斥测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    })
  })

  afterAll(async () => {
    await mutexStudio.close()
    if (mutexUserDataPath) rmSync(mutexUserDataPath, { recursive: true, force: true })
  })

  it('同一书根并发两个 applyChapterSplit（不同源章、同 plan 基线）→ 恰一成功一 PLAN_STALE，盘面无重复章号', async () => {
    const relA = '写作/正文/第一卷/0020-甲章.md'
    const relB = '写作/正文/第一卷/0021-乙章.md'
    const contentA = chapterContent(20, '甲章', '甲章前半段保留。\n\n甲章后半段迁出标记。')
    const contentB = chapterContent(21, '乙章', '乙章前半段保留。\n\n乙章后半段迁出标记。')
    const dA = await createMutexChapter(relA, contentA)
    const dB = await createMutexChapter(relB, contentB)
    // 同基线干跑：两 plan 都在 max=21 时点算出 newChapterNo=22
    const pA = await planDirectMutex(dA, contentA, '甲章后半段迁出标记')
    const pB = await planDirectMutex(dB, contentB, '乙章后半段迁出标记')
    const svc = new DocumentService({ bookRoot: mutexStudio.bookRoot })
    const apply = (docId: string, p: { planHash: string; cursorOffset: number }, title: string) =>
      applyChapterSplit(
        mutexStudio.bookRoot,
        svc,
        null,
        { docId, title, cursorOffset: p.cursorOffset, planHash: p.planHash },
        mutexRagStub,
      )

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
    const onDisk = mutexChapterNosOnDisk()
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
    const d40 = await createMutexChapter(rel40, content40)
    const d41 = await createMutexChapter(rel41, content41)
    const stalePlan = await planDirectMutex(d40, content40, '丁章后半段迁出标记')
    const freshPlan = await planDirectMutex(d41, content41, '戊章后半段迁出标记')
    const svc = new DocumentService({ bookRoot: mutexStudio.bookRoot })
    const first = await applyChapterSplit(
      mutexStudio.bookRoot,
      svc,
      null,
      { docId: d41, title: '戊拆分新章', cursorOffset: freshPlan.cursorOffset, planHash: freshPlan.planHash },
      mutexRagStub,
    )
    expect(first.ok).toBe(true)
    const replayed = await applyChapterSplit(
      mutexStudio.bookRoot,
      svc,
      null,
      { docId: d40, title: '丁拆分新章', cursorOffset: stalePlan.cursorOffset, planHash: stalePlan.planHash },
      mutexRagStub,
    )
    expect(replayed.ok).toBe(false)
    if (!replayed.ok) expect(replayed.code).toBe('PLAN_STALE')
    // 盘面无重复章号（同书累积：含上一用例的 20/21/22）
    const onDisk = mutexChapterNosOnDisk()
    const nos = onDisk.map((e) => e.no)
    expect(new Set(nos).size).toBe(nos.length)
    expect(nos.sort((a, b) => a - b)).toEqual([20, 21, 22, 40, 41, 42])
    expect(existsSync(join(mutexStudio.bookRoot, '写作/正文/第一卷/0042-戊拆分新章.md'))).toBe(true)
  })
})
