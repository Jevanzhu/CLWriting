<script setup lang="ts">
// 回滚历史版本面板（对齐 mockup revMask）：版本列表 + diff 预览 + 章号输入恢复。
// 版本/diff 数据待 core（git 备份 ref API），先占位；章号恢复走现有 revertBook。
import { ref } from 'vue'

const show = defineModel<boolean>('show', { default: false })
const chapter = ref<number>(1)
const emit = defineEmits<{ confirm: [number] }>()

function confirm(): void {
  emit('confirm', chapter.value)
  show.value = false
}
</script>

<template>
  <div class="modal-mask rev-mask" :class="{ show }" @click.self="show = false">
    <div class="modal rev-modal">
      <div class="modal-head">
        <h3>回滚到历史版本</h3>
        <span class="modal-close" @click="show = false">✕</span>
      </div>
      <div class="rev-body">
        <div class="rev-list">
          <div class="bc-label">版本列表</div>
          <div class="rev-item">
            <span class="dot gray"></span>
            <div>
              <b>历史版本</b>
              <div class="desc">待 core（git 备份 ref API）</div>
            </div>
          </div>
        </div>
        <div class="rev-preview">
          <div class="bc-label">diff 预览</div>
          <div class="rev-preview-stub">选中版本后展示 diff（待 core）</div>
        </div>
      </div>
      <div class="rev-foot">
        <label class="rev-chap">回滚到第
          <input v-model.number="chapter" type="number" min="1" class="rev-input" />
          章/篇之后内容丢弃
        </label>
        <button class="btn primary" @click="confirm">恢复</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rev-mask{position:fixed;inset:0;background:rgba(0,0,0,.32);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:100;opacity:0;pointer-events:none;transition:opacity .2s}
.rev-mask.show{opacity:1;pointer-events:auto}
.rev-modal{width:640px;max-width:92vw;background:var(--panel);border:1px solid var(--border);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;max-height:84vh}
.modal-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border)}
.modal-head h3{margin:0;font-size:15px;color:var(--ink)}
.modal-close{cursor:pointer;color:var(--text-3);font-size:18px;line-height:1}
.rev-body{display:flex;min-height:260px}
.rev-list{width:220px;flex-shrink:0;border-right:1px solid var(--border);padding:10px;overflow-y:auto}
.rev-item{display:flex;gap:8px;padding:8px;border-radius:6px;cursor:pointer;align-items:flex-start}
.rev-item:hover{background:var(--hover)}
.rev-item .desc{font-size:11px;color:var(--text-3);margin-top:2px}
.rev-preview{flex:1;padding:14px 18px}
.rev-preview-stub{color:var(--text-3);font-size:13px;padding:32px 0;text-align:center}
.rev-foot{display:flex;align-items:center;gap:14px;padding:12px 18px;border-top:1px solid var(--border);background:var(--paper)}
.rev-chap{font-size:13px;color:var(--text-2);display:flex;align-items:center;gap:4px;flex:1}
.rev-input{width:60px;padding:4px 8px;border:1px solid var(--border-2);border-radius:6px;font-size:13px;font-family:inherit;background:var(--panel);color:var(--ink)}
.rev-input:focus{outline:none;border-color:var(--ink-cyan);box-shadow:0 0 0 3px var(--cyan-10)}
</style>
