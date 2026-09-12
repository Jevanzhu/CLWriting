<script setup lang="ts">
// 机检面板（M12 块3 B3.2）：本地规则检查，无 AI 依赖，断网可用。
// 点「机检」按钮 → POST /documents/:docId/check → 红黄分组展示。
// 仅对正文章节启用（章纲/设定/卷纲等机检无意义）。
import { computed, watch, markRaw } from 'vue'
import { ShieldCheck, RefreshCw, AlertCircle, AlertTriangle, CircleCheck, ThumbsDown } from 'lucide-vue-next'
import { useCheckStore } from '../../stores/check'
import { useWorkspaceStore } from '../../stores/workspace'
import { useTreeStore } from '../../stores/tree'
import { useUiStore } from '../../stores/ui'
import { isBodyKind } from '../../shared/words'
import { contentStableKeys, checkItemKeyBase } from '../../shared/issue-keys'

const props = defineProps<{ bookName: string }>()
const check = useCheckStore()
const ws = useWorkspaceStore()
const tree = useTreeStore()

const docId = computed(() => ws.activeDocId)
const node = computed(() => (docId.value ? tree.byDocId.get(docId.value) : undefined))
const isCheckable = computed(() => {
  if (!node.value) return false
  return isBodyKind(node.value.path)
})

// R59 清偿批（R57-F-2）：红/黄项 v-for 改稳定键——原用 it.checkId 作键，而 checkId
// 是检查器级 id（同检查器多条命中同 id，如 banned-word 多处命中各自成条目），多条
// 命中时必撞 Vue 重复键；改内容组合键（checkId+消息+leadId+章号，构造单源见
// shared/issue-keys），同内容条目按出现序 #n 消歧
const redKeys = computed(() => contentStableKeys(check.redItems.map(checkItemKeyBase)))
const yellowKeys = computed(() => contentStableKeys(check.yellowItems.map(checkItemKeyBase)))

// R1010c-FE1-P3-2（2026-09-10 全量独立复审修复批）：红/黄项渲染上限——千项级命中全量
// v-for 挂 DOM（max-height 只裁视觉不减节点），对齐域内 RENDER_CAP=100 惯例（先例
// RewritePanel/AuditDiffPanel R-P3-16）：只裁渲染面前 100 条 + 尾部省略提示行；
// 数据面不动——分组头计数仍面向全量，键表也按全量构造（切片与键按下标仍对齐）
const RENDER_CAP = 100
const redItemsView = computed(() => check.redItems.slice(0, RENDER_CAP))
const yellowItemsView = computed(() => check.yellowItems.slice(0, RENDER_CAP))
const redOmitted = computed(() => Math.max(0, check.redItems.length - RENDER_CAP))
const yellowOmitted = computed(() => Math.max(0, check.yellowItems.length - RENDER_CAP))

// R0912-C2-P3-6（2026-09-12 独立重评修复批）：红/黄两组 item 模板逐字重复 → 分组
// 数据化 + 模板 v-for 单份化（原两份逐张一致，DOM 输出不变——template v-for 不产生
// DOM；组序红在前黄在后、各自独立显隐均保持）。markRaw：组件对象不进响应式。
// 与 ReviewPanel 结构相似但数据源不同，按评审口径分文件各自 v-for 化、不跨文件抽组件。
const checkGroups = computed(() => [
  {
    key: 'red', label: '红项', icon: markRaw(AlertCircle), tone: 'red',
    count: check.redItems.length, view: redItemsView.value,
    keys: redKeys.value, keyPrefix: 'r', omitted: redOmitted.value,
  },
  {
    key: 'yellow', label: '黄项', icon: markRaw(AlertTriangle), tone: 'yellow',
    count: check.yellowItems.length, view: yellowItemsView.value,
    keys: yellowKeys.value, keyPrefix: 'y', omitted: yellowOmitted.value,
  },
])

async function runCheck(): Promise<void> {
  if (!docId.value) return
  await check.run(props.bookName, docId.value)
  // T9b：机检结果变化 → 刷新树红点（正文 red 增减要冒泡到树）
  if (!check.error) void tree.loadIssues(props.bookName)
}

// X-P2-15：切文档即清报告（store 注释声称「调用方 clear」但无人调——旧文档红项挂在新文档上）
watch(docId, () => check.clear())

