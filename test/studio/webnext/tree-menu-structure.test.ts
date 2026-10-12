/**
 * 阶段 24（S4）：树菜单结构操作组 + 显示序前一章语义回归。
 *
 * useTreeMenu.buildLeafMenu 长篇正文分支尾部的三项：
 *   merge-into-prev（仅当显示序有前章，label 带前一章名）/ merge-undo（恒显）/
 *   split-here（仅当 opts.activeDocId() === node.docId）；
 * 以及 prevBodyChapterInDisplayOrder 的跨卷显示序语义（树由服务端按 fm 序 ?? 章号
 * 排好，深度优先遍历即作者看到的章序——非章号−1）。
 * 直测范式照 chapter-tree.test.ts（node 环境 window 未定义 → 桌面形态项不出现）。
 *
 * 短篇正文判定改按「书级 kind + 正文路径」（isPieceBodyNode 单源，role 恒 chapter）——
 * 短篇形态的用例由此在 tree store 的 bookKind 上表达：判别性断言前置 'short'，
 * 收尾复位 'long'（各用例共享同一 active pinia）。
 */
import { describe, test, expect } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTreeMenu } from '../../../src/studio/web-next/src/composables/useTreeMenu'
import { useDocStore } from '../../../src/studio/web-next/src/stores/doc'
import {
  bodyChaptersInDisplayOrder,
  prevBodyChapterInDisplayOrder,
} from '../../../src/studio/web-next/src/shared/chapter-tree'
import type { TreeNode } from '../../../src/studio/web-next/src/types/tree'

function node(over: Partial<TreeNode> & { path: string; name: string }): TreeNode {
  return { isDirectory: false, role: 'chapter', children: [], ...over }
}

// useTreeMenu 经 doc store 读书级 kind（短篇正文判定的书级信号）——模块级建 pinia：
// describe 体内即建菜单（收集期先于用例），且各用例须与菜单捕获的是同一 store 实例
//（逐用例换 pinia 会让用例侧的 bookKind 写不进菜单读的那一份）。
setActivePinia(createPinia())

/** 按路径取节点（比多层 children 索引链可读）；找不到 null，mustFind 兜底报错。 */
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

/** 树夹具：写作 → 写作/正文 → 第一卷 → 0001-甲(doc1) / 0002-乙(doc2) / 0003-丙(doc3) */
function volumeFixture(): { grouped: TreeNode[]; raw: TreeNode[]; ch1: TreeNode; ch2: TreeNode; ch3: TreeNode } {
  const ch1 = node({ path: '写作/正文/第一卷/0001-甲.md', name: '0001-甲.md', docId: 'doc1', status: 'draft' })
  const ch2 = node({ path: '写作/正文/第一卷/0002-乙.md', name: '0002-乙.md', docId: 'doc2', status: 'draft' })
  const ch3 = node({ path: '写作/正文/第一卷/0003-丙.md', name: '0003-丙.md', docId: 'doc3', status: 'draft' })
  const vol1 = node({ path: '写作/正文/第一卷', name: '第一卷', isDirectory: true, children: [ch1, ch2, ch3] })
  const bodyRoot = node({ path: '写作/正文', name: '正文', isDirectory: true, children: [vol1] })
  const writeRoot = node({ path: '写作', name: '写作', isDirectory: true, children: [bodyRoot] })
  return { grouped: [writeRoot], raw: [writeRoot], ch1, ch2, ch3 }
}

/** 跨卷夹具：第一卷[0009-丙] 在前、第二卷[0005-戊] 在后（children 顺序即显示序）；
 * 卷后再挂一颗卷外正文（长篇口径参与扁平序；短篇书口径下正文一律短篇形态、不参与）。
 * 章号故意非单调（9 → 5）：显示序前一章 ≠ 章号−1。 */
function crossVolumeFixture(): TreeNode[] {
  const bing = node({ path: '写作/正文/第一卷/0009-丙.md', name: '0009-丙.md', docId: 'dBin', status: 'draft' })
  const wu = node({ path: '写作/正文/第二卷/0005-戊.md', name: '0005-戊.md', docId: 'dWu', status: 'draft' })
  const flat = node({ path: '写作/正文/0002-卷外.md', name: '0002-卷外.md', docId: 'dFlat', status: 'draft' })
  const vol1 = node({ path: '写作/正文/第一卷', name: '第一卷', isDirectory: true, children: [bing] })
  const vol2 = node({ path: '写作/正文/第二卷', name: '第二卷', isDirectory: true, children: [wu] })
  const bodyRoot = node({ path: '写作/正文', name: '正文', isDirectory: true, children: [vol1, vol2, flat] })
  return [node({ path: '写作', name: '写作', isDirectory: true, children: [bodyRoot] })]
}

