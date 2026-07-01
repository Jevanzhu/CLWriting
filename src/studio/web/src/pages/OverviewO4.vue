<script setup lang="ts">
// o4 写作日历（总览子页面）：对齐 mockup renderOvMid o4（近14日字数热力图 + 动笔天数 + 14日总字数）。
// 数据待 core（日维度字数聚合），先占位结构。
</script>

<template>
  <section class="bento-wrap">
    <div class="bento-head">
      <h1 class="bento-title">写作日历</h1>
      <div class="bento-sub">
        <span class="meta-chip">近 14 日热力</span>
        <span class="meta-chip">动笔天数 · 总字数</span>
      </div>
    </div>
    <div class="bento-grid">
      <div class="bento-card bento-full"><div class="bc-label">近 14 日热力图</div>
        <div class="heat-row">
          <div v-for="n in 14" :key="n" class="heat-cell"></div>
        </div>
        <div class="ov-stub">格点热力（数据待 core 日维度字数）</div>
      </div>
      <div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">动笔天数</div><div class="bc-stat">—</div></div>
      <div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">14 日总字数</div><div class="bc-stat">—</div></div>
    </div>
  </section>
</template>

<style scoped>
.ov-stub{color:var(--text-3);font-size:13px;padding:12px 8px;line-height:1.7}
.heat-row{display:flex;gap:6px;padding:14px 8px 4px}
.heat-cell{flex:1;height:32px;border-radius:5px;background:var(--border)}
</style>
