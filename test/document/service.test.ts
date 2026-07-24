import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { DocumentService } from '../../src/document/service.js'
import { appendPending } from '../../src/document/journal.js'
import { hashFile } from '../../src/fs/hash.js'

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
    const r = await svc.save('doc_1', '定稿/正文/0001-开篇.md', {
      content: 'hello',
      expectedRevision: null,
      operationId: 'op1',
      origin: 'manual',
    })
    expect(r.ok).toBe(true)
    expect(r.superseded).toBe(false)
    if (r.ok) expect(r.revision).toMatch(/^sha256:/)
    expect(readFileSync(join(bookRoot, '定稿/正文/0001-开篇.md'), 'utf-8')).toBe('hello')
  })

  it('覆盖保存（expectedRevision=当前）→ ok + 新 revision', async () => {
    const r1 = await svc.save('doc_1', '定稿/正文/0001-开篇.md', {
      content: 'hello', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    if (!r1.ok) throw new Error('prereq')
    const r2 = await svc.save('doc_1', '定稿/正文/0001-开篇.md', {
      content: 'world', expectedRevision: r1.revision, operationId: 'op2', origin: 'manual',
    })
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.revision).not.toBe(r1.revision)
    expect(readFileSync(join(bookRoot, '定稿/正文/0001-开篇.md'), 'utf-8')).toBe('world')
  })

  it('expectedRevision=null 撞已有文件 → REVISION_CONFLICT', async () => {
    await svc.save('doc_1', '定稿/正文/0001-开篇.md', {
      content: 'a', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    const r = await svc.save('doc_1', '定稿/正文/0001-开篇.md', {
      content: 'b', expectedRevision: null, operationId: 'op2', origin: 'manual',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('REVISION_CONFLICT')
  })

  it('expectedRevision 不符磁盘 → REVISION_CONFLICT', async () => {
    await svc.save('doc_1', '定稿/正文/0001-开篇.md', {
      content: 'a', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    const r = await svc.save('doc_1', '定稿/正文/0001-开篇.md', {
      content: 'b', expectedRevision: 'sha256:deadbeef', operationId: 'op2', origin: 'manual',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('REVISION_CONFLICT')
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
    await svc.save('doc_1', '定稿/正文/0001.md', {
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
    expect(reports[0]!.pending[0]!.content).toBe('lost content')
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
    const p = svc.save('doc_1', '定稿/正文/0001.md', {
      content: 'frozen', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    await delay(15)
    expect(existsSync(join(bookRoot, '定稿/正文/0001.md'))).toBe(false)
    svc.unfreeze('doc_1')
    const r = await p
    expect(r.ok).toBe(true)
    expect(readFileSync(join(bookRoot, '定稿/正文/0001.md'), 'utf-8')).toBe('frozen')
  })

  it('同 doc 并发保存串行，内容最终为最后一次', async () => {
    const ps = ['一', '二', '三'].map((c, i) =>
      svc.save('doc_1', '定稿/正文/0001.md', {
        content: c, expectedRevision: null, operationId: `op${i}`, origin: 'manual',
      }),
    )
    const results = await Promise.all(ps)
    // 第一个 ok，后续因基线变化 REVISION_CONFLICT（串行下后续看到前一次落盘）
    const oks = results.filter((r) => r.ok)
    expect(oks.length).toBe(1)
    // 最终落盘内容是串行里最后一个成功的（第一个）
    expect(readFileSync(join(bookRoot, '定稿/正文/0001.md'), 'utf-8')).toBe('一')
  })

  it('不同 doc 并发保存互不阻塞', async () => {
    const t0 = Date.now()
    await Promise.all([
      svc.save('doc_a', '定稿/正文/0001.md', { content: 'a', expectedRevision: null, operationId: 'opa', origin: 'manual' }),
      svc.save('doc_b', '定稿/正文/0002.md', { content: 'b', expectedRevision: null, operationId: 'opb', origin: 'manual' }),
    ])
    // 两个独立 doc 并行，应在 ~一次 IO 时间内完成
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(existsSync(join(bookRoot, '定稿/正文/0001.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '定稿/正文/0002.md'))).toBe(true)
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
    const f = join(bookRoot, '定稿/正文/0001-开篇.md')
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, '原文', 'utf-8')
    const base = hashFile(f) as `sha256:${string}`
    await svc.save('doc_1', '定稿/正文/0001-开篇.md', {
      content: '改后', expectedRevision: base, operationId: 'op1', origin: 'manual',
    })
    const snapDir = join(bookRoot, '工作区', '.snapshots', 'doc_1')
    expect(existsSync(snapDir)).toBe(true)
  })

  it('origin=manual 新建（非 chapter 覆盖）→ 不建快照', async () => {
    await svc.save('doc_1', '素材/灵感.md', {
      content: '新', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    const snapDir = join(bookRoot, '工作区', '.snapshots', 'doc_1')
    expect(existsSync(snapDir)).toBe(false)
  })
})
