/**
 * book-search 扫描行为回归（结果集/排序/截断/排除目录/scope 过滤）。
 *
 * 夹具见 makeTree：五个可搜目录各埋一组命中词，另有 导出/、node_modules/、.版本/
 * 三个必须排除的面——断言逐例钉死命中的相对路径序列（正斜杠），漂移即红。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { searchBookAsync } from '../../src/process/book-search.js'

let root = ''

function makeTree(): string {
  root = mkdtempTracked(join(tmpdir(), 'r35-search-async-'))
  mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
  mkdirSync(join(root, '设定', '伏笔'), { recursive: true })
  mkdirSync(join(root, '大纲'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '导出'), { recursive: true })
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  writeFileSync(
    join(root, '写作', '正文', '0001-雨夜.md'),
    '---\n章号: 1\n标题: 雨夜\n---\n\n烛火摇曳，林远推门。\n',
    'utf-8',
  )
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

describe('扫描结果：目录序 + 目录内文件序', () => {
  // dirs 序 = SEARCH_ALL_DIRS（写作/正文 → 设定 → 大纲 → 布线 → 工作区），
  // 同一目录内按文件名排序（截断取前 50 条要确定性，顺序本身就是契约）
  const cases: Array<[string, string | undefined, string[]]> = [
    [
      '烛火',
      undefined,
      ['写作/正文/0001-雨夜.md', '写作/正文/第一卷/0002-晨光.md', '设定/伏笔/玉佩.md', '工作区/草稿.md'],
    ],
    ['林远', 'all', ['写作/正文/0001-雨夜.md', '设定/人物.md', '大纲/主线.md']],
    // 无清单 → 定稿集不可得 → 全文兜底（不误杀），dirs 收窄到 正文+设定
    ['林远', '定稿', ['写作/正文/0001-雨夜.md', '设定/人物.md']],
    ['烛火', '正文', ['写作/正文/0001-雨夜.md', '写作/正文/第一卷/0002-晨光.md']],
    ['玉佩', '设定', ['设定/伏笔/玉佩.md']],
    ['远行', '大纲', ['大纲/主线.md']],
    ['草稿', '工作区', ['工作区/草稿.md']],
    ['不存在的词', undefined, []],
  ]

  for (const [q, scope, expected] of cases) {
    it(`q=${q} scope=${scope ?? 'all'} → 命中路径序列`, async () => {
      makeTree()
      const out = await searchBookAsync(root, q, scope)
      expect(out.results.map((h) => h.path)).toEqual(expected)
    })
  }
})

describe('排除面与截断', () => {
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

  it('>50 命中文件 → truncated + 50 条上限，且两次扫描逐位相同（截断序确定）', async () => {
    makeTree()
    for (let i = 1; i <= 55; i++) {
      writeFileSync(join(root, '工作区', `便签${String(i).padStart(4, '0')}.md`), `孤本词第${i}处。\n`, 'utf-8')
    }
    const first = await searchBookAsync(root, '孤本词')
    const second = await searchBookAsync(root, '孤本词')
    expect(first.truncated).toBe(true)
    expect(first.results).toHaveLength(50)
    expect(first.results[0]!.path).toBe('工作区/便签0001.md')
    expect(second).toEqual(first)
  })

  it('空查询直返空结果（缓存前置同口径）', async () => {
    makeTree()
    expect(await searchBookAsync(root, '')).toEqual({ results: [] })
    expect(await searchBookAsync(root, '   ')).toEqual({ results: [] })
  })
})
