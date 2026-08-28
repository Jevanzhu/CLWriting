import { test, expect, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// R67-10（十五轮）：writeSplit 写入异常收编 {ok:false}——此前分章单章原子写失败
// （磁盘满/ENAMETOOLONG 边角）从 merged 流式回调或 split 循环裸穿透 exportBook，
// 库形态信封契约被击穿（服务端 500 兜底面丢 chapterCount/warnings 上下文）。
// 故障注入：mock atomicWriteFile 在第 N 次调用后抛 EIO，透传真实写盘。
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
  const root = mkdtempTracked(join(tmpdir(), 'export-werr-'))
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

test('R67-10: split 循环中单章写入失败 → {ok:false} 人话错误带章上下文（不再裸异常穿透）', () => {
  const root = makeLongBook('写入失败')
  writeLongChapter(root, 1, '好章', '第一章正文。')
  writeLongChapter(root, 2, '坏章', '第二章正文。')
  try {
    // failAfter=1：第 1 章写成功，第 2 章抛 EIO
    FAULT.failAfter = 1
    FAULT.writes = 0
    const r = exportBook({ bookRoot: root, format: 'split' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('导出写入失败')
    expect(r.error).toContain('分章 2')
    expect(r.error).toContain('EIO')
    // 第 1 章已落盘（半产物在位——收编口径见源码头注：下次导出整目录归档清位）
    expect(existsSync(join(root, '工作区', '导出', '分章', '0001-好章.md'))).toBe(true)
  } finally {
    FAULT.failAfter = null
    rmSync(root, { recursive: true, force: true })
  }
})

test('R67-10: merged 流式回调内 writeSplit 抛错 → {ok:false} 且全本不发布（tmp 自清理）', () => {
  const root = makeLongBook('流式失败')
  writeLongChapter(root, 1, '甲', '内容一。')
  writeLongChapter(root, 2, '乙', '内容二。')
  try {
    // merged 用 atomicWriteStream（真实写），分章经 writeSplit → atomicWriteFile；
    // failAfter=0：第一章分章写即抛，异常从流式回调穿透到收编层
    FAULT.failAfter = 0
    FAULT.writes = 0
    const r = exportBook({ bookRoot: root, format: 'both' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('导出写入失败')
    // 全本未被发布（atomicWriteStream tmp 自清理，无半截全本残留）
    expect(existsSync(join(root, '工作区', '导出', '全本-流式失败.md'))).toBe(false)
  } finally {
    FAULT.failAfter = null
    rmSync(root, { recursive: true, force: true })
  }
})

test('R67-10: 无故障时 both 形态产物齐整（守恒回归——mock 不改变正常路径）', () => {
  const root = makeLongBook('守恒')
  writeLongChapter(root, 1, '一', '正文一。')
  try {
    FAULT.failAfter = null
    const r = exportBook({ bookRoot: root, format: 'both' })
    expect(r.ok).toBe(true)
    expect(r.chapterCount).toBe(1)
    expect(r.files.some((f) => f.includes('全本-守恒.md'))).toBe(true)
    expect(r.files.some((f) => f.includes('分章/0001-一.md'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
