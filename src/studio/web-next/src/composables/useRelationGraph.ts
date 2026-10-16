/**
 * 关系图共享逻辑（RelationsView 拆分）：节点/边状态 + 径向层次布局 + 派生与视觉编码
 * + 交互装配。壳 RelationsView 调 useRelationGraph(bookName)，本件把三组共享面 provide
 * 出去，RelationGraph / RelationDetail 子组件各自 inject——避免海量 props 透传。
 *
 * 对外契约 = 三个按职能分组的 provide key：状态（数据/筛选/焦点）、渲染（派生统计/视觉
 * 编码）、操作（画布交互/业务动作）。每组是 reactive 组对象：组内字段即解包后的裸值，
 * 模板与脚本直读 `state.nodes` / `render.edgeGeoms` / `ops.onMine`，不再逐处 `.value`；
 * 新增派生值只落一组、只改一处消费。
 *
 * 响应性口径（组内字段不得解构）：组承载的仍是原 ref/computed（ref 身份未变），
 * reactive 只在读写口解包——读到的是值、赋值写回 `.value`，与裸 ref 逐位等价。
 * 因此 `const { nodes } = state` 取到的是当下快照，此后模板不再更新：组要么整体持有
 * （provide/inject 传的就是组本身），要么只解构外层 handle（`{ state, render, ops }`
 * 是普通对象，三个组引用恒定，解构安全）。
 *
 * 引用稳定约定：画布/交互面的函数（bindSvg / onWheel / onNodeDown…）与节点、边数组
 * 原样传递，不包装不重建——`:ref="ops.bindSvg"` 依赖函数引用稳定；useRelationInteraction
 * 依赖注入进去的 ref（view / selectedId）身份不变。
 *
 * 布局说明：主角居中，其余角色按 BFS 跳数分环；二环挂在各自父节点的角度扇区内——
 * 位置本身即语义（谁是核心、谁因谁而来），且确定性布局每次打开都一致。
 * 数据源 #7.5 settings（parseRelations 派生自角色卡「关系」）。
 *
 * 分层（原 719 行混布局/交互一处）：纯计算在 shared/relation-layout
 *（BFS 分环）、交互在 ./useRelationInteraction（拖拽/平移/缩放/复位 + window 监听
 * 登记与卸载），本文件只留数据装载、布局编排、派生/筛选/视觉编码，并把交互面装配进
 * 操作组——对外字段在分组内与分组前逐位一致。
 */
import { ref, computed, reactive, onMounted, provide, inject, type InjectionKey } from 'vue'
import { useRoute } from 'vue-router'
import { getSettings, mineRelations, type CharacterCard, type RelationEdge, type DebtEdge } from '../api/settings'
import { useDocStore } from '../stores/doc'
import { useWorkspaceStore } from '../stores/workspace'
import { useTreeStore } from '../stores/tree'
import { useUiStore } from '../stores/ui'
import { usePrefsStore } from '../stores/prefs'
import { friendlyError } from '../shared/error'
import { CX, CY, W, H, computeRadialLayout } from '../shared/relation-layout'
import { useRelationInteraction } from './useRelationInteraction'

export interface SimNode {
  id: string
  /** 当前位置（拖拽可改） */
  x: number
  y: number
  /** 径向布局算出的原位（双击复位回这里） */
  homeX: number
  homeY: number
  /** 距中心的跳数：0=主角，1=直连，2+=外围，孤立角色排最外环 */
  ring: number
  /** 该节点在环上的角度（弧度），子节点据此挂扇区 */
  angle: number
  degree: number
  isCenter: boolean
  hasCard: boolean
  file?: string
  card?: CharacterCard
}
interface SimEdge {
  from: string
  to: string
  type: string
  kind: 'relation' | 'debt'
  note?: string
}

/** 详情卡关系项（选中节点视角的邻边：对方名 + 边语义 + 对方有无角色卡） */
export interface SelectedRelation {
  other: string
  type: string
  kind: 'relation' | 'debt'
  hasCard: boolean
  note?: string
}

// 画布基准与布局常量：移 shared/relation-layout（纯函数层，可单测）；
// CX/CY 转发导出（RelationGraph.vue 消费）
export { CX, CY } from '../shared/relation-layout'

