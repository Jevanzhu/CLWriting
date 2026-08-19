<script setup lang="ts">
// 开书对话·右栏步骤面板（巨石批 7c 拆分自 OnboardView）：①详情确认 → ②生成中 → ③编辑落盘
// 三相位。生成/保存动作与状态机在父层，本件纯相位渲染（content 编辑经 v-model 双向）。
import { TriangleAlert, Check, Sparkles, FileText, Loader2, RotateCcw, BookOpen } from 'lucide-vue-next'
import { useUiStore } from '../../stores/ui'
import { useTreeStore } from '../../stores/tree'
import { STEP_LABEL, STEP_PATH, STEP_DESC, type OnboardStep } from '../../api/onboard'

const props = defineProps<{
  active: OnboardStep | null
  phase: 'detail' | 'loading' | 'result'
  lastWords: number
  saving: boolean
  err: string | null
}>()
const content = defineModel<string>({ required: true })
const emit = defineEmits<{ gen: []; save: [] }>()
const ui = useUiStore()
const tree = useTreeStore()

function isGenerated(step: OnboardStep): boolean {
  return tree.byPath.has(STEP_PATH[step])
}
</script>

<template>
  <section class="ob-panel">
    <!-- 空状态 -->
    <div v-if="!active" class="panel-empty">
      <BookOpen :size="28" />
      <p>选择左侧步骤开始</p>
    </div>

    <template v-else>
      <!-- ① 详情确认 -->
      <div v-if="phase === 'detail'" class="phase-detail">
        <div class="panel-head">
          <FileText :size="14" />
          <span class="ph-title">{{ STEP_LABEL[active] }}</span>
          <span v-if="isGenerated(active)" class="status done"><Check :size="11" /> 已生成</span>
          <span v-else class="status">未生成</span>
        </div>

        <p class="detail-desc">{{ STEP_DESC[active] }}</p>

        <div class="detail-meta">
          <div class="meta-row">
            <span class="meta-k">保存位置</span>
            <code class="meta-v">{{ STEP_PATH[active] }}</code>
          </div>
          <div v-if="isGenerated(active)" class="meta-warn">
            <TriangleAlert :size="12" /> 该文件已存在，重新生成将覆盖已有内容。
          </div>
        </div>

        <div class="detail-actions">
          <button class="btn primary" :disabled="ui.aiAvailable === false" @click="emit('gen')">
            <Sparkles :size="14" />
            <span>{{ isGenerated(active) ? '重新生成' : '生成' }}</span>
          </button>
        </div>
      </div>

      <!-- ② 生成中 -->
      <div v-else-if="phase === 'loading'" class="phase-loading">
        <Loader2 :size="22" class="spin" />
        <div class="loading-text">
          <span class="loading-title">{{ STEP_LABEL[active] }} 生成中…</span>
          <span class="loading-hint">AI 需要数十秒，请耐心等待</span>
        </div>
      </div>

      <!-- ③ 编辑 + 落盘 -->
      <div v-else class="phase-result">
        <div class="panel-head">
          <span class="ph-title">{{ STEP_LABEL[active] }}</span>
          <span class="status done">完成 · {{ lastWords }} 字</span>
        </div>
        <textarea
          v-model="content"
          class="content-edit"
          placeholder="可编辑后保存"
        ></textarea>
        <div class="actions">
          <button class="btn primary" :disabled="saving" @click="emit('save')">
            {{ saving ? '保存中…' : '保存' }}
          </button>
          <button class="btn" @click="emit('gen')">
            <RotateCcw :size="13" /><span>重新生成</span>
          </button>
        </div>
      </div>
    </template>

    <div v-if="err" class="err-msg">{{ err }}</div>
  </section>
</template>

<style scoped>
.ob-panel {
  min-height: 340px;
  padding-bottom: var(--size-4-5);
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-s);
  animation: fade-up var(--dur-fast) var(--ease-out) 60ms both;
}
@keyframes fade-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}

/* panel-head（与总览页同模式：图标 + 标题，muted 色） */
.panel-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: var(--size-4-4);
  padding: var(--size-4-4) var(--size-4-5) 0;
}
.panel-head svg {
  opacity: 0.5;
  flex-shrink: 0;
}
.ph-title {
  font-size: var(--font-size-l);
  font-weight: 700;
  color: var(--text-normal);
  letter-spacing: -0.01em;
}

/* 空状态 */
.panel-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--size-4-2);
  min-height: 280px;
  color: var(--text-faint);
}
.panel-empty p {
  margin: 0;
  font-size: var(--font-size-s);
}

/* 状态标签 */
.status {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: 99px;
  font-size: var(--font-size-xs);
  font-weight: 500;
  color: var(--text-muted);
  background: var(--background-modifier-hover);
}
.status.done {
  color: var(--dv-good);
  background: color-mix(in srgb, var(--dv-good) 12%, transparent);
}

/* ① 详情 */
.phase-detail {
  padding: 0 var(--size-4-5) var(--size-4-2);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-4);
}
.detail-desc {
  margin: 0;
  font-size: var(--font-size-m);
  line-height: 1.8;
  color: var(--text-muted);
}
.detail-meta {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
  padding: var(--size-4-3);
  background: var(--background-secondary);
  border-radius: var(--radius-m);
}
.meta-row {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
}
.meta-k {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  white-space: nowrap;
}
.meta-v {
  font-family: var(--font-monospace);
  font-size: var(--font-size-s);
  color: var(--text-normal);
  background: var(--background-primary);
  padding: 2px 8px;
  border-radius: var(--radius-s);
}
.meta-warn {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--font-size-xs);
  color: var(--text-warning);
}
.detail-actions {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
}

/* ② 生成中 */
.phase-loading {
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  padding: var(--size-4-8) var(--size-4-5);
}
.loading-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.loading-title {
  font-size: var(--font-size-m);
  font-weight: 600;
  color: var(--text-normal);
}
.loading-hint {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}

/* ③ 结果 */
.phase-result {
  padding: 0 var(--size-4-5) var(--size-4-2);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
}
.content-edit {
  width: 100%;
  min-height: 300px;
  box-sizing: border-box;
  padding: var(--size-4-3);
  font-family: var(--prose-font);
  font-size: var(--prose-size);
  line-height: var(--prose-lh);
  color: var(--text-normal);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  resize: vertical;
  outline: none;
  transition: border-color var(--dur-fast) var(--ease-out);
}
.content-edit:focus {
  border-color: var(--interactive-accent);
  background: var(--background-primary);
}
.actions {
  display: flex;
  gap: var(--size-4-2);
}

/* 按钮 */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 7px 16px;
  font-size: var(--font-size-m);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.btn.primary {
  background: var(--interactive-accent);
  border-color: transparent;
  color: var(--text-on-accent);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.btn:hover:not(:disabled) {
  border-color: var(--background-modifier-border-hover);
}
.btn.primary:hover:not(:disabled) {
  background: var(--interactive-accent-hover);
}

.spin {
  animation: cw-spin 0.9s linear infinite;
  color: var(--text-accent);
}
@keyframes cw-spin {
  to { transform: rotate(360deg); }
}

.err-msg {
  margin-top: var(--size-4-3);
  padding: 0 var(--size-4-5);
  font-size: var(--font-size-s);
  color: var(--text-error);
}
</style>
