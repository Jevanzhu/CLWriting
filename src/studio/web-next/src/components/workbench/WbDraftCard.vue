<script setup lang="ts">
// 工作台生成正文卡（巨石批 7a 拆分，M4 默认主区：作者看到的是文章，不是事件日志）。
// 正文与字数读 workbench store；「存草稿并编辑」动作与 draftSaved 提示态留在父层
// （切 tab 重挂不丢已存提示，行为与拆分前一致）。
import { computed } from 'vue'
import { CircleCheck } from 'lucide-vue-next'
import { useWorkbenchStore } from '../../stores/workbench'
import { countWords } from '../../shared/words' // R64-33：字数与编辑器头/右栏同源（码点+剥标记）
import BetaBadge from '../ui/BetaBadge.vue'

defineProps<{
  draftSaved: { path?: string; words: number } | null
  /** 存草稿在途（R73-63）：父层 onSaveDraft 在途锁的可视面——禁按钮 + 文案反馈，挡双击重复提交 */
  saving?: boolean
}>()
const emit = defineEmits<{ save: [] }>()
const wb = useWorkbenchStore()
const draftWords = computed(() => countWords(wb.textOut))
</script>

<template>
  <section class="card draft-card">
    <div class="card-head">
      <span>生成正文 <BetaBadge /></span>
      <span class="muted">{{ draftWords }} 字</span>
    </div>
    <pre class="draft-preview">{{ wb.textOut || '（无正文，点「生成」开始）' }}</pre>
    <div class="draft-actions">
      <!-- F4（五十九轮）：断连重连水印期间禁存——textOut 可能残缺，禁按钮 + 明示原因；
           R73-63：存草稿在途同样禁存（父层在途锁） -->
      <button class="btn primary" :disabled="!wb.textOut.trim() || wb.textIncomplete || saving" @click="emit('save')">
        {{ saving ? '存草稿中…' : '存草稿并编辑' }}
      </button>
      <span v-if="wb.textIncomplete" class="muted incomplete">重连同步中，正文可能不完整</span>
      <span v-if="draftSaved" class="muted"><CircleCheck :size="12" /> {{ draftSaved.words }} 字已存</span>
    </div>
  </section>
</template>

<style scoped>
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--font-size-m);
  font-weight: 600;
  color: var(--text-normal);
  margin-bottom: var(--size-4-2);
}
.muted {
  font-size: var(--font-size-xs);
  font-weight: 400;
  color: var(--text-faint);
}
/* F4（五十九轮）：不完整水印提示（与 muted 区分，用警示色） */
.incomplete {
  color: var(--text-warning, #b8860b);
}
.btn {
  padding: 0 16px;
  height: 32px;
  font-size: var(--font-size-m);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
}
.btn.primary {
  background: var(--interactive-accent);
  border-color: var(--interactive-accent);
  color: var(--text-on-accent);
}
.btn.primary:hover {
  background: var(--interactive-accent-hover);
}
.draft-card {
  flex: 1;
  min-height: 240px;
  display: flex;
  flex-direction: column;
}
.draft-preview {
  flex: 1;
  min-height: 120px;
  margin: var(--size-4-2) 0;
  padding: var(--size-4-3);
  font-family: var(--prose-font);
  font-size: var(--prose-size);
  line-height: var(--prose-lh);
  color: var(--text-normal);
  background: var(--background-primary);
  border-radius: var(--radius-s);
  white-space: pre-wrap;
  overflow: auto;
}
.draft-actions {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
}
</style>
