import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { DocumentService } from '../../src/document/service.js'
import { appendPending, type JournalPending } from '../../src/document/journal.js'
import { readTodayDelta, todayDate } from '../../src/document/words-diary.js'
import { hashFile } from '../../src/fs/hash.js'
import { computeRevision } from '../../src/document/revision.js'

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('DocumentService / 保存协议主路径', () => {
  let bookRoot: string
  let svc: DocumentService
  beforeEach(() => {
    bookRoot = mkdtempSync(join(tmpdir(), 'svc-'))
    mkdirSync(join(bookRoot, '工作区'), { recursive: true })
    svc = new DocumentService({ bookRoot })
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('新建保存（expectedRevision=null，文件不存在）→ ok + 落盘', async () => {
    const r = await svc.save('doc_1', '写作/正文/0001-开篇.md', {
      content: 'hello',
      expectedRevision: null,
      operationId: 'op1',
      origin: 'manual',
    })
    expect(r.ok).toBe(true)
    expect(r.superseded).toBe(false)
    if (r.ok) expect(r.revision).toMatch(/^sha256:/)
    expect(readFileSync(join(bookRoot, '写作/正文/0001-开篇.md'), 'utf-8')).toBe('hello')
  })

  it('覆盖保存（expectedRevision=当前）→ ok + 新 revision', async () => {
    const r1 = await svc.save('doc_1', '写作/正文/0001-开篇.md', {
      content: 'hello', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    if (!r1.ok) throw new Error('prereq')
    const r2 = await svc.save('doc_1', '写作/正文/0001-开篇.md', {
      content: 'world', expectedRevision: r1.revision, operationId: 'op2', origin: 'manual',
    })
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.revision).not.toBe(r1.revision)
    expect(readFileSync(join(bookRoot, '写作/正文/0001-开篇.md'), 'utf-8')).toBe('world')
  })

  it('expectedRevision=null 撞已有文件 → REVISION_CONFLICT', async () => {
    await svc.save('doc_1', '写作/正文/0001-开篇.md', {
      content: 'a', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    const r = await svc.save('doc_1', '写作/正文/0001-开篇.md', {
      content: 'b', expectedRevision: null, operationId: 'op2', origin: 'manual',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('REVISION_CONFLICT')
  })

  it('expectedRevision 不符磁盘 → REVISION_CONFLICT', async () => {
    await svc.save('doc_1', '写作/正文/0001-开篇.md', {
      content: 'a', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    const r = await svc.save('doc_1', '写作/正文/0001-开篇.md', {
      content: 'b', expectedRevision: 'sha256:deadbeef', operationId: 'op2', origin: 'manual',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('REVISION_CONFLICT')
  })

  // ── M-5（第六轮）：非 UTF-8 覆写防线（save 主路径含 autosave）──

  it('M-5: GBK 文件被错误编码打开后 autosave → 拒绝保存，原始字节一字不动', async () => {
    // 非 chapter 文档（设定）——maybeSnapshot 只留底章，此路径无快照兜底，防线是唯一保护
    const fp = join(bookRoot, '设定', '世界观.md')
    mkdirSync(join(bookRoot, '设定'), { recursive: true })
    // GBK「序」(0xD0F2) +「正文」(0xD5FD CEC4)：utf-8 读入产生 U+FFFD 替换符
    const gbk = Buffer.concat([
      Buffer.from('---\n名称: ', 'utf-8'),
      Buffer.from([0xd0, 0xf2]),
      Buffer.from('\n---\n', 'utf-8'),
      Buffer.from([0xd5, 0xfd, 0xce, 0xc4]),
    ])
    writeFileSync(fp, gbk)
    const before = readFileSync(fp)
    // 模拟编辑器以 utf-8 读入（乱码含 U+FFFD）后 autosave 存回
    const mojibake = readFileSync(fp, 'utf-8')
    const r = await svc.save('doc_world', '设定/世界观.md', {
      content: mojibake + '作者补的一句',
      expectedRevision: computeRevision(fp),
      operationId: 'op1',
      origin: 'autosave',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('WRITE_ERROR')
    expect(r.reason).toContain('UTF-8')
    // 原始字节一字不动（拒绝即零副作用）
    expect(readFileSync(fp).equals(before)).toBe(true)
  })

  it('M-5: 盘上是合法 UTF-8（含真实 � 字符）→ 放行，普通编辑不受防线影响', async () => {
    const fp = join(bookRoot, '设定', '世界观.md')
    mkdirSync(join(bookRoot, '设定'), { recursive: true })
    writeFileSync(fp, '\uFFFD 旧内容', 'utf-8') // 合法 UTF-8 编码的 U+FFFD 字符（0xEF 0xBF 0xBD）
    const r = await svc.save('doc_world', '设定/世界观.md', {
      content: '\uFFFD 旧内容 + 新内容',
      expectedRevision: computeRevision(fp),
      operationId: 'op2',
      origin: 'autosave',
    })
    expect(r.ok).toBe(true)
  })

  it('P5-数据层（第七轮）: restore 到尚不存在的文件 → 跳过快照正常落盘（原 ENOENT 抛 WRITE_ERROR）', async () => {
    // 外部恢复/合并场景：目标文件已被清掉（expectedRevision=null 过基线校验），
    // maybeSnapshot 无底可留应直接跳过——原实现 readFileSync(absPath) ENOENT 抛走，
    // 本可成功的恢复性新建被拒
    mkdirSync(join(bookRoot, '设定'), { recursive: true })
    const fp = join(bookRoot, '设定', '世界观.md')
    expect(existsSync(fp)).toBe(false)
    const r = await svc.save('doc_world', '设定/世界观.md', {
      content: '恢复出来的内容',
      expectedRevision: null,
      operationId: 'op-restore-missing',
      origin: 'restore',
    })
    expect(r.ok).toBe(true)
    expect(readFileSync(fp, 'utf-8')).toContain('恢复出来的内容')
  })

  it('低级项（第六轮）：GBK 只污染 fm 区（body 纯 ASCII）→ updateChapterMeta 同样拒绝，原始字节一字不动', async () => {
    // 原判据只查 body：fm 区 GBK 标题读入 U+FFFD 但 body 干净 → 放行后 fm 往返把乱码写回
    const r0 = await svc.createDocument({ relPath: '写作/正文/0002-风起.md', content: '---\n章号: 2\n标题: 风起\n---\nplain ascii body' })
    if (!r0.ok) throw new Error('prereq')
    const fp = join(bookRoot, '写作/正文/0002-风起.md')
    const gbkFm = Buffer.concat([
      Buffer.from('---\n章号: 2\n标题: ', 'utf-8'),
      Buffer.from([0xb7, 0xe7]), // GBK「风」——utf-8 fatal 解码必炸、读入产生 U+FFFD
      Buffer.from('\n---\nplain ascii body', 'utf-8'),
    ])
    writeFileSync(fp, gbkFm)

    const r = svc.updateChapterMeta(r0.docId, { 标题: '新标题' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('WRITE_ERROR')
    // 原始字节一字不动（防线只拒绝不修改）
    expect(readFileSync(fp).equals(gbkFm)).toBe(true)
  })

  it('DA-1（第七轮）：GBK 污染 fm 区 → updateDocMeta 同款字节级拒绝，原始字节一字不动', async () => {
    // 卷纲/总纲写回路径原先只查字符串 U+FFFD，与 updateChapterMeta 口径分裂
    const r0 = await svc.createDocument({ relPath: '大纲/总纲.md', content: '---\ntype: 总纲\n---\nplain ascii body' })
    if (!r0.ok) throw new Error('prereq')
    const fp = join(bookRoot, '大纲/总纲.md')
    const gbkFm = Buffer.concat([
      Buffer.from('---\ntype: 总纲\n标题: ', 'utf-8'),
      Buffer.from([0xb7, 0xe7]), // GBK「风」——utf-8 fatal 解码必炸
      Buffer.from('\n---\nplain ascii body', 'utf-8'),
    ])
    writeFileSync(fp, gbkFm)
    const r = svc.updateDocMeta(r0.docId, { 备注: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('WRITE_ERROR')
    expect(readFileSync(fp).equals(gbkFm)).toBe(true)
  })

  it('DA-1（第七轮）：盘上合法 UTF-8（含真实 � 字符）→ updateDocMeta 放行（升级判据消除误拒）', async () => {
    const r0 = await svc.createDocument({ relPath: '大纲/卷纲/第一卷.md', content: '---\nvolume: 1\n---\n\uFFFD 卷内既有要点' })
    if (!r0.ok) throw new Error('prereq')
    const r = svc.updateDocMeta(r0.docId, { 备注: '已校' })
    expect(r.ok).toBe(true) // 原字符串判据会把合法 UTF-8 的真实 � 误判为乱码而拒写
    if (r.ok) expect(readFileSync(join(bookRoot, r.path), 'utf-8')).toContain('� 卷内既有要点')
  })

  it('低级项（第六轮）：盘上合法 UTF-8（body 含真实 �）→ updateChapterMeta 放行，与 save 主路径 M-5 同口径', async () => {
    const r0 = await svc.createDocument({ relPath: '写作/正文/0003-开篇.md', content: '---\n章号: 3\n标题: 开篇\n---\n\uFFFD 旧内容' })
    if (!r0.ok) throw new Error('prereq')
    const r = svc.updateChapterMeta(r0.docId, { 标题: '改题' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // rename 跟随新标题；body 的真实 � 原样透传
      expect(readFileSync(join(bookRoot, r.path), 'utf-8')).toContain('\uFFFD 旧内容')
    }
  })

  it('RB-KN-P2-2: journal 追加失败 → SaveResult 契约（ok:false WRITE_ERROR），不 reject 不落盘', async () => {
    // 占住 journal 文件路径（目录）→ appendPending 抛 EISDIR（模拟磁盘满/权限类故障）
    mkdirSync(join(bookRoot, '工作区', '.journal', 'doc_1.jsonl'), { recursive: true })
    const r = await svc.save('doc_1', '写作/正文/0001-开篇.md', {
      content: 'hello', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('WRITE_ERROR')
    if (!r.ok) expect(r.reason).toContain('journal')
    // 正文未落盘（pending 记不上就不写，防无 journal 兜底的落盘）
    expect(existsSync(join(bookRoot, '写作/正文/0001-开篇.md'))).toBe(false)
  })

  it('路径越出（.. 穿越）→ PATH_ESCAPE，不落盘', async () => {
    const r = await svc.save('doc_x', '../../../etc/passwd', {
      content: 'x', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('PATH_ESCAPE')
  })

  it('只读文档（定稿/摘要）→ CAPABILITY_DENIED', async () => {
    const r = await svc.save('doc_s', '定稿/摘要/0001.md', {
      content: 'x', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CAPABILITY_DENIED')
  })

  it('save settled 记今日字数 delta（E4：新建 + 修改累加，strip fm 口径）', async () => {
    // 新建 save（expectedRevision null）→ delta = 新内容正文字数（fm 已剥）
    const r0 = await svc.save('doc_w', '写作/正文/0001-初稿.md', {
      content: '---\n标题: x\n---\n你好世界', expectedRevision: null, operationId: 'op-d1', origin: 'manual',
    })
    if (!r0.ok) throw new Error('prereq r0')
    expect(readTodayDelta(bookRoot, todayDate())).toBe(4) // 「你好世界」4 字
    // 修改 save → delta = 新旧差（新增「再见」2 字）
    const r1 = await svc.save('doc_w', '写作/正文/0001-初稿.md', {
      content: '---\n标题: x\n---\n你好世界再见', expectedRevision: r0.revision, operationId: 'op-d2', origin: 'manual',
    })
    expect(r1.ok).toBe(true)
    expect(readTodayDelta(bookRoot, todayDate())).toBe(6) // 累计 4 + 2
  })
})

describe('DocumentService / journal 与崩溃恢复', () => {
  let bookRoot: string
  let svc: DocumentService
  beforeEach(() => {
    bookRoot = mkdtempSync(join(tmpdir(), 'svcj-'))
    mkdirSync(join(bookRoot, '工作区', '.journal'), { recursive: true })
    svc = new DocumentService({ bookRoot })
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('保存成功后 journal pending+settled 成对，recover 无未结算', async () => {
    await svc.save('doc_1', '写作/正文/0001.md', {
      content: 'hello', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    expect(svc.recover()).toEqual([])
  })

  it('recover 报告 pending 无 settled（崩溃未结算）', () => {
    const jp = join(bookRoot, '工作区', '.journal', 'doc_y.jsonl')
    appendPending(jp, 'doc_y', null, 'lost content')
    const reports = svc.recover()
    expect(reports.length).toBe(1)
    expect(reports[0]!.docId).toBe('doc_y')
    expect((reports[0]!.pending[0] as JournalPending).content).toBe('lost content')
  })

  it('recover：aborted 不算未结算', () => {
    const jp = join(bookRoot, '工作区', '.journal', 'doc_z.jsonl')
    const opId = appendPending(jp, 'doc_z', null, 'will fail')
    // 手动追加 aborted
    writeFileSync(jp, JSON.stringify({ opId, ts: new Date().toISOString(), status: 'aborted', reason: 'boom' }) + '\n', { flag: 'a' })
    expect(svc.recover()).toEqual([])
  })
})

describe('DocumentService / freeze + 串行', () => {
  let bookRoot: string
  let svc: DocumentService
  beforeEach(() => {
    bookRoot = mkdtempSync(join(tmpdir(), 'svcf-'))
    mkdirSync(join(bookRoot, '工作区'), { recursive: true })
    svc = new DocumentService({ bookRoot })
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('freeze 后 save 排队不执行，unfreeze 后落盘', async () => {
    svc.freeze('doc_1')
    const p = svc.save('doc_1', '写作/正文/0001.md', {
      content: 'frozen', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    await delay(15)
    expect(existsSync(join(bookRoot, '写作/正文/0001.md'))).toBe(false)
    svc.unfreeze('doc_1')
    const r = await p
    expect(r.ok).toBe(true)
    expect(readFileSync(join(bookRoot, '写作/正文/0001.md'), 'utf-8')).toBe('frozen')
  })

  it('同 doc 并发保存串行，内容最终为最后一次', async () => {
    const ps = ['一', '二', '三'].map((c, i) =>
      svc.save('doc_1', '写作/正文/0001.md', {
        content: c, expectedRevision: null, operationId: `op${i}`, origin: 'manual',
      }),
    )
    const results = await Promise.all(ps)
    // 第一个 ok，后续因基线变化 REVISION_CONFLICT（串行下后续看到前一次落盘）
    const oks = results.filter((r) => r.ok)
    expect(oks.length).toBe(1)
    // 最终落盘内容是串行里最后一个成功的（第一个）
    expect(readFileSync(join(bookRoot, '写作/正文/0001.md'), 'utf-8')).toBe('一')
  })

  it('不同 doc 并发保存互不阻塞', async () => {
    const t0 = Date.now()
    await Promise.all([
      svc.save('doc_a', '写作/正文/0001.md', { content: 'a', expectedRevision: null, operationId: 'opa', origin: 'manual' }),
      svc.save('doc_b', '写作/正文/0002.md', { content: 'b', expectedRevision: null, operationId: 'opb', origin: 'manual' }),
    ])
    // 两个独立 doc 并行，应在 ~一次 IO 时间内完成
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(existsSync(join(bookRoot, '写作/正文/0001.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '写作/正文/0002.md'))).toBe(true)
  })
})

describe('DocumentService / snapshot 触发', () => {
  let bookRoot: string
  let svc: DocumentService
  beforeEach(() => {
    bookRoot = mkdtempSync(join(tmpdir(), 'svcs-'))
    mkdirSync(join(bookRoot, '工作区'), { recursive: true })
    svc = new DocumentService({ bookRoot })
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('改已存在定稿章（chapter）→ 建修改前快照', async () => {
    // 先建一个定稿章
    const f = join(bookRoot, '写作/正文/0001-开篇.md')
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, '原文', 'utf-8')
    const base = hashFile(f) as `sha256:${string}`
    await svc.save('doc_1', '写作/正文/0001-开篇.md', {
      content: '改后', expectedRevision: base, operationId: 'op1', origin: 'manual',
    })
    const snapDir = join(bookRoot, '工作区', '.版本', 'doc_1')
    expect(existsSync(snapDir)).toBe(true)
  })

  it('origin=manual 新建（非 chapter 覆盖）→ 不建快照', async () => {
    await svc.save('doc_1', '素材/灵感.md', {
      content: '新', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    const snapDir = join(bookRoot, '工作区', '.版本', 'doc_1')
    expect(existsSync(snapDir)).toBe(false)
  })
})

// ── V-P2-1：排队 save 与结构性操作（rename/trash）竞态 ──────────────
// 结构性操作同步执行不排队：入队 save 出队时目标路径可能已被移走/删除。
// 新建档（expectedRevision=null）撞空路径本会直接落盘 → 在旧路径复活文件。

describe('DocumentService / V-P2-1 迟到 save 不复活旧路径', () => {
  let bookRoot: string
  let svc: DocumentService
  beforeEach(() => {
    bookRoot = mkdtempSync(join(tmpdir(), 'svc-race-'))
    mkdirSync(join(bookRoot, '工作区'), { recursive: true })
    svc = new DocumentService({ bookRoot })
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('rename 后迟到的 null 基线 save → REVISION_CONFLICT，旧路径不复活', async () => {
    const created = await svc.createDocument({ relPath: '写作/正文/0001-开篇.md', content: '初稿' })
    if (!created.ok) throw new Error('prereq create')
    const renamed = await svc.renameDocument({ docId: created.docId, newName: '0002-改名.md' })
    if (!renamed.ok) throw new Error('prereq rename')

    const r = await svc.save(created.docId, '写作/正文/0001-开篇.md', {
      content: '迟到的新建内容', expectedRevision: null, operationId: 'op-late', origin: 'autosave',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('REVISION_CONFLICT')
    expect(existsSync(join(bookRoot, '写作/正文/0001-开篇.md'))).toBe(false)
  })

  it('trash 后迟到的 null 基线 save → 拒绝（回收站在案，不绕过软删）', async () => {
    const created = await svc.createDocument({ relPath: '写作/正文/0003-雪夜.md', content: '雪' })
    if (!created.ok) throw new Error('prereq create')
    const trashed = await svc.trashDocument({ docId: created.docId })
    if (!trashed.ok) throw new Error('prereq trash')

    const r = await svc.save(created.docId, '写作/正文/0003-雪夜.md', {
      content: '迟到内容', expectedRevision: null, operationId: 'op-late2', origin: 'autosave',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('REVISION_CONFLICT')
      expect(r.reason).toContain('回收站')
    }
    expect(existsSync(join(bookRoot, '写作/正文/0003-雪夜.md'))).toBe(false)
  })

  it('rename 后按登记新路径保存 → 放行（save 跟随文档）', async () => {
    const created = await svc.createDocument({ relPath: '写作/正文/0005-跟随.md', content: 'a' })
    if (!created.ok) throw new Error('prereq create')
    await svc.renameDocument({ docId: created.docId, newName: '0006-新名.md' })
    const r = await svc.save(created.docId, '写作/正文/0006-新名.md', {
      content: 'b', expectedRevision: created.revision, operationId: 'op-follow', origin: 'manual',
    })
    expect(r.ok).toBe(true)
    expect(readFileSync(join(bookRoot, '写作/正文/0006-新名.md'), 'utf-8')).toBe('b')
  })

  it('未移动未删除 → 同路径正常保存不受影响', async () => {
    const created = await svc.createDocument({ relPath: '写作/正文/0007-常例.md', content: 'a' })
    if (!created.ok) throw new Error('prereq create')
    const r = await svc.save(created.docId, '写作/正文/0007-常例.md', {
      content: 'b', expectedRevision: created.revision, operationId: 'op-ok', origin: 'manual',
    })
    expect(r.ok).toBe(true)
  })

  it('ee-P1-5：journal pending 写失败 → {ok:false} 契约而非裸异常（Promise.resolve 不捕同步 throw）', async () => {
    const created = await svc.createDocument({ relPath: '写作/正文/0008-journal.md', content: 'a' })
    if (!created.ok) throw new Error('prereq create')
    // 把 .journal 目录槽位占成普通文件 → appendMovePending 落盘必失败（ENOTDIR）
    writeFileSync(join(bookRoot, '工作区', '.journal'), '占用目录槽位的文件')
    // 修复前：appendMovePending 在 try 外同步 throw，renameDocument 直接抛裸异常；
    // 修复后：收进 {ok:false, code:WRITE_ERROR} 契约（调用方 API 层按信封回 4xx/5xx）
    const p = svc.renameDocument({ docId: created.docId, newName: '0009-改名.md' })
    await expect(p).resolves.toMatchObject({ ok: false, code: 'WRITE_ERROR' })
    // 源文件未被移动（rename 从未执行）
    expect(existsSync(join(bookRoot, '写作/正文/0008-journal.md'))).toBe(true)
  })
})
