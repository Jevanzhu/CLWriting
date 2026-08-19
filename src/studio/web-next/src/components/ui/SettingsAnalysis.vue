<script setup lang="ts">
// 设置 · 智能分析页（全局）：AI 机检（短篇严格模式）/ 关系图（自动梳理/增量阈值）/ 知识检索（启用/提供方）的全局默认。
// IA 重组后独立成页——本页只承载全局层（不依赖当前书），本书独立设定在「本书」页的各同名组：
// 生效链 book.yaml 对应键 → global.json（prefs store）→ 硬编码回落（服务端合并同链）。
// 知识检索：书里只存「选哪个提供方 + 开不开启」；endpoint/model/key 归应用级 RAG 提供方管。
import { computed, watch, onActivated } from 'vue'
import { useUiStore } from '../../stores/ui'
import { usePrefsStore } from '../../stores/prefs'
import { useProviderStore } from '../../stores/provider'
import BetaBadge from './BetaBadge.vue'

const ui = useUiStore()
// 全局默认值来自 prefs store（main.ts 在 mount 前 await init()，设置打开时必已就绪）
const prefs = usePrefsStore()
// 阶段 14 §6.3：RAG 提供方读统一 provider store（与服务提供方页共享一份，一处增删处处新鲜）
const pstore = useProviderStore()

// 检索提供方列表（全局默认组下拉的数据源；本书子项的下拉在「本书」页各自读 store）
const ragProviders = computed(() => pstore.ragProviders)

function loadRagProviders(): void {
  void pstore.refreshRag()
}

// 设置弹窗打开时拉一次提供方列表（本页不依赖当前书，无需 watch bookName）
watch(
  () => ui.settingsOpen,
  (open) => {
    if (open) loadRagProviders()
  },
  { immediate: true },
)
// keep-alive 页切走只 deactivated 不 unmount——设置开着切去「服务提供方」页增删 RAG 后回来，
// watch 不会再触发（settingsOpen 未变）；store 共享后本就地新鲜，回页仍补拉一次兜底
onActivated(() => {
  if (ui.settingsOpen) loadRagProviders()
})

// ── 全局默认控件：直写 prefs store（clamp 在 store setter，防抖落 global.json）──

function onGlobalRagToggle(e: Event): void {
  prefs.setRagEnabled((e.target as HTMLInputElement).checked)
}
function onGlobalRagProviderChange(e: Event): void {
  prefs.setRagProvider((e.target as HTMLSelectElement).value)
}
function onGlobalThresholdInput(e: Event): void {
  // 非法输入（空/非数字）不写 store——Number('')=0 会被 clamp 成 1，须先挡掉
  const raw = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(raw)) prefs.setRelationMineThreshold(raw)
}
</script>

<template>
  <!-- 单根包裹：多根 fragment 在 <Transition> 下无法动画（Vue warn） -->
  <div class="settings-tab">
    <div class="cfg-card-head">AI 机检 <BetaBadge /></div>
    <section class="cfg-card">
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">短篇严格模式</div>
          <div class="setting-item-desc">把短篇专属黄项（字数/身体部位词/比喻/五段节数/开头钩子/反转线索/情绪曲线）提升为红项——机检红项会打回重写，过不了不交稿；仅作用于短篇书</div>
        </div>
        <div class="setting-item-control">
          <label class="switch">
            <input type="checkbox" aria-label="短篇严格模式（全局默认）" :checked="prefs.defaultShortStrict" @change="prefs.setDefaultShortStrict(($event.target as HTMLInputElement).checked)" />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>
    </section>

    <div class="cfg-card-head">关系图 <BetaBadge /></div>
    <section class="cfg-card">
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">自动梳理 <BetaBadge /></div>
          <div class="setting-item-desc">打开关系图时，若新增章节达到阈值则自动 AI 梳理</div>
        </div>
        <div class="setting-item-control">
          <label class="switch">
            <input type="checkbox" aria-label="关系图自动梳理（全局默认）" :checked="prefs.relationAutoMine" @change="prefs.setRelationAutoMine(($event.target as HTMLInputElement).checked)" />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">章节增量阈值 <BetaBadge /></div>
          <div class="setting-item-desc">自上次梳理后新增多少章触发自动梳理</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="1" max="20" step="1" aria-label="章节增量阈值（全局默认）" :value="prefs.relationMineThreshold" @change="onGlobalThresholdInput($event)" />
          <span class="val-suffix">章</span>
        </div>
      </div>
    </section>

    <div class="cfg-card-head">知识检索 <BetaBadge /></div>
    <section class="cfg-card">
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">启用检索 <BetaBadge /></div>
          <div class="setting-item-desc">开启后 AI 可检索已有章节作为上下文</div>
        </div>
        <div class="setting-item-control">
          <label class="switch">
            <input type="checkbox" aria-label="启用知识检索（全局默认）" :checked="prefs.ragEnabled" @change="onGlobalRagToggle($event)" />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">检索提供方</div>
          <div class="setting-item-desc">
            {{ ragProviders.length ? '嵌入提供方在「服务提供方」页管理，未单独设定的书使用此默认' : '尚未配置嵌入提供方——请先到「服务提供方」页添加 RAG 提供方' }}
          </div>
        </div>
        <div class="setting-item-control">
          <select
            class="rag-prov-select"
            aria-label="检索提供方（全局默认）"
            :value="prefs.ragProvider"
            @change="onGlobalRagProviderChange($event)"
          >
            <option value="" disabled>{{ ragProviders.length ? '请选择' : '暂无可选提供方' }}</option>
            <option v-for="p in ragProviders" :key="p.id" :value="p.id">{{ p.name }}（{{ p.model }}）</option>
          </select>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* 检索提供方下拉（对齐设置页输入控件风格） */
.rag-prov-select {
  max-width: 260px;
  padding: 6px 10px;
  font-size: var(--font-size-s);
  color: var(--text-normal);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}

.rag-prov-select:hover {
  border-color: var(--interactive-accent);
}

.rag-prov-select:focus {
  outline: none;
  border-color: var(--interactive-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}
</style>
