<script setup lang="ts">
// 设置 · 外观 tab：主题、界面字体、紧凑模式、书架视图。
import { computed } from 'vue'
import { usePrefsStore } from '../../stores/prefs'
import { useTheme } from '../../composables/useTheme'
import { useSystemFonts } from '../../composables/useSystemFonts'
import FontPicker from './FontPicker.vue'
import SettingItem from './SettingItem.vue'
import SettingToggle from './SettingToggle.vue'

const prefs = usePrefsStore()
const { theme, setTheme } = useTheme()
const { chineseFonts, englishFonts, fontDisplayName, defaultUiFontCn, defaultUiFontEn } = useSystemFonts()
const hasDesktop = computed(() => typeof window !== 'undefined' && !!window.clwritingDesktop)
</script>

<template>
  <section class="cfg-card">
    <SettingItem name="主题" desc="亮色或暗色外观">
      <div class="seg">
        <button :class="{ on: theme === 'light' }" @click="setTheme('light', $event)">亮色</button>
        <button :class="{ on: theme === 'dark' }" @click="setTheme('dark', $event)">暗色</button>
      </div>
    </SettingItem>
    <SettingItem name="字号" desc="界面文字整体大小（两平台通用）">
      <div class="seg">
        <button :class="{ on: prefs.get('uiFontSizeStep') === -1 }" @click="prefs.set('uiFontSizeStep', -1)">小</button>
        <button :class="{ on: prefs.get('uiFontSizeStep') === 0 }" @click="prefs.set('uiFontSizeStep', 0)">标准</button>
        <button :class="{ on: prefs.get('uiFontSizeStep') === 1 }" @click="prefs.set('uiFontSizeStep', 1)">大</button>
        <button :class="{ on: prefs.get('uiFontSizeStep') === 2 }" @click="prefs.set('uiFontSizeStep', 2)">特大</button>
      </div>
    </SettingItem>
    <SettingItem v-if="hasDesktop" name="界面字体" desc="侧栏与菜单等 UI 文字">
      <div class="font-pair">
        <!-- -：字体下拉补可访问名称（win 自绘按钮/原生 select 均无内在名） -->
        <FontPicker
          class="font-select"
          ariaLabel="界面中文字体"
          :value="prefs.get('uiFontCn')"
          :fonts="chineseFonts"
          :default-font="defaultUiFontCn"
          placeholder="中文 · 默认"
          :display="fontDisplayName"
          @change="prefs.set('uiFontCn', $event)"
        />
        <FontPicker
          class="font-select"
          ariaLabel="界面英文字体"
          :value="prefs.get('uiFontEn')"
          :fonts="englishFonts"
          :default-font="defaultUiFontEn"
          placeholder="英文 · 默认"
          :display="fontDisplayName"
          @change="prefs.set('uiFontEn', $event)"
        />
      </div>
    </SettingItem>
    <SettingToggle
      name="紧凑模式"
      desc="收窄侧栏间距，列表显示更多内容"
      ariaLabel="紧凑模式"
      :checked="prefs.get('compact')"
      @change="prefs.set('compact', $event)"
    />
    <SettingItem name="书架视图" desc="书架的显示方式">
      <div class="seg">
        <button :class="{ on: prefs.get('shelfView') === 'grid' }" @click="prefs.set('shelfView', 'grid')">网格</button>
        <button :class="{ on: prefs.get('shelfView') === 'list' }" @click="prefs.set('shelfView', 'list')">列表</button>
      </div>
    </SettingItem>
  </section>
</template>
