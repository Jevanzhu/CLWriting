/**
 * R49-7（评审 R49）：listMdRecursive 嵌套 AppleDouble（._）文件漏拦回归。
 *
 * recursive readdir 条目含子目录前缀（如 `卷一/._001.md`）——旧过滤 f.startsWith('._')
 * 只拦顶层，嵌套 ._ 文件漏拦，混进 countChapters 与 relations.mine 的正文节选
 * （拼 AI prompt）。修复后改段级判定：任一路径段以 `._` 开头即过滤（win/posix
 * 分隔符都顾）；扁平条目单段，与 overview.ts 等扁平版 startsWith 过滤行为一致。
 *
 * 观测面：导出的 getSettingsCached（R46-16 缓存壳）→ relationCache.currentChapters
 * （countChapters 直接消费 listMdRecursive）。每用例独立 tmpdir 书根，缓存键不串。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSettingsCached } from '../../src/studio/server/api/settings.js'

let root = ''

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

/** 经 settings 缓存壳读 countChapters（listMdRecursive 的生产消费面） */
function currentChapters(bookRoot: string): number {
  const r = getSettingsCached(bookRoot) as { relationCache: { currentChapters: number } }
  return r.relationCache.currentChapters
}

describe('R49-7: listMdRecursive 嵌套 AppleDouble（._）过滤', () => {
  it('嵌套子目录内的 ._ 文件不再计入正文章节数', () => {
    root = mkdtempSync(join(tmpdir(), 'clwriting-r49-7-'))
    const prose = join(root, '写作', '正文')
    mkdirSync(join(prose, '卷一'), { recursive: true })
    writeFileSync(join(prose, '001-第一章.md'), '---\n章号: 1\n标题: 第一章\n---\n正文')
    writeFileSync(join(prose, '卷一', '002-第二章.md'), '---\n章号: 2\n标题: 第二章\n---\n正文')
    // macOS 资源叉伴生文件落在子目录内：recursive readdir 条目形如 `卷一/._002.md`
    //（修复前 startsWith('._') 不命中，被当合法章计入 countChapters）
    writeFileSync(join(prose, '卷一', '._002.md'), 'junk appledouble')
    expect(currentChapters(root)).toBe(2)
  })

  it('顶层 ._ 文件照旧过滤（行为不变）', () => {
    root = mkdtempSync(join(tmpdir(), 'clwriting-r49-7-'))
    const prose = join(root, '写作', '正文')
    mkdirSync(prose, { recursive: true })
    writeFileSync(join(prose, '001-第一章.md'), '---\n章号: 1\n标题: 第一章\n---\n正文')
    writeFileSync(join(prose, '._001.md'), 'junk appledouble')
    expect(currentChapters(root)).toBe(1)
  })

  it('路径段（目录段）以 ._ 开头的嵌套文件也过滤', () => {
    root = mkdtempSync(join(tmpdir(), 'clwriting-r49-7-'))
    const prose = join(root, '写作', '正文')
    mkdirSync(join(prose, '._卷一'), { recursive: true })
    writeFileSync(join(prose, '001-第一章.md'), '---\n章号: 1\n标题: 第一章\n---\n正文')
    writeFileSync(join(prose, '._卷一', '002-第二章.md'), '---\n章号: 2\n标题: 第二章\n---\n正文')
    expect(currentChapters(root)).toBe(1)
  })
})
