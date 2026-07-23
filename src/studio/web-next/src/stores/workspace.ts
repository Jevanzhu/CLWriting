import { defineStore } from 'pinia'
import { ref } from 'vue'

// 工作区状态：面板折叠态（T0.3）+ tabs/activeTab（T0.5 补，含 localStorage 持久化）。
// 专注模式独立于 leftOpen/rightOpen——focus 时左右栏视觉收起，退出恢复原 leftOpen/rightOpen。
export const useWorkspaceStore = defineStore('workspace', () => {
  const leftOpen = ref(true)
  const rightOpen = ref(true)
  const focusMode = ref(false)

  function toggleLeft(): void {
    leftOpen.value = !leftOpen.value
  }
  function toggleRight(): void {
    rightOpen.value = !rightOpen.value
  }
  function toggleFocus(): void {
    focusMode.value = !focusMode.value
  }

  return { leftOpen, rightOpen, focusMode, toggleLeft, toggleRight, toggleFocus }
})
