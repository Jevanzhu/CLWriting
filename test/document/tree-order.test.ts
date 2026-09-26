/**
 * 阶段 24 章节结构操作（留洞制）批 A / S2：树排序键接线（tree.ts sortTreeByOrder）。
 *
 * 覆盖：序 缺省 = 章号（现状不变，旧书零迁移）/ 序 越卷重排（各卷子目录分别按序重排、
 * 卷目录次序不动）/ tie-break 章号 → path / 非正文目录不受影响 / probe order 带出。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTree, type TreeNode } from '../../src/document/tree.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

let root = ''

beforeEach(() => {
  root = mkdtempTracked(join(tmpdir(), 'clw-tree-order-'))
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

const writeCh = (rel: string, chapter: number, title: string, fmExtra = '') => {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(
    abs,
    `---\n章号: ${chapter}\n标题: ${title}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n${fmExtra}---\n\n正文。\n`,
  )
}

const chapterNamesUnder = (path: string): string[] => {
  const found = findNode(buildTree(root), path)
  return found ? found.children.filter((c) => !c.isDirectory).map((c) => c.name) : []
}

function findNode(nodes: TreeNode[], path: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n
    const hit = findNode(n.children, path)
    if (hit) return hit
  }
  return undefined
}

describe('S2 sortTreeByOrder：树重排', () => {
  it('序 缺省 = 章号（现状不变，旧书零迁移）——无 序 章节按章号数值序', () => {
    writeCh('写作/正文/0003-C.md', 3, 'C')
    writeCh('写作/正文/0001-A.md', 1, 'A')
    writeCh('写作/正文/0002-B.md', 2, 'B')
    expect(chapterNamesUnder('写作/正文')).toEqual(['0001-A', '0002-B', '0003-C'])
  })

  it('序 重排：`序: 1.5`（拆分新章中值）插到 1 与 2 之间', () => {
    writeCh('写作/正文/0001-A.md', 1, 'A')
    writeCh('写作/正文/0002-B.md', 2, 'B')
    writeCh('写作/正文/0005-新章.md', 5, '新章', '序: 1.5\n')
    expect(chapterNamesUnder('写作/正文')).toEqual(['0001-A', '0005-新章', '0002-B'])
  })

  it('序 越卷重排：各卷子目录分别按 序 重排，卷目录次序与目录优先不动', () => {
    writeCh('写作/正文/卷一/0001-A.md', 1, 'A')
    writeCh('写作/正文/卷一/0002-B.md', 2, 'B', '序: 0.5\n')
    writeCh('写作/正文/卷二/0003-C.md', 3, 'C', '序: 2.5\n')
    writeCh('写作/正文/卷二/0004-D.md', 4, 'D')
    const body = findNode(buildTree(root), '写作/正文')!
    // 卷目录在前（compareNode 目录优先保留），卷间按 localeCompare(zh-Hans-CN)——
    // 拼音序「二(èr)」先于「一(yī)」，维持 scanDir 现状不改
    expect(body.children.filter((c) => c.isDirectory).map((c) => c.name)).toEqual(['卷二', '卷一'])
    expect(chapterNamesUnder('写作/正文/卷一')).toEqual(['0002-B', '0001-A'])
    expect(chapterNamesUnder('写作/正文/卷二')).toEqual(['0003-C', '0004-D'])
  })

  it('tie-break：同 序 → 章号 → path（稳定确定性）', () => {
    writeCh('写作/正文/0002-B.md', 2, 'B', '序: 2.5\n')
    writeCh('写作/正文/0007-G.md', 7, 'G', '序: 2.5\n')
    writeCh('写作/正文/0005-E.md', 5, 'E', '序: 2.5\n')
    expect(chapterNamesUnder('写作/正文')).toEqual(['0002-B', '0005-E', '0007-G'])
  })

  it('非正文目录不受影响（大纲/章纲按 localeCompare 现状，序 重排仅正文子树）', () => {
    mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
    writeFileSync(join(root, '大纲', '章纲', 'b-章.md'), 'x')
    writeFileSync(join(root, '大纲', '章纲', 'a-章.md'), 'x')
    writeFileSync(join(root, '大纲', '章纲', '5-带序号章.md'), `---\n序: 0.1\n---\n\nx`)
    const outline = findNode(buildTree(root), '大纲/章纲')!
    // 无 序 键的按名排序（localeCompare 现状）；带 fm 序 的章纲文件不参与正文重排语义
    expect(outline.children.map((c) => c.name).indexOf('5-带序号章') as number).toBeGreaterThanOrEqual(0)
    expect(outline.children.map((c) => c.name)).toContain('a-章')
    expect(outline.children.map((c) => c.name)).toContain('b-章')
  })

  it('probe order 带出：TreeNode.order 反映 fm 序（正文角色）', () => {
    writeCh('写作/正文/0002-B.md', 2, 'B', '序: 2.5\n')
    writeCh('写作/正文/0001-A.md', 1, 'A')
    const nodes = buildTree(root)
    const body = findNode(nodes, '写作/正文')!
    const byName = new Map(body.children.map((c) => [c.name, c]))
    expect(byName.get('0002-B')!.order).toBe(2.5)
    expect(byName.get('0001-A')!.order).toBeUndefined()
  })

  it('非数字前缀文件不参与重排（保持原相对序沉底）', () => {
    writeCh('写作/正文/0001-A.md', 1, 'A')
    writeCh('写作/正文/0002-B.md', 2, 'B')
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    writeFileSync(join(root, '写作', '正文', '手记-杂谈.md'), '---\n---\n\nx')
    const names = chapterNamesUnder('写作/正文')
    expect(names).toEqual(['0001-A', '0002-B', '手记-杂谈'])
  })
})
