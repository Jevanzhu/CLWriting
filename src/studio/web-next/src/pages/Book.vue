<script setup lang="ts">
import { computed, watch } from 'vue'
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
import { useSseSelfHeal } from '../composables/useSseSelfHeal'
import { useBookSwitchGuard } from '../composables/useBookSwitchGuard'
import { useAutosave } from '../composables/useAutosave'
import { useUnloadFlush } from '../composables/useUnloadFlush'
import { useWorkspaceStore } from '../stores/workspace'
import { useTreeStore } from '../stores/tree'

// RC：本页 setup 只留接线与模板——三段切书守卫状态机 / 关窗刷新卸载冲刷 /
// 自动保存节拍 / SSE 自愈接线（心跳 + SSE 同挂载点 + 半开看门狗 + 服务重启广播）分别
// 抽入 composables/{useBookSwitchGuard,useUnloadFlush,useAutosave,useSseSelfHeal}。

// 工作区视图（/book/:name）：套 Obsidian 外壳 + 进书心跳 + 编辑视图（消费活动 tab docId）。
// bookName 走 computed：同组件复用切书（/book/A→/book/B）时 bookName/心跳/doc 缓存/tabs 跟随更新。
const route = useRoute()
// params.name 缺失（脏路由/手输 URL）时归空串——String(undefined) 会把字面量 'undefined'
// 当书名，心跳每 20s POST /books/undefined/heartbeat + SSE 连不存在书
const bookName = computed(() => {
  const n = route.params.name
  return n === undefined || n === null ? '' : String(n)
})
// 持有 SSE 自愈句柄——切书链尾调 resync 强制重取连接级 sync 快照（sync 是连接级
// 一次性推送，时序见 useBookSwitchGuard 内说明）
const sse = useSseSelfHeal(() => bookName.value)

// RC：切书链（watch(bookName) 编排 + 三段守卫 + 取消回滚）抽入
// useBookSwitchGuard；resync 取 useSseSelfHeal 句柄（心跳与 SSE 同源挂载，防
// 「SSE 与心跳分处两处」断链——收拢已由 composable 结构保证）。
useBookSwitchGuard({ bookName, resync: () => sse.resync() })

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

// RC：自动保存节拍与关窗/刷新/卸载冲刷各自抽成 composable；本页只负责
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
/* 面板切换：view 间淡入淡出（out-in：旧出完再入新，无重叠布局抖动） */
.clw-view-enter-active,
.clw-view-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out);
}
.clw-view-enter-from,
.clw-view-leave-to {
  opacity: 0;
}
</style>
