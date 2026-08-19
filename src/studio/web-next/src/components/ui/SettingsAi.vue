<script setup lang="ts">
// 设置 · AI 写作页（全局）：AI 对话（对话助手）+ AI 写作全局默认（文风注入/自动确认细纲/批量章数/单章上限）。
// IA 重组后独立成页——本页只承载全局层（不依赖当前书），本书独立设定在「本书」页的 AI 写作组：
// 生效链 book.yaml 对应键 → global.json（prefs store）→ 硬编码回落。
// 分析侧在「智能分析」页；提供方在「服务提供方」页。
import { usePrefsStore } from '../../stores/prefs'
import BetaBadge from './BetaBadge.vue'

// 全局默认值来自 prefs store（main.ts 在 mount 前 await init()，设置打开时必已就绪）
const prefs = usePrefsStore()

// ── 全局默认控件：直写 prefs store（clamp 在 store setter，防抖落 global.json）──

function onGlobalConfirmToggle(e: Event): void {
  prefs.setAutoConfirmOutline((e.target as HTMLInputElement).checked)
}
function onGlobalBatchInput(e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(raw)) prefs.setAiBatchSize(raw)
}
function onGlobalCallsInput(e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(raw)) prefs.setCallsPerChapter(raw)
}
</script>

<template>
  <!-- 单根包裹：多根 fragment 在 <Transition> 下无法动画（Vue warn） -->
  <div class="settings-tab">
    <div class="cfg-card-head">AI 对话 <BetaBadge /></div>
    <section class="cfg-card">
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">对话助手</div>
          <div class="setting-item-desc">在工作台显示对话面板，可与 AI 讨论剧情、机检章节</div>
        </div>
        <div class="setting-item-control">
          <label class="switch">
            <input type="checkbox" aria-label="对话助手" :checked="prefs.chatEnabled" @change="prefs.setChatEnabled(($event.target as HTMLInputElement).checked)" />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>
    </section>

    <div class="cfg-card-head">AI 写作 <BetaBadge /></div>
    <section class="cfg-card">
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">文风注入</div>
          <div class="setting-item-desc">AI 写正文时遵循文风铁律的强度</div>
        </div>
        <div class="setting-item-control">
          <div class="seg">
            <button :class="{ on: prefs.styleInjection === 'light' }" @click="prefs.setStyleInjection('light')">轻</button>
            <button :class="{ on: prefs.styleInjection === 'heavy' }" @click="prefs.setStyleInjection('heavy')">重</button>
          </div>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">自动确认细纲 <span class="tag-soon">即将支持</span></div>
          <div class="setting-item-desc">AI 生成细纲后自动确认，无需手动点确认</div>
        </div>
        <div class="setting-item-control">
          <label class="switch">
            <input type="checkbox" aria-label="自动确认细纲（全局默认）" :checked="prefs.autoConfirmOutline" @change="onGlobalConfirmToggle($event)" />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">批量写作章数</div>
          <div class="setting-item-desc">一次自动写作流程连续写的章数，中途红项触顶会停在当前章</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="1" max="20" step="1" aria-label="批量写作章数（全局默认）" :value="prefs.aiBatchSize" @change="onGlobalBatchInput($event)" />
          <span class="val-suffix">章</span>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">单章调用上限</div>
          <div class="setting-item-desc">每章 AI 辅助的最大调用次数，防止成本失控</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="1" max="50" step="1" aria-label="单章调用上限（全局默认）" :value="prefs.callsPerChapter" @change="onGlobalCallsInput($event)" />
          <span class="val-suffix">次</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.tag-soon {
  padding: 1px 7px;
  font-size: var(--font-size-xxs);
  font-weight: 600;
  border-radius: 99px;
  background: var(--background-modifier-hover);
  color: var(--text-faint);
}
</style>
