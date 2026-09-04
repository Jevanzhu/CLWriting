<script setup lang="ts">
// 设置 · 外观 tab：主题、界面字体、紧凑模式、书架视图。
import { computed } from 'vue'
import { usePrefsStore } from '../../stores/prefs'
import { useTheme } from '../../composables/useTheme'
import { useSystemFonts } from '../../composables/useSystemFonts'
import FontPicker from './FontPicker.vue'

const prefs = usePrefsStore()
const { theme, setTheme } = useTheme()
const { chineseFonts, englishFonts, fontDisplayName, defaultUiFontCn, defaultUiFontEn } = useSystemFonts()
const hasDesktop = computed(() => typeof window !== 'undefined' && !!window.clwritingDesktop)
</script>

<template>
  <section class="cfg-card">
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">主题</div>
        <div class="setting-item-desc">亮色或暗色外观</div>
      </div>
      <div class="setting-item-control">
        <div class="seg">
          <button :class="{ on: theme === 'light' }" @click="setTheme('light', $event)">亮色</button>
          <button :class="{ on: theme === 'dark' }" @click="setTheme('dark', $event)">暗色</button>
        </div>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">字号</div>
        <div class="setting-item-desc">界面文字整体大小（两平台通用）</div>
      </div>
      <div class="setting-item-control">
        <div class="seg">
          <button :class="{ on: prefs.uiFontSizeStep === -1 }" @click="prefs.setUiFontSizeStep(-1)">小</button>
          <button :class="{ on: prefs.uiFontSizeStep === 0 }" @click="prefs.setUiFontSizeStep(0)">标准</button>
          <button :class="{ on: prefs.uiFontSizeStep === 1 }" @click="prefs.setUiFontSizeStep(1)">大</button>
          <button :class="{ on: prefs.uiFontSizeStep === 2 }" @click="prefs.setUiFontSizeStep(2)">特大</button>
        </div>
      </div>
    </div>
    <div v-if="hasDesktop" class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">界面字体</div>
        <div class="setting-item-desc">侧栏与菜单等 UI 文字</div>
      </div>
      <div class="setting-item-control">
        <div class="font-pair">
          <FontPicker class="font-select" :value="prefs.uiFontCn" :fonts="chineseFonts" :default-font="defaultUiFontCn" placeholder="中文 · 默认" :display="fontDisplayName" @change="prefs.setUiFontCn($event)" />
          <FontPicker class="font-select" :value="prefs.uiFontEn" :fonts="englishFonts" :default-font="defaultUiFontEn" placeholder="英文 · 默认" :display="fontDisplayName" @change="prefs.setUiFontEn($event)" />
        </div>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">紧凑模式</div>
        <div class="setting-item-desc">收窄侧栏间距，列表显示更多内容</div>
      </div>
      <div class="setting-item-control">
        <label class="switch">
          <input type="checkbox" aria-label="紧凑模式" :checked="prefs.compact" @change="prefs.setCompact(($event.target as HTMLInputElement).checked)" />
          <span class="switch-slider"></span>
        </label>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">书架视图</div>
        <div class="setting-item-desc">书架的显示方式</div>
      </div>
      <div class="setting-item-control">
        <div class="seg">
          <button :class="{ on: prefs.shelfView === 'grid' }" @click="prefs.setShelfView('grid')">网格</button>
          <button :class="{ on: prefs.shelfView === 'list' }" @click="prefs.setShelfView('list')">列表</button>
        </div>
      </div>
    </div>
  </section>
</template>
