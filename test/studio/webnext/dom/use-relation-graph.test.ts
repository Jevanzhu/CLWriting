/**
 * 关系图行为测试：挂真壳（RelationsView + RelationGraph/RelationDetail 真实组件链），
 * mock store/api 层，建图/布局走真实纯函数 shared/relation-layout。
 *
 * 断言纪律：只锚对外可观察面——DOM 渲染结果、交互效果（点击/悬停/键盘/事件）、
 * 边界调用（被 mock 的 api/store）。不锚 composable 内部字段名，也不锚源码文本：
 * 共享面按职能分组提供（provide/inject），组内字段更名不该让行为测试变红。
 *
 * 覆盖：建图契约（互记去重/债务边/主角居中默认选中）、载入失败与重试、
 * 三层筛选（孤立默认隐藏/搜索聚焦子图/图例语义色过滤）、点选 → 焦点与图渲染同步、
 * AI 梳理（成功重载/空产不重载/失败不覆盖图错误态/在途切书静默/防重入）、
 * 自动梳理门（探测中与不可达不放行）、画布左键平移守卫、节点视觉三级编码、
 * provide/inject 契约（作用域外即抛）、键盘可达（roving/方向键/Enter/详情项/图例 chip）、
 * wheelScale 纯函数（滚轮 deltaY → 缩放倍率）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  mineRelations: vi.fn(),
  getConfig: vi.fn(),
  toast: vi.fn(),
  docOpen: vi.fn(async () => {}),
  openTab: vi.fn(),
  // onMine 的切书守卫读路由参数即时源（doc.bookName 要等 flushDirty，滞后数秒）
  docState: { bookName: '测试书' },
  routeState: { params: { name: '测试书' } },
  // 树 byPath 活源（打开角色卡按 file→node 解析；默认空 = 角色卡入口早退）
  treeByPath: new Map<string, { docId?: string }>(),
  // aiAvailable 三态可变活源（true/false/null=探测中）——自动梳理门用例改此值验放行口径
  uiState: { aiAvailable: true as boolean | null },
}))

vi.mock('../../../../src/studio/web-next/src/api/settings', () => ({
  getSettings: mocks.getSettings,
  mineRelations: mocks.mineRelations,
}))
vi.mock('../../../../src/studio/web-next/src/api/books', () => ({
  getConfig: mocks.getConfig,
}))
vi.mock('../../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: vi.fn(() => ({
    open: mocks.docOpen,
    get bookName() {
      return mocks.docState.bookName
    },
  })),
}))
vi.mock('../../../../src/studio/web-next/src/stores/workspace', () => ({
  // 书级配置读单源（同书共享一次请求）在生产由 workspace store 承担——本档桩面照其
  // 对外形补 loadBookConfig，桩内转调同一 api 面（转调/失败语义等价，见真件）。
  useWorkspaceStore: vi.fn(() => ({
    openTab: mocks.openTab,
    loadBookConfig: async (name: string) => {
      try {
        return { config: await mocks.getConfig(name), error: null }
      } catch (e) {
        return { config: null, error: e }
      }
    },
  })),
}))
vi.mock('../../../../src/studio/web-next/src/stores/tree', () => ({
  useTreeStore: vi.fn(() => ({ byPath: mocks.treeByPath })),
}))
vi.mock('../../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: vi.fn(() => ({
    toast: mocks.toast,
    get aiAvailable() {
      return mocks.uiState.aiAvailable
    },
  })),
}))
vi.mock('../../../../src/studio/web-next/src/stores/prefs', () => ({
  // 真件对外是 get(key) 读口（全局默认托底）：桩给同形读口 + 与真件一致的硬编码默认
  //（自动梳理默认关、阈值 3），路「书级未设回落全局默认」的判定与真件同口径
  usePrefsStore: vi.fn(() => ({
    get: (key: string) => (key === 'relationMineThreshold' ? 3 : false),
  })),
}))
vi.mock('vue-router', () => ({
  useRoute: vi.fn(() => mocks.routeState),
}))

import RelationsView from '../../../../src/studio/web-next/src/views/RelationsView.vue'
import RelationGraph from '../../../../src/studio/web-next/src/components/relations/RelationGraph.vue'
import { wheelScale } from '../../../../src/studio/web-next/src/composables/useRelationGraph'
import type { SettingsResult } from '../../../../src/studio/web-next/src/api/settings'

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

/** 梳理成功后再拉的 settings：多一个「李四」与一条同门边——重载与否可观察 */
function extendedFixture(): SettingsResult {
  const base = fixture()
  return {
    ...base,
    characters: [
      ...base.characters,
      { file: 'd.md', 姓名: '李四', 身份: '反派', 目标: '', 境界: '', 关系: '', 正文: '' },
    ],
    characterRelations: [...base.characterRelations, { from: '林远', to: '李四', type: '同门' }],
  }
}