// B1（批 6）：误报标记——一次确认防误触；按 checkId 幂等（已标灰显）。标记落
// check/false-positive 事件 → 语料回归库燃料。
// 低级项（第六轮）：原生 confirm → ui.ask 统一弹窗（Electron 渲染层禁原生模态且样式割裂）；
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
  if (props.bookName !== book || docId.value !== id) return
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
      <button
        class="check-run-btn"
        :disabled="!isCheckable || check.loading"
        @click="runCheck"
      >
        <RefreshCw :size="13" :class="{ spin: check.loading }" />
        <span>{{ check.loading ? '检查中…' : '校对' }}</span>
      </button>
    </div>

    <div v-if="!isCheckable" class="check-hint">
      校对仅适用于正文 / 草稿文档。
    </div>

    <div v-else-if="check.error" class="check-error">
      <AlertCircle :size="14" />
      <span>{{ check.error }}</span>
    </div>

    <template v-else-if="check.report">
      <div
        v-if="check.redItems.length === 0 && check.yellowItems.length === 0"
        class="check-clean"
      >
        <CircleCheck :size="16" />
        <span>未发现问题</span>
      </div>

      <!-- R0912-C2-P3-6：红/黄两组模板单份化（组差异数据化，DOM 逐像素不变） -->
      <template v-for="g in checkGroups" :key="g.key">
        <div v-if="g.count > 0" class="check-group">
          <div class="group-label" :class="`group-label--${g.tone}`">
            <component :is="g.icon" :size="13" />
            <span>{{ g.label }}（{{ g.count }}）</span>
          </div>
          <div
            v-for="(it, i) in g.view"
            :key="g.keyPrefix + g.keys[i]"
            class="check-item"
            :class="`check-item--${g.tone}`"
          >
            <div class="item-msg">{{ it.message }}</div>
            <button
              class="fp-btn"
              :class="{ done: check.flagged.has(it.checkId) }"
              :disabled="check.flagging !== null || check.flagged.has(it.checkId)"
              :title="check.flagged.has(it.checkId) ? '已标记误报' : '标记为误报（喂语料回归库）'"
              @click="flagFalsePositive(it.checkId)"
            >
              <ThumbsDown :size="12" />
              {{ check.flagged.has(it.checkId) ? '已标误报' : '误报' }}
            </button>
          </div>
          <!-- R1010c-FE1-P3-2：RENDER_CAP 截断省略提示行（数据面计数不虚减） -->
          <div v-if="g.omitted > 0" class="cap-hint">已省略 {{ g.omitted }} 项</div>
        </div>
      </template>

      <div v-if="check.flagError" class="check-hint fp-error">{{ check.flagError }}</div>
    </template>

    <div v-else class="check-hint">
      点击「校对」检查当前文档（禁词 / 复读 / 句式 / 字数 / 设定连贯…）。
    </div>
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
.spin {
  animation: clw-spin 0.9s linear infinite;
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
.check-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.group-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--font-size-xs);
  font-weight: 600;
}
.group-label--red {
  color: var(--text-error);
}
.group-label--yellow {
  color: var(--text-warning);
}
/* R0912-3 #13：原同选择器两处分离规则（间隔在 .cap-hint）合并——属性并集、
 * 无重叠声明，级联结果逐字不变 */
.check-item {
  padding: 6px 8px;
  border-radius: var(--radius-s);
  font-size: var(--font-size-s);
  line-height: 1.5;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
/* R1010c-FE1-P3-2：渲染上限省略提示行——纯展示（弱化色，r54 tree-cap-hint 同语义） */
.cap-hint {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
}
.check-item--red {
  background: color-mix(in srgb, var(--text-error) 8%, transparent);
  border-left: 2px solid var(--text-error);
}
.check-item--yellow {
  background: color-mix(in srgb, var(--text-warning) 8%, transparent);
  border-left: 2px solid var(--text-warning);
}
.item-msg {
  color: var(--text-normal);
}
.fp-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  font-size: var(--font-size-xxs);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.fp-btn:hover:not(:disabled) {
  color: var(--text-normal);
  border-color: var(--text-muted);
}
.fp-btn:disabled {
  cursor: default;
  opacity: 0.75;
}
.fp-btn.done {
  color: var(--text-accent, inherit);
}
.fp-error {
  color: var(--text-error);
}
</style>
