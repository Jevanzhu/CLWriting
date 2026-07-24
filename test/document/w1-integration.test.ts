/**
 * W1 保存安全补齐集成测（T10）—— 覆盖 §9 测试矩阵中 T5-T9 未专项覆盖的项：
 * 原子性中断（落盘失败目标不变）、symlink 越出、保存不建清单、
 * snapshot restore 覆盖前、service 层 superseded 传播。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  readdirSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { DocumentService } from '../../src/document/service.js'
import { hashFile } from '../../src/fs/hash.js'

describe('W1 / 原子性与路径安全', () => {
  let bookRoot: string
  let svc: DocumentService
  beforeEach(() => {
    bookRoot = mkdtempSync(join(tmpdir(), 'w1-'))
    mkdirSync(join(bookRoot, '工作区'), { recursive: true })
    svc = new DocumentService({ bookRoot })
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('落盘失败（只读目录）→ WRITE_ERROR，目标文件不变（无半截）', async () => {
    const roDir = join(bookRoot, '素材')
    mkdirSync(roDir, { recursive: true })
    const f = join(roDir, 'x.md')
    writeFileSync(f, '原文')
    const base = hashFile(f) as `sha256:${string}`
    chmodSync(roDir, 0o555)
    try {
      const r = await svc.save('doc_x', '素材/x.md', {
        content: '新内容', expectedRevision: base, operationId: 'op1', origin: 'manual',
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('WRITE_ERROR')
      // 目标不变（atomicWriteFile 失败已清 tmp，未 rename → 无半截）
      expect(readFileSync(f, 'utf-8')).toBe('原文')
    } finally {
      chmodSync(roDir, 0o755) // 恢复以便 afterEach rmSync
    }
  })

  it('symlink 越出书仓库 → PATH_ESCAPE，不落盘', async () => {
    mkdirSync(join(bookRoot, '定稿', '正文'), { recursive: true })
    symlinkSync('/etc/passwd', join(bookRoot, '定稿', '正文', 'link.md'))
    const r = await svc.save('doc_l', '定稿/正文/link.md', {
      content: 'x', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('PATH_ESCAPE')
  })
})

describe('W1 / 清单与快照策略', () => {
  let bookRoot: string
  let svc: DocumentService
  beforeEach(() => {
    bookRoot = mkdtempSync(join(tmpdir(), 'w1m-'))
    mkdirSync(join(bookRoot, '工作区'), { recursive: true })
    svc = new DocumentService({ bookRoot })
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('旧书无清单，保存成功但不创建清单（保存不算结构性操作）', async () => {
    const r = await svc.save('doc_1', '素材/x.md', {
      content: 'x', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    expect(r.ok).toBe(true)
    expect(existsSync(join(bookRoot, '项目', '文档清单.jsonl'))).toBe(false)
  })

  it('origin=restore 覆盖前建快照（内容=改前磁盘版）', async () => {
    const f = join(bookRoot, '素材', 'r.md')
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, '原文')
    const base = hashFile(f) as `sha256:${string}`
    await svc.save('doc_r', '素材/r.md', {
      content: '恢复版', expectedRevision: base, operationId: 'op1', origin: 'restore',
    })
    const snapDir = join(bookRoot, '工作区', '.snapshots', 'doc_r')
    expect(existsSync(snapDir)).toBe(true)
    const snaps = readdirSync(snapDir).filter((n) => n.endsWith('.md'))
    expect(snaps.length).toBe(1)
    expect(readFileSync(join(snapDir, snaps[0]!), 'utf-8')).toContain('原文')
  })
})

describe('W1 / superseded 传播', () => {
  let bookRoot: string
  let svc: DocumentService
  beforeEach(() => {
    bookRoot = mkdtempSync(join(tmpdir(), 'w1s-'))
    mkdirSync(join(bookRoot, '工作区'), { recursive: true })
    svc = new DocumentService({ bookRoot })
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  it('同 doc 连续保存，旧请求完成时标记 superseded=true', async () => {
    // freeze 制造排队时序：两个都入队后 unfreeze，保证第一个 run 时第二个已入队
    svc.freeze('doc_s')
    const p1 = svc.save('doc_s', '素材/s.md', {
      content: '一', expectedRevision: null, operationId: 'op1', origin: 'manual',
    })
    const p2 = svc.save('doc_s', '素材/s.md', {
      content: '二', expectedRevision: null, operationId: 'op2', origin: 'manual',
    })
    svc.unfreeze('doc_s')
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.superseded).toBe(true) // 完成时 op2 已入队（maxToken=2）
    expect(r2.ok).toBe(false) // null 撞 p1 落盘 → 冲突
  })
})