/** 图例只列本图真正出现的语义色，没有的关系类型不占位（债务另有一项，不参与统计）。 */
const LEGEND = [
  { color: 'var(--cat-5)', label: '亲密' },
  { color: 'var(--cat-4)', label: '长辈' },
  { color: 'var(--cat-3)', label: '同辈' },
  { color: 'var(--cat-2)', label: '从属' },
  { color: 'var(--cat-1)', label: '对立' },
] as const

/** 债务边的弓形高度：同一对角色往往既有关系边又有债务边，直线会完全重合。 */
const DEBT_BOW = 26

// 滚轮缩放纯函数随交互面迁 ./useRelationInteraction，原入口（测试的具名导入）经下方
// re-export 原样保留——对外模块面零变化。
export { wheelScale } from './useRelationInteraction'

/** 共享面之一——状态：图数据、三层筛选与焦点（选中/hover/拖拽）及其派生视图。
 *  焦点口径：hover（临时探索）优先，否则选中（详情卡所指）。 */
export interface RelationState {
  nodes: SimNode[]
  edges: SimEdge[]
  loading: boolean
  err: string | null
  searchQuery: string
  showOrphans: boolean
  hiddenColors: Set<string>
  visibleNodes: SimNode[]
  hiddenCount: number
  hoverId: string | null
  selectedId: string | null
  dragId: string | null
  selectedNode: SimNode | null
  selectedCard: CharacterCard | null
  selectedRelations: SelectedRelation[]
}

/** 共享面之二——渲染：视口/边几何/计数/图例等派生值 + 节点与边的视觉编码。 */
export interface RelationRender {
  view: { x: number; y: number; w: number; h: number }
  viewBoxStr: string
  edgeGeoms: { e: SimEdge; d: string; mx: number; my: number }[]
  nodeCount: number
  edgeCount: number
  debtCount: number
  activeLegend: Array<(typeof LEGEND)[number]>
  isDim: (id: string) => boolean
  edgeDim: (e: SimEdge) => boolean
  edgeActive: (e: SimEdge) => boolean
  nodeFontSize: (node: SimNode) => number
  nodeH: (node: SimNode) => number
  nodeW: (node: SimNode) => number
  nodeRx: (node: SimNode) => number
  nodeColor: (node: SimNode) => string
  edgeColor: (e: SimEdge) => string
  relColor: (r: { type: string; kind: 'relation' | 'debt' }) => string
}

/** 共享面之三——操作：画布交互（拖拽/平移/缩放/复位 + svg 绑定）与业务动作
 *（点选与图例过滤、重载、AI 梳理、打开角色卡）。 */
export interface RelationOps {
  bindSvg: (el: unknown) => void
  onWheel: (evt: WheelEvent) => void
  onBgDown: (evt: MouseEvent) => void
  onNodeDown: (node: SimNode, evt: MouseEvent) => void
  onNodeDblClick: (node: SimNode) => void
  resetView: () => void
  selectNode: (id: string) => void
  toggleColor: (color: string) => void
  mining: boolean
  onMine: () => Promise<void>
  openCharacter: (n: SimNode) => Promise<void>
  load: () => Promise<void>
}

/** useRelationGraph 的返回（= 三个 provide key 的持有袋）。
 *  外层是普通对象：解构出组是安全的；组内字段不可解构（见文件头响应性口径）。 */
export interface RelationGraphHandle {
  state: RelationState
  render: RelationRender
  ops: RelationOps
}

const STATE_KEY: InjectionKey<RelationState> = Symbol('rel-graph-state')
const RENDER_KEY: InjectionKey<RelationRender> = Symbol('rel-graph-render')
const OPS_KEY: InjectionKey<RelationOps> = Symbol('rel-graph-ops')

/** 子组件取图共享面（必须在 RelationsView 的 provide 作用域内调用）。
 *  三组分别注入：缺任一组即 provide/inject 契约破损，就地抛错定位，不让下游读到 undefined。 */
export function useRelationGraphInjected(): RelationGraphHandle {
  const state = inject(STATE_KEY)
  const render = inject(RENDER_KEY)
  const ops = inject(OPS_KEY)
  if (!state || !render || !ops) throw new Error('useRelationGraphInjected 必须在 RelationsView 内部使用')
  return { state, render, ops }
}

