<script setup lang="ts">
// o2 字数统计（总览子页面）：对齐 mockup renderOvMid o2（各章字数 bar-chart + 目标/总/平均/异常 stat + 各章明细可跳编辑）。
// 数据待 core（字数维度聚合），先占位结构。
</script>

<template>
  <section class="bento-wrap">
    <div class="bento-head">
      <h1 class="bento-title">字数统计</h1>
      <div class="bento-sub">
        <span class="meta-chip">各章字数分布</span>
        <span class="meta-chip">目标 · 平均 · 异常</span>
      </div>
    </div>
    <div class="bento-grid">
      <div class="bento-card bento-full"><div class="bc-label">各章字数柱图</div><div class="ov-stub">柱图待 core（可复用 getRhythm wordCurve）</div></div>
      <div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">目标</div><div class="bc-stat">—</div></div>
      <div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">平均</div><div class="bc-stat">—</div></div>
      <div class="bento-card"><div class="bc-menu">⋮</div><div class="bc-label">异常</div><div class="bc-stat" style="color:var(--cinnabar)">—</div></div>
      <div class="bento-card bento-full"><div class="bc-label">各章明细</div><div class="ov-stub">点击章名跳编辑（数据待 core）</div></div>
    </div>
  </section>
</template>

<style scoped>
.ov-stub{color:var(--text-3);font-size:13px;padding:20px 8px;line-height:1.7}
</style>
