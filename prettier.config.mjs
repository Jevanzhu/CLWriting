/**
 * 代码格式化门（质量债 P3-4）：全库单一格式口径，杜绝「缩进错乱」类手工漂移。
 *
 * printWidth 取值依据是既有代码实测分布，不是拍脑袋：src 非空行 117,687 行中 > 120
 * 的仅 375 行（0.6%）、> 100 的 1,379 行（1.8%）。取 120 让本次一次性归一化尽量只落在
 * 「本就该改」的形态上，不把大量成文长行拆开重排——同批实测全库真实 diff：
 * printWidth 100 → +46,821/−17,000 行；120 → +26,021/−14,357；140 → +18,858/−16,037。
 * 120 是「可读性尚在」与「改动面收敛」的折中点（100 会把 570 个 src 文件里的 433 个全改一遍）。
 *
 * 其余取值对齐既有代码的压倒性多数形态（实测）：行尾无分号（非 .d.ts 面分号 19 处 /
 * 行尾分号形态 44,607 处几乎全在第三方 .d.ts）、单引号、多行尾逗号（18,509 处）、
 * 两空格缩进、箭头函数单参带括号（5,701 处 vs 无括号 589 处）。endOfLine 钉 lf
 * 与 .gitattributes 的 `* text=auto eol=lf` 同口径，防跨机检出漂移破坏字节等价金测。
 */
export default {
  semi: false,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 120,
  tabWidth: 2,
  arrowParens: 'always',
  endOfLine: 'lf',
  vueIndentScriptAndStyle: false,
  proseWrap: 'preserve',
}
