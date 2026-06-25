import { ref } from 'vue'

// 工作台事件流共享状态（模块级单例）：Workbench.vue 写入，右栏 EventStream 读取，实现跨组件联动。
export interface WbLogEntry {
  t: string
  type: string
  text: string
}

const log = ref<WbLogEntry[]>([])

export function useWorkbenchLog() {
  return {
    log,
    push: (e: WbLogEntry): void => {
      log.value.push(e)
    },
    clear: (): void => {
      log.value = []
    },
  }
}
