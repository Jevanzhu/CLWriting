<script setup lang="ts">
// 设置弹窗（细案 T2.4 + T4.2）：主题（亮/暗）+ 正文排版滑块 + 桌面动作。
// 沿用旧偏好键 clw-*（prefs store 持久化 + apply :root）。
// 桌面动作（打开书库目录）仅桌面版显示——window.clwritingDesktop 判空降级。
import { computed } from 'vue'
import { useUiStore } from '../../stores/ui'
import { usePrefsStore } from '../../stores/prefs'
import { useTheme } from '../../composables/useTheme'
import { useWorkspaceStore } from '../../stores/workspace'

const ui = useUiStore()
const prefs = usePrefsStore()
const { theme, setTheme } = useTheme()
const ws = useWorkspaceStore()

// 桌面版注入 window.clwritingDesktop；浏览器版无 → 隐藏桌面动作区
const hasDesktop = computed(() => typeof window !== 'undefined' && !!window.clwritingDesktop)

async function openBookDir(): Promise<void> {
  if (!ws.bookName) return
  await window.clwritingDesktop?.openBookDir(ws.bookName)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="ui.settingsOpen" class="modal-mask" @click.self="ui.closeSettings">
      <div class="settings-modal">
        <div class="modal-head">
          <span>设置</span>
          <button class="close-btn" @click="ui.closeSettings">×</button>
        </div>
        <div class="setting-row">
          <label>主题</label>
          <div class="seg">
            <button :class="{ on: theme === 'light' }" @click="setTheme('light')">亮</button>
            <button :class="{ on: theme === 'dark' }" @click="setTheme('dark')">暗</button>
          </div>
        </div>
        <div class="setting-row">
          <label>正文字号 <span class="val">{{ prefs.proseSize }}px</span></label>
          <input
            type="range"
            min="13"
            max="24"
            :value="prefs.proseSize"
            @input="prefs.setSize(Number(($event.target as HTMLInputElement).value))"
          />
        </div>
        <div class="setting-row">
          <label>行距 <span class="val">{{ prefs.proseLh }}</span></label>
          <input
            type="range"
            min="1.4"
            max="2.4"
            step="0.05"
            :value="prefs.proseLh"
            @input="prefs.setLh(Number(($event.target as HTMLInputElement).value))"
          />
        </div>
        <div class="setting-row">
          <label>段距 <span class="val">{{ prefs.proseGap }}em</span></label>
          <input
            type="range"
            min="0.5"
            max="2.5"
            step="0.1"
            :value="prefs.proseGap"
            @input="prefs.setGap(Number(($event.target as HTMLInputElement).value))"
          />
        </div>
        <div v-if="hasDesktop" class="setting-row">
          <label>书库</label>
          <button class="link-btn" @click="openBookDir">在文件管理器中打开书库目录</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 150;
  display: flex;
  align-items: center;
  justify-content: center;
}
.settings-modal {
  width: 400px;
  max-width: 92vw;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
  padding: var(--size-4-4);
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-normal);
  margin-bottom: var(--size-4-4);
}
.close-btn {
  border: none;
  background: transparent;
  font-size: 20px;
  color: var(--text-faint);
  cursor: pointer;
}
.close-btn:hover {
  color: var(--text-normal);
}
.setting-row {
  margin-bottom: var(--size-4-4);
}
.setting-row label {
  display: block;
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: var(--size-4-2);
}
.val {
  color: var(--text-normal);
  font-variant-numeric: tabular-nums;
}
.setting-row input[type='range'] {
  width: 100%;
}
.seg {
  display: inline-flex;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  overflow: hidden;
}
.seg button {
  padding: 5px 14px;
  font-size: 12px;
  border: none;
  background: var(--background-primary);
  color: var(--text-muted);
  cursor: pointer;
}
.seg button.on {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
}
.link-btn {
  padding: 5px 12px;
  font-size: 12px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
}
.link-btn:hover {
  background: var(--background-modifier-hover);
}
</style>
