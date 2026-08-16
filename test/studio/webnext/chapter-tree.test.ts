/**
 * Z-P2-10 拆分单测：shared/chapter-tree.ts 纯工具 + composables/useTreeMenu.ts 菜单构建。
 *
 * 拆分前这批逻辑只能靠 e2e 兜底（tree-ops/tree-issues/batch-finalize）；
 * 拆出后纯函数化，本文件单测锁行为（node 环境 window 未定义 → hasShowInFolder=false
 * 恰好覆盖浏览器形态；桌面形态的「打开所在文件夹」由 e2e 兜）。
 */
import { test, expect, describe } from 'vitest'
import {
  sanitizeName,
  isVolumeDir,
  extractChapterNo,
  nextChapterNoIn,
  lastVolumePathIn,
  volumeCountIn,
  collectAncestors,
  moveToTargetsFor,
  pendingChaptersUpToIn,
  defaultExpandedDirs,
} from '../../../src/studio/web-next/src/shared/chapter-tree'
import { useTreeMenu } from '../../../src/studio/web-next/src/composables/useTreeMenu'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

// ── fixture：四层树 写作→正文→卷→章（卷一 1/2 章 + 卷二 3/5 章 + 大纲/设定区）─────

function node(over: Partial<TreeNode> & { path: string; name: string }): TreeNode {
  return { isDirectory: false, role: '', children: [], ...over }
}

/** 按路径取节点（比多层 children 索引链可读）；找不到返回 null，由 mustFind 兜底报错。 */
function findPath(ns: TreeNode[], path: string): TreeNode | null {
  for (const n of ns) {
    if (n.path === path) return n
    if (n.children.length) {
      const r = findPath(n.children, path)
      if (r) return r
    }
  }
  return null
}

function mustFind(ns: TreeNode[], path: string): TreeNode {
  const r = findPath(ns, path)
  if (!r) throw new Error(`fixture 缺少节点：${path}`)
  return r
}

function fixtureTree(): { grouped: TreeNode[]; raw: TreeNode[] } {
  const ch1 = node({ path: '写作/正文/第一卷/0001-开篇.md', name: '0001-开篇.md', docId: 'd1', status: 'final' })
  const ch2 = node({ path: '写作/正文/第一卷/0002-迷雾.md', name: '0002-迷雾.md', docId: 'd2', status: 'draft' })
  const ch3 = node({ path: '写作/正文/第二卷/0003-风暴.md', name: '0003-风暴.md', docId: 'd3', status: 'revision' })
  const ch4 = node({ path: '写作/正文/第二卷/0005-越章.md', name: '0005-越章.md', docId: 'd4', status: 'draft' })
  const vol1 = node({ path: '写作/正文/第一卷', name: '第一卷', isDirectory: true, children: [ch1, ch2] })
  const vol2 = node({ path: '写作/正文/第二卷', name: '第二卷', isDirectory: true, children: [ch3, ch4] })
  const bodyRoot = node({ path: '写作/正文', name: '正文', isDirectory: true, children: [vol1, vol2] })
  const writeGroup = node({ path: '写作', name: '写作', isDirectory: true, children: [bodyRoot] })
  const outline = node({ path: '大纲', name: '大纲', isDirectory: true, children: [] })
  const settings = node({ path: '设定', name: '设定', isDirectory: true, children: [] })
  const grouped = [writeGroup, outline, settings]
  return { grouped, raw: grouped } // 测试里 raw 与 grouped 同构即可（按章扫）
}

describe('sanitizeName', () => {
  test('合法名 trim 后通过', () => {
    expect(sanitizeName('  开篇 ')).toBe('开篇')
  })
  test('空/分隔符/点开头/控制字符拒绝', () => {
    expect(sanitizeName('')).toBeNull()
    expect(sanitizeName('a/b')).toBeNull()
    expect(sanitizeName('a\\b')).toBeNull()
    expect(sanitizeName('.hidden')).toBeNull()
    expect(sanitizeName('a\x01b')).toBeNull()
  })
})

