/**
 * 模态框焦点陷阱（WAI-ARIA Modal 对话框规范）：
 * 打开时焦点移入模态框内第一个可交互元素；Tab/Shift+Tab 在模态框内循环；关闭时焦点返回触发器。
 *
 * 用法：const modalRef = ref<HTMLElement>() → useFocusTrap(modalRef)
 * 在模态框根元素上绑 ref + tabindex="-1"；v-if 切换或组件卸载时自动归还焦点。
 */
import { watch, type Ref } from 'vue'

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

// R8C-F2（2026-09-09 修复批）：嵌套浮层 Tab 抢焦点——此前全部 trap 在 document
// capture 期无条件处理 Tab、无「上层遮罩开着则让渡」判据：设置弹窗先开（trap 先注册
// 先执行），确认框/勾选窗（Teleport 到 body，位于设置弹窗 DOM 外）压上后，焦点在
// 确认框内按 Tab → 下层 trap 先命中「activeElement 不在自身」→ preventDefault + 焦点
// 拉回设置弹窗首元素，确认框内 Tab 卡死（确认钮键盘不可达）。修复：模块级活跃 trap
// 登记表（注册序 = 浮层层级序），仅**最顶层**（最后注册且未卸载）的 trap 处理 Tab，
// 下层 trap 静默让渡（不 preventDefault、不抢焦点）；顶层关闭/卸载后下一层自动恢复
// 处理权。
// R0910-W（2026-09-10 修复批）：登记项改为 onCleanup 时按身份 splice 移除——原实现
// 仅置 disposed 标记、残留登记常驻数组（一次会话每开合一次浮层即 +1 项，永不回收），
// topmostActiveSeq 又在每次 Tab 按下遍历全表，耗时随会话单调增长；改为移除后登记表
// 体量恒等于当前打开的浮层数，扫描 O(开层数)，顶层判定语义不变。
// （同题并合记：dev 侧 R1010b-FE-P2-2 同日同修——按 seq findIndex 摘除 + disposed
// 过滤形态；本合并取 win 身份 splice 形态，两侧测试钩子 __focusTrapActiveCountForTest
// 共用，行为等价。）
const activeTraps: Array<{ seq: number }> = []
let trapSeq = 0

/** 当前最顶层活跃 trap 的 seq（0 = 无活跃 trap）。 */
function topmostActiveSeq(): number {
  let top = 0
  for (const t of activeTraps) if (t.seq > top) top = t.seq
  return top
}

export function useFocusTrap(targetRef: Ref<HTMLElement | null>): void {
  let previouslyFocused: HTMLElement | null = null
  let seq = 0

  function getFocusable(el: HTMLElement): HTMLElement[] {
    return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (e) => !e.hasAttribute('disabled') && e.offsetParent !== null,
    )
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return
    // R8C-F2：仅最顶层活跃 trap 处理 Tab——下层 trap 让渡（嵌套浮层防抢焦点；
    // 顶层 trap 需要把焦点拉回自己框内时下方不让渡也无从争抢，反之亦然）
    if (topmostActiveSeq() !== seq) return
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
        // R8C-F2：登记活跃 trap 并取注册序（层级序）——后注册者（上层浮层）优先
        seq = ++trapSeq
        const entry = { seq }
        activeTraps.push(entry)
        document.addEventListener('keydown', onKeydown, true)

        // ref 变 null（v-if 关闭）或组件卸载时归还焦点
        onCleanup(() => {
          // R0910-W：按身份移除登记项（而非仅置标记）——登记表体量恒等于在开浮层数，
          // 不随会话开合次数增长；顶层判定语义（max seq）不变
          const i = activeTraps.indexOf(entry)
          if (i !== -1) activeTraps.splice(i, 1)
          document.removeEventListener('keydown', onKeydown, true)
          previouslyFocused?.focus()
        })
      }
    },
    { immediate: true },
  )
}

/**
 * R1010b-FE-P2-2（2026-09-10 内存专项重审修复批）：活跃 trap 计数探针——仅供回归
 * 测试断言「关浮层即摘登记」（锁 activeTraps 只增不减回归；生产代码零调用）。
 */
export function __focusTrapActiveCountForTest(): number {
  return activeTraps.length
}