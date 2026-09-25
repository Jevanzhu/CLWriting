import { test, expect, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// R74-2（二十二轮）：导出目录准备/清旧收编 {ok:false}——mkdirSync(exportDir) 与
// readdirSync(exportDir)（清旧产物循环）此前位于主信封 try 之外，工作区只读/EACCES/
// 目录被并发删时裸异常上抛（worker 形态变 500 且丢 chapterCount/warnings，违背
// R67-10/R70-4 信封契约）。故障注入：mock node:fs 的 mkdirSync/readdirSync，仅在
// 路径含「导出」且开关开时抛 EACCES（其余调用透传真实 fs——章扫描/配置读不受影响）。
const FAULT = vi.hoisted(() => ({ mkdir: false, readdir: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const eacces = (): Error => Object.assign(new Error('EACCES: permission denied, 模拟只读工作区'), { code: 'EACCES' })
  return {
    ...actual,
    mkdirSync: ((p, ...rest) => {
      if (FAULT.mkdir && String(p).includes('导出')) throw eacces()
      return (actual.mkdirSync as typeof mkdirSync)(p, ...rest)
    }) as typeof mkdirSync,
    readdirSync: ((p, ...rest) => {
      if (FAULT.readdir && String(p).includes('导出')) throw eacces()
      // readdirSync 多重载（Dirent/Buffer/string 变体）经窄化签名透传，返回值原样回传
      const real = actual.readdirSync as unknown as (...args: unknown[]) => unknown
      return real(p, ...rest)
    }) as typeof readdirSync,
  }
})

import { exportBook } from '../../src/export/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function makeLongBook(title: string): string {
  const root = mkdtempTracked(join(tmpdir(), 'export-r74-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'book:', `  title: ${title}`, '  genre: 玄幻'].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  return root
}

function writeLongChapter(root: string, num: number, title: string, body: string): void {
  writeFileSync(join(root, '写作', '正文', `${num}-${title}.md`), `---\n章号: ${num}\n标题: ${title}\n---\n${body}`, 'utf-8')
}

test('R74-2: mkdirSync(导出目录) 抛 EACCES → {ok:false} 信封（不再裸异常上抛）', () => {
  const root = makeLongBook('目录失败')
  writeLongChapter(root, 1, '好章', '第一章正文。')
  try {
    FAULT.mkdir = true
    const r = exportBook({ bookRoot: root, format: 'both' })
    expect(r.ok).toBe(false)
    expect(r.chapterCount).toBe(0) // 信封字段不丢（worker 形态可序列化回应）
    expect(r.error).toContain('导出写入失败')
    expect(r.error).toContain('EACCES')
  } finally {
    FAULT.mkdir = false
    rmSync(root, { recursive: true, force: true })
  }
})

test('R74-2: 清旧 readdirSync(导出目录) 抛 EACCES → {ok:false} 信封（mkdir 已过、目录被并发删/EACCES）', () => {
  const root = makeLongBook('清点失败')
  writeLongChapter(root, 1, '好章', '第一章正文。')
  try {
    FAULT.readdir = true
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(false)
    expect(r.chapterCount).toBe(0)
    expect(r.error).toContain('导出写入失败')
    expect(r.error).toContain('EACCES')
  } finally {
    FAULT.readdir = false
    rmSync(root, { recursive: true, force: true })
  }
})

test('R74-2: 无故障守恒回归——mock 不改变正常导出路径（信封收编零误伤）', () => {
  const root = makeLongBook('守恒')
  writeLongChapter(root, 1, '一', '正文一。')
  try {
    const r = exportBook({ bookRoot: root, format: 'both' })
    expect(r.ok).toBe(true)
    expect(r.chapterCount).toBe(1)
    expect(r.files.some((f) => f.includes('全本-守恒.md'))).toBe(true)
    expect(r.files.some((f) => f.includes('分章/0001-一.md'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
