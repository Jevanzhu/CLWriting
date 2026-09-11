<script setup lang="ts">
/**
 * 对话助手 dock（FAB 演进版）：左下角 FAB → 输入框 + 独立「对话」按钮 → 对话框。
 * 「对话」按钮未开时在输入框上方 6px；打开时融入对话框头部左上角（胶囊标签）。
 * 输入框为 Codex 风格（与工作台对话一致）：章节左下 + 模型/推理等级/清空/发送右下。
 * R0912-C2-P3-4（2026-09-12 独立重评修复批）：composer 模板+CSS 与 ChatPanel 双份
 * 收敛为 chat/ChatComposer.vue（glass 档承载玻璃拟态/70px 输入框等差异，DOM 不变）。
 */
import { ref, nextTick } from 'vue'
import { MessageCircle, ChevronUp, ChevronDown, X } from 'lucide-vue-next'
import ChatPanel from '../panels/ChatPanel.vue'
import ChatComposer from '../panels/chat/ChatComposer.vue'
import BetaBadge from '../ui/BetaBadge.vue'

defineProps<{
  bookName: string
  currentChapter?: number
}>()

/** 消息面板句柄——发送后强制滚底（R48-96：经 ChatPanel 转发调 ChatMessages） */
const panelRef = ref<InstanceType<typeof ChatPanel> | null>(null)

/** 输入框是否展开 */
const fabOpen = ref(false)
/** 对话框是否打开 */
const chatOpen = ref(false)

// R48-96（四十八轮）：发送后强制滚底——原回调只开框不滚（R72-11 只接了 ChatPanel
// 面板路径），dock 场景消息落入视口下方不跟随；开框 + nextTick 后经面板转发滚底
async function afterPushed(): Promise<void> {
  chatOpen.value = true
  await nextTick()
  panelRef.value?.scrollToBottom(true)
}

/** FAB toggle：开 → 收（收起时对话框一并收起） */
function onFab(): void {
  fabOpen.value = !fabOpen.value
  if (!fabOpen.value) chatOpen.value = false
}

/** 「对话」按钮 toggle 对话框 */
function onExpandChat(): void {
  chatOpen.value = !chatOpen.value
}
</script>

<template>
  <div class="chat-dock">
    <!-- 对话框（独立圆角框，75% 玻璃，正文宽度，紧贴输入框上方） -->
    <div v-if="chatOpen" class="chat-window">
      <!-- 头部占位：对话按钮融入此处左上角 -->
      <div class="window-head"></div>
      <div class="window-body">
        <ChatPanel ref="panelRef" :book-name="bookName" :current-chapter="currentChapter" hide-composer />
      </div>
    </div>

    <!-- 输入框（Codex 风格，与工作台对话一致；glass=dock 玻璃档，R0912-C2-P3-4） -->
    <div v-if="fabOpen" class="chat-stack">
      <ChatComposer glass :book-name="bookName" :current-chapter="currentChapter" :on-pushed="afterPushed" />
    </div>

    <!-- 「对话」按钮：未开时在输入框上方；打开时融入对话框左上角 -->
    <button v-if="fabOpen" class="chat-expand" :class="{ on: chatOpen }" @click="onExpandChat">
      <MessageCircle :size="13" />
      <span>对话 <BetaBadge /></span>
      <ChevronDown v-if="chatOpen" :size="13" />
      <ChevronUp v-else :size="13" />
    </button>

    <!-- FAB（左下角，常驻 toggle） -->
    <button class="fab" :class="{ on: fabOpen }" title="对话助手 Beta" @click="onFab">
      <X v-if="fabOpen" :size="18" />
      <MessageCircle v-else :size="21" />
    </button>
  </div>
</template>

