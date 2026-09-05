<script setup lang="ts">
// 设置 · 编辑器 tab：正文字体/字号/行距为全局正文排版——编辑区、开书对话、草稿卡等
// 所有正文编辑框同步（2026-09-05 作者确认全局一致）；纸张（宽度/自动保存）。
import { computed } from 'vue'
import { usePrefsStore } from '../../stores/prefs'
import { parseNumericInput } from '../../shared/numeric-input'
import { useSystemFonts } from '../../composables/useSystemFonts'
import { PROSE_PRESETS, matchProsePreset, type ProsePreset } from '../../shared/prose-presets'
import FontPicker from './FontPicker.vue'

const prefs = usePrefsStore()
const { chineseFonts, englishFonts, fontDisplayName, defaultProseFontCn, defaultProseFontEn } = useSystemFonts()
const hasDesktop = computed(() => typeof window !== 'undefined' && !!window.clwritingDesktop)

// 正文排版预设（F 线 2026-09-05）：激活态由四字段派生，手动改任一项即落「自定义」；
// 应用 = 逐项走既有 setter（apply()/持久化链路复用，无新持久化键）
const activePresetId = computed(() =>
  matchProsePreset({ proseFontCn: prefs.proseFontCn, proseFontEn: prefs.proseFontEn, proseSize: prefs.proseSize, proseLh: prefs.proseLh }),
)
function applyPreset(p: ProsePreset): void {
  prefs.setProseFontCn(p.values.proseFontCn)
  prefs.setProseFontEn(p.values.proseFontEn)
  prefs.setSize(p.values.proseSize)
  prefs.setLh(p.values.proseLh)
}

// 全局默认：纸张宽度 / 自动保存（书级覆盖现由「本书」页管理，全局页只设跨书共享默认）
function onPageWidthInput(v: number): void {
  prefs.setPageWidth(v)
}
function onAutosaveInput(v: number): void {
  prefs.setAutosaveInterval(v)
}

/**
 * range 配套数字输入：clamp 到范围后调 setter。
 * R72-11（二十轮 E-2）：空串/非数字走共享 helper 挡掉（原 Number('')=0 过闸被钳成 min）
 */
function numInput(min: number, max: number, setter: (v: number) => void, e: Event): void {
  const v = parseNumericInput(e)
  if (v === null) return
  setter(Math.min(max, Math.max(min, v)))
}
</script>

<template>
  <!-- 单根包裹：见 SettingsBook.vue 说明 -->
  <div class="settings-tab">
  <div class="cfg-card-head">字体</div>
  <section class="cfg-card">
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">排版预设</div>
        <div class="setting-item-desc">成组方案一键切换；手动调整任一项后变为自定义</div>
      </div>
      <div class="setting-item-control">
        <div class="preset-row" role="group" aria-label="正文排版预设">
          <button
            v-for="p in PROSE_PRESETS"
            :key="p.id"
            type="button"
            class="preset-chip"
            :class="{ active: activePresetId === p.id }"
            :title="p.desc"
            @click="applyPreset(p)"
          >
            {{ p.label }}
          </button>
          <span v-if="activePresetId === 'custom'" class="preset-chip custom">自定义</span>
        </div>
      </div>
    </div>
    <div v-if="hasDesktop" class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">正文字体</div>
        <div class="setting-item-desc">编辑区、开书对话、草稿卡等所有正文编辑框</div>
      </div>
      <div class="setting-item-control">
        <div class="font-pair">
          <FontPicker class="font-select" :value="prefs.proseFontCn" :fonts="chineseFonts" :default-font="defaultProseFontCn" placeholder="中文 · 默认" :display="fontDisplayName" @change="prefs.setProseFontCn($event)" />
          <FontPicker class="font-select" :value="prefs.proseFontEn" :fonts="englishFonts" :default-font="defaultProseFontEn" placeholder="英文 · 默认" :display="fontDisplayName" @change="prefs.setProseFontEn($event)" />
        </div>
      </div>
    </div>
  </section>

  <div class="cfg-card-head">排版</div>
  <section class="cfg-card">
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">正文字号</div>
        <div class="setting-item-desc">所有正文编辑框文字大小</div>
      </div>
      <div class="setting-item-control">
        <input type="range" min="13" max="24" :value="prefs.proseSize" @input="prefs.setSize(Number(($event.target as HTMLInputElement).value))" />
        <input class="val-input" type="number" min="13" max="24" :value="prefs.proseSize" @change="numInput(13, 24, prefs.setSize, $event)" />
        <span class="val-suffix">px</span>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">行距</div>
        <div class="setting-item-desc">所有正文编辑框行间距倍数</div>
      </div>
      <div class="setting-item-control">
        <input type="range" min="1.4" max="2.4" step="0.05" :value="prefs.proseLh" @input="prefs.setLh(Number(($event.target as HTMLInputElement).value))" />
        <input class="val-input" type="number" min="1.4" max="2.4" step="0.05" :value="prefs.proseLh" @change="numInput(1.4, 2.4, prefs.setLh, $event)" />
        <span class="val-suffix">×</span>
      </div>
    </div>
  </section>

  <div class="cfg-card-head">纸张</div>
  <section class="cfg-card">
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">纸张宽度</div>
        <div class="setting-item-desc">
          写作区纸张的最大宽度（全局默认；某本书要单独设 —— 去「本书」页）
        </div>
      </div>
      <div class="setting-item-control">
        <input type="range" min="600" max="1400" step="20" :value="prefs.pageWidth" @input="onPageWidthInput(Number(($event.target as HTMLInputElement).value))" />
        <input class="val-input" type="number" min="600" max="1400" step="20" :value="prefs.pageWidth" @change="numInput(600, 1400, onPageWidthInput, $event)" />
        <span class="val-suffix">px</span>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">自动保存</div>
        <div class="setting-item-desc">
          编辑后自动保存的间隔（全局默认；某本书要单独设 —— 去「本书」页）
        </div>
      </div>
      <div class="setting-item-control">
        <input type="range" min="5" max="120" step="5" :value="prefs.autosaveInterval" @input="onAutosaveInput(Number(($event.target as HTMLInputElement).value))" />
        <input class="val-input" type="number" min="5" max="120" step="5" :value="prefs.autosaveInterval" @change="numInput(5, 120, onAutosaveInput, $event)" />
        <span class="val-suffix">s</span>
      </div>
    </div>
  </section>
  </div>
</template>

<style scoped>
/* 排版预设 chips（F 线 2026-09-05）：胶囊排布，激活态 accent 描边浅底；
 * 标签用 --text-normal（win 反糊口径：小字号不挂 muted 灰） */
.preset-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}
.preset-chip {
  padding: 3px 10px;
  border: 1px solid var(--background-modifier-border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-normal);
  font-size: var(--font-size-s);
  line-height: 1.6;
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.preset-chip:hover {
  border-color: var(--interactive-accent);
}
.preset-chip.active {
  border-color: var(--interactive-accent);
  background: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
}
.preset-chip.custom {
  cursor: default;
  color: var(--text-faint);
  border-style: dashed;
}
</style>
