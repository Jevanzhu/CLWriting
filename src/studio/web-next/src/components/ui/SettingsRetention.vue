<script setup lang="ts">
// 设置 · 版本保留页（全局）：保留天数/保留数量的全局默认。
// IA 重组后从「本书」页的版本与定稿子页拆出独立成页——本页只承载全局默认组（不依赖当前书），
// 本书独立设定与定稿版本统计在「本书」页。
// 生效链：book.yaml snapshots → global.json（prefs store）→ 硬编码 14 天 / 30 个，服务端 prune 同链。
import { usePrefsStore } from '../../stores/prefs'
import { parseNumericInput } from '../../shared/numeric-input'

// 全局默认值来自 prefs store（main.ts 在 mount 前 await init()，设置打开时必已就绪）
const prefs = usePrefsStore()

/** 全局默认数值输入（clamp 后写 store → global.json）。
 *  R72-11（二十轮 E-2）：空串/非数字走共享 helper 挡掉（原 Number('')=0 过闸被钳成 1） */
function onGlobalSnapInput(which: 'days' | 'count', e: Event): void {
  const v = parseNumericInput(e)
  if (v === null) return
  if (which === 'days') prefs.setSnapDays(Math.min(365, Math.max(1, Math.round(v))))
  else prefs.setSnapCount(Math.min(200, Math.max(1, Math.round(v))))
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
          <div class="setting-item-desc">所有书统一按此规则保留（无书级覆盖）</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="1" max="365" aria-label="保留天数（全局默认）" :value="prefs.snapDays" @change="onGlobalSnapInput('days', $event)" />
          <span class="val-suffix">天</span>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">保留数量</div>
          <div class="setting-item-desc">每章历史版本的数量上限（所有书统一）</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="1" max="200" aria-label="保留数量（全局默认）" :value="prefs.snapCount" @change="onGlobalSnapInput('count', $event)" />
          <span class="val-suffix">个</span>
        </div>
      </div>
    </section>
  </div>
</template>
