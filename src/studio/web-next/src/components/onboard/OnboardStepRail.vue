<script setup lang="ts">
// 开书对话·左栏分组步骤列表（巨石批 7c 拆分自 OnboardView）。
// 分组结构由父层按书型过滤后传入（isShort/isGrowthBook 语义在父层）；
// 「已生成」圆点读章节树（STEP_PATH 落盘位置）。
import { computed } from 'vue'
import { useTreeStore } from '../../stores/tree'
import { STEP_LABEL, STEP_PATH, type OnboardStep } from '../../api/onboard'

const props = defineProps<{
  groups: { label: string; steps: OnboardStep[] }[]
  active: OnboardStep | null
  disabled: boolean
}>()
const emit = defineEmits<{ select: [step: OnboardStep] }>()
const tree = useTreeStore()

const stepIndex = computed(() => {
  const m = new Map<OnboardStep, number>()
  let n = 0
  for (const g of props.groups) for (const s of g.steps) m.set(s, ++n)
  return m
})

function isGenerated(step: OnboardStep): boolean {
  return tree.byPath.has(STEP_PATH[step])
}
</script>

<template>
  <nav class="ob-rail">
    <div v-for="g in groups" :key="g.label" class="rail-group">
      <div class="rail-group-label">{{ g.label }}</div>
      <button
        v-for="s in g.steps"
        :key="s"
        class="rail-item"
        :class="{ on: active === s }"
        :disabled="disabled"
        @click="emit('select', s)"
      >
        <span class="rail-no">{{ stepIndex.get(s) }}</span>
        <span class="rail-label">{{ STEP_LABEL[s] }}</span>
        <span v-if="isGenerated(s)" class="rail-dot" title="已生成"></span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.ob-rail {
  position: sticky;
  top: var(--size-4-5);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-1);
  padding: var(--size-4-3);
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-s);
  animation: clw-fade-up var(--dur-fast) var(--ease-out) both;
}

.rail-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.rail-group:not(:first-child) {
  margin-top: var(--size-4-2);
  padding-top: var(--size-4-2);
  border-top: 1px solid var(--background-modifier-border);
}
.rail-group-label {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: var(--size-4-1) 6px var(--size-4-2);
  font-size: var(--font-size-s);
  font-weight: 700;
  color: var(--text-normal);
}
.rail-group-label::before {
  content: '';
  width: 3px;
  height: 13px;
  border-radius: 2px;
  background: var(--interactive-accent);
  opacity: 0.6;
}
.rail-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: none;
  border-left: 2px solid transparent;
  border-radius: 0 var(--radius-s) var(--radius-s) 0;
  background: none;
  font-size: var(--font-size-s);
  color: var(--text-muted);
  cursor: pointer;
  text-align: left;
  transition: all var(--dur-fast) var(--ease-out);
}
.rail-item:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.rail-item.on {
  background: color-mix(in srgb, var(--interactive-accent) 10%, transparent);
  border-left-color: var(--interactive-accent);
  color: var(--text-accent);
  font-weight: 600;
}
.rail-item:disabled {
  opacity: 0.5;
  cursor: default;
}
.rail-no {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  min-width: 16px;
}
.rail-item.on .rail-no {
  color: var(--text-accent);
}
.rail-label {
  flex: 1;
}
.rail-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dv-good);
  flex-shrink: 0;
}
</style>
