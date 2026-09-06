/**
 * R51-F-7a（五十一轮）回归：导出全空白（非空串）正文章不再计入章数产空壳。
 *
 * readUnitBody 判空此前 `!r.body`——纯空行/空白符正文（非空串）判不住，照常计入
 * chapterCount 并在产物中产出空壳章节（标题行 + 空段）。修复：trim 判空，与空正文
 * 同口径记 warnings 跳过。
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportBook } from '../../src/export/index.js'

function makeLongBook(title: string): string {
  const root = mkdtempTracked(join(tmpdir(), 'r51-f7-export-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'book:', `  title: ${title}`, '  genre: 玄幻'].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  return root
}

function writeChapterFile(root: string, num: number, title: string, body: string): void {
  writeFileSync(join(root, '写作', '正文', `${num}-${title}.md`), `---\n章号: ${num}\n标题: ${title}\n---\n${body}`, 'utf-8')
}

test('R51-F-7a: 全空白正文章 → 记警告跳过，不计章数、不出空壳', () => {
  const root = makeLongBook('空白章书')
  writeChapterFile(root, 1, '真实章', '雪落在了城墙上。')
  // 全空白正文：非空串（纯空行 + 空白符）——修复前 !r.body 判不住
  writeChapterFile(root, 2, '空白章', '\n\n   \n\t\n')
  try {
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.chapterCount).toBe(1) // 只计真实章（修复前 2）
    expect(r.warnings?.some((w) => w.includes('空白章') && w.includes('正文为空'))).toBe(true)
    const merged = readFileSync(join(root, '工作区', '导出', '全本-空白章书.md'), 'utf-8')
    expect(merged).toContain('# 真实章')
    expect(merged).not.toContain('# 空白章') // 空壳章节不产出（修复前出标题行 + 空段）
    expect(merged).toContain('雪落在了城墙上')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R51-F-7a: 全部空白 → 零可写章按既有失败口径收口（不产空书）', () => {
  const root = makeLongBook('全空白书')
  writeChapterFile(root, 1, '空一章', '\n\n')
  try {
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.chapterCount).toBe(0)
    expect(r.error).toContain('正文全部为空')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
