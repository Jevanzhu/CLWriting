<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceShell from '../components/shell/WorkspaceShell.vue'
import EditorView from '../views/EditorView.vue'
import WorkbenchView from '../views/WorkbenchView.vue'
import OnboardView from '../views/OnboardView.vue'
import OverviewView from '../views/OverviewView.vue'
import RelationsView from '../views/RelationsView.vue'
import LearnView from '../views/LearnView.vue'
import StyleView from '../views/StyleView.vue'
import AuditView from '../views/AuditView.vue'
import { useHeartbeat } from '../composables/useHeartbeat'
import { useSse } from '../composables/useSse'
import { useChatTier } from '../composables/useChatTier'
import { useDocStore } from '../stores/doc'
import { useWorkspaceStore } from '../stores/workspace'
import { useTreeStore } from '../stores/tree'
import { useCheckStore } from '../stores/check'
import { useReviewStore } from '../stores/review'
import { useLearnStore } from '../stores/learn'
import { useStyleStore } from '../stores/style'
import { useRewriteStore } from '../stores/rewrite'
import { useWorkbenchStore } from '../stores/workbench'
import { useChatStore } from '../stores/chat'
import { usePrefsStore } from '../stores/prefs'
import { useUiStore } from '../stores/ui'

// 工作区视图（/book/:name）：套 Obsidian 外壳 + 进书心跳 + 编辑视图（消费活动 tab docId）。
// bookName 走 computed：同组件复用切书（/book/A→/book/B）时 bookName/心跳/doc 缓存/tabs 跟随更新。
const route = useRoute()
// X-P2-21：params.name 缺失（脏路由/手输 URL）时归空串——String(undefined) 会把字面量
// 'undefined' 当书名，心跳每 20s POST /books/undefined/heartbeat + SSE 连不存在书
const bookName = computed(() => {
  const n = route.params.name
  return n === undefined || n === null ? '' : String(n)
})
useHeartbeat(() => bookName.value)
// R29-10（二十九轮）：持有 useSse 句柄——切书 watch 链尾调 resync() 强制重取连接级
// sync 快照（sync 是连接级一次性推送，见 watch 内时序说明）
const sse = useSse(() => bookName.value)

