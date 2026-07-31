/**
 * M1 草稿覆写留底单测（最小修缮方案）。
 *
 * snapshotBeforeOverwrite 纯函数：覆写前检测 + force 快照。
 * 范式同 kind-branches：临时目录 fixture，不起 HTTP、不调大模型。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotBeforeOverwrite } from '../../src/studio/server/api/draft.js'

let root = ''
const REL = '工作区/草稿-42.md'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-draft-m1-'))
  mkdirSync(join(root, '工作区'), { recursive: true })
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

/** 列指定 docId 目录下的快照文件 */
function snapshotFiles(docId: string): string[] {
  const dir = join(root, '工作区', '.snapshots', docId)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.md'))
}

describe('snapshotBeforeOverwrite(M1 覆写留底)', () => {
  it('已有草稿且内容不同 → 留快照（旧内容 + origin draft-overwrite）', () => {
    writeFileSync(join(root, REL), '旧稿：他把烟摁灭。', 'utf8')
    const id = snapshotBeforeOverwrite(root, REL, '新稿：重生成的内容。')
    expect(id).not.toBeNull()
    // 未登记清单 → 文件名派生键
    const files = snapshotFiles('草稿-42')
    expect(files).toHaveLength(1)
    const snap = readFileSync(join(root, '工作区', '.snapshots', '草稿-42', files[0]!), 'utf8')
    expect(snap).toContain('旧稿：他把烟摁灭。')
    expect(snap).toContain('来源: draft-overwrite')
    expect(snap).not.toContain('新稿')
  })

  it('内容相同 → 不留', () => {
    writeFileSync(join(root, REL), '同一份内容', 'utf8')
    expect(snapshotBeforeOverwrite(root, REL, '同一份内容')).toBeNull()
    expect(snapshotFiles('草稿-42')).toHaveLength(0)
  })

  it('目标文件不存在（首次生成）→ 不留', () => {
    expect(snapshotBeforeOverwrite(root, REL, '首稿')).toBeNull()
    expect(existsSync(join(root, '工作区', '.snapshots'))).toBe(false)
  })

  it('清单已登记 → 快照落真 docId 目录（与编辑器历史同目录可恢复）', () => {
    writeFileSync(join(root, REL), '旧稿', 'utf8')
    mkdirSync(join(root, '项目'), { recursive: true })
    const lines = [
      JSON.stringify({ version: 1, type: 'header' }),
      JSON.stringify({ id: 'doc-abc123', nodeType: 'document', path: REL, parentId: null, status: 'draft' }),
    ]
    writeFileSync(join(root, '项目', '文档清单.jsonl'), lines.join('\n') + '\n', 'utf8')
    const id = snapshotBeforeOverwrite(root, REL, '新稿')
    expect(id).not.toBeNull()
    expect(snapshotFiles('doc-abc123')).toHaveLength(1)
    expect(snapshotFiles('草稿-42')).toHaveLength(0)
  })

  it('连续覆写 → 每次都留（force 绕节流）', () => {
    writeFileSync(join(root, REL), '版本1', 'utf8')
    expect(snapshotBeforeOverwrite(root, REL, '版本2')).not.toBeNull()
    writeFileSync(join(root, REL), '版本2', 'utf8')
    expect(snapshotBeforeOverwrite(root, REL, '版本3')).not.toBeNull()
    expect(snapshotFiles('草稿-42')).toHaveLength(2)
  })

  it('短篇固定名 草稿-1.md 同样受保护', () => {
    const shortRel = '工作区/草稿-1.md'
    writeFileSync(join(root, shortRel), '第1篇草稿', 'utf8')
    const id = snapshotBeforeOverwrite(root, shortRel, '第2篇草稿盖过来')
    expect(id).not.toBeNull()
    const files = snapshotFiles('草稿-1')
    expect(files).toHaveLength(1)
    expect(readFileSync(join(root, '工作区', '.snapshots', '草稿-1', files[0]!), 'utf8')).toContain('第1篇草稿')
  })
})
