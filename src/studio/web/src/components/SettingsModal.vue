<script setup lang="ts">
// 设置弹层：字体/排版/模型/快捷键（主题已收敛单 mono，无切换）。
import { NModal } from 'naive-ui'

const show = defineModel<boolean>('show', { default: false })

const fonts = [
  { id: 'kai', label: '楷体（系统，默认）', css: "'STKaiti','KaiTi','楷体',serif" },
  { id: 'song', label: '宋体', css: "'Songti SC',serif" },
  { id: 'lxgw', label: '霞鹜文楷（需安装）', css: "'LXGW WenKai','楷体',serif" },
]
</script>

<template>
  <NModal v-model:show="show" preset="card" title="设置" :bordered="false" style="width: 560px; max-width: 92vw">
    <div class="cfg-section">
      <div class="cfg-title">正文字体</div>
      <label v-for="f in fonts" :key="f.id" class="font-row">
        <input type="radio" name="clw-font" :value="f.id" :checked="f.id === 'kai'" />
        <span class="font-nm" :style="{ fontFamily: f.css }">{{ f.label }}</span>
      </label>
      <div class="cfg-hint">字体切换为占位，后续接入正文渲染。</div>
    </div>

    <div class="cfg-section">
      <div class="cfg-title">排版</div>
      <div class="kv"><span>字号</span><b>16.5 px</b></div>
      <div class="kv"><span>行高</span><b>2.0</b></div>
      <div class="kv"><span>段间距</span><b>16 px</b></div>
      <div class="kv"><span>编辑模式</span><b>按文档类型：正文 / 大纲 / 设定</b></div>
    </div>

    <div class="cfg-section">
      <div class="cfg-title">模型与驱动</div>
      <div class="kv"><span>驱动</span><b>claude CLI 子进程</b></div>
      <div class="kv"><span>原则</span><b>不直连大模型 · key 不入库</b></div>
    </div>

    <div class="cfg-section">
      <div class="cfg-title">快捷键</div>
      <div class="kv"><span>⌘P</span><b>命令面板</b></div>
      <div class="kv"><span>⤢</span><b>专注模式</b></div>
      <div class="kv"><span>◧</span><b>详情面板</b></div>
    </div>
  </NModal>
</template>

<style scoped>
.cfg-section {
  margin-bottom: 20px;
}
.cfg-title {
  font-size: 11px;
  color: var(--text-3);
  letter-spacing: 1px;
  text-transform: uppercase;
  margin-bottom: 10px;
}
.font-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  margin-bottom: 6px;
  cursor: pointer;
}
.font-row:hover {
  border-color: var(--ink-cyan);
}
.font-row input {
  accent-color: var(--ink-cyan);
}
.font-nm {
  font-size: 13px;
  color: var(--ink);
}
.cfg-hint {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 6px;
}
.kv {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 0;
  font-size: 13px;
  color: var(--text-2);
}
.kv b {
  color: var(--ink);
  font-weight: 500;
}
</style>
