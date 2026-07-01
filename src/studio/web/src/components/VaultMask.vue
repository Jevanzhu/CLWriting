<script setup lang="ts">
// 新建书库弹窗（对齐 mockup vaultMask）：名称输入 + 路径预览联动 + 目录树预览 + 创建。
// 创建逻辑待桌面端 IPC（desktop.createLibrary）/后端，先占位 hint。
import { ref, computed } from 'vue'
import { useHint } from '../composables/useHint'

const show = defineModel<boolean>('show', { default: false })
const { hint } = useHint()
const name = ref('')
const path = computed(() => `~/CLWriting/${name.value.trim() || '未命名'}`)

function submit(): void {
  const n = name.value.trim()
  if (!n) {
    hint('请填写书库名称')
    return
  }
  // TODO(desktop/core): 调 desktop.createLibrary 或后端 API 创建书库目录结构
  hint(`书库「${n}」创建待桌面端支持`)
  show.value = false
  name.value = ''
}
</script>

<template>
  <div class="modal-mask vault-mask" :class="{ show }" @click.self="show = false">
    <div class="modal vault-modal">
      <div class="modal-head">
        <h3>新建书库</h3>
        <span class="modal-close" @click="show = false">✕</span>
      </div>
      <div class="vault-body">
        <label class="vault-label">书库名称
          <input v-model="name" placeholder="如：我的玄幻系列" class="vault-input" />
        </label>
        <div class="vault-path">路径：<b>{{ path }}</b></div>
        <div class="vault-tree">
          <div class="bc-label">目录结构预览</div>
          <pre class="dir-preview">{{ path }}/
├── 定稿/
│   ├── 正文/
│   └── 设定/
├── 大纲/
├── 文风/
└── 工作区/</pre>
        </div>
      </div>
      <div class="vault-foot">
        <button class="btn" @click="show = false">取消</button>
        <button class="btn primary" @click="submit">创建书库</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vault-mask{position:fixed;inset:0;background:rgba(0,0,0,.32);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:100;opacity:0;pointer-events:none;transition:opacity .2s}
.vault-mask.show{opacity:1;pointer-events:auto}
.vault-modal{width:520px;max-width:92vw;background:var(--panel);border:1px solid var(--border);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.modal-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border)}
.modal-head h3{margin:0;font-size:15px;color:var(--ink)}
.modal-close{cursor:pointer;color:var(--text-3);font-size:18px;line-height:1}
.vault-body{padding:18px;display:flex;flex-direction:column;gap:14px}
.vault-label{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text-2)}
.vault-input{padding:8px 10px;border:1px solid var(--border-2);border-radius:8px;font-size:14px;font-family:inherit;background:var(--paper);color:var(--ink)}
.vault-input:focus{outline:none;border-color:var(--ink-cyan);box-shadow:0 0 0 3px var(--cyan-10)}
.vault-path{font-size:12px;color:var(--text-3);font-family:ui-monospace,monospace}
.vault-path b{color:var(--ink)}
.dir-preview{margin:6px 0 0;padding:12px 14px;background:var(--paper);border:1px solid var(--border);border-radius:8px;font-family:ui-monospace,monospace;font-size:12px;color:var(--text-2);line-height:1.7;white-space:pre;overflow-x:auto}
.vault-foot{display:flex;justify-content:flex-end;gap:10px;padding:12px 18px;border-top:1px solid var(--border);background:var(--paper)}
</style>
