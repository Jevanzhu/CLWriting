/**
 * R73-36（二十一轮）回归：migrateFinalizedRevisions 的 join(bookRoot, e.path) 直拼
 * 改过 safe-path 校验（resolveWithinRoot 口径）。
 *
 * manifest 属可篡改数据面：`../` 越出条目此前可让 computeRevision 读到书仓库外文件
 * （外部文件字节 → finalizedRevision 基线，越界读 + 误标 final 断写双重风险）；修复后
 * 不合法条目跳过不设基线，合法 clean 条目照常设基线。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { execSync } from 'node:child_process'
import { migrateFinalizedRevisions } from '../../src/install/migrate-finalized-revision.js'
import { readManifest, writeManifest, upsertEntry, type Manifest } from '../../src/document/manifest.js'

describe('R73-36 / 定稿基线迁移 safe-path 校验', () => {
  let root: string
  let outsideFile: string

  beforeEach(() => {
    // 书根自带 .git（迁移前置检查 join(bookRoot,'.git')）；越界目标放书根外的临时目录
    root = mkdtempSync(join(tmpdir(), 'r73-mig-'))
    outsideFile = join(root, '..', `外部机密-${basename(root)}.md`)
    writeFileSync(outsideFile, '书仓库外的文件内容', 'utf-8')
    // 合法 clean 章节文件 + git 仓库（已提交 → porcelain 空 → 不在脏集）
    writeFileSync(join(root, '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n\n正文。\n', 'utf-8')
    execSync('git init -q && git add -A && git -c user.email=t@t.io -c user.name=t commit -qm init', { cwd: root, stdio: 'ignore' })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outsideFile, { force: true })
  })

  function seedManifest(escapePath: string): void {
    const m: Manifest = { version: 1, entries: new Map() }
    upsertEntry(m, { id: 'doc_ok', nodeType: 'document', path: '0001-开篇.md', parentId: null })
    upsertEntry(m, { id: 'doc_evil', nodeType: 'document', path: escapePath, parentId: null })
    mkdirSync(join(root, '项目'), { recursive: true })
    writeManifest(join(root, '项目', '文档清单.jsonl'), m)
  }

  it('../ 越出条目被跳过（不越界读、不误标 final），合法条目照常设基线', () => {
    seedManifest(`../${basename(outsideFile)}`)
    const n = migrateFinalizedRevisions(root)
    expect(n).toBe(1) // 仅 doc_ok
    const entries = readManifest(join(root, '项目', '文档清单.jsonl')).entries
    expect(entries.get('doc_ok')?.finalizedRevision).toMatch(/^sha256:/)
    expect(entries.get('doc_evil')?.finalizedRevision).toBeUndefined()
  })

  it('绝对路径条目同样被拒', () => {
    seedManifest(outsideFile)
    const n = migrateFinalizedRevisions(root)
    expect(n).toBe(1)
    expect(readManifest(join(root, '项目', '文档清单.jsonl')).entries.get('doc_evil')?.finalizedRevision).toBeUndefined()
  })
})