/** 自动梳理全条件满足的载荷（章节增量 5 ≥ 阈值 1；开关在用例里开） */
function autoFixture(): SettingsResult {
  return { ...fixture(), relationCache: { chapterCount: 0, currentChapters: 5 } }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSettings.mockResolvedValue(fixture())
  mocks.getConfig.mockResolvedValue({})
  mocks.docState.bookName = '测试书'
  mocks.routeState.params.name = '测试书'
  mocks.uiState.aiAvailable = true
  mocks.treeByPath.clear()
})

type Wrapper = ReturnType<typeof mount>

/** 挂真壳并冲掉 onMounted 的装载链（SVG 需真实连接时传 attach） */
async function mountView(attach = false): Promise<Wrapper> {
  const w = mount(RelationsView, { props: { bookName: '测试书' }, ...(attach ? { attachTo: document.body } : {}) })
  await flushPromises()
  return w
}

/** 可见节点名（DOM 序 = 可见节点序） */
function nodeLabels(w: Wrapper): string[] {
  return w.findAll('.node-g .node-label').map((n) => n.text())
}

/** 按角色名取节点组（未渲染即失败并报出角色名，避免静默 undefined） */
function nodeWith(w: Wrapper, id: string) {
  const el = w.findAll('.node-g').find((n) => n.find('.node-label').text() === id)
  if (!el) throw new Error(`节点未渲染：${id}`)
  return el
}

/** 高亮的边（焦点邻边）类型标签——焦点与图渲染同步的可观察面 */
function activeEdgeTypes(v: Wrapper): string[] {
  return v
    .findAll('.edges > g')
    .filter((g) => g.find('.edge').classes().includes('active'))
    .map((g) => g.find('.edge-label').text())
}

/** 按关系类型取边组（未渲染即失败并报出类型名） */
function edgeWith(v: Wrapper, type: string) {
  const el = v.findAll('.edges > g').find((g) => g.find('.edge-label').text() === type)
  if (!el) throw new Error(`边未渲染：${type}`)
  return el
}

/** 点选节点：mousedown + window mouseup = 未拖动即选中（与真交互同路径） */
async function clickNode(w: Wrapper, id: string): Promise<void> {
  await nodeWith(w, id).trigger('mousedown')
  window.dispatchEvent(new MouseEvent('mouseup'))
  await nextTick()
}

