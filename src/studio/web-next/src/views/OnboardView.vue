<script setup lang="ts">
// 开书对话（细案 T3.3）：分步 AI 生成设定 → 预览编辑 → 落盘。
// realm 仅成长线书；各步覆盖对应设定文件，已开的书慎用。
import { ref } from 'vue'
import { onboardAi, onboardSave, STEP_LABEL, type OnboardStep } from '../api/onboard'
import { useUiStore } from '../stores/ui'

const props = defineProps<{ bookName: string }>()
const ui = useUiStore()

const STEPS = Object.keys(STEP_LABEL) as OnboardStep[]
const active = ref<OnboardStep | null>(null)
const content = ref('')
const loading = ref(false)
const saving = ref(false)
const err = ref<string | null>(null)

async function gen(step: OnboardStep): Promise<void> {
  active.value = step
  loading.value = true
  err.value = null
  content.value = ''
  try {
    const r = await onboardAi(props.bookName, { step })
    content.value = r.content
    ui.toast(`${STEP_LABEL[step]} 生成（${r.words} 字）`, 'success')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
    ui.toast(err.value, 'error')
  } finally {
    loading.value = false
  }
}
async function save(): Promise<void> {
  if (!active.value) return
  saving.value = true
  try {
    await onboardSave(props.bookName, { step: active.value, content: content.value })
    ui.toast('已落盘', 'success')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
    ui.toast(err.value, 'error')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="onboard">
    <section class="card">
      <div class="card-head">开书对话 · 分步生成设定</div>
      <p class="warn">⚠ 各步会覆盖对应设定文件（总纲 / 名册 / 世界观…），已开的书慎用。</p>
      <div class="step-grid">
        <button
          v-for="s in STEPS"
          :key="s"
          class="step-btn"
          :class="{ on: active === s }"
          :disabled="loading"
          @click="gen(s)"
        >
          {{ STEP_LABEL[s] }}
        </button>
      </div>
    </section>

    <section v-if="active" class="card">
      <div class="card-head">
        <span>{{ STEP_LABEL[active] }}</span>
        <span class="muted">{{ loading ? '生成中…（AI 阻塞数十秒）' : '' }}</span>
      </div>
      <textarea
        v-model="content"
        class="content-edit"
        :disabled="loading"
        placeholder="点上方按钮生成，或直接编辑后落盘"
      ></textarea>
      <div class="actions">
        <button class="btn primary" :disabled="loading || saving" @click="save">
          {{ saving ? '保存中…' : '落盘' }}
        </button>
      </div>
    </section>

    <div v-if="err" class="err-msg">{{ err }}</div>
  </div>
</template>

<style scoped>
.onboard {
  height: 100%;
  overflow: auto;
  padding: var(--size-4-4) var(--size-4-6);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
  max-width: 820px;
  margin: 0 auto;
}
.card {
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  padding: var(--size-4-3);
}
.card-head {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-normal);
  margin-bottom: var(--size-4-2);
  display: flex;
  justify-content: space-between;
}
.warn {
  font-size: 12px;
  color: var(--text-warning);
  margin-bottom: var(--size-4-3);
  line-height: 1.6;
}
.step-grid {
  display: flex;
  flex-wrap: wrap;
  gap: var(--size-4-2);
}
.step-btn {
  padding: 6px 14px;
  font-size: 12px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-muted);
  cursor: pointer;
}
.step-btn:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.step-btn.on {
  border-color: var(--interactive-accent);
  color: var(--interactive-accent);
}
.step-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.muted {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-faint);
}
.content-edit {
  width: 100%;
  min-height: 320px;
  box-sizing: border-box;
  padding: var(--size-4-3);
  font-family: var(--prose-font);
  font-size: var(--prose-size);
  line-height: var(--prose-lh);
  color: var(--text-normal);
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  resize: vertical;
  outline: none;
}
.content-edit:focus {
  border-color: var(--interactive-accent);
}
.actions {
  margin-top: var(--size-4-3);
}
.btn {
  padding: 6px 16px;
  font-size: 13px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
}
.btn.primary {
  background: var(--interactive-accent);
  border-color: var(--interactive-accent);
  color: var(--text-on-accent);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.err-msg {
  font-size: 12px;
  color: var(--text-error);
}
</style>
