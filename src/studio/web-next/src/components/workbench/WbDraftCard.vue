<script setup lang="ts">
// 工作台生成正文卡（7a 拆分默认主区：作者看到的是文章，不是事件日志）。
// 正文与字数读 workbench store；「存草稿并编辑」动作与 draftSaved 提示态留在父层
// （切 tab 重挂不丢已存提示，行为与拆分前一致）。
import { ref, watch, onBeforeUnmount } from 'vue'
import { CircleCheck } from 'lucide-vue-next'
import { useWorkbenchStore } from '../../stores/workbench'
import { useDebouncedWordCount } from '../../composables/useDebouncedWordCount' // 字数防抖（口径与编辑器头同源 countWords）
import BetaBadge from '../ui/BetaBadge.vue'

defineProps<{
  draftSaved: { path?: string; words: number } | null
  /** 存草稿在途：父层 onSaveDraft 在途锁的可视面——禁按钮 + 文案反馈，挡双击重复提交 */
  saving?: boolean
  /** 生成中：genBusy（本地在途锁 + wb.running）时禁存——流式生成中
   *  textOut 是半章残稿，此前按钮不查 running，可存残稿并切离工作台；入口兜底闸在父层
   * onSaveDraft（不完整水印的既有双保险口径） */
  genBusy?: boolean
}>()
const emit = defineEmits<{ save: [] }>()
const wb = useWorkbenchStore()
// 流式期每个 text 事件向 textOut 追加后 computed 全文重算——
// 一章从 0 流式长到 N 字的总成本 O(N²/chunk)（全文正则替换 + 码点展开，与 <pre> 全文
// 插值同帧）；改 150ms 防抖（EditorView wordCount 同款先例），与流式渲染解耦。
// textOut 为裸生成文本（无 fm），stripFm:false
const { count: draftWords } = useDebouncedWordCount(() => wb.textOut, undefined, { stripFm: false })
// 流式正文 <pre> 的 150ms trailing debounce 尾沿去抖渲染——store 每 text 事件整体拼接
// textOut，<pre> 全量插值直连时每事件一次全文 DOM 排版（一章流式长到 N 字累计
// O(N²/chunk)，同帧还叠加 draftWords 重算与事件流渲染，token 级小 chunk 下与布局争帧）。
// 对齐 useDebouncedWordCount同款 150ms 档位：本地 rendered ref 仅在静默 150ms
// 后取最新值渲染（trailing 保证最终一致——最后一次追加必被渲染）；初值取挂载当拍
// textOut（重挂/切 tab 回来即见既有草稿）。文本安全性不变（仍插值，无 v-html）；
// store 聚合侧不动；按钮禁用判据仍直连 wb.textOut（保存口径不受渲染节流影响）。
const rendered = ref(wb.textOut)
let renderTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => wb.textOut,
  (v) => {
    if (renderTimer) clearTimeout(renderTimer)
    renderTimer = setTimeout(() => {
      renderTimer = null
      rendered.value = v
    }, 150)
  },
)
onBeforeUnmount(() => {
  if (renderTimer) {
    clearTimeout(renderTimer)
    renderTimer = null
  }
})
</script>

<template>
  <section class="card draft-card">
    <div class="card-head">
      <span>生成正文 <BetaBadge /></span>
      <span class="muted">{{ draftWords }} 字</span>
    </div>
    <!-- 渲染走 150ms trailing 尾沿去抖的 rendered（见 script 注），不再每 text 事件全文重排 -->
    <pre class="draft-preview">{{ rendered || '（无正文，点「生成」开始）' }}</pre>
    <div class="draft-actions">
      <!-- 断连重连水印期间禁存——textOut 可能残缺，禁按钮 + 明示原因；
：存草稿在途同样禁存（父层在途锁）；
：生成中（genBusy）禁存——半章残稿不得落盘 -->
      <button
        class="btn primary"
        :disabled="!wb.textOut.trim() || wb.textIncomplete || saving || genBusy"
        @click="emit('save')"
      >
        {{ genBusy ? '生成中，暂不能存草稿' : saving ? '存草稿中…' : '存草稿并编辑' }}
      </button>
      <span v-if="wb.textIncomplete" class="muted incomplete">重连同步中，正文可能不完整</span>
      <span v-if="draftSaved" class="muted"><CircleCheck :size="12" /> {{ draftSaved.words }} 字已存</span>
    </div>
  </section>
</template>

<style scoped>
.muted {
  font-size: var(--font-size-xs);
  font-weight: 400;
  color: var(--text-faint);
}
/* 不完整水印提示（与 muted 区分，用警示色）。
 * 删回退值——原此处 #b8860b（浅色档）与 StartupNoticeBanner 的
 * #d4a72c 各执一份，与 tokens.css 定义（浅 #b8860b / 暗 #d4a13a）三方不一致；
 * token 已定义，回退值只会掩盖拼写错误。 */
.incomplete {
  color: var(--text-warning);
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
