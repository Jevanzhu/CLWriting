<script setup lang="ts">
// 设置弹层（mockup .modal-mask/.modal/.mb-section/.swatch-row/.kv）。
// 主题（标准/暖纸/柔光）+ 字体双维度切换均持久化；排版 size/lh/gap 实时改 :root CSS var。
import { ref, onMounted } from 'vue'
import { useHint } from '../composables/useHint'
import { useTheme } from '../composables/useTheme'
import { useFont } from '../composables/useFont'
import { useTypography } from '../composables/useTypography'
import type { ThemeId } from '../types/theme'

const show = defineModel<boolean>('show', { default: false })
const { hint } = useHint()
const { theme, themes, setTheme } = useTheme()
const { appFontId, editorFontId, appFonts, editorFonts, setAppFont, setEditorFont } = useFont()
const { proseSize, proseLh, proseGap, setSize, setLh, setGap } = useTypography()

/** 选主题：持久化 + 应用 + 反馈（useTheme 切 [data-theme] 全套色 token） */
function selectTheme(id: ThemeId, name: string): void {
  setTheme(id)
  hint('主题 · ' + name)
}

const currentLib = ref('当前书库')

onMounted(async () => {
  try {
    const p = await window.clwritingDesktop?.getCurrentLibrary()
    if (p) currentLib.value = p
  } catch {
    /* 浏览器版无 desktop IPC */
  }
})

/** 选界面字体 / 编辑器字体：useFont 持久化 + 应用 + 即时反馈 */
function selectAppFont(id: string, label: string): void {
  setAppFont(id)
  hint('界面字体 · ' + label)
}
function selectEditorFont(id: string, label: string): void {
  setEditorFont(id)
  hint('编辑器字体 · ' + label)
}
</script>

<template>
  <div class="modal-mask" :class="{ show }" @click.self="show = false">
    <div class="modal">
      <div class="modal-head">
        <h2>设置</h2>
        <div class="modal-close" @click="show = false">✕</div>
      </div>
      <div class="modal-body">
        <div class="mb-section">
          <h3>主题</h3>
          <label v-for="t in themes" :key="t.id" class="swatch-row" @click="selectTheme(t.id, t.name)">
            <input type="radio" name="clw-theme" :checked="theme === t.id" />
            <div class="nm"><span class="swatch-dot" :style="{ background: t.accent }"></span>{{ t.name }}<span class="swatch-desc">{{ t.desc }}</span></div>
          </label>
        </div>

        <div class="mb-section">
          <h3>界面字体<span class="swatch-desc">影响菜单/按钮等 UI 文字</span></h3>
          <label v-for="f in appFonts" :key="f.id" class="swatch-row" @click="selectAppFont(f.id, f.label)">
            <input type="radio" name="clw-app-font" :checked="appFontId === f.id" />
            <div class="nm" :style="{ fontFamily: f.stack }">{{ f.label }}</div>
          </label>
        </div>

        <div class="mb-section">
          <h3>编辑器字体<span class="swatch-desc">影响正文与章节标题</span></h3>
          <label v-for="f in editorFonts" :key="f.id" class="swatch-row" @click="selectEditorFont(f.id, f.label)">
            <input type="radio" name="clw-editor-font" :checked="editorFontId === f.id" />
            <div class="nm" :style="{ fontFamily: f.stack }">{{ f.label }}</div>
          </label>
        </div>

        <div class="mb-section">
          <h3>排版</h3>
          <div class="cfg-sliders">
            <div>
              <div class="cfg-slider-head"><span>字号</span><b>{{ proseSize }} px</b></div>
              <input
                type="range" min="12" max="24" step="0.5" :value="proseSize"
                @input="setSize(Number(($event.target as HTMLInputElement).value))"
              />
            </div>
            <div>
              <div class="cfg-slider-head"><span>行高</span><b>{{ proseLh }}</b></div>
              <input
                type="range" min="1.4" max="3" step="0.1" :value="proseLh"
                @input="setLh(Number(($event.target as HTMLInputElement).value))"
              />
            </div>
            <div>
              <div class="cfg-slider-head"><span>段间距</span><b>{{ proseGap }} px</b></div>
              <input
                type="range" min="8" max="32" step="2" :value="proseGap"
                @input="setGap(Number(($event.target as HTMLInputElement).value))"
              />
            </div>
          </div>
        </div>

        <div class="mb-section">
          <h3>书库</h3>
          <div class="kv"><span class="k">当前</span><span class="v">{{ currentLib }}</span></div>
        </div>

        <div class="mb-section">
          <h3>模型与驱动</h3>
          <div class="kv"><span class="k">驱动</span><span class="v">Claude CLI 子进程</span></div>
          <div class="kv"><span class="k">原则</span><span class="v">不直连大模型 · key 不入库</span></div>
        </div>

        <div class="mb-section">
          <h3>快捷键</h3>
          <div class="kv"><span class="k">⌘P</span><span class="v">命令面板</span></div>
          <div class="kv"><span class="k">⌘B</span><span class="v">折叠侧栏</span></div>
          <div class="kv"><span class="k">⌘⇧F</span><span class="v">专注模式</span></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* mockup 覆盖 .modal-mask/.modal/.modal-head/.modal-close/.modal-body/.mb-section/.swatch-row/.nm/.kv；
   仅补滑块容器（mockup 用内联样式，Vue 抽类更清晰）。 */
.swatch-row{margin-bottom:6px}
.swatch-row:last-child{margin-bottom:0}
.swatch-dot{display:inline-block;width:14px;height:14px;border-radius:50%;margin-right:8px;vertical-align:middle;border:1px solid var(--border-2)}
.swatch-desc{margin-left:8px;color:var(--text-3);font-size:11px;font-weight:normal}
.cfg-sliders {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 0;
}
.cfg-slider-head {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  margin-bottom: 6px;
}
.cfg-slider-head span {
  color: var(--text-2);
}
.cfg-slider-head b {
  color: var(--ink);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.cfg-sliders input[type='range'] {
  width: 100%;
  accent-color: var(--ink-cyan);
}
</style>
