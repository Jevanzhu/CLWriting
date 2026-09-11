<script setup lang="ts">
/**
 * 对话输入区 composer（R0912-C2-P3-4，2026-09-12 独立重评修复批：自 ChatPanel 与
 * ChatDock 的双份模板 + ~150 行 CSS 收敛，纯结构去重——DOM/类名/事件语义不变）。
 * 逻辑层照旧走共享 useChatComposer（勿在本组件重复实现）；发送后回调经 onPushed
 * prop 透传（两消费方滚底/开框行为各异，原语义不变）。
 *
 * 两消费方差异面经 glass prop 传（dock 悬浮档 vs 工作台实底档，共 5 处，值原样）：
 * ① .chat-composer 外层 padding（工作台有 / dock 由 .chat-stack 定位无）
 * ② .composer-box 玻璃拟态（70% 透明 + backdrop-blur + shadow-m 档）
 * ③ .chat-input min-height 56 vs 70（70 含内边距 box-sizing）
 * ④ .composer-footer padding（var 档 vs 2px 12px 6px）
 * ⑤ .chapter-menu 阴影深一档（dock 悬浮覆盖，原 ChatDock scoped 规则随迁）
 */
import { Send, Trash2, BookOpen, ChevronDown, Square } from 'lucide-vue-next'
import { useChatStore } from '../../../stores/chat'
import { useChatComposer } from '../../../composables/useChatComposer'
import ModelEffortBar from '../../ui/ModelEffortBar.vue'

const props = defineProps<{
  bookName: string
  /** 当前编辑器章号（章节选择器用） */
  currentChapter?: number
  /** pushUser 后、sendChat 前回调（工作台：滚底；dock：开框 + 滚底） */
  onPushed?: () => void | Promise<void>
  /** dock 玻璃档（见头注差异清单）；不传 = 工作台实底档 */
  glass?: boolean
}>()

const chat = useChatStore()

// R48-97（四十八轮）：原 ChatPanel 的 enabled=!hideComposer 与其模板 v-if 同条件——
// 抽组件后「不被渲染即不实例化」，enabled 恒 true 语义等价（双活监听面随 v-if 消失）。
// onPushed 经 props 活值透传（非 setup 快照，防 prop 晚到丢回调）。
const {
  input, sending, busy, chatRunning, selectedChapter,
  chapterMenuOpen, chapterWrapRef,
  handleSend, handleKeydown, stopChat, handleClear,
  toggleChapterMenu, selectChapter,
} = useChatComposer(
  () => props.bookName,
  () => props.currentChapter,
  () => props.onPushed?.(),
)
</script>

<template>
  <div class="chat-composer" :class="{ glass }">
    <div class="composer-box">
      <!-- 主区：输入框 -->
      <div class="composer-main">
        <textarea
          v-model="input"
          class="chat-input"
          placeholder="给 AI 发消息…"
          rows="2"
          :disabled="busy"
          @keydown="handleKeydown"
        />
      </div>

      <!-- 底栏：章节选择+快捷键提示（左）+ 模型/推理等级/清空/发送（右） -->
      <div class="composer-footer">
        <div class="composer-foot-left">
          <div ref="chapterWrapRef" class="composer-chapter-wrap">
            <button type="button" class="composer-chapter" :class="{ on: selectedChapter !== undefined }" @click="toggleChapterMenu">
              <BookOpen :size="14" />
              <span>{{ selectedChapter !== undefined ? `第 ${selectedChapter} 章` : '全书' }}</span>
              <ChevronDown :size="10" />
            </button>
            <div v-if="chapterMenuOpen" class="chapter-menu">
              <button type="button" class="chapter-menu-item" :class="{ active: selectedChapter === undefined }" @click="selectChapter(undefined)">全书</button>
              <button v-if="currentChapter" type="button" class="chapter-menu-item" :class="{ active: selectedChapter === currentChapter }" @click="selectChapter(currentChapter)">第 {{ currentChapter }} 章</button>
            </div>
          </div>
          <span class="composer-hint">Enter 发送 · Shift+Enter 换行</span>
        </div>
        <div class="composer-actions">
          <ModelEffortBar />
          <button
            v-if="chat.hasMessages"
            class="composer-clear"
            title="清空对话"
            @click="handleClear"
          >
            <Trash2 :size="13" />
          </button>
          <button
            v-if="chatRunning"
            class="chat-stop-btn"
            title="停止"
            @click="stopChat"
          >
            <Square :size="14" />
          </button>
          <!-- R33D-28：busy/sending 禁用同双消费方（入口静默 return 的死按钮面） -->
          <button
            v-else
            class="chat-send-btn"
            :disabled="!input.trim() || busy || sending"
            @click="handleSend"
          >
            <Send :size="15" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── 输入区：Codex 风格——章节左下 + 模型/推理等级右下 + 发送 ──（工作台实底档为基） */
