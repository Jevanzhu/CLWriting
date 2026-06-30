<script setup lang="ts">
/** 行级 diff 展示(+ 新 / - 旧 / 空格 同)，接受/拒绝。B 策略保留 script，行用 mockup .diff-line。 */

interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
}

defineProps<{ diff: DiffLine[]; applying?: boolean }>()
const emit = defineEmits<{ accept: []; reject: [] }>()
</script>

<template>
  <div class="diff-view">
    <div class="diff-bar">
      <span class="diff-label">改写预览 <span class="add">+新</span> / <span class="del">-旧</span></span>
      <span class="diff-ops">
        <button class="btn primary" :disabled="applying" @click="emit('accept')">{{ applying ? '应用中…' : '✓ 接受' }}</button>
        <button class="btn" :disabled="applying" @click="emit('reject')">✗ 拒绝</button>
      </span>
    </div>
    <div class="diff-body">
      <div v-for="(l, i) in diff" :key="i" class="diff-line" :class="l.type">{{ l.text || ' ' }}</div>
    </div>
  </div>
</template>

<style scoped>
/* mockup 覆盖 .diff-line(.add/.del)；此处仅补内嵌容器与操作栏（mockup 的 diff 是弹窗两栏，架构不同）。 */
.diff-view{margin-top:12px;border:1px solid var(--border);border-radius:8px;overflow:hidden}
.diff-bar{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--paper);border-bottom:1px solid var(--border);font-size:12px;color:var(--text-2)}
.diff-label .add{color:var(--ink-cyan)}
.diff-label .del{color:var(--cinnabar)}
.diff-ops{display:flex;gap:8px}
.diff-body{max-height:420px;overflow-y:auto;padding:8px 12px}
</style>
