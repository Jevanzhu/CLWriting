/**
 * W2A T3 —— tree.ts（扫描 + 构建 + 缓存）单测。
 * 覆盖：跳过内部目录、叶子挂 docId/status、卷目录关联卷纲、排序（目录优先 + localeCompare）、
 * getBookTreeIndex 缓存与 invalidate 重建（revision 递增）。
 *
 * 约定：TreeNode.path 文件带 .md（与 manifest entry.path / git status 输出一致），
 * name 是去 .md 的展示名。查找/断言用 path（带 .md），UI 显示用 name。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import {
  scanBookTree, buildTree, getBookTreeIndex, invalidateTreeIndex, probeCachedPublished, probeCachedRevision,
  type TreeNode,
} from '../../src/document/tree.js'

/** 造书：写作/正文/第一卷/0001 + 大纲/卷纲/第一卷 + 工作区/.journal + 工作区/待定稿（应跳过）。 */
function makeBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'w2a-tree-'))
  execSync('git init && git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n正文', 'utf-8')
  mkdirSync(join(root, '大纲', '卷纲'), { recursive: true })
  writeFileSync(join(root, '大纲', '卷纲', '第一卷.md'), '# 第一卷纲', 'utf-8')
  mkdirSync(join(root, '工作区', '.journal'), { recursive: true }) // 应跳过
  writeFileSync(join(root, '工作区', '.journal', 'doc_x.jsonl'), '{}', 'utf-8')
  mkdirSync(join(root, '工作区', '待定稿', '0001'), { recursive: true }) // 应跳过
  writeFileSync(join(root, '工作区', '待定稿', '0001', '草稿-1.md'), '草稿', 'utf-8')
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
  return root
}

function collectPaths(nodes: TreeNode[], acc: string[] = []): string[] {
  for (const n of nodes) {
    acc.push(n.path)
    if (n.children.length) collectPaths(n.children, acc)
  }
  return acc
}

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n
    if (n.children.length) {
      const f = findNode(n.children, path)
      if (f) return f
    }
  }
  return null
}

test('scanBookTree: 跳过 .git/.cache/工作区内部目录（.journal/待定稿）', () => {
  const root = makeBook()
  const paths = collectPaths(scanBookTree(root))
  expect(paths.some((p) => p.includes('.git'))).toBe(false)
  expect(paths.some((p) => p.includes('.journal'))).toBe(false)
  expect(paths.some((p) => p.includes('待定稿'))).toBe(false)
  expect(paths).toContain('写作/正文/第一卷/0001-开篇.md')
  expect(paths).toContain('大纲/卷纲/第一卷.md')
  rmSync(root, { recursive: true, force: true })
})

test('buildTree: 叶子挂 docId（无清单→legacy:）+ status（无 entry→draft）+ name 去 .md', () => {
  const root = makeBook()
  const chapter = findNode(buildTree(root), '写作/正文/第一卷/0001-开篇.md')
  expect(chapter).not.toBeNull()
  expect(chapter!.docId).toMatch(/^legacy:/)
  expect(chapter!.status).toBe('draft') // 无 manifest entry → 从未定稿 → draft
  expect(chapter!.role).toBe('chapter')
  expect(chapter!.name).toBe('0001-开篇') // 展示名去 .md
  expect(chapter!.path).toBe('写作/正文/第一卷/0001-开篇.md') // path 带 .md
  rmSync(root, { recursive: true, force: true })
})

test('buildTree: 叶子 wordCount（正文 chapter 剥 fm 算字数；非正文 role 无）', () => {
  const root = makeBook()
  const nodes = buildTree(root)
  const chapter = findNode(nodes, '写作/正文/第一卷/0001-开篇.md')
  expect(chapter!.wordCount).toBe(2) // fm 后正文「正文」2 字
  const outline = findNode(nodes, '大纲/卷纲/第一卷.md')
  expect(outline!.wordCount).toBeUndefined() // 卷纲非正文 role，不算字数
  rmSync(root, { recursive: true, force: true })
})

test('buildTree: 卷目录关联卷纲（同名 stem）', () => {
  const root = makeBook()
  const vol = findNode(buildTree(root), '写作/正文/第一卷')
  expect(vol).not.toBeNull()
  expect(vol!.isDirectory).toBe(true)
  expect(vol!.volumeOutlinePath).toBe('大纲/卷纲/第一卷.md')
  rmSync(root, { recursive: true, force: true })
})

test('buildTree: 卷目录无对应卷纲 → volumeOutlinePath undefined', () => {
  const root = makeBook()
  mkdirSync(join(root, '写作', '正文', '第二卷'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '第二卷', '0050-惊蛰.md'), '---\n章号: 50\n---\n正文', 'utf-8')
  const vol2 = findNode(buildTree(root), '写作/正文/第二卷')
  expect(vol2).not.toBeNull()
  expect(vol2!.volumeOutlinePath).toBeUndefined()
  rmSync(root, { recursive: true, force: true })
})

test('排序：同级目录优先于文件（第一卷 目录排在 0099-平铺 文件前）', () => {
  const root = makeBook()
  writeFileSync(join(root, '写作', '正文', '0099-平铺.md'), '---\n章号: 99\n---\n正文', 'utf-8')
  const bodyDir = findNode(buildTree(root), '写作/正文')!
  const names = bodyDir.children.map((c) => ({ name: c.name, dir: c.isDirectory }))
  const volIdx = names.findIndex((c) => c.name === '第一卷')
  const fileIdx = names.findIndex((c) => c.name === '0099-平铺')
  expect(volIdx).toBeGreaterThanOrEqual(0)
  expect(fileIdx).toBeGreaterThanOrEqual(0)
  expect(volIdx).toBeLessThan(fileIdx) // 目录优先
  rmSync(root, { recursive: true, force: true })
})