.chat-composer {
  padding: var(--size-4-1) var(--size-4-5) var(--size-4-4);
  flex-shrink: 0;
}
/* dock 玻璃档：定位与占位由 ChatDock 的 .chat-stack 负责，本层不再占 padding */
.chat-composer.glass {
  padding: 0;
}
.composer-box {
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  background: var(--background-primary);
  box-shadow: var(--shadow-s);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.composer-box:hover {
  border-color: var(--background-modifier-border-hover);
}
.composer-box:focus-within {
  border-color: var(--interactive-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--interactive-accent) 14%, transparent), var(--shadow-s);
}
/* ① dock 玻璃档 box：与对话框/按钮同透明度（原 ChatDock 值原样） */
.chat-composer.glass .composer-box {
  border-color: color-mix(in srgb, var(--background-modifier-border) 70%, transparent);
  background: color-mix(in srgb, var(--background-primary) 70%, transparent);
  backdrop-filter: blur(20px) saturate(1.4);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  box-shadow: var(--shadow-m);
}
.composer-main {
  display: flex;
  align-items: flex-start;
  gap: var(--size-4-2);
  padding: var(--size-4-3) var(--size-4-3) var(--size-4-1);
}
.composer-chapter-wrap {
  position: relative;
}
.composer-chapter {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  padding: 3px 11px;
  border-radius: 999px;
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-family: inherit;
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.composer-chapter:hover {
  border-color: var(--background-modifier-border-hover);
  color: var(--text-normal);
}
.composer-chapter.on {
  border-color: color-mix(in srgb, var(--interactive-accent) 40%, transparent);
  color: var(--text-accent);
}
/* 章节自定义下拉菜单（向上弹出，与 composer-box 同风格；基础样式在全局 base.css） */
.chat-input {
  flex: 1;
  min-height: 56px;
  resize: none;
  border: none;
  background: transparent;
  padding: var(--size-4-1) 0;
  font-size: var(--font-size-m);
  font-family: inherit;
  line-height: 1.6;
  color: var(--text-normal);
  outline: none;
}
/* ③ dock 档输入框加高（70 含内边距，保证 dock 整体 ≤130px） */
.chat-composer.glass .chat-input {
  min-height: 70px;
  box-sizing: border-box;
}
.chat-input::placeholder {
  color: var(--text-faint);
}
.chat-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--size-4-2);
  padding: var(--size-4-1) var(--size-4-3) var(--size-4-3);
}
/* ④ dock 档底栏更紧（原 ChatDock 值原样） */
.chat-composer.glass .composer-footer {
  padding: 2px 12px 6px;
}
.composer-foot-left {
  display: flex;
  align-items: center;
  gap: var(--size-4-6);
  min-width: 0;
}
.composer-hint {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
  user-select: none;
}
.composer-actions {
  display: flex;
  align-items: center;
  gap: 5px;
}
.composer-clear {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--text-faint);
  background: none;
  border: none;
  cursor: pointer;
  border-radius: var(--radius-s);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.composer-clear:hover {
  color: var(--text-normal);
  background: var(--background-modifier-hover);
}
.chat-stop-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border-radius: 50%;
  border: none;
  background: var(--dv-bad);
  color: var(--text-on-accent);
  cursor: pointer;
  transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.chat-stop-btn:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}
.chat-send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  border-radius: 50%;
  border: none;
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  cursor: pointer;
  transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.chat-send-btn:hover:not(:disabled) {
  opacity: 0.9;
  transform: translateY(-1px);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--interactive-accent) 35%, transparent);
}
.chat-send-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
/* ⑤ dock 档：菜单悬浮于编辑区上方，阴影深一档（原 ChatDock scoped 覆盖随迁） */
.chat-composer.glass .chapter-menu {
  box-shadow: var(--shadow-m);
}
</style>