describe('关系图建图契约（挂真壳渲染）', () => {
  it('互记关系去重为一条边、债务边入图、主角居中并默认选中', async () => {
    const v = await mountView()
    try {
      expect(v.find('.rel-graph svg.graph').exists()).toBe(true)
      // 可见节点 = 中心 + 有线节点（孤立老王默认隐藏）；阿三仅债务边提及 → 无卡灰节点
      expect(nodeLabels(v)).toHaveLength(3)
      expect(nodeLabels(v)).toEqual(expect.arrayContaining(['林远', '苏婉', '阿三']))
      expect(nodeWith(v, '阿三').classes()).toContain('no-card')
      // 边：互记的恋人只出一条（标签唯一）+ 债务一条
      expect(v.findAll('.edge')).toHaveLength(2)
      const edgeTypes = v.findAll('.edge-label').map((t) => t.text())
      expect(edgeTypes.filter((t) => t === '恋人')).toHaveLength(1)
      expect(edgeTypes).toContain('灵石债')
      expect(v.find('.edges > g .edge').classes()).not.toContain('debt')
      expect(edgeWith(v, '灵石债').find('.edge').classes()).toContain('debt') // 债务边走虚线分支
      // 主角居中 + 默认选中，详情卡与开卡入口跟随
      expect(v.find('.node-g.center .node-label').text()).toBe('林远')
      expect(v.find('.node-g.center').attributes('aria-current')).toBe('true')
      expect(v.find('.dc-name').text()).toBe('林远')
      expect(v.find('.dc-degree').text()).toBe('2 条关联')
      expect(v.find('.dc-tag').text()).toContain('主角')
      expect(v.find('.dc-open').exists()).toBe(true)
    } finally {
      v.unmount()
    }
  })

  it('载入失败 → 失败态与重试入口，图区不渲染；重试成功即出图', async () => {
    mocks.getSettings.mockRejectedValueOnce(new Error('server 500'))
    const v = await mountView()
    try {
      expect(v.find('.state-block.err').text()).toContain('关系图载入失败')
      expect(v.findAll('.node-g')).toHaveLength(0)
      expect(v.find('.rel-graph').exists()).toBe(false)
      await v.find('.state-block.err .btn').trigger('click')
      await flushPromises()
      expect(v.find('.rel-graph svg.graph').exists()).toBe(true)
      expect(nodeLabels(v)).toContain('林远')
    } finally {
      v.unmount()
    }
  })
})

describe('关系图三层筛选（顶栏 + 图例交互）', () => {
  it('孤立角色默认隐藏，「+N无关系」展开与搜索叠加时的「收起」文案', async () => {
    const v = await mountView()
    try {
      expect(nodeLabels(v)).not.toContain('老王')
      expect(v.find('.show-all-btn').text()).toBe('+1无关系')
      await v.find('.show-all-btn').trigger('click')
      expect(nodeLabels(v)).toContain('老王')
      expect(v.find('.show-all-btn').exists()).toBe(false) // 无隐藏项 → 切换入口隐去
      // 搜索再收窄：隐藏计数又 > 0，且已展开态 → 入口文案切「收起」
      await v.find('.search-box input').setValue('苏婉')
      expect(v.find('.show-all-btn').text()).toBe('收起')
      await v.find('.search-box input').setValue('')
      expect(nodeLabels(v)).toContain('老王') // 展开态保持
    } finally {
      v.unmount()
    }
  })

  it('搜索聚焦：只留匹配节点与其一阶邻居，跨出子图的边一并隐去', async () => {
    const v = await mountView()
    try {
      await v.find('.search-box input').setValue('苏婉')
      expect(nodeLabels(v)).toHaveLength(2)
      expect(nodeLabels(v)).toEqual(expect.arrayContaining(['苏婉', '林远']))
      expect(v.findAll('.edge')).toHaveLength(1) // 阿三被滤 → 债务边端点不可见
      expect(v.findAll('.edge-label').map((t) => t.text())).toEqual(['恋人'])
      await v.find('.search-box input').setValue('')
      expect(nodeLabels(v)).toHaveLength(3)
      expect(v.findAll('.edge')).toHaveLength(2)
    } finally {
      v.unmount()
    }
  })

  it('图例只列本图出现的语义色；点 chip 隐去该类关系边，债务边与再点恢复不受影响', async () => {
    const v = await mountView()
    try {
      const chips = v.findAll('.legend .lg.clickable')
      expect(chips).toHaveLength(1) // 本图只有「恋人」类语义色
      expect(chips[0]!.text()).toContain('亲密')
      expect(chips[0]!.attributes('aria-pressed')).toBe('true')
      await chips[0]!.trigger('click')
      expect(v.findAll('.edge')).toHaveLength(1)
      expect(v.findAll('.edge-label').map((t) => t.text())).toEqual(['灵石债'])
      expect(v.findAll('.legend .lg.clickable')[0]!.attributes('aria-pressed')).toBe('false')
      await v.findAll('.legend .lg.clickable')[0]!.trigger('click')
      expect(v.findAll('.edge')).toHaveLength(2)
    } finally {
      v.unmount()
    }
  })
})

