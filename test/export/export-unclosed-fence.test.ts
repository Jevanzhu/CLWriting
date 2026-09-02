/**
 * IR-5（独立重评 2026-09-02）：purifyBody 未闭合围栏 #% 批注泄漏修复——
 * 奇数个 ``` 行（作者忘收口）时首遍状态机把其后全部行当「围栏内」整段跳过剥除，
 * 作者批注成串泄漏进导出稿；修复 = 末态仍在围栏内则按无围栏重剥（批注零泄漏优先，
 * 坏围栏章节内紧贴形态的代码字面 `#%` 接受误剥——权衡登记见 purifyBody 注释；
 * `#` 前带空白的松散字面维持 E-9f 既有口径保留）。
 * 闭合围栏的 N-6 既有契约（围栏内代码字面量保留）不回归。
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportBook } from '../../src/export/index.js'

function makeLongBook(title: string): string {
  const root = mkdtempTracked(join(tmpdir(), 'export-fence-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'book:', `  title: ${title}`, '  genre: 玄幻'].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  return root
}

function writeLongChapter(root: string, num: number, title: string, body: string): void {
  writeFileSync(
    join(root, '写作', '正文', `${num}-${title}.md`),
    `---\n章号: ${num}\n标题: ${title}\n---\n${body}`,
    'utf-8',
  )
}

function exportMerged(root: string, bookTitle: string): string {
  const r = exportBook({ bookRoot: root, format: 'merged' })
  expect(r.ok).toBe(true)
  return readFileSync(join(root, '工作区', '导出', `全本-${bookTitle}.md`), 'utf-8')
}

test('IR-5：未闭合围栏后的批注不再泄漏（按无围栏重剥）', () => {
  const root = makeLongBook('坏围栏书')
  const body = [
    '开场正文。#% 开场批注',
    '```js',
    'const a = 1  #% 围栏内松散字面',
    'x = 1#% 围栏内紧贴批注',
    '围栏忘收口后的正文。',
    '#% 泄漏的整行批注',
    '普通正文#%行中批注',
  ].join('\n')
  writeLongChapter(root, 1, '坏围栏章', body)
  try {
    const merged = exportMerged(root, '坏围栏书')
    // 批注零泄漏：围栏外的（首遍漏剥的）全部剥净
    expect(merged).not.toContain('开场批注')
    expect(merged).not.toContain('泄漏的整行批注')
    expect(merged).not.toContain('行中批注')
    // 围栏内紧贴批注按权衡登记接受误剥（宁误剥不泄漏）
    expect(merged).not.toContain('围栏内紧贴批注')
    // `#` 前带空白的行中松散字面维持 E-9f 权衡保留（与围栏无关的既有口径）
    expect(merged).toContain('#% 围栏内松散字面')
    // 正文与围栏行本体保留
    expect(merged).toContain('开场正文。')
    expect(merged).toContain('围栏忘收口后的正文。')
    expect(merged).toContain('普通正文')
    expect(merged).toContain('const a = 1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('IR-5 回归：闭合围栏的代码字面量仍保留（N-6 契约不回归）', () => {
  const root = makeLongBook('好围栏书')
  const body = [
    '开场#% 批注一',
    '```js',
    "const key = '#%not-comment'",
    '```',
    '收尾#% 批注二',
  ].join('\n')
  writeLongChapter(root, 1, '好围栏章', body)
  try {
    const merged = exportMerged(root, '好围栏书')
    // 围栏外的批注剥净、围栏内的字面量保留
    expect(merged).not.toContain('批注一')
    expect(merged).not.toContain('批注二')
    expect(merged).toContain('#%not-comment')
    expect(merged).toContain('开场')
    expect(merged).toContain('收尾')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
