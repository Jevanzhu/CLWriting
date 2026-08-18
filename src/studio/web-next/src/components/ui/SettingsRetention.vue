<script setup lang="ts">
// 设置 · 版本保留页（全局）：保留天数/保留数量的全局默认。
// IA 重组后从「本书」页的版本与定稿子页拆出独立成页——本页只承载全局默认组（不依赖当前书），
// 本书独立设定与定稿版本统计在「本书」页。
// 生效链：book.yaml snapshots → global.json（prefs store）→ 硬编码 14 天 / 30 个，服务端 prune 同链。
import { usePrefsStore } from '../../stores/prefs'

// 全局默认值来自 prefs store（main.ts 在 mount 前 await init()，设置打开时必已就绪）
const prefs = usePrefsStore()

/** 全局默认数值输入（clamp 后写 store → global.json） */
function onGlobalSnapInput(which: 'days' | 'count', e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  if (!Number.isFinite(raw)) return
  if (which === 'days') prefs.setSnapDays(Math.min(365, Math.max(1, Math.round(raw))))
  else prefs.setSnapCount(Math.min(200, Math.max(1, Math.round(raw))))
}
</script>

<template>
  <!-- 单根包裹：多根 fragment 在 <Transition> 下无法动画（Vue warn） -->
  <div class="settings-tab">
    <div class="cfg-card-head">版本保留</div>
    <section class="cfg-card">
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">保留天数</div>
          <div class="setting-item-desc">未单独设定的书使用此规则</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="1" max="365" aria-label="保留天数（全局默认）" :value="prefs.snapDays" @change="onGlobalSnapInput('days', $event)" />
          <span class="val-suffix">天</span>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">保留数量</div>
          <div class="setting-item-desc">每章历史版本的数量上限</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="1" max="200" aria-label="保留数量（全局默认）" :value="prefs.snapCount" @change="onGlobalSnapInput('count', $event)" />
          <span class="val-suffix">个</span>
        </div>
      </div>
    </section>
  </div>
</template>
