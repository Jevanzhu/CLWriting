<script setup lang="ts">
// 开书对话·故事梗概卡（巨石批 7c 拆分自 OnboardView）：作者设想输入，AI 据其开书。
// localStorage 持久化（300ms 防抖）随卡迁移；值经 v-model 与父层双向（gen() 读同一份）。
import { onMounted, onBeforeUnmount, watch } from 'vue'
import { PenLine } from 'lucide-vue-next'

const props = defineProps<{ bookName: string }>()
const storyPremise = defineModel<string>({ required: true })

// ── localStorage 持久化（隐私模式静默忽略）──
const PREMISE_KEY = (n: string) => `clwriting:onboard-premise:${n}`
onMounted(() => {
  try {
    storyPremise.value = localStorage.getItem(PREMISE_KEY(props.bookName)) ?? ''
  } catch { /* 隐私模式忽略 */ }
})
let premiseTimer: ReturnType<typeof setTimeout> | null = null
watch(storyPremise, (v) => {
  if (premiseTimer) clearTimeout(premiseTimer)
  premiseTimer = setTimeout(() => {
    premiseTimer = null
    try {
      localStorage.setItem(PREMISE_KEY(props.bookName), v)
    } catch { /* 忽略 */ }
  }, 300)
})
onBeforeUnmount(() => {
  if (premiseTimer) { clearTimeout(premiseTimer); premiseTimer = null }
})
</script>

<template>
  <section class="ob-premise">
    <div class="premise-head">
      <PenLine :size="14" />
      <span class="premise-title">故事梗概</span>
      <span class="premise-sub">输入你的设想，AI 将据此生成各步设定</span>
    </div>
    <textarea
      v-model="storyPremise"
      class="premise-input"
      rows="3"
      placeholder="例：少年林开出身微末，因一场灭门奇案卷入上古灵脉之争，在宗门、朝堂与江湖的暗流中步步为营……"
    ></textarea>
    <div class="premise-foot">
      <span class="premise-hint">生成的每一步都会以此为基准，可随时修改</span>
    </div>
  </section>
</template>

<style scoped>
.ob-premise {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-s);
  padding: var(--size-4-4) var(--size-4-5);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
  animation: clw-fade-up 0.5s var(--ease-out) 120ms both;
}

.premise-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.premise-head svg {
  opacity: 0.5;
  flex-shrink: 0;
  color: var(--text-muted);
}
.premise-title {
  font-size: var(--font-size-m);
  font-weight: 700;
  color: var(--text-normal);
  letter-spacing: -0.01em;
}
.premise-sub {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.premise-input {
  width: 100%;
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
  transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.premise-input:focus {
  border-color: var(--interactive-accent);
  background: var(--background-primary);
}
.premise-input::placeholder {
  color: var(--text-faint);
}
.premise-foot {
  display: flex;
  align-items: center;
  gap: 5px;
}
.premise-hint {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
}
</style>
