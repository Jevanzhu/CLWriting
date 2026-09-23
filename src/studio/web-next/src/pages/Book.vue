<script setup lang="ts">
import { computed, watch, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import WorkspaceShell from '../components/shell/WorkspaceShell.vue'
import EditorView from '../views/EditorView.vue'
import WorkbenchView from '../views/WorkbenchView.vue'
import OnboardView from '../views/OnboardView.vue'
import OverviewView from '../views/OverviewView.vue'
import RelationsView from '../views/RelationsView.vue'
import LearnView from '../views/LearnView.vue'
import StyleView from '../views/StyleView.vue'
import AuditView from '../views/AuditView.vue'
import { useHeartbeat, heartbeatFailStreak } from '../composables/useHeartbeat'
import { useSse } from '../composables/useSse'
import { useBookSwitchGuard } from '../composables/useBookSwitchGuard'
import { useAutosave } from '../composables/useAutosave'
import { useUnloadFlush } from '../composables/useUnloadFlush'
import { useWorkspaceStore } from '../stores/workspace'
import { useTreeStore } from '../stores/tree'
import { useWorkbenchStore } from '../stores/workbench'
import { useUiStore } from '../stores/ui'

// RC 源码重审 B-5：本页 setup 只留接线与模板——三段切书守卫状态机 / 关窗刷新卸载冲刷 /
// 自动保存节拍分别抽入 composables/{useBookSwitchGuard,useUnloadFlush,useAutosave}；
// SSE 半开看门狗留在本页（r1010c-fe2-sse-401-selfheal 的源码锚定要求 useHeartbeat/useSse/
// heartbeatFailStreak/sse.resync 同处本 setup，防挂载点分离静默断链）。

// 工作区视图（/book/:name）：套 Obsidian 外壳 + 进书心跳 + 编辑视图（消费活动 tab docId）。
// bookName 走 computed：同组件复用切书（/book/A→/book/B）时 bookName/心跳/doc 缓存/tabs 跟随更新。
const route = useRoute()
// params.name 缺失（脏路由/手输 URL）时归空串——String(undefined) 会把字面量 'undefined'
// 当书名，心跳每 20s POST /books/undefined/heartbeat + SSE 连不存在书
const bookName = computed(() => {
  const n = route.params.name
  return n === undefined || n === null ? '' : String(n)
})
useHeartbeat(() => bookName.value)
// 持有 useSse 句柄——切书链尾调 resync() 强制重取连接级 sync 快照（sync 是连接级一次性
// 推送，时序见 useBookSwitchGuard 内说明）
const sse = useSse(() => bookName.value)

// RC 源码重审 B-5：切书链（watch(bookName) 编排 + 三段守卫 + 取消回滚）抽入
// useBookSwitchGuard；resync 仍取本页 useSse 句柄（挂载点不变，防「SSE 与心跳分处两处」
// 断链）。
useBookSwitchGuard({ bookName, resync: () => sse.resync() })

// 看门狗两处消费（workbench.connected 判据 / ui.toast 提示）——其余 store 已随各自
// 被抽职责移入对应 composable（tabs 校验仍用下方 ws/tree）。
const workbench = useWorkbenchStore()
const ui = useUiStore()

// SSE 半开连接盲窗看门狗——服务端「接受连接、回 200 头、此后不
// 发数据也不关」时 EventSource 无 onerror，useSse 的 connected 冻结在 true 直至服务端
// requestTimeout（~300s），期间 AI 进度事件全丢而 UI 无感。心跳（20s 一拍的独立在线
// 探测）连续 2 拍失败且 SSE 仍处 connected 态 → resync() 断开重连、重取连接级 sync
// 快照自愈。去抖：触发即复位连败计数（下一拍重新起算，成功拍/useSse 侧 stop 也复位）。
// SSE 非 connected 时不插手：断连重连已由 useSse 自身的 fail-closed 退避链接管。
watch(heartbeatFailStreak, (n) => {
  if (n >= 2 && workbench.connected) {
    heartbeatFailStreak.value = 0
    sse.resync()
  }
})
// 主进程「服务已自动重启/自愈成功」广播
// （desktop:server-restarted）——崩溃自动重启/session-end 自愈钉住端口拉回后，旧
// SSE 连接已随 child 进程换代而死，EventSource 只能等自身退避重连；订阅广播主动
// resync() 立即断旧连新 + 重取连接级 sync 快照，服务恢复对作者即时可感。浏览器版
// 无此通道（window.clwritingDesktop 判空降级，desktop.d.ts 同步登记）。
const offServerRestarted = window.clwritingDesktop?.onServerRestarted?.(() => {
  sse.resync()
  ui.toast('写作服务已自动恢复，正在重连', 'info')
})
onUnmounted(() => offServerRestarted?.())

// tree 加载后校验 tabs（剔除失效 docId）——bookName 与 ownerBook 都须入 watch 源：
// 只看树节点数会让「两书节点数相同」的切书漏校验，陈旧 activeDocId 滞留（编辑器空态
// 且无「文档已不存在」提示）；切书窗内 tree 仍持旧书键集，键集属主随行传入后由
// validate 侧按属主不符跳过，ownerBook 入源则保证新书树归位时必补一次属主匹配的校验
// （等尺寸切书不再漏校验）。
const ws = useWorkspaceStore()
const tree = useTreeStore()
watch(
  [() => tree.byDocId.size, bookName, () => tree.ownerBook],
  () => ws.validate(new Set(tree.byDocId.keys()), tree.ownerBook),
)

// RC 源码重审 B-5：自动保存节拍与关窗/刷新/卸载冲刷各自抽成 composable；本页只负责
// 按需挂上。
useAutosave()
useUnloadFlush()
</script>

<template>
  <WorkspaceShell :book-name="bookName">
    <Transition name="clw-view" mode="out-in">
      <EditorView v-if="ws.activeView === 'editor'" :doc-id="ws.activeDocId" />
      <WorkbenchView v-else-if="ws.activeView === 'workbench'" :book-name="bookName" />
      <!-- :key=bookName —— 切书时强制重建（下列视图无 watch bookName、多为仅 onMounted 拉数；
           无 key 复用组件会一直显示旧书数据）。WorkbenchView 由内部 watch 重载规则命中，
           无需 key。StyleView 必须挂 key——store 层虽有切书 watch，但 StyleBaselineCard
           铁律编辑框 / StyleAcceptancePanel 分析结果是组件本地 ref 不随 store 重载，A 书
           展开编辑→切 B 书→保存会把 A 书铁律整段覆盖进 B 书（跨书写坏），重建实例一并
           消灭显示残留 -->
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
