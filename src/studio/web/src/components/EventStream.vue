<script setup lang="ts">
// 工作台右栏：事件流（mockup .card>.card-title + .ev.ev-{cls}）。读 useWorkbenchLog 共享状态（Workbench 写入），真联动。
import { useWorkbenchLog } from '../composables/useWorkbenchLog'

const { log } = useWorkbenchLog()
</script>

<template>
  <div class="card">
    <div class="card-title">
      事件流 <span style="color: var(--text-3); text-transform: none; font-weight: 400">driver SSE</span>
    </div>
    <div v-for="(l, i) in log" :key="i" class="ev" :class="`ev-${l.type}`">
      <span class="ev-t">{{ l.t }}</span>
      <span class="ev-type">{{ l.type }}</span>
      <span class="ev-text">{{ l.text }}</span>
    </div>
    <div v-if="!log.length" class="hint">等待事件…</div>
  </div>
</template>
