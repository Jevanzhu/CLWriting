<script setup lang="ts">
// 篇章信息弹窗（块2.2）：编辑 章号 / 标题，落 frontmatter + 路径同步 rename。
// 长/短篇统一用「章号」作正文编号字段（无「篇号」概念）。
import { ref, watch } from 'vue'
import { isImeComposing } from '../../shared/ime'

const props = defineProps<{
  modelValue: boolean
  /** 章号 当前值（null = 空） */
  num: number | null
  标题: string
  /** 短篇正文 → 标题「篇章信息」；否则「章节信息」（字段统一为 章号） */
  isPiece?: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  save: [meta: { 标题: string; num: number }]
}>()

const titleInput = ref('')
const noInput = ref('')
watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      titleInput.value = props.标题
      noInput.value = props.num === null ? '' : String(props.num)
    }
  },
  { immediate: true },
)

// R70-28（十八轮）：章号非法的字段级反馈——此前静默 return，按钮只禁空值不禁非法值，
// Enter 提交「看似失灵」无任何提示
const numError = ref('')
function onSave(): void {
  const n = Number(noInput.value)
  // 低-3（第十轮）：章号补整数校验——3.5 这类小数旧口径放行后文件名落成 03.5-…，
  // 从「章号 = 整数编号」特性中脱落（前端拒收 + 服务端 documents.ts 同点位 fail-closed）
  if (!Number.isInteger(n) || n < 1) {
    numError.value = '章号须为 ≥1 的整数'
    return
  }
  numError.value = ''
  emit('save', { 标题: titleInput.value.trim() || '未命名', num: n })
  emit('update:modelValue', false)
}
const numLabel = () => '章号'
const dlgTitle = () => (props.isPiece ? '篇章信息' : '章节信息')

function onKeySave(e: KeyboardEvent): void {
  // R61-3（第六十一轮）：IME 组合期确认候选的 Enter 让渡（组合期 v-model 是旧值，
  // 放行会以缺字标题保存并触发 rename）
  if (isImeComposing(e)) return
  onSave()
}
</script>

<template>
  <teleport to="body">
    <div v-if="modelValue" class="meta-mask" @click.self="emit('update:modelValue', false)">
      <div
        class="meta-dialog"
        @keydown.enter="onKeySave"
        @keydown.esc="emit('update:modelValue', false)"
      >
        <div class="side-title">{{ dlgTitle() }}</div>
        <label class="field">
          {{ numLabel() }}
          <input v-model="noInput" type="number" min="1" autofocus @input="numError = ''" />
          <div v-if="numError" class="num-error">{{ numError }}</div>
        </label>
        <label class="field">
          标题
          <input v-model="titleInput" />
        </label>
        <div class="meta-actions">
          <button class="btn" @click="emit('update:modelValue', false)">取消</button>
          <button class="btn primary" :disabled="!noInput" @click="onSave">保存</button>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.meta-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.meta-dialog {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  padding: 16px 18px;
  width: min(320px, calc(100vw - 32px));
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
.meta-actions {
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
