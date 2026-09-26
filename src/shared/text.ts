/**
 * 文本计量纯函数单源（修复批）。
 *
 * 此前码点计数在六处各持一份同口径实现（process/summary、ai/prompts/compaction、
 * check/count、learn、metrics/style、web-next stores/chat），历史注释里各自记有
 * 「不引 X 依赖」的局部理由（learn 纯脚本边界、metrics→process→ai 成环）——单源
 * 下沉到本模块后依赖链顾虑整体消除：本模块刻意零内部依赖（对齐 short-defaults.ts
 * 的 shared 惯例），任意层引用均无依赖倒挂与循环风险。
 */

/** 码位计数——自增计数器逐码点数，替代 `[...text].length` 全量展开数组只为取个数
 *  的写法；口径：代理对（高低各一码元）算一个码位，孤立代理项各算一个，与展开
 *  结果一致（口径，本注钉住）。 */
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

/** 按码位截断（Array.from 迭代码点）——String.slice 按 UTF-16 码元，增补平面字符
 *  （CJK 扩展 B 生僻字、emoji）在边界处被切成半个代理对，产出尾带孤立高代理的
 *  乱码串。原实现居 process/summary.ts（十五轮登记销账）， C101 下沉
 *  本模块单源：document 层（structure-split/merge 干跑预览）与 process 层共用同一
 *  口径，消除「同仓两处码元截断漏网」（下沉先例 = codePointLength
 *  ）。：下沉时留在 process/summary.ts 的 re-export 中转已剥除——
 *  消费方一律直引本模块（中转层即 ai↔process 的环边来源）。 */
export function clipByCodePoints(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('')
}

/** 毫秒 → 作者可读时长短句（Opus-5.5 轮）。
 *
 *  起因：超时文案在 src/ai/runner.ts 里写死 `${timeoutMs / 60_000} 分钟`——档位 timeoutMs
 *  可被配置成任意毫秒值（如 90_000 → 「1.5 分钟」、30_000 → 「0.5 分钟」，极端值 60 →
 *  「0.001 分钟」），作者看到的小数分钟既不像他配的值也不可读。
 *
 *  口径：**向下取整**——文案说的是「超过 N …」（已发生的时长下界），例如 90_000ms 报
 *  「超过 1 分钟」为真、报「2 分钟」为假；单位按量级三档选最长可读者，毫秒档仅在
 *  <1s 时出现（正常配置不会走到，但档位可注入任意值，故不能假设）。
 *
 *  零内部依赖（同本模块惯例），任意层可引。 */
export function formatTimeoutText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return `${ms} 毫秒`
  if (ms < 1000) return `${Math.floor(ms)} 毫秒`
  if (ms < 60_000) return `${Math.floor(ms / 1000)} 秒`
  return `${Math.floor(ms / 60_000)} 分钟`
}
