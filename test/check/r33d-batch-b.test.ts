/**
 * R33D（三十三轮）批 B 回归——机检/格式三件：
 *
 * - R33D-3：readLeadUpdateChapterTag 剥 BOM——带 BOM + 章标签的账本推进此前 tag 恒
 *   null（mainIsThisChapter 对任意章为 true → 跨章履历污染）。
 * - R33D-14：声明侧读失败标记 reason:'read-failed'（机检产黄项的判定源；chapter-mismatch
 *   维持静默）。
 * - R33D-17：writeTreeIssuesCacheBatch 单事务包批（行数正确落盘 + 批失败回退逐行）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readLeadUpdateChapterTag } from '../../src/check/lead-updates.js'
import { outlineDeclarationForChapter } from '../../src/check/outline-leads.js'
import { writeTreeIssuesCacheBatch, readTreeIssuesCache, type TreeIssuesCacheRow } from '../../src/check/tree-issues-cache.js'
import { ensureTreeIssuesTables } from '../../src/cache/schema.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'r33d-batch-b-'))
  dirs.push(d)
  return d
}

describe('R33D-3：账本推进章标签剥 BOM', () => {
  it('带 BOM 的 `\\uFEFF# 第5章` → tag=5（此前恒 null）', () => {
    const root = tmp()
    const fp = join(root, '账本推进.md')
    writeFileSync(fp, '\uFEFF# 第5章 账本推进\n- 悬念-001 递进：证据。\n', 'utf-8')
    expect(readLeadUpdateChapterTag(fp)).toBe(5)
  })

  it('无 BOM 行为不变；无标签 → null（回归）', () => {
    const root = tmp()
    const fp = join(root, '账本推进.md')
    writeFileSync(fp, '# 第3章 账本推进\n', 'utf-8')
    expect(readLeadUpdateChapterTag(fp)).toBe(3)
    writeFileSync(fp, '- 无标题条目\n', 'utf-8')
    expect(readLeadUpdateChapterTag(fp)).toBeNull()
  })
})

describe('R33D-14：声明侧读失败 reason 标记', () => {
  it('细纲在位但不可读（目录占位）→ known:false + reason:read-failed', () => {
    const root = tmp()
    mkdirSync(join(root, '工作区', '细纲.md'), { recursive: true })
    const d = outlineDeclarationForChapter(root, 1)
    expect(d.known).toBe(false)
    expect(d.reason).toBe('read-failed')
  })

  it('细纲属他章 → known:false + reason:chapter-mismatch（非故障，不产黄）', () => {
    const root = tmp()
    mkdirSync(join(root, '工作区'), { recursive: true })
    writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 2\n推进: 成长线-001\n---\n\n本章细纲。\n', 'utf-8')
    const d = outlineDeclarationForChapter(root, 1)
    expect(d.known).toBe(false)
    expect(d.reason).toBe('chapter-mismatch')
  })

  it('正常细纲 → known:true 且无 reason', () => {
    const root = tmp()
    mkdirSync(join(root, '工作区'), { recursive: true })
    writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 1\n推进: 成长线-001\n---\n\n本章细纲。\n', 'utf-8')
    const d = outlineDeclarationForChapter(root, 1)
    expect(d.known).toBe(true)
    expect(d.leads).toEqual(['成长线-001'])
    expect(d.reason).toBeUndefined()
  })
})

describe('R33D-17：章缓存批量落盘单事务', () => {
  function makeDb(): { db: DatabaseSync; path: string } {
    const root = tmp()
    const path = join(root, 'index.db')
    const db = new DatabaseSync(path)
    ensureTreeIssuesTables(db)
    return { db, path }
  }

  it('多行一次批量写入 → 全部可读（单 COMMIT）', () => {
    const { db } = makeDb()
    const rows: TreeIssuesCacheRow[] = Array.from({ length: 50 }, (_, i) => ({
      relPath: `写作/正文/${String(i + 1).padStart(3, '0')}-章.md`,
      chapterFp: 1_700_000_000_000_000 + i,
      size: 100 + i,
      verdictFp: null,
      value: { hasRed: i % 2 === 0, verdictRejected: false },
    }))
    writeTreeIssuesCacheBatch(db, rows)
    for (const r of rows) {
      const got = readTreeIssuesCache(db, r.relPath, r.chapterFp, r.size, r.verdictFp)
      expect(got).toEqual(r.value)
    }
    db.close()
  })

  it('空数组 → no-op 不抛', () => {
    const { db } = makeDb()
    expect(() => writeTreeIssuesCacheBatch(db, [])).not.toThrow()
    db.close()
  })
})
