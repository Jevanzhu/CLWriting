/**
 * R72-22（二十轮 G-8）：useRelationGraph composable 单测（对齐 useShelf 范式：mock store/api 层，
 * 布局/图构造走真实纯函数 shared/relation-layout）。
 * 覆盖：建图契约（双方互记的无向对去重/度数/主角中心默认选中）、加载失败、
 * 三层筛选（孤立默认隐藏/搜索聚焦子图/图例语义色过滤）、AI 梳理（成功重载/
 * 空产不重载/失败只 toast 不覆盖图 err/mining 防重入）、onBgDown 仅左键平移
 *（R72-11 回归钉）。
 * 注：composable 内 onMounted/provide 依赖组件实例，测试直接调 load()（Vue 仅告警）。
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  mineRelations: vi.fn(),
  getConfig: vi.fn(),
  toast: vi.fn(),
  docOpen: vi.fn(async () => {}),
  openTab: vi.fn(),
  // R75-E-P3c：onMine 切书守卫读 doc.bookName——可变活源（新用例 mid-flight 改书名验守卫）。
  // R76-34（二十四轮 E 域）：守卫源改为路由参数（doc.bookName 是 flushDirty 滞后活源）——
  // routeState.params.name 同为可变活源，mid-flight 改名验守卫
  docState: { bookName: '测试书' },
  routeState: { params: { name: '测试书' } },
}))

vi.mock('../../../src/studio/web-next/src/api/settings', () => ({
  getSettings: mocks.getSettings,
  mineRelations: mocks.mineRelations,
}))
vi.mock('../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
}))
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: vi.fn(() => ({
    open: mocks.docOpen,
    // R75-E-P3c：getter 保活源（mid-flight 改 docState.bookName 守卫即时可见）
    get bookName() { return mocks.docState.bookName },
  })),
}))
vi.mock('../../../src/studio/web-next/src/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => ({ openTab: mocks.openTab })),
}))
vi.mock('../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: vi.fn(() => ({ byPath: new Map() })),
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({ toast: mocks.toast, aiAvailable: true })),
}))
vi.mock('../../../src/studio/web-next/src/stores/prefs', () => ({
  usePrefsStore: vi.fn(() => ({ relationAutoMine: false, relationMineThreshold: 20 })),
}))
// R76-34：onMine 切书守卫改读 route.params.name（即时源）——mock useRoute 返回可变
// routeState（守卫用例 mid-flight 改 params.name）
vi.mock('vue-router', () => ({
  useRoute: vi.fn(() => mocks.routeState),
}))

import { useRelationGraph } from '../../../src/studio/web-next/src/composables/useRelationGraph'
import type { SettingsResult } from '../../../src/studio/web-next/src/api/settings'

/** 林远=主角（中心）；苏婉与林远互记恋人（建图须去重为一条）；老王有卡无边（孤立）；
 *  阿三仅出现于债务边（无卡灰节点）。relationCache 不给 → 自动梳理早退。 */
function fixture(): SettingsResult {
  return {
    kind: 'long',
    characters: [
      { file: 'a.md', 姓名: '林远', 身份: '主角', 目标: '', 境界: '', 关系: '', 正文: '' },
      { file: 'b.md', 姓名: '苏婉', 身份: '女主', 目标: '', 境界: '', 关系: '', 正文: '' },
      { file: 'c.md', 姓名: '老王', 身份: '杂役', 目标: '', 境界: '', 关系: '', 正文: '' },
    ],
    characterRelations: [
      { from: '林远', to: '苏婉', type: '恋人' },
      { from: '苏婉', to: '林远', type: '恋人' }, // 双方互记 → 去重
    ],
    debtGraph: [{ 编号: 'D1', 标题: '灵石债', 状态: '未还', 欠方: '阿三', 债主: '林远' }],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSettings.mockResolvedValue(fixture())
  mocks.getConfig.mockResolvedValue({})
  mocks.docState.bookName = '测试书' // R75-E-P3c：守卫用例改过后复位
  mocks.routeState.params.name = '测试书' // R76-34：路由参数守卫源复位
})