describe('isVolumeDir / extractChapterNo', () => {
  test('卷目录判定：正文直属单层', () => {
    expect(isVolumeDir('写作/正文/第一卷')).toBe(true)
    expect(isVolumeDir('写作/正文')).toBe(false)
    expect(isVolumeDir('写作/正文/第一卷/nested')).toBe(false)
    expect(isVolumeDir('大纲/章纲')).toBe(false)
  })
  test('章号提取两形态', () => {
    expect(extractChapterNo('0001-开篇')).toBe(1)
    expect(extractChapterNo('第12章-高潮')).toBe(12)
    expect(extractChapterNo('第12章')).toBe(12)
    expect(extractChapterNo('无数字章名')).toBeNull()
  })
})

describe('树派生计数与定位', () => {
  test('nextChapterNo = 最大章号 + 1（扫 grouped）', () => {
    expect(nextChapterNoIn(fixtureTree().grouped)).toBe(6)
  })
  test('lastVolumePath / volumeCount', () => {
    expect(lastVolumePathIn(fixtureTree().grouped)).toBe('写作/正文/第二卷')
    expect(volumeCountIn(fixtureTree().grouped)).toBe(2)
  })
  test('collectAncestors：卷内章的祖先链', () => {
    expect(collectAncestors(fixtureTree().grouped, '写作/正文/第一卷/0001-开篇.md')).toEqual([
      '写作',
      '写作/正文',
      '写作/正文/第一卷',
    ])
    expect(collectAncestors(fixtureTree().grouped, '不存在的路径')).toBeNull()
  })
  test('moveToTargets：正文根 + 各卷，排除自身所在目录', () => {
    const t = fixtureTree()
    const ch2 = mustFind(t.grouped, '写作/正文/第一卷/0002-迷雾.md')
    const targets = moveToTargetsFor(ch2, t.grouped)
    expect(targets).toEqual([{ label: '正文根', dir: '写作/正文' }, { label: '第二卷', dir: '写作/正文/第二卷' }])
  })
})

describe('pendingChaptersUpToIn（批量定稿收集）', () => {
  test('只收 draft/revision 且章号 ≤ 目标，按章号升序，含自身', () => {
    const t = fixtureTree()
    const ch3 = mustFind(t.grouped, '写作/正文/第二卷/0003-风暴.md') // 第 3 章 revision
    expect(pendingChaptersUpToIn(ch3, t.raw)).toEqual(['d2', 'd3']) // d1 final 不收，d4=5>3 不收
  })
  test('越章目标收齐所有待定稿', () => {
    const t = fixtureTree()
    const ch4 = mustFind(t.grouped, '写作/正文/第二卷/0005-越章.md') // 第 5 章 draft
    expect(pendingChaptersUpToIn(ch4, t.raw)).toEqual(['d2', 'd3', 'd4'])
  })
  test('无章号文件 → 空', () => {
    const odd = node({ path: '写作/正文/x.md', name: '无数字.md', docId: 'dx', status: 'draft' })
    expect(pendingChaptersUpToIn(odd, [odd])).toEqual([])
  })
})

describe('defaultExpandedDirs', () => {
  test('一级目录 + 写作/正文', () => {
    expect(defaultExpandedDirs(fixtureTree().grouped)).toEqual(['写作', '写作/正文', '大纲', '设定'])
  })
})

