/**
 * 残留清偿批（三十四轮）回归：docId 收编链全异步化。
 * 同步 resolvePath/lookupPathByDocId/adoptLegacyDoc/upsertManifestEntry 已删——
 * 本文件锚定异步孪生（resolvePathAsync → lookupPathByDocIdAdoptAsync →
 * upsertManifestEntryAsync）的收编语义与 executeSave 前段 await 迁移后的保存链。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentService } from '../../src/document/service.js'
import { legacyId } from '../../src/document/stable-id.js'
import { readManifestStrict } from '../../src/document/manifest.js'
import { computeRevision } from '../../src/document/revision.js'

/** v2 结构旧文件（稳定 ID 上线前就在盘上，无清单登记）。 */
const LEGACY_CHAPTER = '写作/正文/0099-旧章.md'
const DOCID = legacyId(LEGACY_CHAPTER)

let bookRoot = ''
let svc: DocumentService

beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'r34d-res-'))
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(bookRoot, LEGACY_CHAPTER), '---\n章号: 99\n标题: 旧章\n---\n正文。')
  svc = new DocumentService({ bookRoot })
})
afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

describe('resolvePathAsync（残留清偿：同步收编链已删，异步孪生为唯一实现）', () => {
  it('legacy 未登记 → 扫盘反查收编：返回路径 + 清单落登记', async () => {
    const path = await svc.resolvePathAsync(DOCID)
    expect(path).toBe(LEGACY_CHAPTER)
    // 收编落盘：清单出现该 docId（异步清单锁 RMW 的可见效果）
    const m = readManifestStrict(join(bookRoot, '项目', '文档清单.jsonl'))
    expect(m?.entries.get(DOCID)?.path).toBe(LEGACY_CHAPTER)
  })

  it('收编后二读走清单命中（不依赖盘上文件仍在）', async () => {
    await svc.resolvePathAsync(DOCID)
    // 文件移走后清单命中仍返回登记路径（与原同步版同口径：命中读在收编之前）
    rmSync(join(bookRoot, LEGACY_CHAPTER))
    expect(await svc.resolvePathAsync(DOCID)).toBe(LEGACY_CHAPTER)
  })

  it('非 legacy 未登记 → null 且不建清单（无写动作）', async () => {
    expect(await svc.resolvePathAsync('doc_not_registered')).toBeNull()
    expect(existsSync(join(bookRoot, '项目', '文档清单.jsonl'))).toBe(false)
  })
})

describe('executeSave 前段收编（R27-43 → 残留清偿批 await 迁移）', () => {
  it('legacy docId 直接保存 → 前段收编 + 落盘 + 清单登记一次成链', async () => {
    const r = await svc.save(DOCID, LEGACY_CHAPTER, {
      content: '---\n章号: 99\n标题: 旧章\n---\n新正文。',
      expectedRevision: computeRevision(join(bookRoot, LEGACY_CHAPTER)),
      operationId: 'op-r34d-res-1',
      origin: 'manual',
    })
    expect(r.ok).toBe(true)
    expect(readFileSync(join(bookRoot, LEGACY_CHAPTER), 'utf-8')).toContain('新正文。')
    const m = readManifestStrict(join(bookRoot, '项目', '文档清单.jsonl'))
    expect(m?.entries.get(DOCID)?.path).toBe(LEGACY_CHAPTER)
  })

  it('前段收编抛出（清单锁超时）→ WRITE_ERROR 信封 resolve（R27-43 契约，await 迁移后同形）', async () => {
    const target = svc as unknown as { lookupPathByDocIdAdoptAsync: (id: string) => Promise<string | null> }
    const real = target.lookupPathByDocIdAdoptAsync.bind(svc)
    let calls = 0
    vi.spyOn(target, 'lookupPathByDocIdAdoptAsync').mockImplementation((id: string) => {
      calls++
      // 第一次 = 前段（抛点，锁内复核不再到达）；断言与 R28-5 的第二次抛点互为镜像
      if (calls === 1) return Promise.reject(new Error('清单锁获取超时（模拟 withManifestLockAsync 2×5s fail-closed）'))
      return real(id)
    })
    const r = await svc.save('doc_r34d_front', '写作/正文/0001.md', {
      content: 'x',
      expectedRevision: null,
      operationId: 'op-r34d-res-2',
      origin: 'manual',
    })
    expect(calls).toBe(1)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('WRITE_ERROR')
      expect(r.reason).toContain('保存前清单查询失败')
      expect(r.reason).toContain('清单锁获取超时')
    }
  })
})
