/**
 * R49-2：purifyBody 围栏判定与机检 checkSectionCount 收编 format/fence 单源
 * （CommonMark 0-3 空格缩进口径）——4+ 空格缩进属 indented code block，其内 ```
 * 行此前被 trimStart().startsWith('```') 误当围栏开关；误开栏成对闭合（首尾两个
 * 缩进 ``` 行）时 IR-5 两遍收口兜底不触发（末态不在围栏内），其间真实 `#%` 批注
 * 被当围栏内容整段保留漏进导出稿。
 * 对照：顶格围栏内 `#%` 代码字面量保留的 N-6 契约不回退。
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportBook } from '../../src/export/index.js'

function makeLongBook(title: string): string {
  const root = mkdtempTracked(join(tmpdir(), 'export-r49-fence-'))
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

test('R49-2：缩进代码块（4 空格）内 ``` 行不再当围栏开关，其间批注照常剥除', () => {
  const root = makeLongBook('缩进围栏书')
  const body = [
    '开场正文。',
    '',
    '    const flag = true',
    '    ```',
    '    #% 剧透批注',
    '#% 顶格剧透批注',
    '    ```',
    '',
    '结尾正文。',
  ].join('\n')
  writeLongChapter(root, 1, '缩进围栏章', body)
  try {
    const merged = exportMerged(root, '缩进围栏书')
    // 误开栏成对闭合 → IR-5 两遍兜底不触发，批注此前整段保留泄漏；现在剥除
    expect(merged).not.toContain('剧透批注')
    // 缩进代码块本体与围栏外正文照常保留（识别收紧不误伤）
    expect(merged).toContain('const flag = true')
    expect(merged).toContain('开场正文。')
    expect(merged).toContain('结尾正文。')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R49-2 对照：顶格围栏内 #% 代码字面量仍保留（N-6 契约不回退）', () => {
  const root = makeLongBook('顶格围栏书')
  const body = [
    '开场#% 批注',
    '```',
    "const tip = '#% 代码字面'",
    '```',
    '收尾#% 批注',
  ].join('\n')
  writeLongChapter(root, 1, '顶格围栏章', body)
  try {
    const merged = exportMerged(root, '顶格围栏书')
    // 围栏外的批注剥净、围栏内的字面量保留
    expect(merged).not.toContain('开场批注')
    expect(merged).not.toContain('收尾批注')
    expect(merged).toContain('#% 代码字面')
    expect(merged).toContain('开场')
    expect(merged).toContain('收尾')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
