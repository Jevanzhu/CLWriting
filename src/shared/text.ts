/**
 * 文本计量纯函数单源（复审-0914-优化 A2，2026-09-14 修复批）。
 *
 * 此前码点计数在六处各持一份同口径实现（process/summary、ai/prompts/compaction、
 * check/count、learn、metrics/style、web-next stores/chat），历史注释里各自记有
 * 「不引 X 依赖」的局部理由（learn 纯脚本边界、metrics→process→ai 成环）——单源
 * 下沉到本模块后依赖链顾虑整体消除：本模块刻意零内部依赖（对齐 short-defaults.ts
 * 的 shared 惯例），任意层引用均无依赖倒挂与循环风险。
 */

/** 码位计数——自增计数器逐码点数，替代 `[...text].length` 全量展开数组只为取个数
 *  的写法；口径：代理对（高低各一码元）算一个码位，孤立代理项各算一个，与展开
 *  结果一致（N-14 第五十四轮口径，本注钉住）。 */
export function codePointLength(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    // 高代理项后随低代理项 → 成对算一个码位，跳过低代理项
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) i++
    }
    n++
  }
  return n
}