export function useRelationGraph(bookName: string): RelationGraphHandle {
  const doc = useDocStore()
  const ws = useWorkspaceStore()
  const tree = useTreeStore()
  const ui = useUiStore()
  // 关系图自动梳理的全局默认托底（书级未设时生效；ref 初值即硬编码回落，服务端合并同链）
  const prefs = usePrefsStore()
  // 切书复检即时源——setup 语境取一次（onMine 事件/异步链里调 useRoute 会脱离
  // inject 语境报错）；route.params.name 随导航即时更新，比 doc.bookName（flushDirty 滞后
  // 数秒）可靠
  const route = useRoute()

  const nodes = ref<SimNode[]>([])
  const edges = ref<SimEdge[]>([])
  const loading = ref(true)
  const err = ref<string | null>(null)
  const hoverId = ref<string | null>(null)
  const selectedId = ref<string | null>(null)
  const searchQuery = ref('')
  /** viewBox（缩放/平移）：{x,y,w,h} */
  const view = ref({ x: 0, y: 0, w: W, h: H })
  const viewBoxStr = computed(() => `${view.value.x} ${view.value.y} ${view.value.w} ${view.value.h}`)

  function buildGraph(characters: CharacterCard[], rels: RelationEdge[], debts: DebtEdge[]): void {
    const byId = new Map<string, SimNode>()
    const ensure = (id: string, hasCard: boolean, file?: string, card?: CharacterCard): SimNode => {
      let n = byId.get(id)
      if (!n) {
        n = {
          id,
          x: CX,
          y: CY,
          homeX: CX,
          homeY: CY,
          ring: 0,
          angle: 0,
          degree: 0,
          isCenter: false,
          hasCard,
          file,
          card,
        }
        byId.set(id, n)
      } else if (card && !n.card) {
        n.card = card
        n.hasCard = true
        n.file = file
      }
      return n
    }
    for (const c of characters) {
      if (c.姓名) ensure(c.姓名, true, c.file, c)
    }
    // 角色卡的「关系」是双方各记一遍（林远记恋人苏婉，苏婉也记恋人林远），
    // 直接建边会得到两条完全重合的线：度数翻倍、标签叠画。按无向对去重。
    const valid: SimEdge[] = []
    const seen = new Set<string>()
    const pairKey = (a: string, b: string, kind: string): string => `${a < b ? `${a} ${b}` : `${b} ${a}`} ${kind}`
    for (const r of rels) {
      if (!r.from || !r.to || r.from === r.to) continue
      const k = pairKey(r.from, r.to, 'relation')
      if (seen.has(k)) continue
      seen.add(k)
      valid.push({ from: r.from, to: r.to, type: r.type, kind: 'relation', note: r.note })
      ensure(r.from, byId.has(r.from) ? byId.get(r.from)!.hasCard : false)
      ensure(r.to, byId.has(r.to) ? byId.get(r.to)!.hasCard : false)
    }
    // 债务子图：欠方→债主，弧线虚线（与同一对的关系边错开）；端点可能无角色卡 → 灰节点
    for (const d of debts) {
      if (!d.欠方 || !d.债主 || d.欠方 === d.债主) continue
      const k = pairKey(d.欠方, d.债主, 'debt')
      if (seen.has(k)) continue
      seen.add(k)
      valid.push({ from: d.欠方, to: d.债主, type: d.标题 || '债', kind: 'debt' })
      ensure(d.欠方, byId.has(d.欠方) ? byId.get(d.欠方)!.hasCard : false)
      ensure(d.债主, byId.has(d.债主) ? byId.get(d.债主)!.hasCard : false)
    }
    for (const e of valid) {
      byId.get(e.from)!.degree++
      byId.get(e.to)!.degree++
    }
    nodes.value = [...byId.values()]
    edges.value = valid
    layoutRadial()
    // 默认选中中心角色
    const center = nodes.value.find((n) => n.isCenter)
    if (center) selectedId.value = center.id
  }

  // ── 径向层次布局 ──────────────────────────────
  // 力导向对 5~10 个节点会退化成随机散点，且每次位置都不同；这里改用
  // 确定性的 BFS 分环，位置稳定且直接表达层次。
  // 算法本体抽 shared/relation-layout.ts 纯函数（可独立单测），
  // 此处只留「数据 → 算法 → 视口贴合」的编排。

  function layoutRadial(): void {
    if (!nodes.value.length) return
    computeRadialLayout(nodes.value, edges.value, edgeTypeOf)
    fitView()
  }

  /** 中心与某节点之间的关系类型（环 1 排序用；无边 → 空串）。 */
  function edgeTypeOf(a: string, b: string): string {
    const e = edges.value.find((x) => (x.from === a && x.to === b) || (x.from === b && x.to === a))
    return e?.type ?? ''
  }

  /** 视口贴合内容包围盒（节点少时不留大片空白）。 */
  function fitView(): void {
    const ns = nodes.value
    if (!ns.length) return
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    for (const n of ns) {
      const hw = nodeW(n) / 2
      const hh = nodeH(n) / 2
      minX = Math.min(minX, n.homeX - hw)
      maxX = Math.max(maxX, n.homeX + hw)
      minY = Math.min(minY, n.homeY - hh)
      maxY = Math.max(maxY, n.homeY + hh)
    }
    const pad = 48
    const cw = maxX - minX + pad * 2
    const ch = maxY - minY + pad * 2
    // 保持画布宽高比，短边补足
    const ratio = W / H
    let w = cw
    let h = ch
    if (w / h > ratio) h = w / ratio
    else w = h * ratio
    view.value = {
      x: (minX + maxX) / 2 - w / 2,
      y: (minY + maxY) / 2 - h / 2,
      w,
      h,
    }
  }

  async function load(): Promise<void> {
    loading.value = true
    err.value = null
    try {
      const r = await getSettings(bookName)
      buildGraph(r.characters, r.characterRelations, r.debtGraph)
      loading.value = false
      // 自动梳理：章节增量达阈值时触发
      void maybeAutoMine(r.relationCache)
    } catch (e) {
      err.value = friendlyError(e)
      loading.value = false
    }
  }
  onMounted(load)

  // ── AI 关系梳理（读名册/角色卡/正文，AI 提炼关系边）──
  const mining = ref(false)
  /** 显示孤立角色（有卡但零关系边） */
  const showOrphans = ref(false)
  /** 被图例 chip 过滤掉的语义色集合 */
  const hiddenColors = ref<Set<string>>(new Set())
  async function onMine(): Promise<void> {
    if (mining.value) return
    // 书名入口捕获 + await 后复检（StyleAcceptancePanel 同款）——RelationsView
    // 挂 :key=bookName 整树重建，本死实例的 bookName 参数冻结在旧书；梳理可达数分钟，
    // 在途切书后成败 toast 都会落在新书界面、死续体 load 还会重拉旧书数据。
    // 活源比 doc store 内 live bookName（Book.vue 切书编排的权威书名，ForeshadowPanel 同款）
    const book = bookName
    mining.value = true
    err.value = null
    try {
      const r = await mineRelations(book, true)
      if (route.params.name !== book) return // 已切书：死实例不再 toast / 重拉旧书
      if (r.ok && r.relations.length) {
        ui.toast(`AI 已梳理 ${r.relations.length} 条关系`, 'success')
        await load()
      } else {
        ui.toast('AI 未梳理到关系（材料不足或产出为空）', 'info')
      }
    } catch (e) {
      // 梳理失败只 toast，不覆盖 err——图主体已渲染成功，页面不应变「载入失败」
      if (route.params.name !== book) return // A 书的失败 toast 不落 B 书界面（改路由参数即时源）
      ui.toast(friendlyError(e), 'error')
    } finally {
      mining.value = false
    }
  }

  /** 自动梳理：打开关系图时，若章节增量达阈值则触发。仅探测明确可用才自动（避免失败 toast）。 */
  async function maybeAutoMine(cache?: { chapterCount: number | null; currentChapters: number }): Promise<void> {
    if (mining.value || !cache) return
    // 自动路径仅明确可用（true）才放行——原 === false 判定让探测中
    //（null）也起跑，后端实际不可达时自动梳理变成自动失败 toast；手动 onMine 不受影响
    if (ui.aiAvailable !== true) return
    // 配置读走 workspace.loadBookConfig 单源（同书多消费方共享一次请求与缓存）；
    // 读不到（error 面）与失败同口径——不自动触发（不惊扰作者）
    const loaded = await ws.loadBookConfig(bookName)
    if (loaded.error) return
    // 自动梳理默认关闭（方案③：手动按钮控成本）；作者开启（书级 ?? 全局默认）后才自动
    if (!(loaded.config.auto?.relation_auto_mine ?? prefs.get('relationAutoMine'))) return
    const threshold = loaded.config.auto?.relation_mine_threshold ?? prefs.get('relationMineThreshold')
    const last = cache.chapterCount ?? 0
    if (cache.currentChapters - last < threshold) return
    await onMine()
  }

  /** 图例 chip toggle：隐藏/恢复某类语义色的边。 */
  function toggleColor(color: string): void {
    const s = new Set(hiddenColors.value)
    if (s.has(color)) s.delete(color)
    else s.add(color)
    hiddenColors.value = s
  }

  // ── 节点视觉编码 ──────────────────────────────
  // 尺寸三级（主角 > 有卡角色 > 仅被提及），度数不再做连续映射：
  // 十来个节点下连续映射的差异肉眼分辨不出，只会让胶囊参差不齐。

  /** 字号三级。胶囊高宽跟随字号。 */
  function nodeFontSize(node: SimNode): number {
    if (node.isCenter) return 16
    if (!node.hasCard) return 11
    return node.degree >= 3 ? 14 : 13
  }
  /** 胶囊高度 = 字号 + 上下内边距。 */
  function nodeH(node: SimNode): number {
    return nodeFontSize(node) + (node.isCenter ? 18 : 13)
  }
  /** 胶囊宽度 = 字号 × 字数 + 左右内边距（中文字宽约 1em）。 */
  function nodeW(node: SimNode): number {
    return nodeFontSize(node) * Math.max(1, node.id.length) + (node.isCenter ? 32 : 24)
  }
  /** 胶囊圆角 = 半高（全圆胶囊端）。 */
  function nodeRx(node: SimNode): number {
    return nodeH(node) / 2
  }

  /**
   * 语义 → categorical token（色盲安全）。节点身份与边关系共用一套规则，
   * 保证「师父」节点和「师徒」边同色，读图不用来回对照图例。
   */
  function semanticColor(t: string): string {
    if (/敌|仇|恨|魔/.test(t)) return 'var(--cat-1)'
    if (/师|徒|长|父|母|养|亲子/.test(t)) return 'var(--cat-4)'
    if (/情|爱|恋|妻|夫|婚/.test(t)) return 'var(--cat-5)'
    if (/兄|弟|姐|妹|友|同|手足/.test(t)) return 'var(--cat-3)'
    if (/主|仆|属|下|臣/.test(t)) return 'var(--cat-2)'
    return 'var(--text-muted)'
  }
  /** 节点主色：主角=强调色，无卡=灰，其余按身份语义。 */
  function nodeColor(node: SimNode): string {
    if (node.isCenter) return 'var(--interactive-accent)'
    if (!node.hasCard) return 'var(--text-faint)'
    const id = node.card?.身份 ?? ''
    if (/主角|主人公/.test(id)) return 'var(--interactive-accent)'
    return semanticColor(id)
  }

  const byIdMap = computed(() => new Map(nodes.value.map((n) => [n.id, n])))
  function nodeX(id: string): number {
    return byIdMap.value.get(id)?.x ?? CX
  }
  function nodeY(id: string): number {
    return byIdMap.value.get(id)?.y ?? CY
  }

  /** 边几何：关系边走直线，债务边走弧线；顺带给出标签落点。 */
  const edgeGeoms = computed(() => {
    const visIds = new Set(visibleNodes.value.map((n) => n.id))
    return edges.value
      .filter((e) => visIds.has(e.from) && visIds.has(e.to) && !hiddenColors.value.has(edgeColor(e)))
      .map((e) => {
        const x1 = nodeX(e.from)
        const y1 = nodeY(e.from)
        const x2 = nodeX(e.to)
        const y2 = nodeY(e.to)
        if (e.kind !== 'debt') {
          return { e, d: `M${x1},${y1}L${x2},${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 }
        }
        const len = Math.max(1, Math.hypot(x2 - x1, y2 - y1))
        // 控制点沿中垂线外推 2×BOW，二次贝塞尔的弧顶恰好落在 1×BOW 处
        const ox = (-(y2 - y1) / len) * DEBT_BOW * 2
        const oy = ((x2 - x1) / len) * DEBT_BOW * 2
        return {
          e,
          d: `M${x1},${y1}Q${(x1 + x2) / 2 + ox},${(y1 + y2) / 2 + oy} ${x2},${y2}`,
          mx: (x1 + x2) / 2 + ox / 2,
          my: (y1 + y2) / 2 + oy / 2,
        }
      })
  })

  // 焦点 = 悬停（临时探索）优先，否则选中（详情卡所指）
  const focusId = computed(() => hoverId.value ?? selectedId.value)
  const neighbors = computed<Set<string>>(() => {
    const h = focusId.value
    if (!h) return new Set()
    const s = new Set<string>([h])
    for (const e of edges.value) {
      if (e.from === h) s.add(e.to)
      if (e.to === h) s.add(e.from)
    }
    return s
  })

  // ── 三层筛选：孤立过滤 → 图例类型过滤 → 搜索聚焦 ──
  /** 搜索匹配节点 + 其一阶邻居（搜索即聚焦到子图） */
  const searchNeighbors = computed<Set<string>>(() => {
    const q = searchQuery.value.trim().toLowerCase()
    if (!q) return new Set()
    const s = new Set<string>()
    for (const n of nodes.value) {
      if (n.id.toLowerCase().includes(q)) {
        s.add(n.id)
        for (const e of edges.value) {
          if (e.from === n.id) s.add(e.to)
          if (e.to === n.id) s.add(e.from)
        }
      }
    }
    return s
  })
  /** 图例过滤后仍可见的边（用于计算有效 degree / 孤立判定） */
  const effectiveEdges = computed(() => edges.value.filter((e) => !hiddenColors.value.has(edgeColor(e))))
  /** 可见节点：默认隐藏孤立（含因图例过滤变孤立的），搜索时只留匹配+邻居 */
  const visibleNodes = computed(() => {
    const visEdgeIds = new Set(effectiveEdges.value.flatMap((e) => [e.from, e.to]))
    let ns = nodes.value
    if (!showOrphans.value) {
      ns = ns.filter((n) => n.isCenter || visEdgeIds.has(n.id))
    }
    if (searchQuery.value.trim()) {
      ns = ns.filter((n) => searchNeighbors.value.has(n.id))
    }
    return ns
  })
  const hiddenCount = computed(() => nodes.value.length - visibleNodes.value.length)

  function isDim(id: string): boolean {
    // 只有主动 hover 才压暗他人。选中态不压暗——否则一进来默认选中主角，
    // 不与主角相连的关系当场消失，全局图先天残缺。
    // 搜索/图例过滤由 visibleNodes 直接隐藏，不再走 dim。
    return hoverId.value !== null && !neighbors.value.has(id)
  }
  function edgeDim(e: SimEdge): boolean {
    const h = hoverId.value
    return h !== null && e.from !== h && e.to !== h
  }
  /** 高亮 + 显标签：hover 或选中都算（标签只给焦点邻边，避免全图标签打架）。 */
  function edgeActive(e: SimEdge): boolean {
    return focusId.value !== null && (e.from === focusId.value || e.to === focusId.value)
  }

  // ── 右侧详情卡派生（跟随 selectedId，不随 hover 跳动）──
  const selectedNode = computed(() => nodes.value.find((n) => n.id === selectedId.value) ?? null)
  const selectedCard = computed(() => selectedNode.value?.card ?? null)
  const selectedRelations = computed<SelectedRelation[]>(() => {
    const id = selectedId.value
    if (!id) return []
    const out: SelectedRelation[] = []
    for (const e of edges.value) {
      if (e.from === id)
        out.push({
          other: e.to,
          type: e.type,
          kind: e.kind,
          hasCard: byIdMap.value.get(e.to)?.hasCard ?? false,
          note: e.note,
        })
      else if (e.to === id)
        out.push({
          other: e.from,
          type: e.type,
          kind: e.kind,
          hasCard: byIdMap.value.get(e.from)?.hasCard ?? false,
          note: e.note,
        })
    }
    return out
  })
  function selectNode(id: string): void {
    selectedId.value = id
  }

  /** 打开角色卡 tab（详情卡按钮触发）。无 file / 不在树中 → 忽略。 */
  async function openCharacter(n: SimNode): Promise<void> {
    if (!n.hasCard || !n.file) return
    const node = tree.byPath.get(n.file)
    if (!node || !node.docId) return
    // 书名入口捕获 + await 后复检（onMine 同款）——doc.open 的 await 窗口内切书后
    // 旧书 docId 会写进新书工作区（空白页 / 顶开新书同路径文档），违反「迟到写操作不落新书」红线。
    const book = bookName
    try {
      await doc.open(node)
      if (route.params.name !== book) return // 已切书：死实例不写工作区
      ws.openTab(node.docId)
    } catch (e) {
      // 前端：静默吞错收敛（对齐 ForeshadowPanel）；切书后失败 toast 不落新书界面
      if (route.params.name !== book) return
      ui.toast(friendlyError(e), 'error')
    }
  }

  // 交互面（拖拽/平移/缩放/复位 + window 监听登记与卸载）抽
  // ./useRelationInteraction：数据面经 deps 注入（节点读数口 / 视口 / 选中 / 视口贴合），
  // 本文件只装配——对外操作组内字段名与装配前逐位一致。
  // 注入的 view / selectedId 是下面的同一个 ref 实例，身份不得换（交互写回同一响应源）。
  const { bindSvg, dragId, onWheel, onBgDown, onNodeDown, onNodeDblClick, resetView } = useRelationInteraction({
    readNodes: () => nodes.value,
    view,
    selectedId,
    fitView,
  })

  /** 边色：债务恒用 --cat-1（朱红），靠 .debt 虚线区分线型；其余走语义映射。 */
  function edgeColor(e: SimEdge): string {
    return e.kind === 'debt' ? 'var(--cat-1)' : semanticColor(e.type)
  }
  /** 详情卡关系项颜色（复用 edgeColor 语义） */
  function relColor(r: { type: string; kind: 'relation' | 'debt' }): string {
    return edgeColor({ from: '', to: '', type: r.type, kind: r.kind })
  }

  const nodeCount = computed(() => nodes.value.length)
  const edgeCount = computed(() => edges.value.filter((e) => e.kind === 'relation').length)
  const debtCount = computed(() => edges.value.filter((e) => e.kind === 'debt').length)

  /** 图例只列本图真正出现的语义色（activeLegend 过滤） */
  const activeLegend = computed(() => {
    const used = new Set(edges.value.filter((e) => e.kind === 'relation').map((e) => edgeColor(e)))
    return LEGEND.filter((l) => used.has(l.color))
  })

  // 三组共享面：字段仍是上面的 ref/computed（reactive 只在读写口解包），组对象本身即
  // provide 值——子组件 inject 到的是同一实例，不复制、不重建。
  const state: RelationState = reactive({
    nodes,
    edges,
    loading,
    err,
    searchQuery,
    showOrphans,
    hiddenColors,
    visibleNodes,
    hiddenCount,
    hoverId,
    selectedId,
    dragId,
    selectedNode,
    selectedCard,
    selectedRelations,
  })
  const render: RelationRender = reactive({
    view,
    viewBoxStr,
    edgeGeoms,
    nodeCount,
    edgeCount,
    debtCount,
    activeLegend,
    isDim,
    edgeDim,
    edgeActive,
    nodeFontSize,
    nodeH,
    nodeW,
    nodeRx,
    nodeColor,
    edgeColor,
    relColor,
  })
  const ops: RelationOps = reactive({
    bindSvg,
    onWheel,
    onBgDown,
    onNodeDown,
    onNodeDblClick,
    resetView,
    selectNode,
    toggleColor,
    mining,
    onMine,
    openCharacter,
    load,
  })

  provide(STATE_KEY, state)
  provide(RENDER_KEY, render)
  provide(OPS_KEY, ops)
  return { state, render, ops }
}