describe('useTreeMenu 结构操作组（阶段 24 S4）', () => {
  const fx = volumeFixture()
  const menu = useTreeMenu(() => fx, { activeDocId: () => 'doc2' })

  test('0002-乙 → merge-into-prev 出现且 label 带显示序前一章名（甲）；首章 0001-甲 无前章不出现', () => {
    const merge = menu.buildMenuItems(fx.ch2).find((i) => i.key === 'merge-into-prev')
    expect(merge).toBeDefined()
    expect(merge?.label).toContain('并入上一章')
    expect(merge?.label).toContain('甲')
    expect(menu.buildMenuItems(fx.ch1).map((i) => i.key)).not.toContain('merge-into-prev')
  })

  test('三个章节点均含 merge-undo（恒显——树数据不带 fm 结构键，服务端是唯一真相）', () => {
    for (const ch of [fx.ch1, fx.ch2, fx.ch3]) {
      expect(menu.buildMenuItems(ch).map((i) => i.key)).toContain('merge-undo')
    }
  })

  test('split-here 仅当前打开章：activeDocId=doc2 → 乙 含、甲/丙 不含；不传 opts → 全部不含', () => {
    expect(menu.buildMenuItems(fx.ch2).map((i) => i.key)).toContain('split-here')
    expect(menu.buildMenuItems(fx.ch1).map((i) => i.key)).not.toContain('split-here')
    expect(menu.buildMenuItems(fx.ch3).map((i) => i.key)).not.toContain('split-here')
    const bare = useTreeMenu(() => fx) // 不传 opts：拆分点取编辑器光标，未打开章无光标可依
    for (const ch of [fx.ch1, fx.ch2, fx.ch3]) {
      expect(bare.buildMenuItems(ch).map((i) => i.key)).not.toContain('split-here')
    }
  })

  test('顺序锚：merge-into-prev 排在 copy（创建副本）之后', () => {
    const keys = menu.buildMenuItems(fx.ch2).map((i) => i.key)
    expect(keys.indexOf('merge-into-prev')).toBeGreaterThan(keys.indexOf('copy'))
  })

  test('短篇书正文 → 结构三动作全无（留洞制合并/拆分只对长篇章开放；activeDocId 命中也不出 split-here）', () => {
    const piece = node({
      path: '写作/正文/0005-短篇.md',
      name: '0005-短篇.md',
      docId: 'pdoc',
      status: 'draft',
    })
    useDocStore().bookKind = 'short'
    const pieceMenu = useTreeMenu(() => ({ grouped: [piece], raw: [piece] }), { activeDocId: () => 'pdoc' })
    const keys = pieceMenu.buildMenuItems(piece).map((i) => i.key)
    expect(keys).not.toContain('merge-into-prev')
    expect(keys).not.toContain('merge-undo')
    expect(keys).not.toContain('split-here')
    // 对照：同节点同树在长篇书口径下走长篇章分支（判据在书级 kind，不在节点本身）
    useDocStore().bookKind = 'long'
    expect(pieceMenu.buildMenuItems(piece).map((i) => i.key)).toContain('merge-undo')
  })
})

describe('prevBodyChapterInDisplayOrder（显示序前一章）', () => {
  const grouped = crossVolumeFixture()

  test('跨卷按树显示序，非章号−1：第二卷 0005-戊 的前一章 = 第一卷 0009-丙', () => {
    // 扁平序 = 深度优先 children 顺序：丙(9) → 戊(5) → 卷外(2)；长篇口径下正文全部参与
    expect(bodyChaptersInDisplayOrder(grouped).map((n) => n.name)).toEqual(['0009-丙.md', '0005-戊.md', '0002-卷外.md'])
    const wu = mustFind(grouped, '写作/正文/第二卷/0005-戊.md')
    const prev = prevBodyChapterInDisplayOrder(wu, grouped)
    expect(prev?.name).toBe('0009-丙.md') // 章号 5−1=4 并不存在——prev 不是按章号推的
  })

  test('短篇书口径：正文一律短篇形态，扁平序为空（结构操作只对长篇章开放）', () => {
    expect(bodyChaptersInDisplayOrder(grouped, 'short')).toEqual([])
    const wu = mustFind(grouped, '写作/正文/第二卷/0005-戊.md')
    expect(prevBodyChapterInDisplayOrder(wu, grouped, 'short')).toBeNull()
  })

  test('首章 → null（并入上一章无目标）', () => {
    const bing = mustFind(grouped, '写作/正文/第一卷/0009-丙.md')
    expect(prevBodyChapterInDisplayOrder(bing, grouped)).toBeNull()
  })
})
