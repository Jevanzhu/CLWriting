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
 * 生命周期：本 composable 只注册一个 watch(bookName, …, { immediate: true })——无定时器
 * 与窗事件监听，随组件实例自动停（onUnmounted 无需额外清理）。
 *
 * 语义零变化：本文件是 Book.vue 原切书链的逐行搬迁（E-7 / R26-18 / R28-24 / R29-10 /
 * R32-8 / R33-9 / R33D-9 / R37-1 / Z-8 / F1 / P1-7a 各条注释随迁），差异仅两处：
 * ①`bookName`/`resync` 改为注入（原为本页 computed 与 useSse 句柄）；
 * ②各 store 在本函数内取实例（与调用点同在 setup 上下文，实例同源）。
 */
import { watch, type ComputedRef } from 'vue'
import { useRouter } from 'vue-router'
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

/** 切书守卫的注入面（其余依赖在本函数内取——pinia/路由实例与 setup 同源）。 */
export interface BookSwitchGuardDeps {
  /** 当前书（route.params.name 派生的 computed；同书重入短路与脏路由分支的判据源） */
  bookName: ComputedRef<string>
  /** 强制重取连接级 SSE sync 快照（useSse 句柄的 resync——R29-10 切书链尾收口） */
  resync: () => void
}

/** 注册切书链（含三段守卫与取消回滚）。仅响应 bookName 变化，无返回值。 */
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

  let bookGen = 0
  // Z-8（第五十八轮）：上一本书名（冲突守卫取消时回退路由用）
  let lastBook = ''
  // 复审-0914-优化修复批（P1-7a）：切书链三段「确认丢弃→取消则回滚」守卫（Z-8 冲突
  // 预检 / F1 flush 失败 / R37-1 flush 后冲突复查）此前近乎逐字三连，收敛为参数化单源。
  // 各段预检条件、弹窗文案、回滚时序（事件 store 清空 → 回退路由 → gen/书名复检 →
  // resync + 补种历史）逐位不变；R 编号沿革注释随实现移位保留。
  /** 清空事件驱动各 store（切书/脏路由/回退共用六件；workbench 清点由各段口径单独控制） */
  function clearEventStores(): void {
    check.clear()
    review.clear()
    learn.clear()
    style.clear()
    rewrite.clear()
    chat.clear()
  }
  /** 守卫取消分支共用回滚：清污 → 回退路由 → 复检通过则 resync + 补种原书历史 */
  async function revertToPrevBook(prevBook: string, gen: number, clearWorkbench: boolean): Promise<void> {
    // clearWorkbench 仅 Z-8 段为真：其弹窗在 workbench.clear()（链首，第五轮口径）之前，
    // 取消回退须补清；F1/R37-1 段弹窗前链首已清，不重复
    if (clearWorkbench) workbench.clear()
    clearEventStores()
    // R33D-9：重挂路径 lastBook 为 ''，回退目标用权威源 prevBook
    lastBook = prevBook
    await router.replace(`/book/${encodeURIComponent(prevBook)}`)
    if (gen === bookGen && bookName.value === prevBook) {
      resync()
      void chat.seedHistory(prevBook)
    }
  }
  /** 三段守卫共用决断弹窗 + 取消回滚。返回 'dropped' = 作者确认丢弃（调用方继续切换）；
   *  'stale' = 弹窗 await 窗内轮回作废；'reverted' = 留在原书且回滚已完成——两者调用方直接 return */
  async function askDropOrRevert(opts: {
    gen: number
    prevBook: string
    title: string
    message: string
    clearWorkbench: boolean
  }): Promise<'dropped' | 'stale' | 'reverted'> {
    const drop = await ui.ask({
      title: opts.title,
      message: opts.message,
      confirmText: '丢弃并切换',
      cancelText: '留在本书',
      danger: true,
    })
    if (opts.gen !== bookGen) return 'stale'
    if (!drop) {
      // 取消 = 留在原书，但弹窗 await 期间路由已是目标书 n——R32-8（三十二轮）：SSE 已
      // 连上 n，其 sync/chat/text 事件已 dispatch 进仍展示原书的 store；回退路由重入
      // n===lastBook 被 R26-18 短路，清污永不触发 → 污染残留至下次切书。此处等效清污：
      // 按切书口径清事件驱动各 store（Z-8 段含 workbench——R28-24 的「原封」口径就此
      // 让位：B 的 sync 在 await 窗已污染 running 态，原封会假显示目标书写稿中；回退后
      // resync 由服务端权威快照重建），再回退路由 + chat 补种原书历史。R26-18/R33D-9：
      // 恢复 lastBook = prevBook 维持「lastBook ⟺ 当前路由书」不变式，回退重入即被短路。
      await revertToPrevBook(opts.prevBook, opts.gen, opts.clearWorkbench)
      return 'reverted'
    }
    return 'dropped'
  }
  watch(bookName, async (n) => {
    // 快速连切防乱序：flushDirty 挂起期间又切了书 → 本轮放弃（新轮回处理切换）
    const gen = ++bookGen
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
      if (gen !== bookGen) return // 挂起期间路由又变：交新轮回处理
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
      return
    }
    // Z-8（第五十八轮）：未决冲突守卫——conflict && dirty 文档的本地修改从未落盘（autosave
    // 跳过 conflict 项），setBook 清缓存即不可恢复丢失，此前全程静默。确认弹窗：拒绝 → 回退
    // 路由留在原书（first watch 即时跑，lastBook 初值为空时跳过守卫）
    // R33D-9（三十三轮）：守卫的「原书」代次源补权威回退——lastBook 是组件实例本地值，
    // Book 重挂（/book/A → /shelf → /book/B）后首跑为 ''，Z-8/F1 双双跳过 → A 的
    // conflict+dirty 缓存被 setBook('B') 清掉静默丢失。doc store 是应用级单例（卸载后
    // bookName 仍指 A），以其为回退源：重挂路径守卫照常跑（作者至少拿到决断权）。
    // doc.bookName 类型 string|null（null=未载入），守卫语义下 null 与 '' 同义
    const prevBook = lastBook || doc.bookName || ''
    // R37-1（三十七轮批E）：Z-8 预检已决断「丢弃并切换」的 docId 台账——预检弹窗确认后
    // 条目仍保持 conflict+dirty（flushDirty 不存 conflict 项），下方 flush 后复查须排除，
    // 否则同一批文档二次弹窗（对同一决断重复提问）
    const adjudicated = new Set<string>()
    if (prevBook !== '' && n !== prevBook) {
      const conflicted = doc.conflictedDirtyDocs()
      if (conflicted.length > 0) {
        const verdict = await askDropOrRevert({
          gen,
          prevBook,
          title: `有 ${conflicted.length} 个文档存在未处理的修改冲突`,
          message: '这些文档的本地修改从未保存，切换书将永久丢弃。建议先在编辑器处理（重载/覆盖）。仍要切换吗？',
          clearWorkbench: true,
        })
        if (verdict !== 'dropped') return
        // 确认丢弃：登记已决断——flush 后复查不再对这批 conflict 二次弹窗
        for (const id of conflicted) adjudicated.add(id)
      }
    }
    // 时序说明（R62-48 → R29-10 改写）——bookName 走 computed，路由一变新书 SSE/心跳
    // 即刻连上；弹窗等待与 flushDirty await 期间新书连接已存在，其连接级 sync 快照随时
    // 可能到达。第五轮把 workbench.clear() 提前到 flushDirty 之前（防「sync(running=true)
    // 先到、其后的 clear 把 running 错误复位 → 可再『生成』双 spawn 窗」），该口径保持
    // 不变；但 clear 早于 clear 前到达的 sync 仍会被复位且连接常驻不再重发（假空闲）——
    // R29-10 在链尾以 resync() 断开重连，让服务端对新连接重发权威快照收口
    lastBook = n
    workbench.clear()
    // 切书前先保存当前书的 dirty 文档（setBook 会清空缓存，否则 <autosaveInterval 的编辑静默丢失）
    const failed = await doc.flushDirty()
    if (gen !== bookGen) return
    // F1（五十九轮）：守卫拓宽——非冲突保存失败（网络断/5xx）的 dirty 文档同样从未
    // 落盘，setBook 清缓存即不可恢复丢失，与 Z-8 冲突形态同类灾难；统一走确认弹窗
    // （文案区分），拒绝 → 回退路由留在原书重试保存
    if (failed.length > 0 && prevBook !== '') {
      // P1-7a：决断弹窗 + 取消回滚收敛 askDropOrRevert 单源（clearWorkbench=false：
      // workbench 已在链首 clear——第五轮口径，原取消分支注释随实现移入 helper）
      const verdict = await askDropOrRevert({
        gen,
        prevBook,
        title: `有 ${failed.length} 个文档保存失败`,
        message: '这些文档的本地修改因网络/服务异常未能写入磁盘，切换书将永久丢弃。建议留在本书重试保存。仍要切换吗？',
        clearWorkbench: false,
      })
      if (verdict !== 'dropped') return
    }
    // R37-1（三十七轮批E）：flush 等待窗口内复查冲突——上方 Z-8 守卫在 flushDirty 之前
    // 查 conflictedDirtyDocs，等待期间在途保存可能落成 REVISION_CONFLICT（conflict=true、
    // dirty=true），这类条目既不在 failed 内也不被 flushDirty 后续轮次重扫，不复查则
    // setBook 清缓存即不可恢复丢失。走 Z-8 同款决断（文案/回退/清污口径与上方一致）；
    // 预检已决断「丢弃」的批次（adjudicated）不二次弹窗。
    const conflictedAfterFlush = doc.conflictedDirtyDocs().filter((id) => !adjudicated.has(id))
    if (conflictedAfterFlush.length > 0 && prevBook !== '') {
      // P1-7a：同款决断（文案/回退/清污口径与 Z-8/F1 一致，收敛 helper 单源；
      // adjudicated 台账见上方预检——已决断批次不二次弹窗）
      const verdict = await askDropOrRevert({
        gen,
        prevBook,
        title: `有 ${conflictedAfterFlush.length} 个文档存在未处理的修改冲突`,
        message: '这些文档的本地修改从未保存，切换书将永久丢弃。建议先在编辑器处理（重载/覆盖）。仍要切换吗？',
        clearWorkbench: false,
      })
      if (verdict !== 'dropped') return
    }
    doc.setBook(n)
    ws.setBook(n)
    // 清空各 store 旧书状态（chat 消息常驻 ChatDock，必须清；其余防残留上次操作结果）
    // P1-7a：六件清空收敛 clearEventStores 单源（时序不变）
    clearEventStores()
    // Y-P2-5：切书/刷新后从事件库恢复对话历史（store 内自带空判/竞态守卫，失败静默）
    if (n) void chat.seedHistory(n)
    // 切书后刷新对话档位（防短暂显示旧书模型列表）
    void useChatTier().refresh()
    // R29-10（二十九轮）：切书链收尾强制重取 SSE sync 快照——上方 await 链（确认弹窗/
    // flushDirty 秒级在途）期间新书连接的 sync 可能已到并被链首 workbench.clear() 复位
    //（假空闲 → 状态卡显示可再「生成」的双 spawn 窗）。gen 守卫通过（本轮仍是最新切书）
    // 且 bookName 仍等于 n（本轮切书结果未被再切覆盖）时，断开重连让服务端重发权威快照
    if (gen === bookGen && bookName.value === n) resync()
  }, { immediate: true })
}
