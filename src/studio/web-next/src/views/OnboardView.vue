<script setup lang="ts">
// 开书对话（细案 T3.3）：分步 AI 生成设定 → 预览编辑 → 落盘。
// realm 仅成长线书；各步覆盖对应设定文件，已开的书慎用。
import { ref, onMounted } from 'vue'
import { TriangleAlert, Check } from 'lucide-vue-next'
import { onboardAi, onboardSave, STEP_LABEL, STEP_PATH, type OnboardStep } from '../api/onboard'
import { useUiStore } from '../stores/ui'
import { useTreeStore } from '../stores/tree'

const props = defineProps<{ bookName: string }>()
const ui = useUiStore()
const tree = useTreeStore()

// 已生成判定：对应设定文件是否已在树中（工作区文件不进树 → first-outline 步判不到，边缘场景可接受）
function isGenerated(step: OnboardStep): boolean {
  return tree.byPath.has(STEP_PATH[step])
}

onMounted(() => {
  void tree.load(props.bookName)
})

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
    void tree.load(props.bookName) // 刷新「已生成」打勾
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
    <!-- G4：AI 不可达置灰提示 -->
    <div v-if="ui.aiAvailable === false" class="ai-warn">
      AI 驱动不可用（claude CLI 未就绪），开书对话暂不可用。请确认 claude CLI 已安装并在 PATH。
    </div>
    <section class="card">
      <div class="card-head">开书对话 · 分步生成设定</div>
      <p class="warn"><TriangleAlert :size="14" /> 各步会覆盖对应设定文件（总纲 / 名册 / 世界观…），已开的书慎用。</p>
      <div class="step-grid">
        <button
          v-for="(s, i) in STEPS"
          :key="s"
          class="step-btn"
          :class="{ on: active === s, done: isGenerated(s) }"
          :disabled="loading || ui.aiAvailable === false"
          @click="gen(s)"
        >
          <span class="step-no">{{ i + 1 }}</span>
          <span class="step-label">{{ STEP_LABEL[s] }}</span>
          <Check v-if="isGenerated(s)" :size="13" class="step-done" />
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
  box-shadow: var(--shadow-s);
}
.card-head {
  font-size: var(--font-size-m);
  font-weight: 600;
  color: var(--text-normal);
  margin-bottom: var(--size-4-2);
  display: flex;
  justify-content: space-between;
}
.warn {
  display: flex;
  align-items: flex-start;
  gap: 6px;
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
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
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
.step-btn.done {
  border-color: var(--color-green, #4e9d68);
}
.step-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.step-no {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.step-label {
  flex: 1;
}
.step-done {
  color: var(--color-green, #4e9d68);
  flex-shrink: 0;
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
.ai-warn {
  padding: 8px 12px;
  margin-bottom: var(--size-4-3);
  font-size: 12px;
  color: var(--text-warning);
  background: var(--background-modifier-border);
  border-radius: var(--radius-s);
}
</style>
