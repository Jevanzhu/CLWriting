/**
 * RC 源码重审 B-5（Opus-5.5 轮）：切书守卫状态机独立成 composable。
 *
 * 为什么独立：这段是 Book.vue setup 里最大的一块纯编排（约 180 行）——watch(bookName)
 * 的切书链（脏路由分支 / Z-8 冲突预检 / F1 保存失败 / R37-1 flush 后冲突复查三段守卫）
 * 加取消回滚（清污 → 回退路由 → resync + 补种原书历史）。四条条件转移各自带 R 编号
 * 沿革、彼此靠 gen/lastBook 两个代次量耦合，混在页面 setup 里既难分辨「编排 vs 展示」，
 * 也只能经挂载整个 Book 页间接行使。抽出后页面只剩接线，状态机可独立直测
 * （见 test/studio/webnext/book-switch-guard-segments.test.ts）。
 *
 * R0916-7-P3-20（评审 P3-20）改写——切书安全不再靠「先切后回滚」：
 * - ①**路由提交前守卫**（原地切书 /book/A → /book/B，onBeforeRouteUpdate）：冲刷与三段
 *   决断完成才放行；作者取消 → 返回 false 中止导航，路由不提交、目标书 SSE 不连、事件
 *   不落 store。该路径上「先切后回滚」整段（取消后的清污 / 回退路由 / resync 补种）随之
 *   消失——取消时一条状态都没动过。
 * - ②**提交后 watch** 只兜不在此前移的入口：a) 预决断移交（守卫已决断 → 只做状态转移）；
 *   b) 脏路由（name=''：无回退目标，E-7 口径的 flush + 留痕，不弹决断窗）；c) 重挂进书
 *   （/book/A → /shelf → /book/B：Book.vue 未挂载时路由已提交，**本批文件面内无法前移**
 *   ——守卫注册点在 Book.vue 的 setup，未挂载即无从拦截），此路如实保留最小回滚
 *   （revertToPrevBook），不假装前移。
 * - ③**书会话**（composables/useBookSession）接管「进书创建 / 离书 abort」：迟到结果由
 *   会话信号（api/client 按路径接驳）+ AbortError 统一吸收，不再逐点手写书名复检。
 *
 * 生命周期：本 composable 注册一个 watch(bookName, …, { immediate: true }) + 一个
 * onBeforeRouteUpdate（仅 Book 页在册期有效），无定时器与窗事件监听，随组件实例自动停。
 *
 * 语义零变化面：Z-8 / F1 / R37-1 三段的预检条件、弹窗文案、决断顺序、清理时序逐位保持
 * （E-7 / R26-18 / R28-24 / R29-10 / R32-8 / R33-9 / R33D-9 / R37-1 / Z-8 / F1 / P1-7a
 * 各条注释随迁）；`bookName`/`resync` 仍为注入（原为本页 computed 与 useSse 句柄），
 * 各 store 在本函数内取实例（与调用点同在 setup 上下文，实例同源）。
 */
import { watch, type ComputedRef } from 'vue'
import { onBeforeRouteUpdate, useRouter, type RouteLocationNormalized } from 'vue-router'
import { useDocStore } from '../stores/doc'
import { useWorkspaceStore } from '../stores/workspace'
import { useCheckStore } from '../stores/check'
import { useReviewStore } from '../stores/review'
import { useLearnStore } from '../stores/learn'
import { useStyleStore } from '../stores/style'
import { useRewriteStore } from '../stores/rewrite'
import { useWorkbenchStore } from '../stores/workbench'
import { useChatStore } from '../stores/chat'
import { useUiStore } from '../stores/ui'
import { useChatTier } from './useChatTier'
import { useStaleGuard } from './useStaleGuard'
import { beginBookSession, endBookSession } from './useBookSession'

/** 切书守卫的注入面（其余依赖在本函数内取——pinia/路由实例与 setup 同源）。 */
export interface BookSwitchGuardDeps {
  /** 当前书（route.params.name 派生的 computed；同书重入短路与脏路由分支的判据源） */
  bookName: ComputedRef<string>
  /** 强制重取连接级 SSE sync 快照（useSse 句柄的 resync——R29-10 切书链尾收口） */
  resync: () => void
}

