<script setup lang="ts">
// 设置弹窗（细案 T2.4 + T4.2）：主题（亮/暗）+ 正文排版滑块 + 桌面动作。
// 沿用旧偏好键 clw-*（prefs store 持久化 + apply :root）。
// 桌面动作（打开书库目录）仅桌面版显示——window.clwritingDesktop 判空降级。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { X } from 'lucide-vue-next'
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

// 系统字体列表（桌面版 IPC 加载；浏览器版空 → 字体下拉仅"默认"项）
const systemFonts = ref<string[]>([])
onMounted(async () => {
  if (!window.clwritingDesktop) return
  try {
    systemFonts.value = await window.clwritingDesktop.getSystemFonts()
  } catch (e) {
    console.error('加载系统字体失败：', e)
  }
})
// 字体按语言筛选 + 中文显示名：font-list 只返回英文 Family 名，本地内置常见中文字体映射。
// CN_KW 锁中文特定关键字（SC/TC/HK/GB/Hans + 中文族名），排除日韩（Gothic/Mincho/Nanum/Toppan 等）。
const CJK_RE = /[一-鿿㐀-䶿぀-ヿ가-힯]/
const CN_KW =
  /\b(SC|TC|HK|GB|Hans|Hant|Hei|Kai|Heiti|Songti|Kaiti|Yuanti|Libian|Xingkai|Weibei|Baoli|Wawati|Yuppy|Hannotate|HanziPen|Lantinghei|LingWai|FangSong|STHeiti|STSong|STKaiti|STFangsong|STXihei|STXingkai|STXinwei|STHupo|STCaiyun|STZhongsong|Hiragino Sans GB|Source Han Sans|Source Han Serif|Noto Sans SC|Noto Serif SC|Noto Sans CJK|Noto Serif CJK|LXGW WenKai)\b/i
// 英文 Family 名 → 中文显示名（font-list 不提供本地化名，故内置；缺失则显英文原名）
const FONT_CN_LABEL: Record<string, string> = {
  'PingFang SC': '苹方', 'PingFang TC': '苹方', 'PingFang HK': '苹方',
  'Heiti SC': '黑体', 'Heiti TC': '黑体', Hei: '黑体',
  'Songti SC': '宋体', 'Songti TC': '宋体',
  'Kaiti SC': '楷体', 'Kaiti TC': '楷体', Kai: '楷体',
  'Yuanti SC': '圆体', 'Yuanti TC': '圆体',
  'Xingkai SC': '行楷', 'Xingkai TC': '行楷',
  'Weibei SC': '魏碑', 'Weibei TC': '魏碑',
  'Libian SC': '隶变', 'Libian TC': '隶变',
  'Baoli SC': '报隶', 'Baoli TC': '报隶',
  'Yuppy SC': '雅痞', 'Yuppy TC': '雅痞',
  'Wawati SC': '娃娃体', 'Wawati TC': '娃娃体',
  'Hannotate SC': '手札体', 'Hannotate TC': '手札体',
  'HanziPen SC': '汉字笔', 'HanziPen TC': '汉字笔',
  'Lantinghei SC': '兰亭黑', 'Lantinghei TC': '兰亭黑',
  'LingWai SC': '翎外', 'LingWai TC': '翎外',
  'Hiragino Sans GB': '冬青黑体',
  STHeiti: '华文黑体', STSong: '华文宋体', STKaiti: '华文楷体',
  STFangsong: '华文仿宋', STXihei: '华文细黑', STXingkai: '华文行楷',
  STXinwei: '华文新魏', STHupo: '华文琥珀', STCaiyun: '华文彩云',
  STZhongsong: '华文中宋',
  'Source Han Sans SC': '思源黑体', 'Source Han Serif SC': '思源宋体',
  'Noto Sans SC': '思源黑体', 'Noto Serif SC': '思源宋体',
  'Noto Sans CJK SC': '思源黑体', 'Noto Serif CJK SC': '思源宋体',
  'LXGW WenKai': '霞鹜文楷',
}
function isChineseFont(name: string): boolean {
  return CJK_RE.test(name) || CN_KW.test(name) || name in FONT_CN_LABEL
}
function fontDisplayName(name: string): string {
  return FONT_CN_LABEL[name] ?? name
}
const chineseFonts = computed(() => systemFonts.value.filter(isChineseFont))
const englishFonts = computed(() => systemFonts.value.filter((f) => !isChineseFont(f)))
function selValue(e: Event): string {
  return (e.target as HTMLSelectElement).value
}

