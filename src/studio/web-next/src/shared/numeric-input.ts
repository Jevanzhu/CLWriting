/**
 * R72-11（二十轮 E-1/E-2）：设置页数值输入统一解析（共享 helper）。
 *
 * `Number('') === 0` 且 `Number.isFinite(0)` 为真——空串输入能穿过 `isFinite` 闸、
 * 被 store setter 的 clamp 静默钳成下限值（清空输入框反而写入 1/最小值）。此前五个
 * 设置组件各写一份 `Number(...) + isFinite` 守卫，其中 SettingsAnalysis 的注释声称
 * 「空/非数字不写 store」与实际行为相反。统一走本 helper：空串/非有限数字 → null，
 * 调用方不写 store。
 */
export function parseNumericInput(e: Event): number | null {
  const raw = (e.target as HTMLInputElement).value.trim()
  if (raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}
