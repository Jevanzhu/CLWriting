<script setup lang="ts">
// 右侧栏：顶部 tab 条（M12 B0.5：信息/审阅/机检/分析）+ 按 tab 切上半面板
// （信息=字数/大纲表单，审阅/机检/分析 块1/3/4 填充）+ 上下文速查（常驻）。
import { ref, computed } from 'vue'
import { Info, FileSearch, CheckSquare, BarChart3 } from 'lucide-vue-next'
import WritingInfoPanel from '../panels/WritingInfoPanel.vue'
import ContextQuickPanel from '../panels/ContextQuickPanel.vue'
import MetaFormPanel from '../panels/MetaFormPanel.vue'
import CheckPanel from '../panels/CheckPanel.vue'
import ReviewPanel from '../panels/ReviewPanel.vue'
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

// M12 B0.5：右栏 tab（信息=字数/表单 / 审阅=三审+改写 / 机检 / 分析）；审阅·机检·分析由块1/2/3/4 逐个填充
type RightTab = 'info' | 'review' | 'check' | 'analysis'
const tab = ref<RightTab>('info')
const tabs: { key: RightTab; label: string; icon: typeof Info }[] = [
  { key: 'info', label: '信息', icon: Info },
  { key: 'review', label: '审阅', icon: FileSearch },
  { key: 'check', label: '机检', icon: CheckSquare },
  { key: 'analysis', label: '分析', icon: BarChart3 },
]
</script>

<template>
  <div class="sidebar-right">
    <div class="right-topbar" :class="{ 'is-drag': hasDesktop }">
      <div class="right-tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="right-tab"
          :class="{ active: tab === t.key }"
          :title="t.label"
          @click="tab = t.key"
        >
          <component :is="t.icon" :size="16" />
        </button>
      </div>
    </div>
    <div class="right-body">
      <!-- 信息 tab：字数 / 大纲结构化表单 -->
      <template v-if="tab === 'info'">
        <MetaFormPanel v-if="showOutlineForm" :book-name="bookName" />
        <WritingInfoPanel v-else :book-name="bookName" />
      </template>
      <!-- 审阅 tab：块1 三审面板（块2 改写待挂） -->
      <ReviewPanel v-else-if="tab === 'review'" :book-name="bookName" />
      <!-- 机检 tab：块3 本地规则检查（无 AI，断网可用） -->
      <CheckPanel v-else-if="tab === 'check'" :book-name="bookName" />
      <!-- 分析 tab：块4（占位） -->
      <section v-else-if="tab === 'analysis'" class="side-section">
        <div class="side-title">分析</div>
        <div class="side-hint">体验分 / 情绪曲线 / 钩子 / 文风（M12 块4）</div>
      </section>
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
  justify-content: flex-end;
  padding: 0 var(--size-4-2);
  gap: var(--size-4-1);
}
.right-topbar.is-drag {
  -webkit-app-region: drag;
}
.right-tabs {
  display: flex;
  gap: var(--size-4-1);
}
.right-tabs button {
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
  transition: background 0.12s, color 0.12s;
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
.side-section {
  display: flex;
  flex-direction: column;
}
.side-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: var(--size-4-2);
}
.side-hint {
  font-size: 12px;
  color: var(--text-faint);
  line-height: 1.6;
}
</style>
