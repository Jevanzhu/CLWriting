/**
 * 0918独立重评修复批（C001）回归：备料链正文读取异步孪生 readChapterBodiesByNumbersAsync。
 *
 * 原同步 readChapterBodiesByNumbers（walkMdEach + readFileSync 全树扫描 + 逐文件整读）
 * 在 studio 服务进程事件循环内被 await（ai/orchestrate/self-heal 备料链）会冻结同进程
 * 全部书的 SSE/保存——与 book-search R46-3 同族。随批异步化：新增 walkMdEachAsync
 * （与同步 walkMdEach 同纪律：Dirent 判型/realpath 剪枝/根界/`._` 排除，IO 走
 * fs/promises）+ readFileBodyAsync（fs/promises 读后经 frontmatter.readFile content
 * 传参复用解析单源）。同步版唯一消费链（renderRecallHits → prepareMaterials，已
 * async）随批删除。
 *
 * 三态钉：① 章号前缀多形态命中（无补零/3 位/4 位补零 + 卷子目录递归）；
 * ② 并入源回退（按名 miss 经 fm「并入」取目标章正文，正文命中优先）；
 * ③ 正文目录缺失 → 空 Map（不抛）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { readChapterBodiesByNumbersAsync } from '../../src/process/materials.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'

let root = ''

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
})

function makeBook(): string {
  root = mkdtempTracked(join(tmpdir(), 'c001-bodies-'))
  // 含卷子目录（v2 起章节可在 写作/正文/<卷>/ 子目录）
  mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
  return root
}

function meta(章号: number, 标题: string, extra?: Partial<ChapterMeta>): ChapterMeta {
  return {
    章号, 标题, 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫',
    _path: '', _wordCount: 10, ...extra,
  }
}

describe('0918独立重评修复批 C001：readChapterBodiesByNumbersAsync', () => {
  it('章号前缀多形态命中：无补零/3 位/4 位补零全试 + 卷子目录递归', async () => {
    const book = makeBook()
    writeChapter(join(book, '写作', '正文', '7-无补零.md'), meta(7, '无补零'), '七号章正文独有标记。')
    writeChapter(join(book, '写作', '正文', '008-三位.md'), meta(8, '三位'), '八号章正文独有标记。')
    writeChapter(join(book, '写作', '正文', '第一卷', '0009-四位.md'), meta(9, '四位'), '九号章正文独有标记。')

    const bodies = await readChapterBodiesByNumbersAsync(book, [7, 8, 9])
    expect(bodies.get(7)).toContain('七号章正文独有标记')
    expect(bodies.get(8)).toContain('八号章正文独有标记')
    expect(bodies.get(9)).toContain('九号章正文独有标记')
  })

  it('并入源回退：按名 miss 的源章号经 fm「并入」取目标章正文', async () => {
    const book = makeBook()
    // 第 4 章在盘（4 位补零命名，fm 并入: [5]——structure 写侧同一内联形态）；
    // 第 5 章已合并、盘上无按名文件
    writeFileSync(
      join(book, '写作', '正文', '0004-合并章.md'),
      '---\n章号: 4\n标题: 合并章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n并入: [5]\n---\n四号章正文独有标记。\n',
      'utf-8',
    )

    const bodies = await readChapterBodiesByNumbersAsync(book, [4, 5])
    // 目标章按名命中
    expect(bodies.get(4)).toContain('四号章正文独有标记')
    // 源章号按名 miss → 回退命中目标章正文（S2 D3 留洞口径）
    expect(bodies.get(5)).toContain('四号章正文独有标记')
  })

  it('正文目录缺失 → 空 Map（不抛，目录缺失早退语义不变）', async () => {
    // bookRoot 在但无 写作/正文 子树（新建书/未写章形态）
    root = mkdtempTracked(join(tmpdir(), 'c001-bodies-nodir-'))
    const bodies = await readChapterBodiesByNumbersAsync(root, [1, 2])
    expect(bodies.size).toBe(0)
  })
})
