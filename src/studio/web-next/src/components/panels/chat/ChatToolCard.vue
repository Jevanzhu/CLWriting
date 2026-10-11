<script setup lang="ts">
/**
 * 对话工具卡（自 ChatMessages.vue 拆出，DOM/类名/样式不变）。
 *
 * 职责：图标 + 中文名 + 状态徽标 + 参数摘要 + 结果摘要 + 确认按钮。
 *
 * 参数摘要按卡算一次：原实现 v-if 与插值各调一次 toolSummary（同参重复求值，流式
 * 期间按帧 × 卡数放大），收成 computed 后每卡每轮只求值一次（依赖 name/input 与
 * 章名查表函数，父层 chapterNameOf 恒为同一函数引用，不因父层重渲染失效）。
 *
 * 确认在途按 callId 由父层集合承载（同卡防重、跨卡并行），本件只读 `confirming`
 * 布尔并上抛确认意图——集合状态与网络调用仍在父层（单飞与切书守卫都在那里）。
 */
import { computed } from 'vue'
import {
  PenLine,
  ShieldCheck,
  Search,
  BookOpen,
  Scissors,
  Trash2,
  Copy,
  FolderInput,
  Type,
  ScrollText,
  Sparkles,
  Loader2,
} from 'lucide-vue-next'
import type { ToolCard } from '../../../stores/chat'
import { toolLabel, toolSummary, type ChapterNameLookup } from '../../../../../../shared/contract/tool-meta'

const props = defineProps<{
  tool: ToolCard
  /** 章号 → 作者可见章名（章节树解析；解析不到回 null，摘要层回落「第 N 章」） */
  chapterNameOf: ChapterNameLookup
  /** 本卡确认请求在途（同卡防重；跨卡并行不受阻） */
  confirming: boolean
}>()

const emit = defineEmits<{ confirm: [callId: string, ok: boolean] }>()

const TOOL_ICONS: Record<string, typeof PenLine> = {
  write_chapter: PenLine,
  check_chapter: ShieldCheck,
  read_chapter: BookOpen,
  read_skill: BookOpen,
  book_search: Search,
  chapter_status: ScrollText,
  move_chapter: FolderInput,
  rename_chapter: Type,
  copy_chapter: Copy,
  delete_chapter: Trash2,
  rewrite_chapter: Scissors,
  rewrite_selection: Scissors,
  apply_spill: PenLine,
  lead_update: ScrollText,
  harvest_style: Sparkles,
}

/** 参数摘要（放行前作者要核对的目标章 / 新名 / 指令；入参被截断时也照常展示已存部分）
 *  ——按卡算一次，模板两处引用同一缓存值。 */
const params = computed(() => toolSummary(props.tool.name, props.tool.input, props.chapterNameOf))
</script>

<template>
  <div
    class="chat-tool-card"
    :class="{
      'tool-pending': tool.status === 'pending',
      'tool-running': tool.status === 'running',
      'tool-ok': tool.status === 'ok',
      'tool-failed': tool.status === 'failed' || tool.status === 'cancelled',
    }"
  >
    <div class="chat-tool-head">
      <component :is="TOOL_ICONS[tool.name] ?? PenLine" :size="14" />
      <span class="chat-tool-name">{{ toolLabel(tool.name) }}</span>
      <span v-if="tool.status === 'running'" class="chat-tool-badge"> <Loader2 :size="12" class="spin" /> 执行中 </span>
      <span v-else-if="tool.status === 'ok'" class="chat-tool-badge ok">完成</span>
      <span v-else-if="tool.status === 'failed'" class="chat-tool-badge bad">失败</span>
      <span v-else-if="tool.status === 'cancelled'" class="chat-tool-badge bad">已取消</span>
    </div>

    <div v-if="params" class="chat-tool-params">{{ params }}</div>

    <!-- 工具结果摘要 -->
    <div v-if="tool.summary" class="chat-tool-summary">{{ tool.summary }}</div>

    <!-- 确认按钮（仅本卡在途才禁用——其他待确认卡可并行确认） -->
    <div v-if="tool.status === 'pending'" class="chat-tool-confirm">
      <button class="chat-confirm-no" :disabled="confirming" @click="emit('confirm', tool.callId, false)">取消</button>
      <button class="chat-confirm-yes" :disabled="confirming" @click="emit('confirm', tool.callId, true)">
        <Loader2 v-if="confirming" :size="12" class="spin" />
        确认执行
      </button>
    </div>
  </div>
</template>

<style scoped>
/* ── 工具卡片 ── */
.chat-tool-card {
  border: 1px solid var(--background-modifier-border);
  border-left-width: 3px;
  border-radius: var(--radius-s);
  padding: var(--size-4-2) var(--size-4-3);
  font-size: var(--font-size-s);
  background: var(--background-secondary);
}
.tool-pending {
  border-left-color: var(--dv-warn);
}
.tool-running {
  border-left-color: var(--interactive-accent);
}
.tool-ok {
  border-left-color: var(--dv-good);
}
.tool-failed {
  border-left-color: var(--dv-bad);
}

.chat-tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}
.chat-tool-name {
  color: var(--text-normal);
}
.chat-tool-badge {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: var(--font-size-xs);
  font-weight: 500;
  color: var(--text-muted);
  background: var(--background-modifier-hover);
}
.chat-tool-badge.ok {
  color: var(--dv-good);
  background: color-mix(in srgb, var(--dv-good) 12%, transparent);
}
.chat-tool-badge.bad {
  color: var(--dv-bad);
  background: color-mix(in srgb, var(--dv-bad) 12%, transparent);
}
.chat-tool-params {
  margin-top: var(--size-4-1);
  color: var(--text-normal);
  line-height: 1.5;
  font-size: var(--font-size-xs);
  word-break: break-all;
}
.chat-tool-summary {
  margin-top: var(--size-4-1);
  color: var(--text-muted);
  white-space: pre-wrap;
  line-height: 1.5;
  font-size: var(--font-size-xs);
}
.chat-tool-confirm {
  display: flex;
  justify-content: flex-end;
  gap: var(--size-4-2);
  margin-top: var(--size-4-2);
}
.chat-confirm-no,
.chat-confirm-yes {
  font-size: var(--font-size-xs);
  padding: 4px 14px;
  border-radius: 999px;
  border: 1px solid var(--background-modifier-border);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.chat-confirm-no {
  background: var(--background-primary);
  color: var(--text-muted);
}
.chat-confirm-no:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.chat-confirm-yes {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  border-color: transparent;
}
.chat-confirm-yes:hover {
  filter: brightness(1.1);
}
</style>
