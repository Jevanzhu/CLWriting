// 编辑器状态共享（模块级单例）：Editor 写入 dirty/saving，AppShell 顶栏读取；
// triggerSave 由顶栏保存按钮调用，Editor watch saveTick 执行实际保存。
// 用途：保存按钮进顶栏后，跨组件（AppShell→Editor）传递编辑态与触发保存。
import { ref } from 'vue'

const dirty = ref(false)
const saving = ref(false)
const saveTick = ref(0)

/** 顶栏保存按钮 → 触发 Editor 执行保存（saveTick 自增驱动 watch） */
function triggerSave(): void {
  saveTick.value++
}

export function useEditorState() {
  return { dirty, saving, saveTick, triggerSave }
}
