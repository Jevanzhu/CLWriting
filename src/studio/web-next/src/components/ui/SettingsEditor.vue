<script setup lang="ts">
// 设置 · 编辑器 tab：编辑器字体、排版（字号/行距）、纸张（宽度/自动保存）。
import { computed } from 'vue'
import { usePrefsStore } from '../../stores/prefs'
import { parseNumericInput } from '../../shared/numeric-input'
import { useSystemFonts } from '../../composables/useSystemFonts'
import FontPicker from './FontPicker.vue'

const prefs = usePrefsStore()
const { chineseFonts, englishFonts, fontDisplayName } = useSystemFonts()
const hasDesktop = computed(() => typeof window !== 'undefined' && !!window.clwritingDesktop)

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
  <section v-if="hasDesktop" class="cfg-card">
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">编辑器字体</div>
        <div class="setting-item-desc">正文编辑区文字</div>
      </div>
      <div class="setting-item-control">
        <div class="font-pair">
          <FontPicker class="font-select" :value="prefs.proseFontCn" :fonts="chineseFonts" placeholder="中文 · 默认" :display="fontDisplayName" @change="prefs.setProseFontCn($event)" />
          <FontPicker class="font-select" :value="prefs.proseFontEn" :fonts="englishFonts" placeholder="英文 · 默认" :display="fontDisplayName" @change="prefs.setProseFontEn($event)" />
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