describe('关系图选中与焦点同步', () => {
  it('点选节点 → 选中态、详情卡与邻边高亮同拍迁移', async () => {
    const v = await mountView()
    try {
      // 默认选中主角：两条邻边（恋人 + 债务）都是焦点边
      expect(activeEdgeTypes(v)).toEqual(expect.arrayContaining(['恋人', '灵石债']))
      await clickNode(v, '苏婉')
      expect(nodeWith(v, '苏婉').classes()).toContain('selected')
      expect(nodeWith(v, '苏婉').attributes('aria-current')).toBe('true')
      expect(nodeWith(v, '林远').classes()).not.toContain('selected')
      expect(v.find('.dc-name').text()).toBe('苏婉')
      expect(v.find('.dc-rel-name').text()).toBe('林远')
      expect(v.find('.dc-rel-type').text()).toBe('恋人')
      // 焦点迁移：只余「恋人」边高亮（债务边已非焦点邻边）
      expect(activeEdgeTypes(v)).toEqual(['恋人'])
    } finally {
      v.unmount()
    }
  })

  it('点选无卡角色 → 「仅被提及」详情（债务项、无开卡入口）', async () => {
    const v = await mountView()
    try {
      await clickNode(v, '阿三')
      expect(v.find('.dc-name').text()).toBe('阿三')
      expect(v.find('.dc-nocard').text()).toContain('仅被提及')
      expect(v.find('.dc-open').exists()).toBe(false)
      expect(v.find('.dc-rel li.debt').exists()).toBe(true)
      expect(v.find('.dc-rel-name').text()).toBe('林远')
    } finally {
      v.unmount()
    }
  })

  it('详情项点击跳转选中', async () => {
    const v = await mountView()
    try {
      await v.findAll('.dc-rel li')[0]!.trigger('click')
      expect(v.find('.dc-name').text()).toBe('苏婉')
      expect(nodeWith(v, '苏婉').attributes('aria-current')).toBe('true')
    } finally {
      v.unmount()
    }
  })

  it('悬停压暗非邻节点、邻节点不压暗，离开即复位', async () => {
    const v = await mountView()
    try {
      await nodeWith(v, '阿三').trigger('mouseenter')
      expect(nodeWith(v, '阿三').classes()).toContain('hover')
      expect(nodeWith(v, '苏婉').classes()).toContain('dim') // 非阿三邻节点
      expect(nodeWith(v, '林远').classes()).not.toContain('dim') // 邻节点不压暗
      await nodeWith(v, '阿三').trigger('mouseleave')
      expect(nodeWith(v, '苏婉').classes()).not.toContain('dim')
    } finally {
      v.unmount()
    }
  })
})

