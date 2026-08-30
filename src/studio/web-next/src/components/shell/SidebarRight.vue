<script setup lang="ts">
// 右侧栏：顶部 tab 条（M12 B0.5：信息/审阅/机检/分析）+ 按 tab 切上半面板
// （信息=字数/大纲表单，审阅/机检/分析 块1/3/4 填充）+ 上下文速查（常驻）。
import { computed } from 'vue'
import { Info, FileSearch, CheckSquare, PanelRightClose } from 'lucide-vue-next'
import WritingInfoPanel from '../panels/WritingInfoPanel.vue'
import ContextQuickPanel from '../panels/ContextQuickPanel.vue'
import MetaFormPanel from '../panels/MetaFormPanel.vue'
import CheckPanel from '../panels/CheckPanel.vue'
import ReviewPanel from '../panels/ReviewPanel.vue'
import RewritePanel from '../panels/RewritePanel.vue'
import AnalysisPanel from '../panels/AnalysisPanel.vue'
import HistoryPanel from '../panels/HistoryPanel.vue'
import ForeshadowPanel from '../panels/ForeshadowPanel.vue'
import CollapseSection from '../ui/CollapseSection.vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { useTreeStore } from '../../stores/tree'
import { formKindOf, isBodyKind } from '../../shared/words'
import { usePlatform } from '../../composables/usePlatform'

defineProps<{ bookName: string }>()
const ws = useWorkspaceStore()
const tree = useTreeStore()
const { isDesktop, isWin } = usePlatform()

const showOutlineForm = computed(() => {
  if (!ws.activeDocId) return false
  const node = tree.byDocId.get(ws.activeDocId)
  return node ? formKindOf(node.path) !== null : false
})

const tabs: { key: 'info' | 'review' | 'check'; label: string; icon: typeof Info }[] = [
  { key: 'info', label: '信息', icon: Info },
  { key: 'review', label: '审阅', icon: FileSearch },
  { key: 'check', label: '校对', icon: CheckSquare },
]
/** 表单分区标题（按文档类型：章节/章纲/卷纲…信息）。
 *  短篇正文（role=piece-body）与长篇同 path（写作/正文/），按 role 取「短篇」标题。 */
const FORM_TITLE: Record<string, string> = {
  chapter: '章节', 'piece-body': '短篇', 'chapter-outline': '章纲', 'volume-outline': '卷纲',
  synopsis: '总纲', character: '角色', worldview: '世界观', item: '物品',
}
const formSectionTitle = computed(() => {
  if (!ws.activeDocId) return '信息'
  const node = tree.byDocId.get(ws.activeDocId)
  if (!node) return '信息'
  const k = node.role === 'piece-body' ? 'piece-body' : formKindOf(node.path)
  return k ? `${FORM_TITLE[k] ?? '文档'}信息` : '信息'
})
/** 折叠区标题：有表单 → "章节信息"/"章纲信息"…；无表单 → "写作信息" */
const sectionTitle = computed(() => (showOutlineForm.value ? formSectionTitle.value : '写作信息'))
/** 正文才显示 AI 分析区（与 AnalysisPanel 内部 isReviewable 一致）。 */
const isReviewable = computed(() => {
  if (!ws.activeDocId) return false
  const node = tree.byDocId.get(ws.activeDocId)
  if (!node) return false
  return isBodyKind(node.path)
})
</script>

