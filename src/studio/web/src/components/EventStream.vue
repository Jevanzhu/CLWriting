<script setup lang="ts">
// 工作台态右栏：事件流。读 useWorkbenchLog 共享状态（Workbench.vue 写入），真联动。
import { useWorkbenchLog } from '../composables/useWorkbenchLog'

const { log } = useWorkbenchLog()
</script>

<template>
  <div class="es">
    <div class="es-card">
      <div class="es-title">事件流</div>
      <ul class="es-log">
        <li v-for="(l, i) in log" :key="i" :class="`ev-${l.type}`">
          <span class="es-t">{{ l.t }}</span>
          <span class="es-text">{{ l.text }}</span>
        </li>
        <li v-if="!log.length" class="es-empty">等待事件…（工作台操作产生）</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.es-card {
  background: var(--paper);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
}
.es-title {
  font-size: 11px;
  color: var(--text-3);
  letter-spacing: 1px;
  text-transform: uppercase;
  margin-bottom: 8px;
}
.es-log {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 6px;
  max-height: 60vh;
  overflow-y: auto;
}
.es-log li {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 8px;
  font-size: 12px;
  padding: 4px 0;
  border-bottom: 1px dashed var(--border);
}
.es-log li:last-child {
  border-bottom: none;
}
.es-t {
  color: var(--text-3);
  font-family: ui-monospace, monospace;
  font-size: 11px;
}
.es-text {
  color: var(--text-2);
  line-height: 1.5;
}
.es-empty {
  color: var(--text-3);
  display: block !important;
  padding: 12px 0;
  text-align: center;
}
.ev-error .es-text {
  color: var(--cinnabar);
}
.ev-saved .es-text,
.ev-done .es-text {
  color: var(--ink-cyan);
}
.ev-spawn .es-text {
  color: var(--ochre);
}
</style>