describe('关系图 AI 梳理（顶栏按钮）', () => {
  it('成功 → 成功 toast + 重新装载（新角色入图）', async () => {
    const v = await mountView()
    try {
      mocks.mineRelations.mockResolvedValueOnce({
        ok: true,
        cached: false,
        relations: [{ from: '林远', to: '李四', type: '同门' }],
      })
      mocks.getSettings.mockResolvedValueOnce(extendedFixture())
      await v.find('.tool-btn.mine').trigger('click')
      await flushPromises()
      expect(mocks.mineRelations).toHaveBeenCalledWith('测试书', true)
      expect(mocks.toast).toHaveBeenCalledWith('AI 已梳理 1 条关系', 'success')
      expect(nodeLabels(v)).toContain('李四')
      expect(v.find('.tool-btn.mine').attributes('disabled')).toBeUndefined()
      expect(v.find('.tool-btn.mine').text()).toBe('AI 梳理')
    } finally {
      v.unmount()
    }
  })

  it('空产 → info toast，不重新装载', async () => {
    const v = await mountView()
    try {
      mocks.mineRelations.mockResolvedValueOnce({ ok: true, cached: true, relations: [] })
      await v.find('.tool-btn.mine').trigger('click')
      await flushPromises()
      expect(mocks.toast).toHaveBeenCalledWith('AI 未梳理到关系（材料不足或产出为空）', 'info')
      expect(mocks.getSettings).toHaveBeenCalledTimes(1)
      expect(nodeLabels(v)).toHaveLength(3)
    } finally {
      v.unmount()
    }
  })

  it('失败 → 错误 toast，图主体不变「载入失败」', async () => {
    const v = await mountView()
    try {
      mocks.mineRelations.mockRejectedValueOnce(new Error('boom'))
      await v.find('.tool-btn.mine').trigger('click')
      await flushPromises()
      expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('boom'), 'error')
      expect(v.find('.state-block').exists()).toBe(false)
      expect(v.find('.rel-graph').exists()).toBe(true)
      expect(v.find('.dc-name').text()).toBe('林远')
    } finally {
      v.unmount()
    }
  })

  it('梳理在途切书 → 成败都不 toast，也不再重拉旧书', async () => {
    const v = await mountView()
    try {
      const calls = mocks.getSettings.mock.calls.length
      mocks.mineRelations.mockImplementationOnce(async () => {
        mocks.routeState.params.name = '新书B' // await 窗口内切书
        return { ok: true, cached: false, relations: [{ from: '林远', to: '李四', type: '同门' }] }
      })
      await v.find('.tool-btn.mine').trigger('click')
      await flushPromises()
      expect(mocks.toast).not.toHaveBeenCalled()
      expect(mocks.getSettings.mock.calls.length).toBe(calls)
    } finally {
      v.unmount()
    }
  })

  it('进行中防重入：按钮禁用且文案切换，再触发不重复起任务', async () => {
    const v = await mountView()
    try {
      let resolveMine!: (val: unknown) => void
      mocks.mineRelations.mockImplementationOnce(() => new Promise((r) => (resolveMine = r)))
      await v.find('.tool-btn.mine').trigger('click')
      await nextTick()
      expect(mocks.mineRelations).toHaveBeenCalledTimes(1)
      expect(v.find('.tool-btn.mine').attributes('disabled')).toBeDefined()
      expect(v.find('.tool-btn.mine').text()).toContain('梳理中')
      await v.find('.tool-btn.mine').trigger('click')
      expect(mocks.mineRelations).toHaveBeenCalledTimes(1)
      resolveMine({ ok: true, cached: true, relations: [] })
      await flushPromises()
      expect(v.find('.tool-btn.mine').attributes('disabled')).toBeUndefined()
    } finally {
      v.unmount()
    }
  })
})

describe('关系图自动梳理门（打开即探测）', () => {
  it('AI 探测中（null）与不可达（false）都不读配置、不起梳理', async () => {
    for (const state of [null, false]) {
      mocks.uiState.aiAvailable = state
      mocks.getSettings.mockResolvedValueOnce(autoFixture())
      const v = await mountView()
      await new Promise((r) => setTimeout(r, 0)) // 自动路径是 fire-and-forget，冲掉微任务链
      try {
        expect(mocks.getConfig).not.toHaveBeenCalled()
        expect(mocks.mineRelations).not.toHaveBeenCalled()
      } finally {
        v.unmount()
      }
    }
  })

  it('明确可用 + 书级开关与增量阈值均满足才自动起梳理', async () => {
    mocks.uiState.aiAvailable = true
    mocks.getSettings.mockResolvedValueOnce(autoFixture())
    mocks.getConfig.mockResolvedValueOnce({ auto: { relation_auto_mine: true, relation_mine_threshold: 1 } })
    mocks.mineRelations.mockResolvedValueOnce({
      ok: true,
      cached: false,
      relations: [{ from: '林远', to: '李四', type: '同门' }],
    })
    const v = await mountView()
    await new Promise((r) => setTimeout(r, 0))
    try {
      expect(mocks.mineRelations).toHaveBeenCalledTimes(1)
    } finally {
      v.unmount()
    }
  })
})

