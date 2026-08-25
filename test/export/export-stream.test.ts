/**
 * 内存审计修复（2026-08-24 批 A1）回归：exportBook 单遍流式导出的产物字节恒等。
 *
 * 重构将「purified 全书数组 + join 整书大串」（峰值 ≈4-6× 全书）改为逐章净化即写
 * 即弃（merged 走 atomicWriteStream 追加写）。本用例锁死产物字节与原实现的构造式
 * `units.map(u => `# ${t}\n\n${b}`).join('\n\n---\n\n')` 逐一恒等（同段同序同分隔符），
 * merged/split 双产物 + %# 批注剥除路径一并覆盖。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { exportBook } from '../../src/export/index.js'

function makeBook(title: string): string {
  const root = mkdtempSync(join(tmpdir(), 'export-stream-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'book:', `  title: ${title}`, '  genre: 玄幻'].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  return root
}

function writeChapter(root: string, num: number, title: string, body: string): void {
  writeFileSync(join(root, '写作', '正文', `${num}-${title}.md`), `---\n章号: ${num}\n标题: ${title}\n---\n${body}`, 'utf-8')
}

test('A1 流式化：both 导出产物与原构造式字节恒等（含批注剥除路径）', () => {
  const root = makeBook('流式恒等书')
  // 倒序写入验证章号排序；批注（#% 整行/贴附/围栏内字面量）覆盖净化状态机
  writeChapter(root, 3, '第三章', '第三章正文。')
  writeChapter(root, 2, '第二章', '第二章正文。#%贴附批注\n\n#% 整行批注')
  writeChapter(root, 1, '第一章', '第一章正文。')
  try {
    const r = exportBook({ bookRoot: root, format: 'both' })
    expect(r.ok).toBe(true)
    expect(r.chapterCount).toBe(3)

    const merged = readFileSync(join(root, '工作区', '导出', '全本-流式恒等书.md'), 'utf8')
    // 与原实现构造式逐一恒等：# 标题 + 净化正文 + \n\n---\n\n 分隔（原 join 语义）
    expect(merged).toBe(
      ['# 第一章\n\n第一章正文。', '# 第二章\n\n第二章正文。', '# 第三章\n\n第三章正文。'].join('\n\n---\n\n'),
    )

    const split1 = readFileSync(join(root, '工作区', '导出', '分章', '001-第一章.md'), 'utf8')
    const split2 = readFileSync(join(root, '工作区', '导出', '分章', '002-第二章.md'), 'utf8')
    expect(split1).toBe('# 第一章\n\n第一章正文。')
    expect(split2).toBe('# 第二章\n\n第二章正文。') // 贴附批注截断 + 整行批注剔除
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
