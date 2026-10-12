<script setup lang="ts">
// 拆分弹窗：干跑视图展示 + 新章标题必填输入。
// 拆分需要标题输入（执行参数），ui.ask 的布尔确认不够用——合并确认走 ui.ask
// （.cp-modal 动线），本弹窗只承接拆分；焦点圈 / Enter-Esc 让渡 / 重开复位走
// useModalDialog（与篇章信息弹窗同源）。
import { ref } from 'vue'
import { useModalDialog } from '../../composables/useModalDialog'
import ModalMask from '../ui/ModalMask.vue'
import type { SplitPlanView } from '../../api/documents'

const props = defineProps<{
  modelValue: boolean
  /** 干跑视图（null = 关闭态占位，不渲染） */
  plan: SplitPlanView | null
}>()
const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  /** 确认拆分（title 已 trim 非空） */
  confirm: [title: string]
}>()

const titleInput = ref('')

function onConfirm(): void {
  const t = titleInput.value.trim()
  if (!t) return
  emit('confirm', t)
}

// 焦点圈 / Enter-Esc 让渡 / 打开沿复位三件事的域（模板 ref 由本件声明后传入）
const dlgRef = ref<HTMLElement | null>(null)
const { onDialogEnter, onDialogEsc } = useModalDialog({
  target: dlgRef,
  open: () => props.modelValue,
  // 打开沿复位——取消关闭再开不得残留上次的标题草稿
  onOpen: () => {
    titleInput.value = ''
  },
  onEnter: onConfirm,
  onEsc: () => emit('update:modelValue', false),
})
</script>

<template>
  <teleport to="body">
    <!-- 遮罩改走 ModalMask 统一组件（open 即登记 overlayOpen/maskAlpha），
         遮罩 CSS 与浓度不再本组件自持。内层 v-if 自持 plan 窄化——:open 传参不做模板
         窄化，删掉它下方 plan 各字段访问会在 vue-tsc 下报「可能为 null」 -->
    <ModalMask :open="modelValue && plan !== null" kind="splitChapter" @mask-click="emit('update:modelValue', false)">
      <div
        v-if="plan"
        ref="dlgRef"
        class="split-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="在光标处拆分"
        tabindex="-1"
        @keydown.enter="onDialogEnter"
        @keydown.esc="onDialogEsc"
      >
        <div class="side-title">在光标处拆分</div>
        <div class="split-info">
          <div>原章 第 {{ plan.chapterNo }} 章「{{ plan.title }}」：光标前约 {{ plan.headWords }} 字保留</div>
          <div>新章 第 {{ plan.newChapterNo }} 章：光标后约 {{ plan.tailWords }} 字迁出（显示序插在原章之后）</div>
          <div v-if="plan.tailPreview" class="preview">迁出内容预览：「{{ plan.tailPreview }}」</div>
          <div v-if="plan.publishedWarning" class="warn">
            ⚠ 原章已发布——平台连载无插入机制，新章的发布位次需自行处理
          </div>
        </div>
        <label class="field">
          新章标题
          <input v-model="titleInput" autofocus placeholder="拆分出新章的标题（必填）" />
        </label>
        <div class="split-actions">
          <button class="btn" @click="emit('update:modelValue', false)">取消</button>
          <button class="btn primary" :disabled="!titleInput.trim()" @click="onConfirm">拆分</button>
        </div>
      </div>
    </ModalMask>
  </teleport>
</template>

<style scoped>
.split-dialog {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  padding: 16px 18px;
  width: min(380px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: var(--shadow-l);
  animation: clw-appear var(--dur-norm) var(--ease-out);
}
.side-title {
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.split-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--font-size-s);
  color: var(--text-muted);
  line-height: 1.6;
}
.split-info .preview {
  color: var(--text-faint);
}
.split-info .warn {
  color: var(--text-warning);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--font-size-s);
  color: var(--text-muted);
}
.field input {
  padding: 6px 8px;
  font-size: var(--font-size-m);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
  color: var(--text-normal);
}
.split-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
/* border/color/cursor 基三条已收 btn-shared.css（本块留差异声明） */
.btn {
  padding: 6px 14px;
  font-size: var(--font-size-s);
  border-radius: var(--radius-s);
  background: var(--background-primary);
}
/* color/border-color 走 btn-shared.css .btn.primary（背景留此：等特异性平局忌上收） */
.btn.primary {
  background: var(--interactive-accent);
}
.btn.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
