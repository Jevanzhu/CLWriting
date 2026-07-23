<script setup lang="ts">
// T0.3 占位；P2 落写作信息（字数/进度/保存态/回滚）+ 上下文速查 + AI 辅助位（置灰）。
</script>

<template>
  <div class="sidebar-right">
    <div class="side-section">
      <div class="side-title">写作信息</div>
      <div class="side-hint">P2：实时字数 / 目标进度 / 定稿状态 / 保存态 / 回滚</div>
    </div>
    <div class="side-section">
      <div class="side-title">上下文速查</div>
      <div class="side-hint">P2：设定速查 + AI 辅助位（不可达置灰）</div>
    </div>
  </div>
</template>

<style scoped>
.sidebar-right {
  padding: var(--size-4-2) var(--size-4-3);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
}
.side-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: var(--size-4-2);
}
.side-hint {
  font-size: 12px;
  color: var(--text-faint);
  line-height: 1.6;
}
</style>
