/**
 * 模态框焦点陷阱（WAI-ARIA Modal 对话框规范）：
 * 打开时焦点移入模态框内第一个可交互元素；Tab/Shift+Tab 在模态框内循环；关闭时焦点返回触发器。
 *
 * 用法：const modalRef = ref<HTMLElement>() → useFocusTrap(modalRef)
 * 在模态框根元素上绑 ref + tabindex="-1"；v-if 切换或组件卸载时自动归还焦点。
 */
import { watch, type Ref } from 'vue'

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

export function useFocusTrap(targetRef: Ref<HTMLElement | null>): void {
  let previouslyFocused: HTMLElement | null = null

  function getFocusable(el: HTMLElement): HTMLElement[] {
    return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (e) => !e.hasAttribute('disabled') && e.offsetParent !== null,
    )
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return
    const el = targetRef.value
    if (!el) return
    const focusable = getFocusable(el)
    if (focusable.length === 0) return

    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    if (e.shiftKey) {
      if (document.activeElement === first || !el.contains(document.activeElement)) {
        e.preventDefault()
        last.focus()
      }
    } else {
      if (document.activeElement === last || !el.contains(document.activeElement)) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  watch(
    targetRef,
    (el, _old, onCleanup) => {
      if (el) {
        previouslyFocused = document.activeElement as HTMLElement
        const focusable = getFocusable(el)
        if (focusable.length > 0) focusable[0]!.focus()
        else el.focus()
        document.addEventListener('keydown', onKeydown, true)

        // ref 变 null（v-if 关闭）或组件卸载时归还焦点
        onCleanup(() => {
          document.removeEventListener('keydown', onKeydown, true)
          previouslyFocused?.focus()
        })
      }
    },
    { immediate: true },
  )
}
