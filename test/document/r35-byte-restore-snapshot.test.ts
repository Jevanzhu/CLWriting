/**
 * R35-4（三十五轮）回归：restore 字节档覆盖非 UTF-8 文件的「覆盖前留底」字节保真。
 *
 * byteRestore（Buffer 透传 save，R34D-18）是非 UTF-8 档（GBK 等）唯一合法覆写通道
 * ——M-5 防线对其放行。修复前 maybeSnapshot 未传磁盘内容，回退 utf-8 文本读：GBK
 * 盘上内容被解码成 U+FFFD 写入 .版本（假留底——覆写后原字节无任何副本、永久不可
 * 恢复）。修复后 byteRestore 路径传原始字节（同 doMoveOrRename / doTrash 原字节
 * 直存口径），版本快照与被覆盖文件逐字节一致。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DocumentService } from '../../src/document/service.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { listVersions, readVersionRaw, VERSIONS_DIR_NAME } from '../../src/document/version.js'
import { computeRevision } from '../../src/document/revision.js'

let bookRoot = ''
beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'clw-r35-4-'))
})
afterEach(() => {
  if (bookRoot) rmSync(bookRoot, { recursive: true, force: true })
})

test('R35-4: byteRestore 覆盖 GBK 档 → 覆盖前留底为字节保真快照（零 U+FFFD 损伤）', async () => {
  const svc = new DocumentService({ bookRoot })
  const docId = generateDocId()
  const rel = '写作/正文/0001-旧档.md'
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  // GBK 双字节序列（非合法 UTF-8，与 r34d-version-raw-bytes / r73-data-safety 口径一致）
  const gbk = Buffer.concat([
    Buffer.from('---\n章号: 1\n标题: 旧档\n---\n\n第一章 ', 'utf-8'),
    Buffer.from([0xbe, 0xc9, 0xb5, 0xb5]), // GBK「旧档」
    Buffer.from('\n正文继续\n', 'utf-8'),
  ])
  writeFileSync(join(bookRoot, rel), gbk)

  const r = await svc.save(docId, rel, {
    content: Buffer.from('---\n章号: 1\n标题: 旧档\n---\n\n恢复后的原始字节\n', 'utf-8'),
    expectedRevision: computeRevision(join(bookRoot, rel)),
    operationId: 'op-r35-4',
    origin: 'restore',
  })
  expect(r.ok).toBe(true)

  // 修复前：maybeSnapshot 回退 utf-8 文本读，快照是 U+FFFD 失真文本且 ≠ 原字节
  const versionsDir = join(bookRoot, '工作区', VERSIONS_DIR_NAME)
  const versions = listVersions(versionsDir, docId)
  expect(versions.length).toBe(1)
  const raw = readVersionRaw(versionsDir, docId, versions[0]!.id)
  expect(raw).not.toBeNull()
  expect(raw!.content.equals(gbk)).toBe(true)
  expect(raw!.content.includes(Buffer.from('\uFFFD', 'utf8'))).toBe(false)
  expect(raw!.meta.origin).toBe('restore')
})