describe('关系图画布交互与视觉编码', () => {
  it('空白 mousedown 仅左键进入平移（右键/中键不挂 window 监听）', async () => {
    const v = await mountView()
    try {
      const spy = vi.spyOn(window, 'addEventListener')
      const graph = v.find('svg.graph')
      await graph.trigger('mousedown', { button: 2 })
      await graph.trigger('mousedown', { button: 1 })
      expect(spy).not.toHaveBeenCalled()
      await graph.trigger('mousedown', { button: 0 })
      expect(spy).toHaveBeenCalledWith('mousemove', expect.any(Function))
      expect(spy).toHaveBeenCalledWith('mouseup', expect.any(Function))
      window.dispatchEvent(new MouseEvent('mouseup'))
      spy.mockRestore()
    } finally {
      v.unmount()
    }
  })

  it('节点视觉三级编码：主角 > 有卡 > 仅被提及；胶囊全圆端随高度', async () => {
    const v = await mountView()
    try {
      const fontSize = (id: string) => nodeWith(v, id).find('.node-label').attributes('style')
      expect(fontSize('林远')).toContain('16px')
      expect(fontSize('苏婉')).toContain('13px')
      expect(fontSize('阿三')).toContain('11px')
      // 身份语义色：主角走强调色 token，仅被提及走灰 token
      expect(nodeWith(v, '林远').attributes('style')).toContain('var(--interactive-accent)')
      expect(nodeWith(v, '阿三').attributes('style')).toContain('var(--text-faint)')
      // 胶囊端圆角 = 半高
      const cap = nodeWith(v, '苏婉').find('rect.node')
      expect(Number(cap.attributes('rx'))).toBeCloseTo(Number(cap.attributes('height')) / 2, 6)
    } finally {
      v.unmount()
    }
  })
})

describe('关系图打开角色卡（切书复检）', () => {
  it('正常路径：doc.open 后 openTab 写该 docId', async () => {
    mocks.treeByPath.set('a.md', { docId: 'doc-a' }) // 默认选中林远（file a.md）
    const v = await mountView()
    try {
      await v.find('.dc-open').trigger('click')
      await flushPromises()
      expect(mocks.docOpen).toHaveBeenCalledTimes(1)
      expect(mocks.openTab).toHaveBeenCalledWith('doc-a')
    } finally {
      v.unmount()
    }
  })

  it('在途切书 → 旧书 docId 不写进新书工作区（不 openTab）', async () => {
    mocks.treeByPath.set('a.md', { docId: 'doc-a' })
    const v = await mountView()
    try {
      mocks.docOpen.mockImplementationOnce(async () => {
        mocks.routeState.params.name = '新书B' // await 窗口内切书
      })
      await v.find('.dc-open').trigger('click')
      await flushPromises()
      expect(mocks.openTab).not.toHaveBeenCalled()
    } finally {
      v.unmount()
    }
  })
})

describe('关系图共享面 provide/inject 契约', () => {
  it('子组件在 provide 作用域外取共享面 → 立即抛错，不静默读到空面', () => {
    expect(() => mount(RelationGraph)).toThrow(/useRelationGraphInjected/)
  })
})

