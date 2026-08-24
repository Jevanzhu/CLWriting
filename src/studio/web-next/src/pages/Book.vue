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
    // Z-8（第五十八轮）：未决冲突守卫——conflict && dirty 文档的本地修改从未落盘（autosave
    // 跳过 conflict 项），setBook 清缓存即不可恢复丢失，此前全程静默。确认弹窗：拒绝 → 回退
    // 路由留在原书（first watch 即时跑，lastBook 初值为空时跳过守卫）
    const prev = lastBook // F1（五十九轮）：flush 失败守卫拒绝时回退路由用
    if (lastBook !== '' && n !== lastBook) {
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
          void router.replace(`/book/${encodeURIComponent(lastBook)}`)
          return
        }
      }
    }
    lastBook = n
    // 第五轮：workbench.clear() 提前到 flushDirty 之前——旧书有 dirty 文档时 flushDirty
    // 秒级在途，期间新书 SSE 的 sync(running=true) 已先到，随后才执行的 clear() 会把
    // running 错误复位（状态卡显示可再「生成」→ 双 spawn 窗）。clear 只清旧书内存态，
    // 不依赖 doc 缓存，提前无副作用；新月 sync 快照在 await 之后必然重设权威值
    workbench.clear()
    // 切书前先保存当前书的 dirty 文档（setBook 会清空缓存，否则 <autosaveInterval 的编辑静默丢失）
    const failed = await doc.flushDirty()
    if (gen !== bookGen) return
    // F1（五十九轮）：守卫拓宽——非冲突保存失败（网络断/5xx）的 dirty 文档同样从未
    // 落盘，setBook 清缓存即不可恢复丢失，与 Z-8 冲突形态同类灾难；统一走确认弹窗
    // （文案区分），拒绝 → 回退路由留在原书重试保存
    if (failed.length > 0 && prev !== '') {
      const drop = await ui.ask({
        title: `有 ${failed.length} 个文档保存失败`,
        message: '这些文档的本地修改因网络/服务异常未能写入磁盘，切换书将永久丢弃。建议留在本书重试保存。仍要切换吗？',
        confirmText: '丢弃并切换',
        cancelText: '留在本书',
        danger: true,
      })
      if (gen !== bookGen) return
      if (!drop) {
        void router.replace(`/book/${encodeURIComponent(prev)}`)
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
    if (failed.length > 0) {
      console.warn(`[Book] 卸载时 ${failed.length} 个文档保存失败（编辑未落盘）: ${failed.join(', ')}`)
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
