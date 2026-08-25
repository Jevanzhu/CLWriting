/**
 * IME 组合期按键守卫（R61-3/R61-17·第六十一轮收口为单源）。
 *
 * Chromium 中输入法确认候选的按键顺序是 keydown(isComposing=true) → compositionend
 * → input → keyup：组合期 keydown 读到的 v-model 值是组合前旧值（Vue vModelText
 * 组合期不同步，compositionend 才补发 input）；keyup 则在组合结束后触发、与主动
 * 按键不可区分。凡 Enter 提交类键盘入口（发送/改名/存盘/执行命令）必须组合期让渡，
 * 判据与 useHotkeys B-9 同款（isComposing || keyCode 229）。
 */
export function isImeComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229
}