describe('useRelationGraph: 建图契约', () => {
  it('load：互记关系去重为一条边 + 债务边入图 + 主角居中默认选中', async () => {
    const g = useRelationGraph('测试书')
    await g.load()
    expect(g.loading.value).toBe(false)
    expect(g.nodes.value.map((n) => n.id).sort()).toEqual(['林远', '老王', '苏婉', '阿三']) // 码点序
    expect(g.edges.value).toHaveLength(2) // 1 关系（去重后）+ 1 债务
    expect(g.edgeCount.value).toBe(1)
    expect(g.debtCount.value).toBe(1)
    const ling = g.nodes.value.find((n) => n.id === '林远')!
    expect(ling.isCenter).toBe(true) // 身份含「主角」优先
    expect(g.selectedId.value).toBe('林远')
    expect(ling.degree).toBe(2) // 苏婉 + 阿三
    const wang = g.nodes.value.find((n) => n.id === '老王')!
    expect(wang.hasCard).toBe(true)
    expect(wang.degree).toBe(0)
    const asan = g.nodes.value.find((n) => n.id === '阿三')!
    expect(asan.hasCard).toBe(false) // 仅债务边提及 → 灰节点
  })

  it('load 失败 → err 置友好文案，nodes 保持空', async () => {
    mocks.getSettings.mockRejectedValueOnce(new Error('server 500'))
    const g = useRelationGraph('测试书')
    await g.load()
    expect(g.err.value).toBeTruthy()
    expect(g.loading.value).toBe(false)
    expect(g.nodes.value).toHaveLength(0)
  })
})

describe('useRelationGraph: 三层筛选', () => {
  it('孤立节点默认隐藏，showOrphans 开启后恢复', async () => {
    const g = useRelationGraph('测试书')
    await g.load()
    expect(g.visibleNodes.value.map((n) => n.id)).not.toContain('老王')
    expect(g.hiddenCount.value).toBe(1)
    g.showOrphans.value = true
    expect(g.visibleNodes.value.map((n) => n.id)).toContain('老王')
    expect(g.hiddenCount.value).toBe(0)
  })

  it('搜索聚焦：匹配节点 + 一阶邻居，其余隐藏', async () => {
    const g = useRelationGraph('测试书')
    await g.load()
    g.searchQuery.value = '苏婉'
    expect([...g.visibleNodes.value.map((n) => n.id)].sort()).toEqual(['林远', '苏婉'])
    g.searchQuery.value = ''
    expect(g.visibleNodes.value.length).toBeGreaterThan(2)
  })

  it('toggleColor：图例语义色过滤隐藏对应关系边，再 toggle 恢复', async () => {
    const g = useRelationGraph('测试书')
    await g.load()
    const loveColor = g.edgeColor({ from: '林远', to: '苏婉', type: '恋人', kind: 'relation' })
    const before = g.edgeGeoms.value.length
    expect(before).toBe(2)
    g.toggleColor(loveColor)
    expect(g.edgeGeoms.value.length).toBe(1) // 恋人边被滤，债务边（--cat-1）不受影响
    g.toggleColor(loveColor)
    expect(g.edgeGeoms.value.length).toBe(2)
  })
})

describe('useRelationGraph: 选中详情派生', () => {
  it('selectNode → selectedRelations/selectedCard 跟随（去重边的双向可查）', async () => {
    const g = useRelationGraph('测试书')
    await g.load()
    g.selectNode('苏婉')
    expect(g.selectedCard.value?.姓名).toBe('苏婉')
    const rel = g.selectedRelations.value.find((r) => r.other === '林远')
    expect(rel).toMatchObject({ type: '恋人', kind: 'relation', hasCard: true })
  })
})

