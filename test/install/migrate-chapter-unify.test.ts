import { test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateChapterUnify } from '../../src/install/migrate-chapter-unify.js'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clw-unify-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** 写占位文件（自动建父目录）。 */
function write(rel: string, content = '占位'): void {
  const segs = rel.split('/')
  mkdirSync(join(tmp, ...segs.slice(0, -1)), { recursive: true })
  writeFileSync(join(tmp, ...segs), content, 'utf-8')
}

/** 判相对路径是否存在。 */
function has(rel: string): boolean {
  return existsSync(join(tmp, ...rel.split('/')))
}

/** 造一个旧格式短篇书（book.yaml kind=short + 旧 fm 篇号 + 旧目录 大纲/清单） */
function makeShortBook(): void {
  write('book.yaml', 'kind: short\n')
  write('写作/正文/001-雨夜门铃.md', '---\n篇号: 1\n标题: 雨夜门铃\n---\n正文1\n')
  write('写作/正文/002-中奖彩票.md', '---\n篇号: 2\n标题: 中奖彩票\n---\n正文2\n')
  write('大纲/清单/001-雨夜门铃.md', '## 反转线索表\n- 核心反转：a\n')
  write('大纲/清单/002-中奖彩票.md', '## 反转线索表\n- 核心反转：b\n')
}

test('短篇书：fm 篇号→章号 + 目录 大纲/清单→大纲/章纲', () => {
  makeShortBook()
  const r = migrateChapterUnify(tmp)
  expect(r.errors).toEqual([])
  expect(r.migrated).toBeGreaterThan(0)

  // 正文 fm 已改为 章号
  expect(readFileSync(join(tmp, '写作/正文/001-雨夜门铃.md'), 'utf-8')).toContain('章号: 1')
  expect(readFileSync(join(tmp, '写作/正文/001-雨夜门铃.md'), 'utf-8')).not.toContain('篇号:')
  expect(readFileSync(join(tmp, '写作/正文/002-中奖彩票.md'), 'utf-8')).toContain('章号: 2')

  // 目录已迁移
  expect(has('大纲/章纲/001-雨夜门铃.md')).toBe(true)
  expect(has('大纲/清单/001-雨夜门铃.md')).toBe(false)
})

test('幂等：重复调用 no-op（不重复改 fm / 不重复搬目录）', () => {
  makeShortBook()
  migrateChapterUnify(tmp)
  const contentAfterFirst = readFileSync(join(tmp, '写作/正文/001-雨夜门铃.md'), 'utf-8')
  const r2 = migrateChapterUnify(tmp)
  expect(r2.errors).toEqual([])
  expect(readFileSync(join(tmp, '写作/正文/001-雨夜门铃.md'), 'utf-8')).toBe(contentAfterFirst)
})

test('长篇书：no-op（不迁移）', () => {
  write('book.yaml', 'kind: long\n')
  write('写作/正文/第一卷/0001-开篇.md', '---\n章号: 1\n标题: 开篇\n---\n正文\n')
  const r = migrateChapterUnify(tmp)
  expect(r.migrated).toBe(0)
  expect(r.errors).toEqual([])
  // 长篇不受影响
  expect(readFileSync(join(tmp, '写作/正文/第一卷/0001-开篇.md'), 'utf-8')).toContain('章号: 1')
})

test('已迁移书：no-op（fm 已是章号 + 目录已是章纲）', () => {
  write('book.yaml', 'kind: short\n')
  write('写作/正文/001-雨夜门铃.md', '---\n章号: 1\n标题: 雨夜门铃\n---\n正文1\n')
  write('大纲/章纲/001-雨夜门铃.md', '## 反转线索表\n- 核心反转：a\n')
  const r = migrateChapterUnify(tmp)
  expect(r.migrated).toBe(0)
  expect(r.errors).toEqual([])
  expect(readFileSync(join(tmp, '写作/正文/001-雨夜门铃.md'), 'utf-8')).toContain('章号: 1')
})