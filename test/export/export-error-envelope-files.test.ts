/**
 * 重审-09（2026-09-07 全量代码重审 §四.9）回归：导出写入期失败的错误信封回填
 * 已落盘产物。
 *
 * 原实现主写入 catch（merged/split 双模式中途失败）与投稿视图 catch 一律
 * `files: []` 清零——盘上已落的部分产物（已完成写出的 split 逐章文件、短篇分支的
 * merged 全本）无列表，调用方/作者无从核对半产物。修复 = 错误信封回填累积的
 * `files`（每项 push 紧随成功 atomicWriteFile 之后 ⟺ 已落盘；merged 名仅在
 * atomicWriteStream 完整发布后 unshift，中途失败不虚列）。
 * 故障注入手法同 test/export/export-write-error.test.ts（mock atomicWriteFile
 * 在第 N 次调用后抛 EIO，透传真实写盘）。
 */
import { test, expect, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAULT = vi.hoisted(() => ({ failAfter: null as number | null, writes: 0 }))
vi.mock('../../src/fs/atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/fs/atomic.js')>()
  return {
    ...actual,
    atomicWriteFile: (p: string, d: string | Uint8Array, o?: Parameters<typeof actual.atomicWriteFile>[2]) => {
      FAULT.writes++
      if (FAULT.failAfter !== null && FAULT.writes > FAULT.failAfter) {
        throw Object.assign(new Error('EIO: 模拟磁盘写入失败'), { code: 'EIO' })
      }
      return actual.atomicWriteFile(p, d, o)
    },
  }
})

import { exportBook } from '../../src/export/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function makeLongBook(title: string): string {
  const root = mkdtempTracked(join(tmpdir(), 'export-efiles-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'book:', `  title: ${title}`, '  genre: 玄幻'].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  return root
}

function makeShortBook(title: string): string {
  const root = mkdtempTracked(join(tmpdir(), 'export-efiles-s-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'kind: short', '', 'book:', `  title: ${title}`, '  genre: 悬疑'].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  return root
}

function writeLongChapter(root: string, num: number, title: string, body: string): void {
  writeFileSync(join(root, '写作', '正文', `${num}-${title}.md`), `---\n章号: ${num}\n标题: ${title}\n---\n${body}`, 'utf-8')
}

test('重审-09: split 段中途失败 → 错误信封 files 含已完成的逐章产物（现状清零 → 红）', () => {
  const root = makeLongBook('信封回填')
  writeLongChapter(root, 1, '好章', '第一章正文。')
  writeLongChapter(root, 2, '中章', '第二章正文。')
  writeLongChapter(root, 3, '坏章', '第三章正文。')
  try {
    FAULT.failAfter = 1 // 第 1 章写成功，第 2 章抛 EIO（第 3 章未及写）
    FAULT.writes = 0
    const r = exportBook({ bookRoot: root, format: 'split' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('导出写入失败')
    // 已落盘的第 1 章在信封里可核对；未写出的第 2/3 章不虚列
    expect(r.files).toContain('工作区/导出/分章/0001-好章.md')
    expect(r.files.some((f) => f.includes('0002'))).toBe(false)
    expect(r.files.some((f) => f.includes('0003'))).toBe(false)
    // 盘上事实与信封一致
    expect(existsSync(join(root, '工作区', '导出', '分章', '0001-好章.md'))).toBe(true)
  } finally {
    FAULT.failAfter = null
    rmSync(root, { recursive: true, force: true })
  }
})

test('重审-09: both 模式流式回调内失败 → files 含已写 split 章，不含未发布的 merged 名（不虚列）', () => {
  const root = makeLongBook('流式信封')
  writeLongChapter(root, 1, '甲', '内容一。')
  writeLongChapter(root, 2, '乙', '内容二。')
  try {
    FAULT.failAfter = 1 // 第 1 章分章写成功，第 2 章分章写抛 → 全本流式中断不发布
    FAULT.writes = 0
    const r = exportBook({ bookRoot: root, format: 'both' })
    expect(r.ok).toBe(false)
    expect(r.files).toContain('工作区/导出/分章/0001-甲.md')
    expect(r.files.some((f) => f.includes('全本-'))).toBe(false) // merged 未发布，不虚列
    expect(existsSync(join(root, '工作区', '导出', '全本-流式信封.md'))).toBe(false)
  } finally {
    FAULT.failAfter = null
    rmSync(root, { recursive: true, force: true })
  }
})

test('重审-09: 短篇投稿视图写失败 → 信封 files 含已落盘的 merged 全本 + split 章', () => {
  const root = makeShortBook('短篇信封')
  writeFileSync(join(root, '写作', '正文', '1-雪夜.md'), '---\n章号: 1\n标题: 雪夜\n---\n雪夜正文。', 'utf-8')
  try {
    // merged（atomicWriteStream 真实写）+ 分章（atomicWriteFile 第 1 次）成功后，
    // 投稿视图（atomicWriteFile 第 2 次）抛 EIO
    FAULT.failAfter = 1
    FAULT.writes = 0
    const r = exportBook({ bookRoot: root, format: 'both' })
    expect(r.ok).toBe(false)
    expect(r.files.some((f) => f.includes('全本-短篇信封.md'))).toBe(true)
    expect(r.files.some((f) => f.includes('分章/0001-雪夜.md'))).toBe(true)
    // 盘上事实：merged/split 均在位（投稿视图未落）
    expect(existsSync(join(root, '工作区', '导出', '全本-短篇信封.md'))).toBe(true)
    expect(existsSync(join(root, '工作区', '导出', '分章', '0001-雪夜.md'))).toBe(true)
  } finally {
    FAULT.failAfter = null
    rmSync(root, { recursive: true, force: true })
  }
})