const doc = useDocStore()
const ws = useWorkspaceStore()
const tree = useTreeStore()
const check = useCheckStore()
const review = useReviewStore()
const learn = useLearnStore()
const style = useStyleStore()
const rewrite = useRewriteStore()
const workbench = useWorkbenchStore()
const chat = useChatStore()
const prefs = usePrefsStore()
// 切书：同步 doc 缓存 + 载入持久化 tabs + 清空各 store 旧状态
const router = useRouter()
const ui = useUiStore()
let bookGen = 0
  // Z-8（第五十八轮）：上一本书名（冲突守卫取消时回退路由用）
  let lastBook = ''
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
      check.clear()
      review.clear()
      learn.clear()
      style.clear()
      rewrite.clear()
      chat.clear()
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
        const drop = await ui.ask({
          title: `有 ${conflicted.length} 个文档存在未处理的修改冲突`,
          message: '这些文档的本地修改从未保存，切换书将永久丢弃。建议先在编辑器处理（重载/覆盖）。仍要切换吗？',
          confirmText: '丢弃并切换',
          cancelText: '留在本书',
          danger: true,
        })
        if (gen !== bookGen) return
        if (!drop) {
          // R32-8（三十二轮）：取消 = 留在原书，但弹窗 await 期间路由已是目标书 n——
          // SSE 已连上 n，其 sync/chat/text 事件已 dispatch 进仍展示原书的 store；回退
          // 路由重入 n===lastBook 被 R26-18 短路，清污永不触发 → 污染残留至下次切书。
          // 此处等效清污：按切书口径清事件驱动各 store（含 workbench——R28-24 的「原封」
          // 口径就此让位：B 的 sync 在 await 窗已污染 running 态，原封会假显示目标书写稿中；
          // 回退后 resync 由服务端权威快照重建），再回退路由 + chat 补种原书历史。
          workbench.clear()
          check.clear()
          review.clear()
          learn.clear()
          style.clear()
          rewrite.clear()
          chat.clear()
          // R33D-9：重挂路径 lastBook 为 ''，回退目标用权威源 prevBook
          lastBook = prevBook
          await router.replace(`/book/${encodeURIComponent(prevBook)}`)
          if (gen === bookGen && bookName.value === prevBook) {
            sse.resync()
            void chat.seedHistory(prevBook)
          }
          return
        }
        // 确认丢弃：登记已决断——flush 后复查不再对这批 conflict 二次弹窗
        for (const id of conflicted) adjudicated.add(id)
      }
    }
    // 时序说明（R62-48 → R29-10 改写）——bookName 走 computed，路由一变新书 SSE/心跳
    // 即刻连上；弹窗等待与 flushDirty await 期间新书连接已存在，其连接级 sync 快照随时
    // 可能到达。第五轮把 workbench.clear() 提前到 flushDirty 之前（防「sync(running=true)
    // 先到、其后的 clear 把 running 错误复位 → 可再『生成』双 spawn 窗」），该口径保持
    // 不变；但 clear 早于 clear 前到达的 sync 仍会被复位且连接常驻不再重发（假空闲）——
    // R29-10 在链尾以 sse.resync() 断开重连，让服务端对新连接重发权威快照收口
    lastBook = n
    workbench.clear()
    // 切书前先保存当前书的 dirty 文档（setBook 会清空缓存，否则 <autosaveInterval 的编辑静默丢失）
    const failed = await doc.flushDirty()
    if (gen !== bookGen) return
    // F1（五十九轮）：守卫拓宽——非冲突保存失败（网络断/5xx）的 dirty 文档同样从未
    // 落盘，setBook 清缓存即不可恢复丢失，与 Z-8 冲突形态同类灾难；统一走确认弹窗
    // （文案区分），拒绝 → 回退路由留在原书重试保存
    if (failed.length > 0 && prevBook !== '') {
      const drop = await ui.ask({
        title: `有 ${failed.length} 个文档保存失败`,
        message: '这些文档的本地修改因网络/服务异常未能写入磁盘，切换书将永久丢弃。建议留在本书重试保存。仍要切换吗？',
        confirmText: '丢弃并切换',
        cancelText: '留在本书',
        danger: true,
      })
      if (gen !== bookGen) return
      if (!drop) {
        // R26-18：此分支在 lastBook = n 之后取消——lastBook 已指向未切换成的目标书，
        // 与实际路由（回退到 prevBook）不一致；不恢复则回退重入 n=prevBook !== lastBook
        // 走不到上方短路，且此后选回 n 书会被短路误吞。恢复 lastBook = prevBook 维持
        // 「lastBook ⟺ 当前路由书」不变式，回退重入即被短路（不重复清；R28-24：workbench
        // 态已在本轮前段 workbench.clear() 清掉、不因此恢复——第五轮既有口径）。
        // R33D-9：重挂路径 prev 为 ''，恢复目标用权威源 prevBook（维持 lastBook ⟺ 当前路由书不变式）
        lastBook = prevBook
        // R32-8：同 Z-8 取消分支——F1 await 窗（flushDirty + 确认弹窗）期间目标书 n 的
        // 事件已入各 store；回退重入被 R26-18 短路，不在此清污则残留至下次切书。
        // workbench 已在链首 clear（第五轮口径），此处清其余事件驱动 store。
        check.clear()
        review.clear()
        learn.clear()
        style.clear()
        rewrite.clear()
        chat.clear()
        await router.replace(`/book/${encodeURIComponent(prevBook)}`)
        if (gen === bookGen && bookName.value === prevBook) {
          sse.resync()
          void chat.seedHistory(prevBook)
        }
        return
      }
    }
    // R37-1（三十七轮批E）：flush 等待窗口内复查冲突——上方 Z-8 守卫在 flushDirty 之前
    // 查 conflictedDirtyDocs，等待期间在途保存可能落成 REVISION_CONFLICT（conflict=true、
    // dirty=true），这类条目既不在 failed 内也不被 flushDirty 后续轮次重扫，不复查则
    // setBook 清缓存即不可恢复丢失。走 Z-8 同款决断（文案/回退/清污口径与上方一致）；
    // 预检已决断「丢弃」的批次（adjudicated）不二次弹窗。
    const conflictedAfterFlush = doc.conflictedDirtyDocs().filter((id) => !adjudicated.has(id))
    if (conflictedAfterFlush.length > 0 && prevBook !== '') {
      const drop = await ui.ask({
        title: `有 ${conflictedAfterFlush.length} 个文档存在未处理的修改冲突`,
        message: '这些文档的本地修改从未保存，切换书将永久丢弃。建议先在编辑器处理（重载/覆盖）。仍要切换吗？',
        confirmText: '丢弃并切换',
        cancelText: '留在本书',
        danger: true,
      })
      if (gen !== bookGen) return
      if (!drop) {
        // 取消 = 留在原书（R26-18 不变式同上方 F1 取消分支：lastBook 已指 n，恢复为
        // prevBook 维持「lastBook ⟺ 当前路由书」；R32-8 同款清污——await 窗内目标书
        // 事件已入各 store，回退重入被短路，须等效清掉再由 resync/seedHistory 重建）
        lastBook = prevBook
        check.clear()
        review.clear()
        learn.clear()
        style.clear()
        rewrite.clear()
        chat.clear()
        await router.replace(`/book/${encodeURIComponent(prevBook)}`)
        if (gen === bookGen && bookName.value === prevBook) {
          sse.resync()
          void chat.seedHistory(prevBook)
        }
        return
      }
    }
    doc.setBook(n)
    ws.setBook(n)
    // 清空各 store 旧书状态（chat 消息常驻 ChatDock，必须清；其余防残留上次操作结果）
    check.clear()
    review.clear()
    learn.clear()
    style.clear()
    rewrite.clear()
    chat.clear()
    // Y-P2-5：切书/刷新后从事件库恢复对话历史（store 内自带空判/竞态守卫，失败静默）
    if (n) void chat.seedHistory(n)
    // 切书后刷新对话档位（防短暂显示旧书模型列表）
    void useChatTier().refresh()
    // R29-10（二十九轮）：切书链收尾强制重取 SSE sync 快照——上方 await 链（确认弹窗/
    // flushDirty 秒级在途）期间新书连接的 sync 可能已到并被链首 workbench.clear() 复位
    //（假空闲 → 状态卡显示可再「生成」的双 spawn 窗）。gen 守卫通过（本轮仍是最新切书）
    // 且 bookName 仍等于 n（本轮切书结果未被再切覆盖）时，断开重连让服务端重发权威快照
    if (gen === bookGen && bookName.value === n) sse.resync()
}, { immediate: true })
// tree 加载后校验 tabs（剔除失效 docId）
// R33-72（三十三轮）：补书名触发源——原只 watch 树节点数，两书节点数相同时切书
// 不校验，陈旧 activeDocId 滞留（编辑器空态且无「文档已不存在」提示）；回调内以
// 当前树键集为准，失效 docId 一并剔除。
watch(
  [() => tree.byDocId.size, bookName],
  () => ws.validate(new Set(tree.byDocId.keys())),
)
// R44-2（四十四轮）：关窗/刷新兜底改双路。①关窗：主进程在 close 拦截后经
// executeJavaScript 调 window.__clwFlushBeforeClose（页面未死，异步保存链全通），
// 落定/短超时后 destroy——Chromium ≥M80 在页面卸载路径整体禁同步 XHR，原渲染层
// 同步 XHR 兜底经双 Electron 实验实证零字节到达（四十四轮报告 §3.1），已删。
// ②刷新/导航：beforeunload preventDefault 挡下（页面未死）→ 异步 flushDirty →
// 全部落净后带一次性标记重放刷新；未落净（保存失败/冲突未决）不自动重放，toast
// 告知后由作者处理（R71-6 冲突守卫并入本监听；R44-19：Electron 不渲染浏览器
// Leave-site 确认框，静默挡下＝无反馈死刷新）。纯浏览器形态下关窗走原生确认，
// 确认离开时 flush 未竟部分有丢失窗口——生产形态是 Electron 壳，关窗由①负责。
const RELOAD_FLUSH_FLAG = 'clw:reload-after-flush'
function consumeFreshReloadFlag(): boolean {
  const v = sessionStorage.getItem(RELOAD_FLUSH_FLAG)
  if (v === null) return false
  sessionStorage.removeItem(RELOAD_FLUSH_FLAG)
  // 标记只认 10s 内的（flush 后立即重放）：崩溃/中断残留的陈标记不作数，下次刷新照常兜底
  return Date.now() - Number(v) < 10_000
}
function hasUnsavedWork(): boolean {
  // R44-2（四十四轮）：口径只看 dirty——conflict && !dirty 是已决断残留态（overwrite/
  // reload/discard 都会清 conflict，残留不可丢失），拦刷新只会无谓卡死；losable 面
  // 与 flushDirty 的扫描面（dirty && !saving && !conflict）∪（dirty && conflict 守卫面）一致
  for (const e of doc.docs.values()) if (e.dirty) return true
  return false
}
function flushOnUnload(e: BeforeUnloadEvent): void {
  if (consumeFreshReloadFlag()) return // flush 落定后的重放刷新：放行
  if (!hasUnsavedWork()) return
  e.preventDefault()
  e.returnValue = '' // 旧 Chrome/Safari 惯例位（preventDefault 之外的兼容）
  void doc.flushDirty().then(() => {
    if (!hasUnsavedWork()) {
      sessionStorage.setItem(RELOAD_FLUSH_FLAG, String(Date.now()))
      location.reload()
      return
    }
    ui.toast('有修改尚未安全落盘（保存失败或冲突未决），已阻止刷新——请在编辑器内处理后重试', 'warning')
  })
}
type CloseFlushWindow = Window & {
  __clwFlushBeforeClose?: () => Promise<{ failed: string[]; conflict: string[] }>
}
onMounted(() => {
  window.addEventListener('beforeunload', flushOnUnload)
  // 主进程 close/before-quit 拦截的调用面（钩子与页面同生命周期注册/注销；不在编辑页
  // 时无 dirty 状态，主进程拿不到钩子即直接关，无兜底需求）
  ;(window as CloseFlushWindow).__clwFlushBeforeClose = () => doc.flushBeforeClose()
})
onUnmounted(() => {
  window.removeEventListener('beforeunload', flushOnUnload)
  delete (window as CloseFlushWindow).__clwFlushBeforeClose
})

