<script setup lang="ts">
/**
 * 对话助手面板（方案 §3.7.4）。
 *
 * A（工作台 tab）和 B（底部 dock）共用此组件，容器控制尺寸。
 * 视觉参考 Codex Desktop：大圆角输入框 + 内嵌圆形发送 + 无气泡感消息流。
 *
 * hh §八-16 拆分：消息流（确认闸/变体切换/重新生成/滚动跟随）→ chat/ChatMessages.vue
 * （纯搬家，DOM 不变）；R0912-C2-P3-4（2026-09-12 独立重评修复批）：输入区与 ChatDock
 * 的双份模板+CSS 再收敛为 chat/ChatComposer.vue（差异经 glass/onPushed props 传，
 * DOM 不变）。公开契约（bookName/currentChapter/hideComposer）不变——ChatDock /
 * WorkbenchView 零改动。
 */
import { ref, nextTick } from 'vue'
import ChatMessages from './chat/ChatMessages.vue'
import ChatComposer from './chat/ChatComposer.vue'

const props = defineProps<{
  bookName: string
  /** 当前编辑器章号（章节选择器用） */
  currentChapter?: number
  /** 隐藏底部输入区（dock 拆分为独立输入框时，对话框只显示消息） */
  hideComposer?: boolean
}>()

/** 消息流子件句柄——发送后滚底（onPushed 回调经 defineExpose 调子件 scrollToBottom） */
const messagesRef = ref<InstanceType<typeof ChatMessages> | null>(null)

// R72-11（二十轮 E-5）：发送后滚底传 force=true（无条件）——原无参调用在用户上滚
// 读历史时距底超阈值不跟滚，与「发送后应见自己消息」的注释承诺相反
async function afterPushed(): Promise<void> {
  await nextTick()
  messagesRef.value?.scrollToBottom(true)
}

// R48-96（四十八轮）：滚底转发——dock 场景发送入口在 dock 自持 composer，发送后经
// 本转发调消息流强制滚底（ChatDock onPushed → panelRef.scrollToBottom(true)）
defineExpose({
  scrollToBottom: (force: boolean) => messagesRef.value?.scrollToBottom(force),
})
</script>

<template>
  <section class="chat-panel">
    <ChatMessages ref="messagesRef" :book-name="props.bookName" />

    <!-- 输入区：Codex 风格——章节左下 + 模型/推理等级右下 + 发送
        （dock 拆分场景 v-if 隐藏，composer 不实例化即无双活监听，R48-97 语义不变） -->
    <ChatComposer
      v-if="!hideComposer"
      :book-name="props.bookName"
      :current-chapter="props.currentChapter"
      :on-pushed="afterPushed"
    />
  </section>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* 输入区模板与样式（chat-composer/composer-* 族）已随 R0912-C2-P3-4 收敛至
 * chat/ChatComposer.vue（工作台实底档为默认形态，原值不变）。 */
</style>
