<script setup lang="ts">
// 机检面板（M12 块3 B3.2）：本地规则检查，无 AI 依赖，断网可用。
// 点「机检」按钮 → POST /documents/:docId/check → 红黄分组展示。
// 仅对正文章节启用（章纲/设定/卷纲等机检无意义）。
import { computed, watch } from 'vue'
import { ShieldCheck, RefreshCw, AlertCircle, AlertTriangle, CircleCheck } from 'lucide-vue-next'
import { useCheckStore } from '../../stores/check'
import { useWorkspaceStore } from '../../stores/workspace'
import { useTreeStore } from '../../stores/tree'
import { formKindOf, isBodyKind } from '../../shared/words'

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

async function runCheck(): Promise<void> {
  if (!docId.value) return
  await check.run(props.bookName, docId.value)
  // T9b：机检结果变化 → 刷新树红点（正文 red 增减要冒泡到树）
  if (!check.error) void tree.loadIssues(props.bookName)
}

// X-P2-15：切文档即清报告（store 注释声称「调用方 clear」但无人调——旧文档红项挂在新文档上）
watch(docId, () => check.clear())
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

      <div v-if="check.redItems.length > 0" class="check-group">
        <div class="group-label group-label--red">
          <AlertCircle :size="13" />
          <span>红项（{{ check.redItems.length }}）</span>
        </div>
        <div
          v-for="(it, i) in check.redItems"
          :key="'r' + i"
          class="check-item check-item--red"
        >
          <div class="item-msg">{{ it.message }}</div>
        </div>
      </div>

      <div v-if="check.yellowItems.length > 0" class="check-group">
        <div class="group-label group-label--yellow">
          <AlertTriangle :size="13" />
          <span>黄项（{{ check.yellowItems.length }}）</span>
        </div>
        <div
          v-for="(it, i) in check.yellowItems"
          :key="'y' + i"
          class="check-item check-item--yellow"
        >
          <div class="item-msg">{{ it.message }}</div>
        </div>
      </div>
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
  animation: cw-spin 0.9s linear infinite;
}
@keyframes cw-spin {
  to {
    transform: rotate(360deg);
  }
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
.check-item {
  padding: 6px 8px;
  border-radius: var(--radius-s);
  font-size: var(--font-size-s);
  line-height: 1.5;
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
</style>
