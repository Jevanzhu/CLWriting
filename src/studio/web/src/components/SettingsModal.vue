<script setup lang="ts">
// 设置弹层（mockup .modal-mask/.modal/.mb-section/.swatch-row/.kv）。
// 字体/排版实时改 :root CSS var（--prose-font/size/lh/gap），CodeMirror 即刻生效。主题已收敛单 mono。
import { ref, onMounted } from 'vue'
import { useHint } from '../composables/useHint'

const show = defineModel<boolean>('show', { default: false })
const { hint } = useHint()

const fonts = [
  { id: 'kai', label: '楷体（系统，默认）', css: "'STKaiti','KaiTi','楷体',serif" },
  { id: 'song', label: '宋体', css: "'Songti SC',serif" },
  { id: 'lxgw', label: '霞鹜文楷（需安装）', css: "'LXGW WenKai','楷体',serif" },
  { id: 'noto', label: 'Noto 思源宋体', css: "'Noto Serif SC',serif" },
]
const cfgFont = ref(fonts[0]!.css)
const cfgSize = ref(16.5)
const cfgLh = ref(2.0)
const cfgGap = ref(16)
const currentLib = ref('当前书库')

onMounted(async () => {
  try {
    const p = await window.clwritingDesktop?.getCurrentLibrary()
    if (p) currentLib.value = p
  } catch {
    /* 浏览器版无 desktop IPC */
  }
})

/** 字体/排版 → :root CSS var（CodeMirror editorTheme 读这些 var，实时生效） */
function applyCfg(): void {
  const r = document.documentElement.style
  r.setProperty('--prose-font', cfgFont.value)
  r.setProperty('--prose-size', cfgSize.value + 'px')
  r.setProperty('--prose-lh', String(cfgLh.value))
  r.setProperty('--prose-gap', cfgGap.value + 'px')
}

/** 选字体：应用 + 即时反馈（对齐 mockup showHint） */
function selectFont(f: { id: string; label: string; css: string }): void {
  cfgFont.value = f.css
  applyCfg()
  hint('字体已切换 · ' + f.label)
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
          <h3>正文字体</h3>
          <label v-for="f in fonts" :key="f.id" class="swatch-row" @click="selectFont(f)">
            <input type="radio" name="clw-font" :checked="cfgFont === f.css" />
            <div class="nm" :style="{ fontFamily: f.css }">{{ f.label }}</div>
          </label>
        </div>

        <div class="mb-section">
          <h3>排版</h3>
          <div class="cfg-sliders">
            <div>
              <div class="cfg-slider-head"><span>字号</span><b>{{ cfgSize }} px</b></div>
              <input
                type="range" min="12" max="24" step="0.5" :value="cfgSize"
                @input="cfgSize = Number(($event.target as HTMLInputElement).value); applyCfg()"
              />
            </div>
            <div>
              <div class="cfg-slider-head"><span>行高</span><b>{{ cfgLh }}</b></div>
              <input
                type="range" min="1.4" max="3" step="0.1" :value="cfgLh"
                @input="cfgLh = Number(($event.target as HTMLInputElement).value); applyCfg()"
              />
            </div>
            <div>
              <div class="cfg-slider-head"><span>段间距</span><b>{{ cfgGap }} px</b></div>
              <input
                type="range" min="8" max="32" step="2" :value="cfgGap"
                @input="cfgGap = Number(($event.target as HTMLInputElement).value); applyCfg()"
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
