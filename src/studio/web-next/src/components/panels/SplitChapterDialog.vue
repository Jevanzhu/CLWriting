<script setup lang="ts">
// 拆分弹窗（阶段 24 S4）：干跑视图展示 + 新章标题必填输入。
// 拆分需要标题输入（执行参数），ui.ask 的布尔确认不够用——合并确认走 ui.ask
// （.cp-modal 动线），本弹窗只承接拆分；形态仿 ChapterMetaDialog（焦点圈/IME 让渡）。
import { ref, watch } from 'vue'
import { isImeComposing } from '../../shared/ime'
import { useFocusTrap } from '../../composables/useFocusTrap'
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
watch(
  () => props.modelValue,
  (v) => {
    // 重开复位（R71-31 同款）——取消关闭再开不得残留上次的标题草稿
    if (v) titleInput.value = ''
  },
  { immediate: true },
)

function onConfirm(): void {
  const t = titleInput.value.trim()
  if (!t) return
  emit('confirm', t)
}

// R35-36 同款焦点圈：打开时焦点入输入框，Tab 循环锁在弹窗内，关闭归还焦点
const dlgRef = ref<HTMLElement | null>(null)
useFocusTrap(dlgRef)

function onKeyConfirm(e: KeyboardEvent): void {
  // R61-3：IME 组合期确认候选的 Enter 让渡（组合期 v-model 是旧值，放行会以缺字标题拆分）
  if (isImeComposing(e)) return
  // R49-29：Enter 目标是按钮时让渡原生激活——容器级 @keydown.enter 此前抢在按钮 click 前
  if ((e.target as HTMLElement | null)?.closest('button')) return
  onConfirm()
}
// R35-36：IME 组合期 Esc 让渡——组合中按 Esc 是收输入法候选框，放行会误关弹窗
function onKeyEsc(e: KeyboardEvent): void {
  if (isImeComposing(e)) return
  emit('update:modelValue', false)
}
</script>

<template>
  <teleport to="body">
    <!-- R0916-7-P3-22：遮罩改走 ModalMask 统一组件（open 即登记 overlayOpen/maskAlpha），
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
        @keydown.enter="onKeyConfirm"
        @keydown.esc="onKeyEsc"
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
.btn {
  padding: 6px 14px;
  font-size: var(--font-size-s);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
}
.btn.primary {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  border-color: var(--interactive-accent);
}
.btn.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
