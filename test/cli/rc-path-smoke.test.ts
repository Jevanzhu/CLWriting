/**
 * RC 发布闸：中文 + 空格路径专项。
 *
 * 这条测试刻意覆盖安装器共用 scaffold、v0.2 导入、活动书解析、
 * 缓存重建、干净导出。CI matrix 含 windows-latest，因此它也是
 * Windows 中文路径专项证据入口。
 */

import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { importV02Book } from '../../src/import/index.js'
import { exportBook } from '../../src/export/index.js'
import { rebuild } from '../../src/cache/rebuild.js'
import { readActive, readBooks, resolveBookRoot } from '../../src/install/books.js'

const ORIG_CWD = process.cwd()

test('RC: 中文空格路径下导入 v0.2 → 重建缓存 → 导出成稿', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'CLWriting 中文 路径-'))
  try {
    mkdirSync(join(workDir, '.clwriting'), { recursive: true })
    const sourcePath = join(workDir, 'v0.2 旧书.md')
    const source = Array.from({ length: 5 }, (_, i) =>
      `第${i + 1}章：迁移章${i + 1}\n\n这是第${i + 1}章的正文内容，主角在中文路径里完成迁移验证。\n`,
    ).join('\n')
    writeFileSync(sourcePath, source, 'utf-8')

    const imported = importV02Book({
      sourcePath,
      workDir,
      name: '迁移 Smoke 书',
      kind: 'long',
      genre: '玄幻',
    })

    expect(imported.ok).toBe(true)
    expect(imported.chapterCount).toBe(5)
    expect(imported.bookRoot).toContain('迁移 Smoke 书')

    const bookRoot = imported.bookRoot!
    expect(readBooks(workDir).map((b) => b.name)).toContain('迁移 Smoke 书')
    expect(readActive(workDir)).toBe('迁移 Smoke 书')

    process.chdir(workDir)
    const resolved = resolveBookRoot([])
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(realpathSync(resolved.bookRoot)).toBe(realpathSync(bookRoot))

    const rebuilt = rebuild(bookRoot, join(bookRoot, '.cache', 'index.db'))
    expect(rebuilt.chapterCount).toBe(5)
    expect(rebuilt.errors).toHaveLength(0)

    const db = new DatabaseSync(join(bookRoot, '.cache', 'index.db'))
    const row = db.prepare('SELECT title FROM chapters WHERE number = 5').get() as { title: string }
    db.close()
    expect(row.title).toBe('迁移章5')

    const exported = exportBook({ bookRoot, format: 'both' })
    expect(exported.ok).toBe(true)
    expect(exported.files).toContain('工作区/导出/全本-迁移 Smoke 书.md')
    expect(exported.files).toContain('工作区/导出/分章/0005-迁移章5.md')

    const merged = readFileSync(join(bookRoot, '工作区', '导出', '全本-迁移 Smoke 书.md'), 'utf-8')
    expect(merged).toContain('# 迁移章1')
    expect(merged).not.toContain('钩子类型')
    expect(existsSync(join(bookRoot, '工作区', '导出', '分章', '0005-迁移章5.md'))).toBe(true)
  } finally {
    process.chdir(ORIG_CWD)
    rmSync(workDir, { recursive: true, force: true })
  }
})
