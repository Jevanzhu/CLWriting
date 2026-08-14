<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import WorkspaceShell from '../components/shell/WorkspaceShell.vue'
import EditorView from '../views/EditorView.vue'
import WorkbenchView from '../views/WorkbenchView.vue'
import OnboardView from '../views/OnboardView.vue'
import OverviewView from '../views/OverviewView.vue'
import RelationsView from '../views/RelationsView.vue'
import LearnView from '../views/LearnView.vue'
import StyleView from '../views/StyleView.vue'
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

// 工作区视图（/book/:name）：套 Obsidian 外壳 + 进书心跳 + 编辑视图（消费活动 tab docId）。
// bookName 走 computed：同组件复用切书（/book/A→/book/B）时 bookName/心跳/doc 缓存/tabs 跟随更新。
const route = useRoute()
const bookName = computed(() => String(route.params.name))
useHeartbeat(() => bookName.value)
useSse(() => bookName.value)

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
// 切书：同步 doc 缓存 + 载入持久化 tabs + 清空各 store 旧状态
let bookGen = 0
watch(bookName, async (n) => {
  // 快速连切防乱序：flushDirty 挂起期间又切了书 → 本轮放弃（新轮回处理切换）
  const gen = ++bookGen
  // 切书前先保存当前书的 dirty 文档（setBook 会清空缓存，否则 <autosaveInterval 的编辑静默丢失）
  await doc.flushDirty()
  if (gen !== bookGen) return
  doc.setBook(n)
  ws.setBook(n)
  // 清空各 store 旧书状态（chat 消息常驻 ChatDock，必须清；其余防残留上次操作结果）
  check.clear()
  review.clear()
  learn.clear()
  style.clear()
  rewrite.clear()
  workbench.clear()
  chat.clear()
  // 切书后刷新对话档位（防短暂显示旧书模型列表）
  void useChatTier().refresh()
}, { immediate: true })
// tree 加载后校验 tabs（剔除失效 docId）
watch(
  () => tree.byDocId.size,
  () => ws.validate(new Set(tree.byDocId.keys())),
)
// V-P1-2：关窗/重载兜底——beforeunload 窗口内同步落盘 dirty 文档（autosave 间隔内的编辑不再静默丢失）
function flushOnUnload(): void {
  doc.flushSyncOnUnload()
}
onMounted(() => window.addEventListener('beforeunload', flushOnUnload))
onUnmounted(() => window.removeEventListener('beforeunload', flushOnUnload))
</script>

<template>
  <WorkspaceShell :book-name="bookName">
    <Transition name="clw-view" mode="out-in">
      <EditorView v-if="ws.activeView === 'editor'" :doc-id="ws.activeDocId" />
      <WorkbenchView v-else-if="ws.activeView === 'workbench'" :book-name="bookName" />
      <!-- :key=bookName —— 切书时强制重建（两视图内部仅 onMounted 拉数、无 watch bookName；
           无 key 复用组件会一直显示旧书数据） -->
      <OverviewView v-else-if="ws.activeView === 'overview'" :key="bookName" :book-name="bookName" />
      <RelationsView v-else-if="ws.activeView === 'relations'" :key="bookName" :book-name="bookName" />
      <LearnView v-else-if="ws.activeView === 'learn'" :book-name="bookName" />
      <StyleView v-else-if="ws.activeView === 'style'" :book-name="bookName" />
      <OnboardView v-else :book-name="bookName" />
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
