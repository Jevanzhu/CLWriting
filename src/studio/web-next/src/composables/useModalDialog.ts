/**
 * 模态弹窗共用骨架：焦点圈 + Enter/Esc 让渡守卫 + 重开复位。
 *
 * 这三件事在编辑类弹窗里是同一份契约，散在各自组件里收口一处漏一处：
 * ① 焦点圈——打开时焦点入框、Tab/Shift+Tab 只在弹窗内循环、关闭归还焦点
 *    （挂卸与嵌套让渡由 useFocusTrap 承载，本件只负责接上弹窗根 ref）；
 * ② Enter/Esc 让渡——IME 组合期的按键归输入法：组合期 v-model 仍是旧值，放行的 Enter
 *    会以缺字内容提交，放行的 Esc 会误关弹窗（组合中的 Esc 是收候选框）。Enter 落点在
 *    按钮上时还要让渡原生激活——容器级 @keydown.enter 抢在按钮 click 之前触发，焦点在
 *    「取消」钮上按 Enter 会变成先提交后取消；
 * ③ 重开复位——字段级错误提示 / 草稿这类暂态归组件持有，取消关闭不清则残留到下一次
 *    打开，作者会误以为新弹窗的旧错仍在。
 *
 * 用法：组件内声明弹窗根 ref（`const dlgRef = ref<HTMLElement | null>(null)`）后传入：
 * `useModalDialog({ target: dlgRef, open, onOpen, onEnter, onEsc })`；模板上弹窗根元素绑
 * `ref="dlgRef"` + `tabindex="-1"` + `@keydown.enter="onDialogEnter"` +
 * `@keydown.esc="onDialogEsc"`。`open` 取弹窗开合条件（v-model 值或 v-if 判据），其打开沿
 * （含挂载即打开）调用 onOpen；Enter/Esc 的两个守卫在内部统一执行完毕后回调业务副作用。
 * ref 由调用方声明（不从本件返回值解构）：模板的 `ref="dlgRef"` 是字符串字面量，
 * vue-tsc 不把它计入绑定读取，解构来的绑定会被 noUnusedLocals 判为未读。
 */
import { watch, type Ref } from 'vue'
import { isImeComposing } from '../shared/ime'
import { useFocusTrap } from './useFocusTrap'

export interface ModalDialogOptions {
  /** 弹窗根元素 ref（焦点圈以此为域；模板绑 ref="dlgRef" + tabindex="-1"） */
  target: Ref<HTMLElement | null>
  /** 开合条件取值（v-model 值 / 弹窗根 v-if 判据）——打开沿即复位时机 */
  open: () => boolean
  /** 打开沿复位（含挂载即打开）；缺省不复位 */
  onOpen?: () => void
  /** 非组合期、且落点不在按钮上的 Enter；缺省不接 Enter */
  onEnter?: () => void
  /** 非组合期的 Esc；缺省不接 Esc */
  onEsc?: () => void
}

export interface ModalDialogHandles {
  /** 容器级 @keydown.enter 处理（守卫见头注②） */
  onDialogEnter: (e: KeyboardEvent) => void
  /** 容器级 @keydown.esc 处理（守卫见头注②） */
  onDialogEsc: (e: KeyboardEvent) => void
}

export function useModalDialog(opts: ModalDialogOptions): ModalDialogHandles {
  useFocusTrap(opts.target)

  watch(
    opts.open,
    (v) => {
      if (v) opts.onOpen?.()
    },
    { immediate: true },
  )

  function onDialogEnter(e: KeyboardEvent): void {
    // 组合期 Enter 让渡：组合期 v-model 是旧值，放行会以缺字内容提交
    if (isImeComposing(e)) return
    // 落点在按钮上让渡原生激活：容器级 Enter 抢在按钮 click 前会「先提交后取消」
    if ((e.target as HTMLElement | null)?.closest('button')) return
    opts.onEnter?.()
  }

  function onDialogEsc(e: KeyboardEvent): void {
    // 组合期 Esc 是收输入法候选框，放行会误关弹窗
    if (isImeComposing(e)) return
    opts.onEsc?.()
  }

  return { onDialogEnter, onDialogEsc }
}
