<script setup lang="ts">
// 工作台态左栏：当前任务 + 八阶段进度（占位，后续刀与 Workbench 内部状态联动）。
import { ref } from 'vue'

const stages = ref([
  { id: 'outline', label: '细纲', done: false, active: false },
  { id: 'confirm', label: '确认', done: false, active: false },
  { id: 'prepare', label: '备料', done: false, active: false },
  { id: 'draft', label: '写稿', done: false, active: true },
  { id: 'check', label: '机检', done: false, active: false },
  { id: 'review', label: '三审', done: false, active: false },
  { id: 'finalize', label: '定稿', done: false, active: false },
])
</script>

<template>
  <div class="tl">
    <div class="tl-section">
      <div class="tl-group-title">当前任务</div>
      <div class="tl-task">
        <span class="clw-dot yellow"></span>
        <div>
          <div class="tl-tt">第 1 章 · 写稿中</div>
          <div class="tl-ts">八阶段工作流</div>
        </div>
      </div>
    </div>
    <div class="tl-section">
      <div class="tl-group-title">阶段进度</div>
      <div
        v-for="s in stages"
        :key="s.id"
        class="tl-stage"
        :class="{ active: s.active, done: s.done }"
      >
        <span class="tl-stage-dot">{{ s.done ? '✓' : s.active ? '●' : '○' }}</span>
        <span>{{ s.label }}</span>
      </div>
      <div class="tl-hint">进度与 Workbench 实时联动 · 后续刀接入</div>
    </div>
  </div>
</template>

<style scoped>
.tl {
  padding: 4px 0;
}
.tl-section {
  margin-bottom: 16px;
}
.tl-group-title {
  color: var(--text-3);
  font-size: 10px;
  letter-spacing: 1px;
  padding: 8px 8px 6px;
  text-transform: uppercase;
}
.tl-task {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  margin: 0 4px;
  background: var(--active-bg);
  border-radius: 6px;
}
.tl-tt {
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
}
.tl-ts {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}
.tl-stage {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  margin: 1px 4px;
  font-size: 13px;
  color: var(--text-2);
  border-radius: 5px;
}
.tl-stage-dot {
  width: 16px;
  text-align: center;
  font-size: 11px;
  color: var(--text-3);
}
.tl-stage.active {
  color: var(--ink-cyan);
  background: var(--active-bg);
  font-weight: 500;
}
.tl-stage.active .tl-stage-dot {
  color: var(--ochre);
}
.tl-stage.done {
  color: var(--ink-cyan);
}
.tl-stage.done .tl-stage-dot {
  color: var(--ink-cyan);
}
.tl-hint {
  margin: 8px 12px 0;
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.6;
  border-top: 1px dashed var(--border);
  padding-top: 8px;
}
</style>
