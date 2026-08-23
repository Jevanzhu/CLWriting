/**
 * Y-3（第五十七轮）回归——saveDraft 覆写守卫两件：
 *
 * ① 留底 fail-closed：快照 IO 失败（.版本 不可写）时拒绝覆写上抛——此前降级 null
 *   后照常覆写，M1「作者手改不静默丢失」在 IO 抖动下失守。
 * ② 回收站双认领守卫：目标文件在盘且回收站登记仍认领同一路径（restoreTrash 半途
 *   崩溃态）→ 中止上抛；路径不存在的「删后重写」放行（旧内容在回收站，故意重写不受阻）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { saveDraft } from '../../src/process/draft-pipeline.js'
import { appendTrashEntry } from '../../src/document/trash.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-y3-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const OLD = '---\n章号: 5\n标题: 旧稿\n---\n\n旧正文。'
const NEW = '---\n章号: 5\n标题: 新稿\n---\n\n新正文。'

function putChapter(rel: string, content: string): void {
  writeFileSync(join(root, rel), content)
}

describe('Y-3: saveDraft 留底 fail-closed', () => {
  it('快照写失败（.版本 是文件）→ 拒绝覆写上抛，原文件不动', () => {
    putChapter('写作/正文/0005-旧稿.md', OLD)
    // .版本 做成普通文件 → writeSnapshot 的 mkdir 必败
    mkdirSync(join(root, '工作区'), { recursive: true })
    writeFileSync(join(root, '工作区', '.版本'), 'not-a-dir')
    expect(() => saveDraft(root, 5, NEW)).toThrow()
    expect(readFileSync(join(root, '写作/正文/0005-旧稿.md'), 'utf-8')).toBe(OLD)
  })

  it('正常覆写：先留底后写盘，snapshotted=true', () => {
    putChapter('写作/正文/0005-旧稿.md', OLD)
    const r = saveDraft(root, 5, NEW)
    expect(r.snapshotted).toBe(true)
    expect(readFileSync(join(root, '写作/正文/0005-旧稿.md'), 'utf-8')).toBe(NEW)
  })
})

describe('Y-3: saveDraft 回收站双认领守卫', () => {
  it('文件在盘 + 回收站认领同路径 → 中止上抛，文件不动', () => {
    putChapter('写作/正文/0005-旧稿.md', OLD)
    mkdirSync(join(root, '工作区', '.trash'), { recursive: true })
    writeFileSync(join(root, '工作区', '.trash', 'doc_y3-旧稿.md'), OLD)
    appendTrashEntry(root, {
      id: 'doc_y3',
      originalPath: '写作/正文/0005-旧稿.md',
      trashedPath: '工作区/.trash/doc_y3-旧稿.md',
      trashedAt: '2026-08-24T00:00:00Z',
      role: 'chapter',
    })
    expect(() => saveDraft(root, 5, NEW)).toThrow(/回收站/)
    expect(readFileSync(join(root, '写作/正文/0005-旧稿.md'), 'utf-8')).toBe(OLD)
  })

  it('路径不在盘（删后重写）→ 放行落盘，不受回收站旧条目牵连', () => {
    // 回收站里有同路径旧条目，但文件已不在盘（正常软删形态）
    mkdirSync(join(root, '工作区', '.trash'), { recursive: true })
    writeFileSync(join(root, '工作区', '.trash', 'doc_y3b-新稿.md'), OLD)
    appendTrashEntry(root, {
      id: 'doc_y3b',
      originalPath: '写作/正文/第一卷/0005-新稿.md',
      trashedPath: '工作区/.trash/doc_y3b-新稿.md',
      trashedAt: '2026-08-24T00:00:00Z',
      role: 'chapter',
    })
    const r = saveDraft(root, 5, NEW) // 新章生成路径 = 写作/正文/第一卷/0005-新稿.md
    expect(r.relPath).toBe('写作/正文/第一卷/0005-新稿.md')
    expect(existsSync(join(root, r.relPath))).toBe(true)
  })
})