<style scoped>
.chat-dock {
  position: absolute;
  inset: 0;
  z-index: 60;
  pointer-events: none; /* 透明区域不挡编辑 */
  /* 框宽/框高共享变量：两框同宽同轴，按钮对齐用 */
  --chat-w: calc(min(1020px, calc(100% - 96px)) - 284px);
  --chat-h: min(55vh, 520px);
  /* 输入框距底 + 输入框固定高度：对话框/按钮定位偏移基准 */
  --composer-foot: 45px;
  --composer-h: 130px;
  /* 输入框↔对话框↔按钮 统一间距 */
  --chat-gap: 12px;
}
.chat-dock > * {
  pointer-events: auto;
}

/* ── FAB：accent 实心圆钮，55% 透明 ── */
.fab {
  position: absolute;
  left: 16px;
  bottom: 16px;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  background: color-mix(in srgb, var(--interactive-accent) 55%, transparent);
  backdrop-filter: blur(20px) saturate(1.4);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  color: var(--text-on-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: var(--shadow-m);
  transition:
    transform var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}
.fab:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-l);
  background: color-mix(in srgb, var(--interactive-accent-hover) 55%, transparent);
}
.fab:active {
  transform: translateY(0) scale(0.96);
}
.fab.on {
  background: color-mix(in srgb, var(--background-modifier-active-hover) 55%, transparent);
  color: var(--text-normal);
}

/* ── 输入框定位（居中、贴底） ── */
.chat-stack {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: var(--composer-foot);
  width: var(--chat-w);
}
/* 「对话」按钮：未开时在输入框上方，左对齐输入框左缘 */
.chat-expand {
  position: absolute;
  left: calc(50% - var(--chat-w) / 2);
  transform: none;
  bottom: calc(var(--composer-foot) + var(--composer-h) + var(--chat-gap));
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 14px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--background-modifier-border) 70%, transparent);
  background: color-mix(in srgb, var(--background-primary) 70%, transparent); /* 与输入框/对话框同透明度 */
  backdrop-filter: blur(20px) saturate(1.4);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  box-shadow: var(--shadow-m);
  color: var(--text-muted);
  font-size: var(--font-size-s);
  cursor: pointer;
  transition: left var(--dur-norm) var(--ease-out), bottom var(--dur-norm) var(--ease-out), background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.chat-expand:hover {
  box-shadow: var(--shadow-l);
  color: var(--text-normal);
}
/* 对话框打开：按钮融入对话框头部左上角，胶囊标签（与对话框同玻璃） */
.chat-expand.on {
  left: calc(50% - var(--chat-w) / 2 + 14px);
  bottom: calc(var(--composer-foot) + var(--composer-h) + var(--chat-gap) + var(--chat-h) - 40px);
  background: color-mix(in srgb, var(--background-secondary) 60%, transparent);
  border-color: color-mix(in srgb, var(--background-modifier-border) 60%, transparent);
  box-shadow: none;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: var(--text-accent);
  padding: 4px 12px;
}
.chat-expand.on:hover {
  color: var(--text-normal);
}

/* ── 对话框：70% 玻璃，紧贴输入框上方 ── */
.chat-window {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(var(--composer-foot) + var(--composer-h) + var(--chat-gap)); /* 输入框顶部 + 间距 */
  width: var(--chat-w);
  height: var(--chat-h);
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-l);
  border: 1px solid color-mix(in srgb, var(--background-modifier-border) 70%, transparent);
  box-shadow: var(--shadow-l);
  overflow: hidden;
  background: color-mix(in srgb, var(--background-primary) 70%, transparent);
  backdrop-filter: blur(20px) saturate(1.4);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  animation: dock-in var(--dur-norm) var(--ease-out);
}
/* 头部占位：对话按钮融入的纵向空间 */
.window-head {
  height: 40px;
  flex-shrink: 0;
}
.window-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
@keyframes dock-in {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}

/* ── 输入框：Codex 风格（与工作台对话一致）──
 * composer 模板与样式（chat-composer/composer-* 族、玻璃档、chapter-menu 阴影覆盖）
 * 已随 R0912-C2-P3-4 收敛至 chat/ChatComposer.vue（glass 档，原值不变）；stack 定位
 * 容器（居中、贴底，宽=--chat-w）保留在上文「输入框定位」段。 */
</style>