<template>
  <div class="sidebar-right">
    <div class="right-topbar" :class="{ 'is-drag': isDesktop, 'wco-avoid': isWin }">
      <button
        class="right-tab"
        data-tip="收起右栏"
        data-tip-dir="bottom"
        @click="ws.toggleRight()"
      >
        <PanelRightClose :size="18" />
      </button>
      <div class="right-tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="right-tab"
          :class="{ active: ws.rightTab === t.key }"
          :data-tip="t.label" data-tip-dir="bottom"
          @click="ws.setRightTab(t.key)"
        >
          <component :is="t.icon" :size="18" />
        </button>
      </div>
    </div>
    <div class="right-body">
      <!-- 信息 tab：写作信息 + 章节表单 + AI 分析（折叠分区） -->
      <template v-if="ws.rightTab === 'info'">
        <CollapseSection v-if="ws.activeDocId" :title="sectionTitle">
          <div class="info-stack">
            <WritingInfoPanel :book-name="bookName" />
            <MetaFormPanel v-if="showOutlineForm" :book-name="bookName" />
          </div>
        </CollapseSection>
        <CollapseSection title="伏笔追踪">
          <ForeshadowPanel :book-name="bookName" />
        </CollapseSection>
        <CollapseSection v-if="isReviewable" title="AI 分析" beta>
          <AnalysisPanel :book-name="bookName" />
        </CollapseSection>
        <CollapseSection v-if="isReviewable" title="本章历史">
          <HistoryPanel :book-name="bookName" />
        </CollapseSection>
      </template>
      <!-- 审阅 tab：块1 三审 + 块2 改写 -->
      <div v-else-if="ws.rightTab === 'review'" class="review-stack">
        <ReviewPanel :book-name="bookName" />
        <RewritePanel :book-name="bookName" />
      </div>
      <!-- 机检 tab：块3 本地规则检查（无 AI，断网可用） -->
      <CheckPanel v-else-if="ws.rightTab === 'check'" :book-name="bookName" />
      <ContextQuickPanel :book-name="bookName" />
    </div>
  </div>
</template>

<style scoped>
.sidebar-right {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--background-secondary);
}
/* 顶部 tab 条：高度对齐 tabbar，桌面版可拖窗；tab 图标居中 */
.right-topbar {
  flex-shrink: 0;
  height: var(--size-tabbar);
  border-bottom: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--size-4-3) 0 var(--size-4-2);
  gap: var(--size-4-1);
}
.right-topbar.is-drag {
  -webkit-app-region: drag;
}
/* J5（win 体验面，2026-08-30 修正）：右栏打开时本栏贴窗口右上角，右侧 tab 组让位
 * WCO 系统窗控。让位作用在 .right-tabs 的 margin-right（而非容器 padding-right 挤压：
 * 原 padding 挤压在窄右栏下会把内容区挤爆、tab 溢出探进窗控下方——实测重叠 10px，
 * 见 CDP 量化；margin 让位保持容器背景满铺、窗控盖于其上无异常，仅把 tab 组推到
 * 窗控左侧）。env(titlebar-area-*) 自适应（非 win/浏览器/mac hiddenInset 回退 0）。
 * 图标放大：tab 容器 26px + icon 18px，.right-tabs 内 gap 收到 2px（用 gap 换尺寸，
 * 让 4 个 tab 的组宽从 24px 方案下放到 26px 仍塞进窗控左侧——右栏固定 259px，窗控
 * 占 137px）；实测呼吸隙≈2px（margin 取「窗控宽」已是安全上限，再大即触发 flex
 * 溢出致 margin 失效复现交叠，故放大只能靠压缩 gap，不能加 margin）。
 * 右栏关闭时贴角的是 TabBar 的 tabbar-actions（避让在其组件内）。 */
.right-topbar.wco-avoid .right-tabs {
  margin-right: calc(100vw - env(titlebar-area-width, 100vw) - env(titlebar-area-x, 0px));
}
.right-tabs {
  display: flex;
  gap: 2px;
}
.right-topbar button {
  -webkit-app-region: no-drag;
}
/* 图标按属性和命名尺寸等比渲染，不被按钮内容盒 flex-shrink 压扁（否则 titlebar
 * 26px 盒内 18px 图标被压成 14px 宽，viewBox 24 被横向拉伸、描边畸变发糊）。 */
.right-topbar svg {
  flex-shrink: 0;
}
.right-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--size-control-sm);
  height: var(--size-control-sm);
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.right-tab:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.right-tab.active {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
}
.right-body {
  flex: 1;
  overflow: auto;
  padding: var(--size-4-3);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-4);
}
.review-stack {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-4);
}
.info-stack {
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-primary);
  padding: var(--size-4-3);
  display: flex;
  flex-direction: column;
}
</style>
