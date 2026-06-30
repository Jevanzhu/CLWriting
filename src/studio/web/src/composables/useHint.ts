// 全局操作反馈提示（对齐 mockup showHint + .hint-tip，v5-components.css:431）。
// 模块级单例 reactive：任意组件 import { useHint } 调 hint() 即弹底部居中浮层，默认 1.7s 自动消失。
// 用于：专注/面板开关、保存、改写采纳、自动推进、字体切换等操作即时反馈。
import { reactive } from 'vue'

const state = reactive({ visible: false, text: '' })
let timer: ReturnType<typeof setTimeout> | undefined

/** 弹一条提示，默认 1700ms 自动消失（对齐 mockup showHint 时长） */
function hint(text: string, ms = 1700): void {
  state.text = text
  state.visible = true
  clearTimeout(timer)
  timer = setTimeout(() => (state.visible = false), ms)
}

export function useHint() {
  return { state, hint }
}
