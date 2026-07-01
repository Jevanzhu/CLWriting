<script setup lang="ts">
// o5 近期动态（总览子页面）：对齐 mockup renderOvMid o5（事件流 bc-ev-row + 本周 章节/体检/伏笔 分类计数）。
// 数据待 core（事件流聚合），先占位结构。
</script>

<template>
  <section class="bento-wrap">
    <div class="bento-head">
      <h1 class="bento-title">近期动态</h1>
      <div class="bento-sub">
        <span class="meta-chip">事件流</span>
        <span class="meta-chip">本周分类计数</span>
      </div>
    </div>
    <div class="bento-grid">
      <div class="bento-card bento-full"><div class="bc-label">事件流</div><div class="ov-stub">事件列表（待 core 事件流聚合）</div></div>
      <div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">本周章节</div><div class="bc-stat">—</div></div>
      <div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">本周体检</div><div class="bc-stat">—</div></div>
      <div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">本周伏笔</div><div class="bc-stat">—</div></div>
    </div>
  </section>
</template>

<style scoped>
.ov-stub{color:var(--text-3);font-size:13px;padding:20px 8px;line-height:1.7}
</style>