describe('useRelationGraph: AI 梳理', () => {
  it('成功 → success toast + 重新加载图', async () => {
    const g = useRelationGraph('测试书')
    await g.load()
    mocks.mineRelations.mockResolvedValueOnce({ ok: true, cached: false, relations: [{ from: 'A', to: 'B', type: '同门' }] })
    await g.onMine()
    expect(mocks.mineRelations).toHaveBeenCalledWith('测试书', true)
    expect(mocks.toast).toHaveBeenCalledWith('AI 已梳理 1 条关系', 'success')
    expect(mocks.getSettings).toHaveBeenCalledTimes(2) // load 重取
    expect(g.mining.value).toBe(false)
  })

  it('空产 → info toast，不重载', async () => {
    const g = useRelationGraph('测试书')
    await g.load()
    mocks.mineRelations.mockResolvedValueOnce({ ok: true, cached: true, relations: [] })
    await g.onMine()
    expect(mocks.toast).toHaveBeenCalledWith('AI 未梳理到关系（材料不足或产出为空）', 'info')
    expect(mocks.getSettings).toHaveBeenCalledTimes(1)
  })

  it('失败 → error toast，且不覆盖图主体 err（图已渲染成功不应变「载入失败」）', async () => {
    const g = useRelationGraph('测试书')
    await g.load()
    expect(g.err.value).toBeNull()
    mocks.mineRelations.mockRejectedValueOnce(new Error('boom'))
    await g.onMine()
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('boom'), 'error')
    expect(g.err.value).toBeNull()
    expect(g.mining.value).toBe(false)
  })

  it('R75-E-P3c/R76-34: 梳理在途切书 → 不 toast、不重载旧书（死实例静默收尾）', async () => {
    const g = useRelationGraph('测试书') // 死实例书名冻结在旧书
    await g.load()
    const callsBefore = mocks.getSettings.mock.calls.length
    // 梳理 await 期间已切到 B 书（R76-34：守卫源为路由参数即时源——doc.bookName 要等
    // flushDirty 数秒后才 setBook，窄窗内靠它复检会漏）
    mocks.mineRelations.mockImplementationOnce(async () => {
      mocks.routeState.params.name = '新书B'
      return { ok: true, cached: false, relations: [{ from: 'A', to: 'B', type: '同门' }] }
    })
    await g.onMine()
    expect(mocks.toast).not.toHaveBeenCalled() // 成败 toast 都不落新书界面
    expect(mocks.getSettings.mock.calls.length).toBe(callsBefore) // 死续体不重拉旧书
    expect(g.mining.value).toBe(false) // finally 复位不受影响
  })

  it('mining 防重入：进行中再触发直接返回（不重复起任务）', async () => {
    const g = useRelationGraph('测试书')
    await g.load()
    let resolveMine!: (v: unknown) => void
    mocks.mineRelations.mockImplementationOnce(() => new Promise((r) => (resolveMine = r)))
    const p1 = g.onMine()
    expect(g.mining.value).toBe(true)
    await g.onMine() // 重入：同步短路
    expect(mocks.mineRelations).toHaveBeenCalledTimes(1)
    resolveMine({ ok: true, relations: [{ from: 'A', to: 'B', type: '同门' }] })
    await p1
    expect(g.mining.value).toBe(false)
  })
})

describe('useRelationGraph: 交互守卫', () => {
  it('onBgDown 仅左键平移（R72-11 回归）：右键/中键不挂 window 监听', async () => {
    const g = useRelationGraph('测试书')
    await g.load()
    const spy = vi.spyOn(window, 'addEventListener')
    g.onBgDown({ button: 2, clientX: 0, clientY: 0 } as MouseEvent)
    g.onBgDown({ button: 1, clientX: 0, clientY: 0 } as MouseEvent)
    expect(spy).not.toHaveBeenCalled()
    g.onBgDown({ button: 0, clientX: 0, clientY: 0 } as MouseEvent)
    expect(spy).toHaveBeenCalledWith('mousemove', expect.any(Function))
    expect(spy).toHaveBeenCalledWith('mouseup', expect.any(Function))
    window.dispatchEvent(new MouseEvent('mouseup'))
    spy.mockRestore()
  })

  it('节点视觉三级编码：主角 > 高度数有卡 > 低度数有卡 > 无卡', async () => {
    const g = useRelationGraph('测试书')
    await g.load()
    const ling = g.nodes.value.find((n) => n.id === '林远')!
    const su = g.nodes.value.find((n) => n.id === '苏婉')!
    const asan = g.nodes.value.find((n) => n.id === '阿三')!
    expect(g.nodeFontSize(ling)).toBe(16)
    expect(g.nodeFontSize(su)).toBe(13) // degree 1 < 3
    expect(g.nodeFontSize(asan)).toBe(11) // 无卡
    expect(g.nodeColor(ling)).toBe('var(--interactive-accent)')
    expect(g.nodeColor(asan)).toBe('var(--text-faint)')
    expect(g.nodeRx(su)).toBe(g.nodeH(su) / 2) // 全圆胶囊端
  })
})
