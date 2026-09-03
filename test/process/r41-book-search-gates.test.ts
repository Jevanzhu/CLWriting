/**
 * R41-6 / R41-8（四十一轮）回归：全书搜索 walk 两处收口。
 *
 * R41-6：.md 判定改大小写不敏感（.MD 漏网——win 手改扩展名常态，.MD 家族
 * R38-9 收编 7 处后本 walk 漏网）；同步 walkMd 与异步 walkMdAsync 同口径。
 * R41-8：walk 排除 spills/——工作区全文快照（内容寻址哈希名）与正本同文，
 * 全书搜索双出处命中且其一指向内部缓存路径。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchBook, searchBookAsync } from '../../src/process/book-search.js'

let root: string
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined as unknown as string
})

function makeBook(): string {
  root = mkdtempSync(join(tmpdir(), 'r41-srch-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  return root
}

describe('R41-6: 搜索 walk 的 .md 大小写不敏感（.MD 不漏）', () => {
  it('同步版：正文区 .MD 文件可被搜出', () => {
    const b = makeBook()
    writeFileSync(join(b, '写作', '正文', '0001-夜行.MD'), '烛火摇曳', 'utf-8')
    const r = searchBook(b, '烛火')
    expect(r.results.map((h) => h.path)).toEqual(['写作/正文/0001-夜行.MD'])
  })

  it('异步版：同口径（walkMdAsync 不漂移）', async () => {
    const b = makeBook()
    writeFileSync(join(b, '写作', '正文', '0002-晨光.MD'), '烛火熄了', 'utf-8')
    const r = await searchBookAsync(b, '烛火')
    expect(r.results.map((h) => h.path)).toEqual(['写作/正文/0002-晨光.MD'])
  })
})

describe('R41-8: 搜索 walk 排除 spills/（全文快照不双出处）', () => {
  it('同步版：工作区/spills 哈希副本不进结果，正本命中', () => {
    const b = makeBook()
    writeFileSync(join(b, '写作', '正文', '0001-正本.md'), '烛火摇曳', 'utf-8')
    mkdirSync(join(b, '工作区', 'spills'), { recursive: true })
    writeFileSync(join(b, '工作区', 'spills', '0123456789abcdef.md'), '烛火摇曳', 'utf-8')
    const r = searchBook(b, '烛火')
    expect(r.results.map((h) => h.path)).toEqual(['写作/正文/0001-正本.md'])
  })

  it('异步版：同口径', async () => {
    const b = makeBook()
    writeFileSync(join(b, '写作', '正文', '0003-副本源.md'), '晨雾弥漫', 'utf-8')
    mkdirSync(join(b, '工作区', 'spills'), { recursive: true })
    writeFileSync(join(b, '工作区', 'spills', 'fedcba9876543210.md'), '晨雾弥漫', 'utf-8')
    const r = await searchBookAsync(b, '晨雾')
    expect(r.results.map((h) => h.path)).toEqual(['写作/正文/0003-副本源.md'])
  })
})