/** 路由书名单源：params.name 缺失（脏路由/手输 URL）归空串——与 Book.vue 的 bookName
 *  computed 同口径（String(undefined) 会把字面量 'undefined' 当书名）。 */
function routeBookName(r: RouteLocationNormalized): string {
  const n = r.params.name
  return n === undefined || n === null ? '' : String(n)
}

/** 注册切书链（路由提交前守卫 + 提交后 watch 兜底）。无返回值。 */
export function useBookSwitchGuard(deps: BookSwitchGuardDeps): void {
  const { bookName, resync } = deps
  const router = useRouter()
  const doc = useDocStore()
  const ws = useWorkspaceStore()
  const check = useCheckStore()
  const review = useReviewStore()
  const learn = useLearnStore()
  const style = useStyleStore()
  const rewrite = useRewriteStore()
  const workbench = useWorkbenchStore()
  const chat = useChatStore()
  const ui = useUiStore()

  // R0916-7-P3-26：切书代次收敛 useStaleGuard 单源（原裸计数器 bookGen）。判定时机逐位
  // 不变（await 后先查代再落态）：脏路由 flush 窗、三段守卫的弹窗 await 窗与链尾 resync
  // 前各有一道 stale/fresh 复检，作废轮的迟到结果一律不落态、不回滚。
  const bookGen = useStaleGuard()
  // Z-8（第五十八轮）：上一本书名（冲突守卫取消时回退路由用）
  let lastBook = ''
  // R0916-7-P3-20：原地切书守卫放行后置位的「已决断」移交目标（本 composable 闭包内单源，
  // 与 watch 同注册处——同起止）；watch 见此只做状态转移，不重复弹窗/回滚。
  let preConfirmed = ''
  // R0916-7-P3-20：内部回滚导航抑制位——revertToPrevBook 的 router.replace 同样是「本
  // 路由记录参数更新」，会再次触发提交前守卫；那是回滚自己发起的导航，不得再被冲刷/决断
  // 拦一遍（否则回滚被二次弹窗拦住）。置位窗口覆盖该次 replace 的守卫执行期。
  let suppressLeaveGuard = false

  /** 清空事件驱动各 store（切书/脏路由/回退共用六件；workbench 清点由各段口径单独控制） */
  function clearEventStores(): void {
    check.clear()
    review.clear()
    learn.clear()
    style.clear()
    rewrite.clear()
    chat.clear()
  }

  /** 切书链首状态转移（第五轮口径：workbench.clear 早于任何 await——防「sync(running=true)
   *  先到、其后 clear 把 running 错误复位 → 可再『生成』双 spawn 窗」）。两条进入路径都在
   *  冲刷/决断落定之后调它：预决断路径在路由提交后同一拍（watch 同步分支，无 await 窗）；
   *  兜底路径在 Z-8 预检之后、flushDirty 之前（见 flushAndAdjudicate 的 onApproved）。 */
  function beginSwitch(n: string): void {
    lastBook = n
    workbench.clear()
  }

  /** 进书状态转移（两条路径共用）：清点 → setBook → 建书会话 → 补种历史/刷档位 → 链尾 resync。 */
  function enterBook(n: string, gen: number): void {
    doc.setBook(n)
    ws.setBook(n)
    // 清空各 store 旧书状态（chat 消息常驻 ChatDock，必须清；其余防残留上次操作结果）
    // P1-7a：六件清空收敛 clearEventStores 单源（时序不变）
    clearEventStores()
    // Y-P2-5：切书/刷新后从事件库恢复对话历史（store 内自带空判/竞态守卫，失败静默）
    if (n) void chat.seedHistory(n)
    // 切书后刷新对话档位（防短暂显示旧书模型列表）
    void useChatTier().refresh()
    // R0916-7-P3-20：进书 = 建书会话（并 abort 上一个会话）。调用前提见 useBookSession
    // 头注的生命周期纪律：此刻旧书的冲刷/决断已全部落定，abort 不会打断冲刷途中的保存。
    beginBookSession(n)
    // R29-10（二十九轮）：切书链收尾强制重取 SSE sync 快照——上方 await 链（确认弹窗/
    // flushDirty 秒级在途）期间新书连接的 sync 可能已到并被链首 workbench.clear() 复位
    //（假空闲 → 状态卡显示可再「生成」的双 spawn 窗）。gen 守卫通过（本轮仍是最新切书）
    // 且 bookName 仍等于 n（本轮切书结果未被再切覆盖）时，断开重连让服务端重发权威快照
    if (bookGen.fresh(gen) && bookName.value === n) resync()
  }

  /** 守卫取消分支共用回滚（**仅 committed 路径**调用——提交前守卫取消即中止导航，无需回滚）：
   *  清污 → 回退路由 → 复检通过则 resync + 补种原书历史 */
  async function revertToPrevBook(prevBook: string, gen: number, clearWorkbench: boolean): Promise<void> {
    // clearWorkbench 仅 Z-8 段为真：其弹窗在 workbench.clear()（链首，第五轮口径）之前，
    // 取消回退须补清；F1/R37-1 段弹窗前链首已清，不重复
    if (clearWorkbench) workbench.clear()
    clearEventStores()
    // R33D-9：重挂路径 lastBook 为 ''，回退目标用权威源 prevBook
    lastBook = prevBook
    suppressLeaveGuard = true
    try {
      await router.replace(`/book/${encodeURIComponent(prevBook)}`)
    } finally {
      suppressLeaveGuard = false
    }
    if (bookGen.fresh(gen) && bookName.value === prevBook) {
      resync()
      void chat.seedHistory(prevBook)
    }
  }

  /** 三段守卫共用决断弹窗（R0916-7-P3-20 自原 askDropOrRevert 收编：弹窗文案、「丢弃并切换」
   *  /「留在本书」语义逐字不变，回滚改由调用方按路径决定）。返回 'dropped' = 作者确认丢弃
   *  （调用方继续切换）；'cancelled' = 作者选择留在原书；'stale' = 弹窗 await 窗内轮回作废
   *  （仅传了 gen 时判定——提交前守卫无轮次面，传 null）。 */
  async function askDrop(opts: { gen: number | null; title: string; message: string }): Promise<'dropped' | 'cancelled' | 'stale'> {
    const drop = await ui.ask({
      title: opts.title,
      message: opts.message,
      confirmText: '丢弃并切换',
      cancelText: '留在本书',
      danger: true,
    })
    if (opts.gen !== null && bookGen.stale(opts.gen)) return 'stale'
    return drop ? 'dropped' : 'cancelled'
  }

  /**
   * 冲刷 + 三段决断单源（Z-8 未决冲突预检 → flushDirty → F1 保存失败 → R37-1 flush 后冲突
   * 复查；各段条件、文案、决断顺序与清理时序逐位不变）。两个入口共用：
   * - mode='precommit'：路由提交前守卫——作者取消回报 'cancelled'，守卫中止导航，**零状态
   *   变更**（故调用方无需任何回滚善后）；
   * - mode='committed'：watch 兜底路径（重挂进书等不可前移入口）——作者取消走
   *   revertToPrevBook 最小回滚（路由已提交，只能回滚）。
   * gen：提交前守卫传 null（路由未提交，无「轮次作废」面）；兜底路径传本轮代次。
   * onApproved：Z-8 预检通过、flushDirty 之前的状态转移钩子（兜底路径把 beginSwitch 放这里
   * ——第五轮「clear 早于 flushDirty」口径逐位不变；提交前守卫不传：取消要零变更）。
   */
  async function flushAndAdjudicate(opts: {
    mode: 'precommit' | 'committed'
    gen: number | null
    prevBook: string
    target: string
    onApproved?: () => void
  }): Promise<'ok' | 'cancelled' | 'reverted' | 'stale'> {
    const { mode, gen, prevBook, target } = opts
    /** 取消收口：提交前 = 回报调用方（守卫中止导航）；提交后 = 最小回滚 */
    const settleCancel = async (clearWorkbench: boolean): Promise<'cancelled' | 'reverted'> => {
      if (mode === 'precommit') return 'cancelled'
      await revertToPrevBook(prevBook, gen as number, clearWorkbench)
      return 'reverted'
    }
    // R37-1（三十七轮批E）：Z-8 预检已决断「丢弃并切换」的 docId 台账——预检弹窗确认后
    // 条目仍保持 conflict+dirty（flushDirty 不存 conflict 项），下方 flush 后复查须排除，
    // 否则同一批文档二次弹窗（对同一决断重复提问）
    const adjudicated = new Set<string>()
    // Z-8（第五十八轮）：未决冲突守卫——conflict && dirty 文档的本地修改从未落盘（autosave
    // 跳过 conflict 项），setBook 清缓存即不可恢复丢失，此前全程静默。确认弹窗：拒绝 → 回退
    // 路由留在原书（first watch 即时跑，lastBook 初值为空时跳过守卫）
    // R33D-9（三十三轮）：守卫的「原书」代次源补权威回退——lastBook 是组件实例本地值，
    // Book 重挂（/book/A → /shelf → /book/B）后首跑为 ''，Z-8/F1 双双跳过 → A 的
    // conflict+dirty 缓存被 setBook('B') 清掉静默丢失（doc store 是应用级单例）。故
    // prevBook 由调用方给权威源（重挂路径取 doc.bookName，见 watch 内注）。
    if (prevBook !== '' && target !== prevBook) {
      const conflicted = doc.conflictedDirtyDocs()
      if (conflicted.length > 0) {
        const verdict = await askDrop({
          gen,
          title: `有 ${conflicted.length} 个文档存在未处理的修改冲突`,
          message: '这些文档的本地修改从未保存，切换书将永久丢弃。建议先在编辑器处理（重载/覆盖）。仍要切换吗？',
        })
        if (verdict === 'stale') return 'stale'
        if (verdict === 'cancelled') return await settleCancel(true)
        // 确认丢弃：登记已决断——flush 后复查不再对这批 conflict 二次弹窗
        for (const id of conflicted) adjudicated.add(id)
      }
    }
    // 时序说明（R62-48 → R29-10 改写）——bookName 走 computed，路由一变新书 SSE/心跳
    // 即刻连上；弹窗等待与 flushDirty await 期间新书连接已存在，其连接级 sync 快照随时
    // 可能到达。第五轮把 workbench.clear() 提前到 flushDirty 之前（防「sync(running=true)
    // 先到、其后的 clear 把 running 错误复位 → 可再『生成』双 spawn 窗」），该口径保持
    // 不变；但 clear 早于 clear 前到达的 sync 仍会被复位且连接常驻不再重发（假空闲）——
    // R29-10 在链尾以 resync() 断开重连，让服务端对新连接重发权威快照收口。
    // R0916-7-P3-20：提交前路径无此面（守卫放行前 SSE 还没连新书，clear 发生在提交后同
    // 一拍，sync 快照到得比 clear 更晚——时序只会更安全）。
    opts.onApproved?.()
    // 切书前先保存当前书的 dirty 文档（setBook 会清空缓存，否则 <autosaveInterval 的编辑静默丢失）
    const failed = await doc.flushDirty()
    if (gen !== null && bookGen.stale(gen)) return 'stale' // 挂起期间路由又变：交新轮回处理
    // F1（五十九轮）：守卫拓宽——非冲突保存失败（网络断/5xx）的 dirty 文档同样从未
    // 落盘，setBook 清缓存即不可恢复丢失，与 Z-8 冲突形态同类灾难；统一走确认弹窗
    // （文案区分），拒绝 → 回退路由留在原书重试保存
    if (failed.length > 0 && prevBook !== '') {
      const verdict = await askDrop({
        gen,
        title: `有 ${failed.length} 个文档保存失败`,
        message: '这些文档的本地修改因网络/服务异常未能写入磁盘，切换书将永久丢弃。建议留在本书重试保存。仍要切换吗？',
      })
      if (verdict === 'stale') return 'stale'
      if (verdict === 'cancelled') return await settleCancel(false)
    }
    // R37-1（三十七轮批E）：flush 等待窗口内复查冲突——上方 Z-8 守卫在 flushDirty 之前
    // 查 conflictedDirtyDocs，等待期间在途保存可能落成 REVISION_CONFLICT（conflict=true、
    // dirty=true），这类条目既不在 failed 内也不被 flushDirty 后续轮次重扫，不复查则
    // setBook 清缓存即不可恢复丢失。走 Z-8 同款决断（文案/回退/清污口径与上方一致）；
    // 预检已决断「丢弃」的批次（adjudicated）不二次弹窗。
    const conflictedAfterFlush = doc.conflictedDirtyDocs().filter((id) => !adjudicated.has(id))
    if (conflictedAfterFlush.length > 0 && prevBook !== '') {
      const verdict = await askDrop({
        gen,
        title: `有 ${conflictedAfterFlush.length} 个文档存在未处理的修改冲突`,
        message: '这些文档的本地修改从未保存，切换书将永久丢弃。建议先在编辑器处理（重载/覆盖）。仍要切换吗？',
      })
      if (verdict === 'stale') return 'stale'
      if (verdict === 'cancelled') return await settleCancel(false)
    }
    return 'ok'
  }

  // ── ① 路由提交前的切书守卫（R0916-7-P3-20：确认与冲刷完成后才提交路由）────────
  // 原地切书 = 同一路由记录的参数更新（/book/A → /book/B），含 push/replace 与浏览器
  // 前进后退；守卫先做冲刷 + 三段决断，放行后 watch 只做状态转移。作者取消 → 返回 false
  // 中止导航：URL 留在原书，目标书的 SSE 从未连上、事件从未落进任何 store，故「先切后
  // 回滚」的整段善后（clearEventStores / 回退路由 / 补种历史）在该路径上不再需要。
  // 收不到的面（重挂进书：/book/A → /shelf → /book/B）见 watch 内记档。
  onBeforeRouteUpdate(async (to, from) => {
    if (suppressLeaveGuard) return true // 回滚自有导航（见本文件 suppressLeaveGuard 注）
    const target = routeBookName(to)
    const current = routeBookName(from)
    // 同书（参数未变/仅查询串变化）不拦；去脏路由（target=''）不在此前移——脏路由不是
    // 「切书」决断（无回退目标），既有 E-7 口径的 flush + 留痕仍在 watch 内（提交后）
    if (!target || target === current) return true
    const verdict = await flushAndAdjudicate({
      mode: 'precommit',
      gen: null,
      prevBook: current || lastBook || doc.bookName || '',
      target,
    })
    if (verdict !== 'ok') return false // 作者取消：路由不提交（零状态变更，无需善后）
    // 预决断移交：watch 见 preConfirmed === n 即只做状态转移（见 watch 内消费点注）
    preConfirmed = target
    return true
  })

  // ── ② 提交后的 watch（预决断移交 / 脏路由 / 不可前移入口的最小回滚）────────────
  watch(bookName, async (n) => {
    // 快速连切防乱序：flushDirty 挂起期间又切了书 → 本轮放弃（新轮回处理切换）
    const gen = bookGen.begin()
    // R26-18（二十六轮）：同书重入短路——守卫取消分支 router.replace 回原书会再次触发
    // 本 watch，此时书并未变化，workbench.clear/flushDirty/setBook/各 store clear 全是
    // 零收益动作（clear 还会误清原书工作台态）。n===lastBook 直接返回，不重复清。
    // R28-24（二十八轮）：口径收窄——「原封」仅对 Z-8 冲突拒绝路径成立（其取消点在
    // 下方 workbench.clear 之前）；F1 路径（flush 失败拒绝）弹窗前 workbench.clear() 已
    // 执行，回退后原书 workbench 态（textOut/healPhase 等）不保留——这是既有第五轮口径
    // （clear 提前防双 spawn 窗），非本短路新增损失；其余 store 均在 clear 之后、未动。
    // 首载 lastBook==='' 不受影响：路由书名经 X-P2-21 归空串时 n==='' 与 lastBook 初值
    // 相等，但首载时各 store 本就是初值，短路等价于原「清一遍空状态」，无行为差异。
    if (n === lastBook) return
    // E-7（二十九轮）：脏路由（name=''，手输坏 URL / 上位页面异常跳转）提前分支——
    // 残存 dirty 属前书，先落盘再按现有切书口径清各 store，防前书数据滞留展示。
    // 不走下方 Z-8/F1 确认弹窗：脏路由不是「切书」决断（无回退目标书），flush 失败
    // 与卸载路径同口径 console.warn 留痕（.版本 快照是恢复底线）
    if (!n) {
      workbench.clear() // 第五轮口径：clear 早于 flushDirty（防双 spawn 窗），此处照搬
      const failedEmpty = await doc.flushDirty()
      if (bookGen.stale(gen)) return // 挂起期间路由又变：交新轮回处理
      // R37-1（三十七轮批E）：flush 等待窗口内在途保存可能落成 conflict——这类条目不在
      // failed 口径内（flushDirty 的扫描排除 conflict 项），一并留痕防静默
      const conflictEmpty = doc.conflictedDirtyDocs()
      if (failedEmpty.length > 0 || conflictEmpty.length > 0) {
        console.warn(`[Book] 脏路由离开时 ${failedEmpty.length} 个文档保存失败（编辑未落盘）: ${failedEmpty.join(', ')}；${conflictEmpty.length} 个文档冲突未决: ${conflictEmpty.join(', ')}`)
      }
      lastBook = ''
      doc.setBook('')
      ws.setBook('')
      // P1-7a：六件清空收敛 clearEventStores 单源（时序不变）
      clearEventStores()
      // R0916-7-P3-20：离书——冲刷已落定（上方 await），作废在册书会话并 abort 其信号
      // （在途本书写请求统一以 AbortError 收口）。卸载体面另有 flushBeforeClose（关窗），
      // 不经此处，故不早 abort。
      endBookSession()
      return
    }
    // R0916-7-P3-20：预决断移交——本轮切书（原地切书）已由提交前守卫完成冲刷与三段决断，
    // 本拍只做状态转移：不重复弹窗、不再有回滚面（取消的那次根本没提交路由，进不到这里）。
    // 标记目标不符即作废（导航被别的守卫拦下/被后发导航顶替时的残值），照下方兜底路径走。
    if (preConfirmed === n) {
      preConfirmed = ''
      beginSwitch(n)
      enterBook(n, gen)
      return
    }
    preConfirmed = ''
    // R0916-7-P3-20（如实记档，不许假装前移）：走到这里 = 路由提交时机在本批文件面内无法
    // 前移的入口——重挂进书（/book/A → /shelf → /book/B）在 Book.vue 未挂载时就已提交路由，
    // 提交前守卫（注册点在 Book.vue setup）收不到；脏路由已在上面单独分支。故此处保留最小
    // 回滚（取消 → revertToPrevBook），而非「确认与冲刷后再提交」。
    // 注：当前代码里该路径的 prevBook 近乎恒为 ''（离书时 E-7 分支已 doc.setBook('')），
    // Z-8/F1/R37-1 三段因此通常跳过，只留纯切换；此守卫是 R33D-9 时代留下的防御，未证死。
    const prevBook = lastBook || doc.bookName || ''
    const verdict = await flushAndAdjudicate({ mode: 'committed', gen, prevBook, target: n, onApproved: () => beginSwitch(n) })
    if (verdict !== 'ok') return
    enterBook(n, gen)
  }, { immediate: true })
}
