<script setup lang="ts">
// o3 完成度（总览子页面）：对齐 mockup renderOvMid o3（综合完成度环 + 正文/大纲/设定/体检/账本 五维度进度条）。
// 数据待 core，先占位结构。
</script>

<template>
  <section class="bento-wrap">
    <div class="bento-head">
      <h1 class="bento-title">完成度</h1>
      <div class="bento-sub">
        <span class="meta-chip">五维度综合</span>
        <span class="meta-chip">正文 · 大纲 · 设定 · 体检 · 账本</span>
      </div>
    </div>
    <div class="bento-grid">
      <div class="bento-card"><div class="bc-label">综合完成度</div><div class="ov-stub">环形图（待 core）</div></div>
      <div class="bento-card bento-full"><div class="bc-label">各维度进度</div>
        <div class="dim-list">
          <div class="dim"><span>正文</span><div class="dim-bar"><div style="width:0%"></div></div><b>—</b></div>
          <div class="dim"><span>大纲</span><div class="dim-bar"><div style="width:0%"></div></div><b>—</b></div>
          <div class="dim"><span>设定</span><div class="dim-bar"><div style="width:0%"></div></div><b>—</b></div>
          <div class="dim"><span>体检</span><div class="dim-bar"><div style="width:0%"></div></div><b>—</b></div>
          <div class="dim"><span>账本</span><div class="dim-bar"><div style="width:0%"></div></div><b>—</b></div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ov-stub{color:var(--text-3);font-size:13px;padding:20px 8px;line-height:1.7}
.dim-list{display:flex;flex-direction:column;gap:10px;padding:8px 4px}
.dim{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-2)}
.dim span{width:48px;flex-shrink:0}
.dim b{margin-left:auto;color:var(--ink)}
.dim-bar{flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden}
.dim-bar>div{height:100%;background:var(--ink-cyan);transition:width .3s}
</style>