describe('useTreeMenu 菜单构建', () => {
  const menu = useTreeMenu(() => fixtureTree())

  test('卷目录 → 新建章节单项', () => {
    const items = menu.buildMenuItems(node({ path: '写作/正文/第一卷', name: '第一卷', isDirectory: true }))
    expect(items.map((i) => i.key)).toEqual(['new-chapter'])
  })
  test('写作/正文 根 → 卷/章节两项', () => {
    const items = menu.buildMenuItems(node({ path: '写作/正文', name: '正文', isDirectory: true }))
    expect(items.map((i) => i.key)).toEqual(['new-volume', 'new-chapter-root'])
  })
  test('大纲根 → 章纲/卷纲/总纲', () => {
    const items = menu.buildMenuItems(node({ path: '大纲', name: '大纲', isDirectory: true }))
    expect(items.map((i) => i.key)).toEqual(['new-chapter-outline', 'new-volume-outline', 'new-synopsis'])
  })
  test('设定根 → 角色/物品/世界观/伏笔', () => {
    const items = menu.buildMenuItems(node({ path: '设定', name: '设定', isDirectory: true }))
    expect(items.map((i) => i.key)).toEqual(['new-character', 'new-item', 'new-worldview', 'new-foreshadow'])
  })
  test('待定稿章叶子 → 定稿 + 批量定稿（有更早待定稿）+ 移动子菜单 + 副本', () => {
    const t = fixtureTree()
    const ch3 = mustFind(t.grouped, '写作/正文/第二卷/0003-风暴.md') // 第 3 章 revision，前面有 d2
    const items = menu.buildMenuItems(ch3)
    const keys = items.map((i) => i.key)
    expect(keys).toContain('finalize')
    expect(keys).toContain('batch-finalize')
    const move = items.find((i) => i.key === 'move')
    // ch3 在第二卷 → 自身所在卷被排除，目标 = 正文根 + 第一卷
    expect(move?.submenu?.map((s) => s.key)).toEqual(['move:写作/正文', 'move:写作/正文/第一卷'])
    expect(keys).toContain('copy')
  })
  test('唯一待定稿章 → 无批量定稿项；final 章 → 无定稿项', () => {
    const t = fixtureTree()
    const ch4 = mustFind(t.grouped, '写作/正文/第二卷/0005-越章.md') // 第 5 章（前面 d2/d3 待定稿 → 有批量）
    expect(menu.buildMenuItems(ch4).map((i) => i.key)).toContain('batch-finalize')
    // 单独一颗树只有一章 draft → 无批量
    const lone = node({ path: '写作/正文/0001-孤章.md', name: '0001-孤章.md', docId: 'x1', status: 'draft' })
    const loneMenu = useTreeMenu(() => ({ grouped: [lone], raw: [lone] }))
    const keys = loneMenu.buildMenuItems(lone).map((i) => i.key)
    expect(keys).toContain('finalize')
    expect(keys).not.toContain('batch-finalize')
    // final 状态 → 定稿项不出现
    const done = node({ path: '写作/正文/0002-已成.md', name: '0002-已成.md', docId: 'x2', status: 'final' })
    const doneKeys = loneMenu.buildMenuItems(done).map((i) => i.key)
    expect(doneKeys).not.toContain('finalize')
    expect(doneKeys).not.toContain('batch-finalize')
  })
  test('叶子固定尾部：复制路径 + 删除；node 环境（无桌面 API）无 reveal-in-folder', () => {
    const t = fixtureTree()
    const ch1 = mustFind(t.grouped, '写作/正文/第一卷/0001-开篇.md')
    const keys = menu.buildMenuItems(ch1).map((i) => i.key)
    expect(keys).toContain('copy-path')
    expect(keys[keys.length - 1]).toBe('delete')
    expect(keys).not.toContain('reveal-in-folder')
  })
  test('短篇 piece-body → 篇章信息（非章节信息），无移动/副本', () => {
    const piece = node({ path: '写作/正文/001-短篇.md', name: '001-短篇.md', docId: 'p1', role: 'piece-body', status: 'draft' })
    const keys = menu.buildMenuItems(piece).map((i) => i.key)
    expect(keys).toContain('meta')
    expect(keys).toContain('finalize')
    expect(keys).not.toContain('move')
    expect(keys).not.toContain('copy')
  })
  test('空白处全量项：8 新建 + 2 分隔线', () => {
    expect(menu.blankItems.filter((i) => !i.separator).map((i) => i.key)).toEqual([
      'new-volume',
      'new-chapter-root',
      'new-chapter-outline',
      'new-volume-outline',
      'new-synopsis',
      'new-character',
      'new-item',
      'new-worldview',
      'new-foreshadow',
    ])
    expect(menu.blankItems.filter((i) => i.separator)).toHaveLength(2)
  })
})
