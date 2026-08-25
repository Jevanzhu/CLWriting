<script setup lang="ts">
// 专注模式右侧竖状浮动排版条：字号/行距/纸宽滑杆 + 中英文字体下拉（常驻半透明，
// hover 加深，对齐 ws-focus-exit 风格）。控件直连 prefs store 既有 setter——调整
// 即时 apply CSS 变量（所见即所得）+ 防抖落 global.json/prefs.json，与设置面板
// 「编辑器」tab 同构同范围；纸宽保持当前 scope（书级覆盖存在时只写本书，label
// 带「本书」标记；切换 scope 仍走设置面板）。非弹层：不进 useHotkeys 的 Esc
// 让渡名单，Esc 保持「退出专注」单一语义。
import { computed } from 'vue'
import { usePrefsStore } from '../../stores/prefs'
import { useSystemFonts, selValue } from '../../composables/useSystemFonts'

const prefs = usePrefsStore()
const { chineseFonts, englishFonts, fontDisplayName } = useSystemFonts()
const hasDesktop = computed(() => typeof window !== 'undefined' && !!window.clwritingDesktop)

/** 纸宽写入保持当前 scope：书级覆盖存在时继续写书级（SettingsEditor 同语义） */
const widthBookOnly = computed(() => prefs.bookPageWidth !== null)
function onPageWidthInput(v: number): void {
  prefs.setPageWidth(v, widthBookOnly.value)
}
</script>

<template>
  <aside class="focus-format-bar" aria-label="排版设置">
    <label class="ffb-item">
      <span class="ffb-label">字号<i class="ffb-val">{{ prefs.proseSize }}px</i></span>
      <input class="ffb-range" type="range" min="13" max="24" :value="prefs.proseSize"
        @input="prefs.setSize(Number(($event.target as HTMLInputElement).value))" />
    </label>
    <label class="ffb-item">
      <span class="ffb-label">行距<i class="ffb-val">{{ prefs.proseLh }}×</i></span>
      <input class="ffb-range" type="range" min="1.4" max="2.4" step="0.05" :value="prefs.proseLh"
        @input="prefs.setLh(Number(($event.target as HTMLInputElement).value))" />
    </label>
    <label class="ffb-item">
      <span class="ffb-label">纸宽<template v-if="widthBookOnly">·本书</template><i class="ffb-val">{{ prefs.effectivePageWidth }}px</i></span>
      <input class="ffb-range" type="range" min="600" max="1400" step="20" :value="prefs.effectivePageWidth"
        @input="onPageWidthInput(Number(($event.target as HTMLInputElement).value))" />
    </label>
    <!-- 字体区：依赖桌面桥取系统字体列表，浏览器/dev 无桥时整区隐藏 -->
    <template v-if="hasDesktop">
      <div class="ffb-sep" />
      <select class="ffb-select" :value="prefs.proseFontCn" :style="{ fontFamily: prefs.proseFontCn || 'inherit' }"
        @change="prefs.setProseFontCn(selValue($event))">
        <option value="">中文 · 默认</option>
        <option v-for="f in chineseFonts" :key="'cn-' + f" :value="f" :style="{ fontFamily: f }">{{ fontDisplayName(f) }}</option>
      </select>
      <select class="ffb-select" :value="prefs.proseFontEn" :style="{ fontFamily: prefs.proseFontEn || 'inherit' }"
        @change="prefs.setProseFontEn(selValue($event))">
        <option value="">英文 · 默认</option>
        <option v-for="f in englishFonts" :key="'en-' + f" :value="f" :style="{ fontFamily: f }">{{ fontDisplayName(f) }}</option>
      </select>
    </template>
  </aside>
</template>

<style scoped>
/* 常驻半透明竖条：不占布局流（absolute 挂 ws-main），hover 加深为实体可操作 */
.focus-format-bar {
  position: absolute;
  right: var(--size-4-4, 16px);
  top: 50%;
  transform: translateY(-50%);
  z-index: 5;
  width: 150px;
  max-height: calc(100vh - 120px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m, 8px);
  background: var(--background-secondary);
  box-shadow: var(--shadow-s), var(--shadow-l);
  opacity: 0.35;
  transition: opacity var(--dur-norm) var(--ease-out);
}
.focus-format-bar:hover {
  opacity: 1;
}
.ffb-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.ffb-label {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: var(--font-size-xs, 12px);
  font-weight: 500;
  color: var(--text-muted);
  white-space: nowrap;
}
.ffb-val {
  font-style: normal;
  font-variant-numeric: tabular-nums;
  color: var(--text-normal);
}
/* 滑杆与 select 样式自持（规格同 settings-shared.css；不依赖设置组件注入顺序） */
.ffb-range {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 6px;
  border-radius: 3px;
  background: var(--background-modifier-border);
  cursor: pointer;
  outline: none;
}
.ffb-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--interactive-accent);
  border: 2px solid var(--background-primary);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  cursor: grab;
}
.ffb-range:active::-webkit-slider-thumb {
  cursor: grabbing;
}
.ffb-range::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--interactive-accent);
  border: 2px solid var(--background-primary);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  cursor: grab;
}
.ffb-sep {
  height: 1px;
  background: var(--background-modifier-border);
}
.ffb-select {
  max-width: 100%;
  padding: 5px 8px;
  font-size: var(--font-size-xs, 12px);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s, 4px);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
}
.ffb-select:focus {
  outline: none;
  border-color: var(--interactive-accent);
}
</style>