// Q-9（第十五轮）：自动保存节拍上移 Book 层——此前绑 EditorView 挂载，切到工作台/
// 总览等视图后编辑器卸载、interval 被清，store 里的 dirty 文档停止自动保存（丢失窗口
// 超过 autosave 间隔）。扫描逻辑在 doc.autosaveTick（覆盖全部打开文档，非仅当前编辑器）。
let autosaveTimer: ReturnType<typeof setInterval> | null = null
function startAutosave(): void {
  if (autosaveTimer) clearInterval(autosaveTimer)
  autosaveTimer = setInterval(() => doc.autosaveTick(), Math.max(5, prefs.effectiveAutosaveInterval) * 1000)
}
onMounted(startAutosave)
watch(() => prefs.effectiveAutosaveInterval, startAutosave)
onUnmounted(() => {
  if (autosaveTimer) clearInterval(autosaveTimer)
  autosaveTimer = null
})
// RB-FE-P1-2：路由离开 /book（组件卸载，watch(bookName) 不再触发）也 flush 脏文档——
// 选 onUnmounted 而非 onBeforeRouteLeave：覆盖一切卸载路径（路由跳转/程序化导航）。
// flushDirty 内部逐文档 try/catch（save 永不 reject），fire-and-forget 安全，不阻塞卸载
// F1（五十九轮）：flush 失败（仍 dirty 未落盘）时 console.warn 留痕——组件即将销毁，
// 无处再提示作者，至少留下可回溯的失败证据（.版本 快照是恢复底线）
onUnmounted(() =>
  void doc.flushDirty().then((failed) => {
    // R37-1（三十七轮批E）：卸载路径无界面可弹——flush 等待窗口内落成的 conflict（不在
    // failed 口径）一并留痕，与卸载时的 failed 同口径（组件已销毁，快照是恢复底线）
    const conflict = doc.conflictedDirtyDocs()
    if (failed.length > 0 || conflict.length > 0) {
      console.warn(`[Book] 卸载时 ${failed.length} 个文档保存失败（编辑未落盘）: ${failed.join(', ')}；${conflict.length} 个文档冲突未决: ${conflict.join(', ')}`)
    }
  }),
)
</script>

