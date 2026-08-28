/**
 * R72-1（二十轮 B-1）回归：保存临界段跨进程锁。
 *
 * B-1：executeSave 的「revision 校验 → atomicWrite → settled」段原先无跨进程互斥，
 * 双进程同基线并发保存同一文档时后写者静默覆盖先写者（lost update）。修复后该段套
 * per-doc 保存锁（`<journal>.save.lock`，与 journal append 自身的 `<journal>.lock`
 * 同目录不同名，防同进程嵌套自锁）。
 *
 * 本文件验证锁路径三态：
 * 1. 忙等拒绝——他进程「存活」持锁时保存按 WRITE_ERROR 拒绝且文件未被写；
 * 2. 释放干净——正常保存完成后锁文件不在盘（不残留、不阻塞后续保存）；
 * 3. 死进程 stale 接管——崩溃残留锁被接管，保存照常成功（锁基建语义在 save 链生效）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { DocumentService } from '../../src/document/service.js'
import { processBootTime } from '../../src/fs/cross-process-lock.js'

describe('R72-1 / 保存临界段跨进程锁', () => {
  let bookRoot: string
  let svc: DocumentService
  let journalPath: string
  let lockPath: string

  beforeEach(() => {
    bookRoot = mkdtempSync(join(tmpdir(), 'r72-lock-'))
    mkdirSync(join(bookRoot, '工作区'), { recursive: true })
    svc = new DocumentService({ bookRoot })
    journalPath = join(bookRoot, '工作区', '.journal', 'doc_1.jsonl')
    lockPath = `${journalPath}.save.lock`
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  function save() {
    return svc.save('doc_1', '写作/正文/0001-开篇.md', {
      content: '新内容',
      expectedRevision: null,
      operationId: 'op1',
      origin: 'manual',
    })
  }

  it('他进程存活持锁 → WRITE_ERROR 拒绝，文件未被写入', async () => {
    // 预置一把「活进程」锁：pid = 本进程（必然存活），save 应忙等超时前先判 held 拒绝。
    // 直接注入锁文件模拟另一进程在临界段内（内容格式与锁基建一致）。
    mkdirSync(dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, bootTime: processBootTime() }), 'utf-8')
    const r = await save()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('WRITE_ERROR')
      expect(r.reason).toContain('另一进程正在保存')
    }
    expect(existsSync(join(bookRoot, '写作/正文/0001-开篇.md'))).toBe(false)
    // 拒绝路径不得删掉他人在位锁
    expect(existsSync(lockPath)).toBe(true)
  })

  it('正常保存后锁释放干净，后续保存不受阻', async () => {
    const r1 = await save()
    expect(r1.ok).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
    // 锁已释放：再次保存（覆盖，走合法基线）照常成功
    if (!r1.ok) throw new Error('prereq')
    const f = join(bookRoot, '写作/正文/0001-开篇.md')
    const r2 = await svc.save('doc_1', '写作/正文/0001-开篇.md', {
      content: '第二版', expectedRevision: r1.revision, operationId: 'op2', origin: 'manual',
    })
    expect(r2.ok).toBe(true)
    expect(readFileSync(f, 'utf-8')).toBe('第二版')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('崩溃残留锁（死 pid）→ stale 接管，保存照常成功', async () => {
    // 找一个几乎不可能存活的 pid：spawn 一下不可执行的探测不值得，直接用
    // process.platform 无关的极大 pid（> pid_max 4194304 on linux；mac 上同样无此进程）。
    mkdirSync(dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, JSON.stringify({ pid: 4_194_999, bootTime: processBootTime() }), 'utf-8')
    const r = await save()
    expect(r.ok).toBe(true)
    expect(existsSync(join(bookRoot, '写作/正文/0001-开篇.md'))).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
  })
})