describe('wheelScale: 滚轮 deltaY → 缩放倍率（纯函数）', () => {
  it('0 边界：deltaY=0 → 恒等 1（不缩放）', () => {
    expect(wheelScale(0)).toBe(1)
  })

  it('方向：向下滚（正 delta）缩小 <1，向上滚（负 delta）放大 >1', () => {
    expect(wheelScale(100)).toBeLessThan(1)
    expect(wheelScale(-100)).toBeGreaterThan(1)
  })

  it('离散滚轮一格（deltaY≈±100）换算区间：≈1.22 倍，与旧固定步进 1.15 观感接近', () => {
    // exp(-100*0.002) = e^-0.2 ≈ 0.8187（缩小）；放大侧为其倒数 ≈ 1.2214
    expect(wheelScale(100)).toBeCloseTo(Math.exp(-0.2), 10)
    expect(wheelScale(-100)).toBeCloseTo(Math.exp(0.2), 10)
    expect(wheelScale(100)).toBeGreaterThan(0.75) // 不因归一而弱于旧步进的量级
    expect(wheelScale(100)).toBeLessThan(0.9) // 且不至于一档过猛
  })

  it('触控板小 delta（1~5）→ 倍率贴近 1（平滑缩放，不再一步撞钳制）', () => {
    for (const d of [1, 2, 4, 5]) {
      expect(wheelScale(d)).toBeGreaterThan(0.99)
      expect(wheelScale(d)).toBeLessThan(1)
      expect(wheelScale(-d)).toBeLessThan(1.02) // 上界留裕量：wheelScale(-5)=e^0.01≈1.010
      expect(wheelScale(-d)).toBeGreaterThan(1)
    }
  })

  it('单调性：deltaY 递增 → 倍率严格递减（不增不平台）', () => {
    const deltas = [-200, -100, -4, -1, 0, 1, 4, 100, 200]
    for (let i = 1; i < deltas.length; i++) {
      expect(wheelScale(deltas[i]!)).toBeLessThan(wheelScale(deltas[i - 1]!))
    }
  })

  it('对称性：wheelScale(-d) × wheelScale(d) = 1（往返滚动不漂移）；大幅值恒正有限', () => {
    for (const d of [1, 100, 480, 5000]) {
      expect(wheelScale(-d) * wheelScale(d)).toBeCloseTo(1, 10)
    }
    expect(wheelScale(10000)).toBeGreaterThan(0)
    expect(Number.isFinite(wheelScale(10000))).toBe(true)
  })
})

