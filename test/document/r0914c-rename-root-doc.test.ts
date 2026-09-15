/**
 * 重评-0914-三轮 P2-2（2026-09-14）回归：根级文档 rename 不得产 './' 前缀清单键。
 *
 * 背景：根级文档真实存在（GUI 建书脚手架必落 简介.md，src/install/scaffold.ts；
 * 自由 .md 经 roleOf 兜底 note、rename/move 能力全开）。rename 分支原直拼
 * `${dirname(oldPath)}/${newName}`，根级 dirname 为 '.' → 清单键 './新名.md'，而
 * docJoinKey/树扫描/保存守卫均不剥 './' → 登记与盘面分裂：docId 退化 legacyId
 * （.版本/.journal 关联断裂）+ 按树路径保存恒 REVISION_CONFLICT。move
 * （normalizeMoveToDir）/copy（doCopy 双拒 '.'/'..'）同族均已修，本文件锁 rename 特判。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentService } from '../../src/document/service.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { computeRevision } from '../../src/document/revision.js'

let bookRoot: string
let svc: DocumentService

beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'clw-r0914c-'))
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  svc = new DocumentService({ bookRoot })
})

afterEach(() => {
  rmSync(bookRoot, { recursive: true, force: true })
})

/** 造根级自由文档（盘上落盘 + 手工登记，模拟脚手架 简介.md 形态） */
function makeRootDoc(name: string, content: string): string {
  writeFileSync(join(bookRoot, name), content, 'utf-8')
  const mp = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(mp)
  const id = generateDocId()
  upsertEntry(m, { id, nodeType: 'document', path: name, parentId: null })
  writeManifest(mp, m)
  return id
}

function registeredPath(docId: string): string {
  return readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.get(docId)!.path
}

describe('重评-0914-三轮 P2-2: 根级文档 rename 不产 ./ 前缀清单键', () => {
  it('根级 rename → 清单键与返回路径均为裸新名，按树路径保存不再 REVISION_CONFLICT', async () => {
    const docId = makeRootDoc('旧名.md', '根级自由文档内容。')
    const r = await svc.renameDocument({ docId, newName: '新名.md' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe('新名.md') // 修复前：'./新名.md'
    expect(registeredPath(docId)).toBe('新名.md') // 修复前清单键 './新名.md' 与树扫描键失配
    expect(existsSync(join(bookRoot, '旧名.md'))).toBe(false)
    expect(existsSync(join(bookRoot, '新名.md'))).toBe(true)
    // 身份闭合：按树路径（无 ./ 前缀）保存命中同一 docId，恒 REVISION_CONFLICT 缺陷不复现
    const s = await svc.save(docId, '新名.md', {
      content: '改名后按树路径保存。',
      expectedRevision: computeRevision(join(bookRoot, '新名.md')),
      operationId: 'op-r0914c-0',
      origin: 'manual',
    })
    expect(s.ok).toBe(true)
  })

  it('非根级 rename 行为不变（清单键保持 目录/新名 形态）', async () => {
    mkdirSync(join(bookRoot, '笔记'), { recursive: true })
    writeFileSync(join(bookRoot, '笔记', '甲.md'), '子目录内容。', 'utf-8')
    const mp = join(bookRoot, '项目', '文档清单.jsonl')
    const m = readManifest(mp)
    const id = generateDocId()
    upsertEntry(m, { id, nodeType: 'document', path: '笔记/甲.md', parentId: null })
    writeManifest(mp, m)
    const r = await svc.renameDocument({ docId: id, newName: '乙.md' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe('笔记/乙.md')
    expect(registeredPath(id)).toBe('笔记/乙.md')
  })
})