test('排序：大纲区总纲置顶（排在 卷纲/章纲 目录前）', () => {
  const root = makeBook()
  mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  writeFileSync(join(root, '大纲', '章纲', '0001-开场.md'), '---\n标题: 开场\n---\n纲', 'utf-8')
  writeFileSync(join(root, '大纲', '总纲.md'), '# 总纲', 'utf-8')
  const outlineDir = findNode(buildTree(root), '大纲')!
  const paths = outlineDir.children.map((c) => c.path)
  expect(paths[0]).toBe('大纲/总纲.md') // 文件总纲优先于 卷纲/章纲 目录
  rmSync(root, { recursive: true, force: true })
})

test('getBookTreeIndex: 缓存同引用；invalidate 后重建 + revision 递增', () => {
  const root = makeBook()
  const idx1 = getBookTreeIndex(root)
  const idx2 = getBookTreeIndex(root)
  expect(idx2).toBe(idx1) // 缓存命中同对象
  expect(idx1.nodes.length).toBeGreaterThan(0)
  expect(idx1.revision).toBeGreaterThan(0)

  invalidateTreeIndex(root)
  const idx3 = getBookTreeIndex(root)
  expect(idx3).not.toBe(idx1) // 重建新对象
  expect(idx3.revision).toBeGreaterThan(idx1.revision) // revision 单调递增
  rmSync(root, { recursive: true, force: true })
})

test('getBookTreeIndex(force): 外部直接写盘的文件——缓存刷不出，force 重扫刷得出', () => {
  const root = makeBook()
  const idx1 = getBookTreeIndex(root)
  expect(collectPaths(idx1.nodes)).not.toContain('设定/伏笔/神秘印记.md')

  // 外部编辑器 / CLI / AI 直接落盘：不经 DocumentService，缓存不会失效
  mkdirSync(join(root, '设定', '伏笔'), { recursive: true })
  writeFileSync(join(root, '设定', '伏笔', '神秘印记.md'), '---\n标题: 神秘印记\n---\n正文', 'utf-8')

  const stale = getBookTreeIndex(root)
  expect(stale).toBe(idx1) // 缓存命中 → 新文件看不见（前端「刷新」也刷不出）
  const fresh = getBookTreeIndex(root, true)
  expect(collectPaths(fresh.nodes)).toContain('设定/伏笔/神秘印记.md')
  expect(fresh.revision).toBeGreaterThan(idx1.revision)
  expect(getBookTreeIndex(root)).toBe(fresh) // force 的结果回写缓存
  rmSync(root, { recursive: true, force: true })
})

test('buildTree: 有清单时叶子挂正式 docId（清单 path 带 .md 对齐）', () => {
  const root = makeBook()
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_01ABC","nodeType":"document","path":"写作/正文/第一卷/0001-开篇.md","parentId":null,"status":"final"}',
    ].join('\n') + '\n',
  )
  const chapter = findNode(buildTree(root), '写作/正文/第一卷/0001-开篇.md')
  expect(chapter!.docId).toBe('doc_01ABC') // 清单命中正式 ID（非 legacy）
  rmSync(root, { recursive: true, force: true })
})

test('probeCachedPublished: fm 引号包 "true" 与 parseFlat 同口径判 published（2026-08-21 口径分裂修复）', () => {
  const root = mkdtempSync(join(tmpdir(), 'w2a-pub-'))
  try {
    // 手写 fm 带引号：document 链路（parseFlat→parseValue unquote）判 published=true，
    // 树 probe 链路此前原样返回 '"true"' 判 false——两链路状态口径分裂
    writeFileSync(join(root, '0002-迷雾.md'), '---\n章号: 2\n已发布: "true"\n---\n正文', 'utf-8')
    expect(probeCachedPublished(root, '0002-迷雾.md')).toBe(true)
    // 无引号裸值维持原行为
    writeFileSync(join(root, '0003-黎明.md'), '---\n章号: 3\n已发布: true\n---\n正文', 'utf-8')
    expect(probeCachedPublished(root, '0003-黎明.md')).toBe(true)
    // 非 true 值不误判
    writeFileSync(join(root, '0004-长夜.md'), '---\n章号: 4\n已发布: "false"\n---\n正文', 'utf-8')
    expect(probeCachedPublished(root, '0004-长夜.md')).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('低级项（第六轮）：同长改写后指纹不复用旧缓存（bigint stat 指纹 + FIFO 上限缓存）', () => {
  const root = mkdtempSync(join(tmpdir(), 'tree-probe-'))
  try {
    const rel = '0001-开篇.md'
    writeFileSync(join(root, rel), '---\n章号: 1\n标题: 开篇\n---\nAAAA', 'utf-8')
    const r1 = probeCachedRevision(root, rel)
    expect(r1).toMatch(/^sha256:/)
    // 同长度不同内容改写：stat 指纹（mtimeNs 级）变化 → 重算哈希，不吃旧缓存
    writeFileSync(join(root, rel), '---\n章号: 1\n标题: 开篇\n---\nBBBB', 'utf-8')
    const r2 = probeCachedRevision(root, rel)
    expect(r2).toMatch(/^sha256:/)
    expect(r2).not.toBe(r1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
