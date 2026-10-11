<script setup lang="ts">
// 机检面板（M12 块3 B3.2）：本地规则检查，无 AI 依赖，断网可用。
// 点「机检」按钮 → POST /documents/:docId/check → 红黄分组展示。
// 仅对正文章节启用（章纲/设定/卷纲等机检无意义）。
import { computed, watch, markRaw } from 'vue'
import { ShieldCheck, RefreshCw, AlertCircle, AlertTriangle, CircleCheck } from 'lucide-vue-next'
import IssueGroup, { type IssueGroupModel } from './IssueGroup.vue'
import { useCheckStore } from '../../stores/check'
import { useWorkspaceStore } from '../../stores/workspace'
import { useTreeStore } from '../../stores/tree'
import { useUiStore } from '../../stores/ui'
import { isBodyKind } from '../../shared/words'
import { capView } from '../../shared/render-cap'
import { contentStableKeys, checkItemKeyBase } from '../../shared/issue-keys'
import { useScopedAction } from '../../composables/useScopedAction'

const props = defineProps<{ bookName: string }>()
const check = useCheckStore()
const ws = useWorkspaceStore()
const tree = useTreeStore()
// 切书守卫单源（stillIn）——确认弹窗滞留期间切书后，标记动作放弃（props 即路由活书名）。
const scoped = useScopedAction(() => props.bookName)

const docId = computed(() => ws.activeDocId)
const node = computed(() => (docId.value ? tree.byDocId.get(docId.value) : undefined))
const isCheckable = computed(() => {
  if (!node.value) return false
  return isBodyKind(node.value.path)
})

// 清偿批红/黄项 v-for 改稳定键——原用 it.checkId 作键，而 checkId
// 是检查器级 id（同检查器多条命中同 id，如 banned-word 多处命中各自成条目），多条
// 命中时必撞 Vue 重复键；改内容组合键（checkId+消息+leadId+章号，构造单源见
// shared/issue-keys），同内容条目按出现序 #n 消歧
const redKeys = computed(() => contentStableKeys(check.redItems.map(checkItemKeyBase)))
const yellowKeys = computed(() => contentStableKeys(check.yellowItems.map(checkItemKeyBase)))

// 红/黄项渲染上限——千项级命中全量
// v-for 挂 DOM（max-height 只裁视觉不减节点），对齐域内 RENDER_CAP=100 惯例（先例
// RewritePanel/AuditDiffPanel ）：只裁渲染面前 100 条 + 尾部省略提示行；
// 数据面不动——分组头计数仍面向全量，键表也按全量构造（切片与键按下标仍对齐）。
// 切片/计数样板收敛 shared/render-cap 单源（capView）。
const RENDER_CAP = 100
const redCap = computed(() => capView(check.redItems, RENDER_CAP))
const yellowCap = computed(() => capView(check.yellowItems, RENDER_CAP))

// 红/黄两组 item 模板逐字重复 → 分组
// 数据化 + 模板 v-for 单份化（原两份逐张一致，DOM 输出不变——template v-for 不产生
// DOM；组序红在前黄在后、各自独立显隐均保持）。markRaw：组件对象不进响应式。
// 组骨架（组头 + 条目 + 省略行）与 ReviewPanel 逐字重复 → 抽 IssueGroup 单源；
// 本模型仅承载数据面，条目渲染与误报钮交互在组件内（key 不消费，只作本处 v-for 键）。
const checkGroups = computed<IssueGroupModel[]>(() => [
  {
    key: 'red',
    label: '红项',
    icon: markRaw(AlertCircle),
    tone: 'red',
    count: check.redItems.length,
    view: redCap.value.view,
    keys: redKeys.value,
    keyPrefix: 'r',
    omitted: redCap.value.omitted,
  },
  {
    key: 'yellow',
    label: '黄项',
    icon: markRaw(AlertTriangle),
    tone: 'yellow',
    count: check.yellowItems.length,
    view: yellowCap.value.view,
    keys: yellowKeys.value,
    keyPrefix: 'y',
    omitted: yellowCap.value.omitted,
  },
])

async function runCheck(): Promise<void> {
  if (!docId.value) return
  await check.run(props.bookName, docId.value)
  // T9b：机检结果变化 → 刷新树红点（正文 red 增减要冒泡到树）
  if (!check.error) void tree.loadIssues(props.bookName)
}

// 切文档即清报告（store 注释声称「调用方 clear」但无人调——旧文档红项挂在新文档上）
watch(docId, () => check.clear())

// 误报标记——一次确认防误触；按 checkId 幂等（已标灰显）。标记落
// check/false-positive 事件 → 语料回归库燃料。
// 低级项：原生 confirm → ui.ask 统一弹窗（Electron 渲染层禁原生模态且样式割裂）；
// 弹窗 await 期间可切书/切文档——上下文入口捕获，确认后已切走则放弃
async function flagFalsePositive(checkId: string): Promise<void> {
  const book = props.bookName
  const id = docId.value
  if (!id) return
  const ok = await useUiStore().ask({
    title: '标记误报',
    message: `把「${checkId}」的这类命中标记为误报？（用于收集语料改进检查器，不影响本次结果）`,
    confirmText: '标记',
  })
  if (!ok) return
  if (!scoped.stillIn(book) || docId.value !== id) return
  await check.flagFalsePositive(book, id, checkId)
}
</script>

<template>
  <section class="check-panel">
    <div class="check-head">
      <div class="check-title-row">
        <ShieldCheck :size="14" />
        <span class="check-title">本地校对</span>
      </div>
      <button class="check-run-btn" :disabled="!isCheckable || check.loading" @click="runCheck">
        <RefreshCw :size="13" :class="{ spin: check.loading }" />
        <span>{{ check.loading ? '检查中…' : '校对' }}</span>
      </button>
    </div>

    <div v-if="!isCheckable" class="check-hint">校对仅适用于正文 / 草稿文档。</div>

    <div v-else-if="check.error" class="check-error">
      <AlertCircle :size="14" />
      <span>{{ check.error }}</span>
    </div>

    <template v-else-if="check.report">
      <div v-if="check.redItems.length === 0 && check.yellowItems.length === 0" class="check-clean">
        <CircleCheck :size="16" />
        <span>未发现问题</span>
      </div>

      <!-- 红/黄两组模板单份化（组差异数据化，DOM 逐像素不变） -->
      <template v-for="g in checkGroups" :key="g.key">
        <IssueGroup
          v-if="g.count > 0"
          variant="check"
          :group="g"
          :flagged="check.flagged"
          :flag-busy="check.flagging !== null"
          @flag="flagFalsePositive"
        />
      </template>

      <div v-if="check.flagError" class="check-hint fp-error">{{ check.flagError }}</div>
    </template>

    <div v-else class="check-hint">点击「校对」检查当前文档（禁词 / 复读 / 句式 / 字数 / 设定连贯…）。</div>
  </section>
</template>

<style scoped>
.check-panel {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
}
.check-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.check-title-row {
  display: inline-flex;
  align-items: center;
  gap: var(--size-4-1);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.check-run-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.check-run-btn:hover:not(:disabled) {
  opacity: 0.88;
}
.check-run-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.check-hint,
.check-error {
  font-size: var(--font-size-s);
  color: var(--text-faint);
  line-height: 1.6;
}
.check-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--text-error);
}
.check-clean {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-s);
  color: var(--dv-good);
}
/* 组容器/组头/条目盒/误报钮/省略行样式随 DOM 迁 IssueGroup.vue（scoped 随组件走，
 * 匹配的元素集合不变——组件根 div 即原 .check-group） */
.fp-error {
  color: var(--text-error);
}
</style>