<template>
  <WorkspaceShell :book-name="bookName">
    <Transition name="clw-view" mode="out-in">
      <EditorView v-if="ws.activeView === 'editor'" :doc-id="ws.activeDocId" />
      <WorkbenchView v-else-if="ws.activeView === 'workbench'" :book-name="bookName" />
      <!-- :key=bookName —— 切书时强制重建（下列视图无 watch bookName、多为仅 onMounted 拉数；
           无 key 复用组件会一直显示旧书数据）。Y-P2-3：WorkbenchView 由内部 watch 重载
           规则命中，无需 key。H-2（二轮复审）：StyleView 改挂 key——store 层虽有切书
           watch，但 StyleBaselineCard 铁律编辑框 / StyleAcceptancePanel 分析结果是组件
           本地 ref 不随 store 重载，A 书展开编辑→切 B 书→保存会把 A 书铁律整段覆盖进
           B 书（跨书写坏），重建实例一并消灭显示残留 -->
      <OverviewView v-else-if="ws.activeView === 'overview'" :key="bookName" :book-name="bookName" />
      <RelationsView v-else-if="ws.activeView === 'relations'" :key="bookName" :book-name="bookName" />
      <LearnView v-else-if="ws.activeView === 'learn'" :key="bookName" :book-name="bookName" />
      <StyleView v-else-if="ws.activeView === 'style'" :key="bookName" :book-name="bookName" />
      <AuditView v-else-if="ws.activeView === 'audit'" :key="bookName" :book-name="bookName" />
      <OnboardView v-else :key="bookName" :book-name="bookName" />
    </Transition>
  </WorkspaceShell>
</template>

<style scoped>
/* P3 面板切换：view 间淡入淡出（out-in：旧出完再入新，无重叠布局抖动） */
.clw-view-enter-active,
.clw-view-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out);
}
.clw-view-enter-from,
.clw-view-leave-to {
  opacity: 0;
}
</style>
