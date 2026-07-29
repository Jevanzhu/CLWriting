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
import CollapseSection from '../ui/CollapseSection.vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { useTreeStore } from '../../stores/tree'
import { formKindOf } from '../../shared/words'

defineProps<{ bookName: string }>()
const ws = useWorkspaceStore()
const tree = useTreeStore()
const hasDesktop = typeof window !== 'undefined' && !!window.clwritingDesktop

const showOutlineForm = computed(() => {
  if (!ws.activeDocId) return false
  const node = tree.byDocId.get(ws.activeDocId)
  return node ? formKindOf(node.path) !== null : false
})

const tabs: { key: 'info' | 'review' | 'check'; label: string; icon: typeof Info }[] = [
  { key: 'info', label: '信息', icon: Info },
  { key: 'review', label: '审阅', icon: FileSearch },
  { key: 'check', label: '机检', icon: CheckSquare },
]
/** 表单分区标题（按文档类型：章节/章纲/卷纲…信息）。 */
const FORM_TITLE: Record<string, string> = {
  chapter: '章节', 'chapter-outline': '章纲', 'volume-outline': '卷纲',
  synopsis: '总纲', character: '角色', worldview: '世界观', item: '物品',
}
const formSectionTitle = computed(() => {
  if (!ws.activeDocId) return '信息'
  const node = tree.byDocId.get(ws.activeDocId)
  const k = node ? formKindOf(node.path) : null
  return k ? `${FORM_TITLE[k] ?? '文档'}信息` : '信息'
})
/** 折叠区标题：有表单 → "章节信息"/"章纲信息"…；无表单 → "写作信息" */
const sectionTitle = computed(() => (showOutlineForm.value ? formSectionTitle.value : '写作信息'))
/** 正文/草稿才显示 AI 分析区（与 AnalysisPanel 内部 isReviewable 一致）。 */
const isReviewable = computed(() => {
  if (!ws.activeDocId) return false
  const node = tree.byDocId.get(ws.activeDocId)
  if (!node) return false
  if (formKindOf(node.path) === 'chapter') return true
  return /^工作区\/草稿-\d+\.md$/.test(node.path)
})
</script>

<template>
  <div class="sidebar-right">
    <div class="right-topbar" :class="{ 'is-drag': hasDesktop }">
      <button
        class="right-tab"
        data-tip="收起右栏"
        data-tip-dir="bottom"
        @click="ws.toggleRight()"
      >
        <PanelRightClose :size="16" />
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
          <component :is="t.icon" :size="16" />
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
        <CollapseSection v-if="isReviewable" title="AI 分析">
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
.right-tabs {
  display: flex;
  gap: var(--size-4-1);
}
.right-topbar button {
  -webkit-app-region: no-drag;
}
.right-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-faint);
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
.side-section {
  display: flex;
  flex-direction: column;
}
.side-title {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: var(--size-4-2);
}
.side-hint {
  font-size: var(--font-size-s);
  color: var(--text-faint);
  line-height: 1.6;
}
</style>
