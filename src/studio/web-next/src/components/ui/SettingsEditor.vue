<script setup lang="ts">
// 设置 · 编辑器 tab：编辑器字体、排版（字号/行距/段距）、纸张（宽度/自动保存）。
import { computed } from 'vue'
import { usePrefsStore } from '../../stores/prefs'
import { useSystemFonts, selValue } from '../../composables/useSystemFonts'

const prefs = usePrefsStore()
const { chineseFonts, englishFonts, fontDisplayName } = useSystemFonts()
const hasDesktop = computed(() => typeof window !== 'undefined' && !!window.clwritingDesktop)

// ── 书级覆盖（纸张宽度/自动保存 可选"仅本书"）──
const pageWidthBookOnly = computed(() => prefs.bookPageWidth !== null)
const autosaveBookOnly = computed(() => prefs.bookAutosaveInterval !== null)
function onPageWidthInput(v: number): void {
  prefs.setPageWidth(v, pageWidthBookOnly.value)
}
function onAutosaveInput(v: number): void {
  prefs.setAutosaveInterval(v, autosaveBookOnly.value)
}
function togglePageWidthScope(): void {
  prefs.setPageWidth(prefs.effectivePageWidth, !pageWidthBookOnly.value)
}
function toggleAutosaveScope(): void {
  prefs.setAutosaveInterval(prefs.effectiveAutosaveInterval, !autosaveBookOnly.value)
}

/** range 配套数字输入：clamp 到范围后调 setter */
function numInput(min: number, max: number, setter: (v: number) => void, e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  if (!Number.isFinite(v)) return
  setter(Math.min(max, Math.max(min, v)))
}
</script>

<template>
  <!-- 单根包裹：见 SettingsBook.vue 说明 -->
  <div class="settings-tab">
  <div class="cfg-card-head">字体</div>
  <section v-if="hasDesktop" class="cfg-card">
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">编辑器字体</div>
        <div class="setting-item-desc">正文编辑区文字</div>
      </div>
      <div class="setting-item-control">
        <div class="font-pair">
          <select class="font-select" :value="prefs.proseFontCn" :style="{ fontFamily: prefs.proseFontCn || 'inherit' }" @change="prefs.setProseFontCn(selValue($event))">
            <option value="">中文 · 默认</option>
            <option v-for="f in chineseFonts" :key="'pcn-' + f" :value="f" :style="{ fontFamily: f }">{{ fontDisplayName(f) }}</option>
          </select>
          <select class="font-select" :value="prefs.proseFontEn" :style="{ fontFamily: prefs.proseFontEn || 'inherit' }" @change="prefs.setProseFontEn(selValue($event))">
            <option value="">英文 · 默认</option>
            <option v-for="f in englishFonts" :key="'pen-' + f" :value="f" :style="{ fontFamily: f }">{{ fontDisplayName(f) }}</option>
          </select>
        </div>
      </div>
    </div>
  </section>

  <div class="cfg-card-head">排版</div>
  <section class="cfg-card">
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">正文字号</div>
        <div class="setting-item-desc">编辑区字体大小</div>
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
        <div class="setting-item-desc">行间距倍数</div>
      </div>
      <div class="setting-item-control">
        <input type="range" min="1.4" max="2.4" step="0.05" :value="prefs.proseLh" @input="prefs.setLh(Number(($event.target as HTMLInputElement).value))" />
        <input class="val-input" type="number" min="1.4" max="2.4" step="0.05" :value="prefs.proseLh" @change="numInput(1.4, 2.4, prefs.setLh, $event)" />
        <span class="val-suffix">×</span>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">段距</div>
        <div class="setting-item-desc">段落间距</div>
      </div>
      <div class="setting-item-control">
        <input type="range" min="0.5" max="2.5" step="0.1" :value="prefs.proseGap" @input="prefs.setGap(Number(($event.target as HTMLInputElement).value))" />
        <input class="val-input" type="number" min="0.5" max="2.5" step="0.1" :value="prefs.proseGap" @change="numInput(0.5, 2.5, prefs.setGap, $event)" />
        <span class="val-suffix">em</span>
      </div>
    </div>
  </section>

  <div class="cfg-card-head">纸张</div>
  <section class="cfg-card">
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">纸张宽度</div>
        <div class="setting-item-desc">
          写作区纸张的最大宽度
          <button class="scope-btn" :class="{ on: pageWidthBookOnly }" @click="togglePageWidthScope">仅本书</button>
        </div>
      </div>
      <div class="setting-item-control">
        <input type="range" min="600" max="1400" step="20" :value="prefs.effectivePageWidth" @input="onPageWidthInput(Number(($event.target as HTMLInputElement).value))" />
        <input class="val-input" type="number" min="600" max="1400" step="20" :value="prefs.effectivePageWidth" @change="numInput(600, 1400, onPageWidthInput, $event)" />
        <span class="val-suffix">px</span>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">自动保存</div>
        <div class="setting-item-desc">
          编辑后自动保存的间隔
          <button class="scope-btn" :class="{ on: autosaveBookOnly }" @click="toggleAutosaveScope">仅本书</button>
        </div>
      </div>
      <div class="setting-item-control">
        <input type="range" min="5" max="120" step="5" :value="prefs.effectiveAutosaveInterval" @input="onAutosaveInput(Number(($event.target as HTMLInputElement).value))" />
        <input class="val-input" type="number" min="5" max="120" step="5" :value="prefs.effectiveAutosaveInterval" @change="numInput(5, 120, onAutosaveInput, $event)" />
        <span class="val-suffix">s</span>
      </div>
    </div>
  </section>
  </div>
</template>