async function openBookDir(): Promise<void> {
  if (!ws.bookName) return
  await window.clwritingDesktop?.openBookDir(ws.bookName)
}

// Esc 关闭（mask 点击已支持；键盘可达性补全）
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && ui.settingsOpen) ui.closeSettings()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="ui.settingsOpen" class="modal-mask" @click.self="ui.closeSettings">
      <div class="settings-modal">
        <div class="modal-head">
          <span>设置</span>
          <button class="close-btn" title="关闭（Esc）" @click="ui.closeSettings"><X :size="18" /></button>
        </div>
        <div class="setting-row">
          <label>主题</label>
          <div class="seg">
            <button :class="{ on: theme === 'light' }" @click="setTheme('light', $event)">亮</button>
            <button :class="{ on: theme === 'dark' }" @click="setTheme('dark', $event)">暗</button>
          </div>
        </div>
        <div v-if="hasDesktop" class="setting-row">
          <label>界面字体</label>
          <div class="font-pair">
            <select
              class="font-select"
              :value="prefs.uiFontCn"
              @change="prefs.setUiFontCn(selValue($event))"
            >
              <option value="">中文 · 默认</option>
              <option v-for="f in chineseFonts" :key="'cn-' + f" :value="f" :style="{ fontFamily: f }">{{ fontDisplayName(f) }}</option>
            </select>
            <select
              class="font-select"
              :value="prefs.uiFontEn"
              @change="prefs.setUiFontEn(selValue($event))"
            >
              <option value="">英文 · 默认</option>
              <option v-for="f in englishFonts" :key="'en-' + f" :value="f" :style="{ fontFamily: f }">{{ fontDisplayName(f) }}</option>
            </select>
          </div>
        </div>
        <div v-if="hasDesktop" class="setting-row">
          <label>编辑器字体</label>
          <div class="font-pair">
            <select
              class="font-select"
              :value="prefs.proseFontCn"
              @change="prefs.setProseFontCn(selValue($event))"
            >
              <option value="">中文 · 默认</option>
              <option v-for="f in chineseFonts" :key="'pcn-' + f" :value="f" :style="{ fontFamily: f }">{{ fontDisplayName(f) }}</option>
            </select>
            <select
              class="font-select"
              :value="prefs.proseFontEn"
              @change="prefs.setProseFontEn(selValue($event))"
            >
              <option value="">英文 · 默认</option>
              <option v-for="f in englishFonts" :key="'pen-' + f" :value="f" :style="{ fontFamily: f }">{{ fontDisplayName(f) }}</option>
            </select>
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
  animation: clw-overlay var(--dur-norm) var(--ease-out);
}
.settings-modal {
  width: 400px;
  max-width: 92vw;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-l);
  padding: var(--size-4-4);
  animation: clw-appear var(--dur-norm) var(--ease-out);
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
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-faint);
  border-radius: var(--radius-s);
  cursor: pointer;
}
.close-btn:hover {
  color: var(--text-normal);
  background: var(--background-modifier-hover);
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
  accent-color: var(--interactive-accent);
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
.font-pair {
  display: flex;
  gap: var(--size-4-2);
}
.font-select {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  font-size: var(--font-size-s);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
}
.font-select:focus {
  border-color: var(--interactive-accent);
  outline: none;
}
</style>