describe('关系图键盘可达：节点 roving + 方向键就近跳 + Enter 选中', () => {
  afterEach(() => {
    document.body.innerHTML = '' // 清掉 attachTo 挂到 body 的视图（focus 断言需元素已连接）
  })

  /** 从当前焦点元素派发 keydown（真键盘事件 target = 焦点元素，冒泡到节点监听） */
  function press(el: Element, key: string): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    el.dispatchEvent(e)
    return e
  }

  it('根 svg 非 img（节点不被当单张图片吞掉）；节点 role=button + 全图唯一 Tab 停靠点', async () => {
    const v = await mountView(true)
    try {
      expect(v.find('.rel-graph svg.graph').attributes('role')).toBe('group')
      const nodes = v.findAll('.node-g')
      expect(nodes).toHaveLength(3) // 可见 = 中心 + 两条边端点（孤立老王默认隐藏）
      expect(nodes.every((n) => n.attributes('role') === 'button')).toBe(true)
      const stops = nodes.filter((n) => n.attributes('tabindex') === '0')
      expect(stops).toHaveLength(1) // roving：Tab 序不被节点淹没
      expect(stops[0]!.attributes('aria-label')).toBe('林远（有角色卡）') // 默认选中中心 = 停靠点
      expect(stops[0]!.attributes('aria-current')).toBe('true') // 选中态对 AT 可见
      expect(v.findAll('.node-g[aria-label="阿三（仅被提及）"]')).toHaveLength(1) // 无卡节点自证
    } finally {
      v.unmount()
    }
  })

  it('方向键按几何就近跳：中心 ↓ 落环 1 下方节点（停靠点随焦点迁移）、↑ 回中心、无候选方向不动', async () => {
    const v = await mountView(true)
    try {
      const center = nodeWith(v, '林远').element as SVGElement
      const asan = nodeWith(v, '阿三').element as SVGElement
      center.focus()
      expect(document.activeElement).toBe(center)

      const down = press(center, 'ArrowDown')
      await nextTick()
      expect(down.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(asan) // 环 1 上下分居：苏婉在上、阿三在下
      expect(nodeWith(v, '阿三').attributes('tabindex')).toBe('0') // roving 停靠点随焦点走
      expect(nodeWith(v, '林远').attributes('tabindex')).toBe('-1')

      press(asan, 'ArrowUp')
      await nextTick()
      expect(document.activeElement).toBe(center) // 上行最近的是中心，不是环上另一节点

      // 最下方节点再 ↓ 无候选：焦点不动（按键仍被消费，防页面默认行为）
      asan.focus()
      const none = press(asan, 'ArrowDown')
      await nextTick()
      expect(none.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(asan)
    } finally {
      v.unmount()
    }
  })

  it('Enter/Space 选中节点（走既有 selectNode 语义）：右侧详情卡随之联动', async () => {
    const v = await mountView(true)
    try {
      const su = nodeWith(v, '苏婉').element as SVGElement
      su.focus()
      press(su, 'Enter')
      await nextTick()
      expect(v.find('.dc-name').text()).toBe('苏婉')
      expect(v.find('.dc-rel-name').text()).toBe('林远') // 详情卡关系项跟随新选中
      expect(nodeWith(v, '苏婉').attributes('aria-current')).toBe('true')

      const asan = nodeWith(v, '阿三').element as SVGElement
      asan.focus()
      press(asan, ' ')
      await nextTick()
      expect(v.find('.dc-name').text()).toBe('阿三') // Space 同 Enter（无卡节点走「仅被提及」分支）
      expect(v.find('.dc-nocard').exists()).toBe(true)
    } finally {
      v.unmount()
    }
  })

  it('详情卡关系项 role=button + tabindex=0：Enter/Space 同点击语义（跳转选中）', async () => {
    const v = await mountView(true)
    try {
      const items = v.findAll('.dc-rel li')
      expect(items).toHaveLength(2) // 林远：苏婉（恋人）+ 阿三（债务）
      expect(items.every((li) => li.attributes('role') === 'button' && li.attributes('tabindex') === '0')).toBe(true)
      const first = items[0]!.element as HTMLElement
      first.focus()
      expect(document.activeElement).toBe(first)
      press(first, 'Enter')
      await nextTick()
      expect(v.find('.dc-name').text()).toBe('苏婉')

      const back = v.findAll('.dc-rel li')[0]!.element as HTMLElement // 苏婉的唯一关系项 = 林远
      back.focus()
      press(back, ' ')
      await nextTick()
      expect(v.find('.dc-name').text()).toBe('林远')
    } finally {
      v.unmount()
    }
  })

  it('图例 chip 是原生按钮（Enter/Space 走浏览器激活，与点击同语义）+ aria-pressed 反映显隐', async () => {
    const v = await mountView(true)
    try {
      const chip = v.find('.legend .lg.clickable')
      expect(chip.element.tagName).toBe('BUTTON')
      expect(chip.attributes('type')).toBe('button')
      expect(chip.attributes('aria-pressed')).toBe('true') // 默认该语义色显示中
      await chip.trigger('click') // 键盘 Enter/Space 走浏览器同一激活路径
      await nextTick()
      expect(chip.attributes('aria-pressed')).toBe('false')
      expect(v.findAll('.edge')).toHaveLength(1) // 恋人边随该语义色过滤隐去，债务边不受影响
    } finally {
      v.unmount()
    }
  })
})
