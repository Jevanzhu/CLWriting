/**
 * 保存链规范形收口回归（平台规范化批一 B，2026-09-03）：
 *
 * save/createDocument 的内容入口 canonicalizeText（剥 BOM、CRLF→LF）——编辑器/API/
 * files.ts PUT 的总闸；copyDocument 对「UTF-8 且需规范」的源做规范化复制（非 UTF-8
 * 源字节级保真不动，P5-数据层防线）。历史版本快照 / journal / spills 不在本闸面
 * （字节保真优先，随源字节派生）。
 */
import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentService } from '../../src/document/service.js'

let bookRoot: string
beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'clw-canonical-save-'))
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
})
afterEach(() => {
  rmSync(bookRoot, { recursive: true, force: true })
})

test('save：CRLF + BOM 内容落盘为 LF 无 BOM（编辑器/API 总闸）', async () => {
  const svc = new DocumentService({ bookRoot })
  const rel = '设定/世界观.md'
  const c = await svc.createDocument({ relPath: rel, content: '---\n名称: A\n---\n第一版' })
  if (!c.ok) throw new Error(`prereq create: ${JSON.stringify(c)}`)

  const s = await svc.save(c.docId, rel, {
    content: '---\n名称: A\n---\n\r\n正文第一段。\r\n正文第二段。\r\n',
    expectedRevision: c.revision,
    operationId: 'op-canonical-1',
    origin: 'manual',
  })
  expect(s.ok).toBe(true)
  const onDisk = readFileSync(join(bookRoot, ...rel.split('/')), 'utf-8')
  expect(onDisk.includes('\r')).toBe(false) // CRLF 全归一
  expect(onDisk).toContain('\n正文第一段。\n正文第二段。\n')
})

test('createDocument：BOM + CRLF 初稿内容生而规范', async () => {
  const svc = new DocumentService({ bookRoot })
  const rel = '设定/力量体系.md'
  const c = await svc.createDocument({ relPath: rel, content: '---\n名称: 体系\n---\n\uFEFF境界划分。\r\n' })
  expect(c.ok).toBe(true)
  const onDisk = readFileSync(join(bookRoot, ...rel.split('/')), 'utf-8')
  expect(onDisk.startsWith('---\n')).toBe(true) // 无 BOM（fence 直接开头）
  expect(onDisk.includes('\r')).toBe(false)
  expect(onDisk).toContain('境界划分。\n')
})

test('copyDocument：CRLF 源规范化复制；非 UTF-8 源字节保真', async () => {
  const svc = new DocumentService({ bookRoot })
  // ① CRLF 源 → 副本规范形
  const src = await svc.createDocument({ relPath: '设定/原稿.md', content: '原稿正文。\r\n第二行。\r\n' })
  if (!src.ok) throw new Error('prereq create')
  const cp = await svc.copyDocument({ docId: src.docId, relPath: '设定/副本.md' })
  expect(cp.ok).toBe(true)
  const copyOnDisk = readFileSync(join(bookRoot, '设定', '副本.md'), 'utf-8')
  expect(copyOnDisk.includes('\r')).toBe(false)
  expect(copyOnDisk).toContain('原稿正文。\n第二行。\n')

  // ② 非 UTF-8 源（GBK 字节「章」+CRLF）→ 副本字节级保真（P5 防线，不毁原始字节）
  const gbk = Buffer.from([0xd5, 0xc2, 0x0d, 0x0a]) // 「章」GBK + CRLF
  const rawRel = '设定/原始字节.md'
  const rawCreate = await svc.createDocument({ relPath: rawRel, content: '占位' })
  if (!rawCreate.ok) throw new Error('prereq create2')
  // 直接覆写盘上字节模拟外部非 UTF-8 文件（清单登记已在）
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(bookRoot, ...rawRel.split('/')), gbk)
  const cp2 = await svc.copyDocument({ docId: rawCreate.docId, relPath: '设定/原始字节副本.md' })
  expect(cp2.ok).toBe(true)
  expect(readFileSync(join(bookRoot, '设定', '原始字节副本.md')).equals(gbk)).toBe(true)
})
