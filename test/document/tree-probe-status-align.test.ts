/**
 * r0914b（全库重评-0914 修复批 B）P3-13：树 probe `已发布`/`序` 解析口径与 status.ts 对齐。
 *
 * 此前 tree.ts parsePublishedValue 不剥行内注释、不认数组形态，与 status.readPublished
 * （parseFlat + isPublishedValue 单源）分裂：`已发布: true # 备注` 树判 false、status 判
 * true；`已发布: ['true']` 同判分裂。本用例锁定两形态下树判定 === status 判定。
 */
import { test, expect } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { probeCachedPublished } from '../../src/document/tree.js'
import type { TreeNode } from '../../src/document/tree.js'
import { readPublished } from '../../src/document/status.js'

test('r0914b P3-13: 树 probe 与 status 已发布判定两形态对齐（行内注释 / 内联数组）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w2a-pub-align-'))
  try {
    const cases: Array<[string, string]> = [
      // 行内注释：parseFlat 侧 E-3 先剥注释得 true；probe 侧此前把「true # 备注」整段当值
      ['0001-注.md', '---\n章号: 1\n已发布: true # 备注\n---\n正文'],
      // 数组形态：isPublishedValue 单源认 ['true']（复审-0913 P3-⑥ 已收编 status 侧）
      ['0002-数组.md', "---\n章号: 2\n已发布: ['true']\n---\n正文"],
      // 对照：数组内非 true 值两链路都判否（不因收编放宽误判）
      ['0003-否.md', '---\n章号: 3\n已发布: ["false"]\n---\n正文'],
    ]
    for (const [name, text] of cases) {
      writeFileSync(join(root, name), text, 'utf-8')
      expect(probeCachedPublished(root, name), `${name} 树判定应与 status 判定相等`).toBe(readPublished(root, name))
    }
    // 真值语义落定：前两形态都是「已发布」，对照形态否
    expect(probeCachedPublished(root, '0001-注.md')).toBe(true)
    expect(probeCachedPublished(root, '0002-数组.md')).toBe(true)
    expect(probeCachedPublished(root, '0003-否.md')).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('r0914b P3-13: `序` 带行内注释不再落缺省（与 readChapter parseFlat 链路同判）', async () => {
  const { parseOrderOf } = await import('../../src/format/chapters.js')
  // probe 侧捕获值先剥注释再交 parseOrderOf——单源函数行为不变（引号配对剥除照旧）
  expect(parseOrderOf('3 # 排序备注')).toBe(undefined) // 单源本身不剥注释（对照）
  const root = mkdtempTracked(join(tmpdir(), 'w2a-order-align-'))
  try {
    const { buildTree } = await import('../../src/document/tree.js')
    // probe 仅对 chapter 角色跑——文件须落 写作/正文/ 下
    writeFileSync(join(root, '写作正文占位'), '', 'utf-8')
    rmSync(join(root, '写作正文占位'))
    const { mkdirSync: mk } = await import('node:fs')
    mk(join(root, '写作', '正文'), { recursive: true })
    writeFileSync(join(root, '写作', '正文', '0001-序.md'), '---\n章号: 1\n序: 3 # 排序备注\n---\n正文', 'utf-8')
    const find = (nodes: TreeNode[], path: string): TreeNode | null => {
      for (const n of nodes) {
        if (n.path === path) return n
        if (n.children.length) {
          const hit = find(n.children, path)
          if (hit) return hit
        }
      }
      return null
    }
    const node = find(buildTree(root), '写作/正文/0001-序.md')
    expect(node).not.toBeNull()
    // 树 order 判得 3（剥注释后命中）；此前 Number('3 # 排序备注') 失败落文件名章号
    expect(node!.order).toBe(3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
