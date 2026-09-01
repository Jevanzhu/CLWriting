/**
 * R35-7（三十五轮）回归：book-search 异步孪生 searchBookAsync。
 *
 * HTTP 全书搜索端点 async 化（fs.promises 全链，扫描期间事件循环可响应其他请求），
 * 同步版保留给 AI book_search 工具。本文件锚定两版行为逐位同源：结果/排序/截断/
 * 排除目录/scope 过滤不漂移。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchBook, searchBookAsync } from '../../src/process/book-search.js'

let root = ''

function makeTree(): string {
  root = mkdtempSync(join(tmpdir(), 'r35-search-async-'))
  mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
  mkdirSync(join(root, '设定', '伏笔'), { recursive: true })
  mkdirSync(join(root, '大纲'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '导出'), { recursive: true })
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '0001-雨夜.md'), '---\n章号: 1\n标题: 雨夜\n---\n\n烛火摇曳，林远推门。\n', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '第一卷', '0002-晨光.md'), '烛火熄了。\n', 'utf-8')
  writeFileSync(join(root, '设定', '人物.md'), '林远，佩玉少年。\n', 'utf-8')
  writeFileSync(join(root, '设定', '伏笔', '玉佩.md'), '烛火下玉佩微烫。\n', 'utf-8')
  writeFileSync(join(root, '大纲', '主线.md'), '林远的远行。\n', 'utf-8')
  writeFileSync(join(root, '工作区', '草稿.md'), '烛火草稿一页。\n', 'utf-8')
  // 排除面（V-P2-25 / 点前缀）：命中词不得越出
  writeFileSync(join(root, '导出', '全本.md'), '烛火导出版。\n', 'utf-8')
  writeFileSync(join(root, 'node_modules', 'dep.md'), '烛火依赖。\n', 'utf-8')
  mkdirSync(join(root, '.版本'), { recursive: true })
  writeFileSync(join(root, '.版本', '旧章.md'), '烛火历史版。\n', 'utf-8')
  return root
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

describe('R35-7 searchBookAsync 与同步版逐位同源', () => {
  const cases: Array<[string, string | undefined]> = [
    ['烛火', undefined],
    ['林远', 'all'],
    ['林远', '定稿'],
    ['烛火', '正文'],
    ['玉佩', '设定'],
    ['远行', '大纲'],
    ['草稿', '工作区'],
    ['不存在的词', undefined],
  ]

  for (const [q, scope] of cases) {
    it(`结果一致：q=${q} scope=${scope ?? 'all'}`, async () => {
      makeTree()
      const sync = searchBook(root, q, scope)
      const async = await searchBookAsync(root, q, scope)
      expect(async).toEqual(sync)
    })
  }

  it('排除目录不越出（导出/node_modules/点前缀）', async () => {
    makeTree()
    expect((await searchBookAsync(root, '导出版')).results).toHaveLength(0)
    expect((await searchBookAsync(root, '依赖')).results).toHaveLength(0)
    expect((await searchBookAsync(root, '历史版')).results).toHaveLength(0)
  })

  it('相对路径正斜杠 + 嵌套子目录可达', async () => {
    makeTree()
    const r = await searchBookAsync(root, '熄了')
    expect(r.results.map((h) => h.path)).toEqual(['写作/正文/第一卷/0002-晨光.md'])
  })

  it('截断口径一致：>50 命中文件 truncated + 50 条上限', async () => {
    makeTree()
    for (let i = 1; i <= 55; i++) {
      writeFileSync(join(root, '工作区', `便签${String(i).padStart(4, '0')}.md`), `孤本词第${i}处。\n`, 'utf-8')
    }
    const sync = searchBook(root, '孤本词')
    const async = await searchBookAsync(root, '孤本词')
    expect(sync.truncated).toBe(true)
    expect(async).toEqual(sync)
    expect(async.results).toHaveLength(50)
  })

  it('空查询直返空结果（缓存前置同口径）', async () => {
    makeTree()
    expect(await searchBookAsync(root, '')).toEqual({ results: [] })
    expect(await searchBookAsync(root, '   ')).toEqual({ results: [] })
  })
})
