/**
 * 中文引号体系单一真相源（V-P1-6/V-P2-12）。
 *
 * 此前 count.ts 与 leads.ts 三处各写一套引号字符集，且各有漏字：
 * 对话行识别缺 U+201C（“）、证据提取只认 ASCII 直引号——中文网文两种主流
 * 引号（「」与 “”）在三个检查器里分别被漏掉一种。全部检查器从这里取字符集。
 */

/** 开引号（直角 + 弯引号双体系） */
export const QUOTE_OPEN = '「『“‘'
/** 闭引号（直角 + 弯引号双体系） */
export const QUOTE_CLOSE = '」』”’'

/** 成对引号包裹的片段（跨体系配对：任一开 + 任一闭）。对话行/引文判定用。 */
export const QUOTED_SPAN_RE = /[「『“][^」』”]*[」』”]/

/** 剥除行内全部引号片段，返回引号外文本（对话标签判定只看提示语，V-P1-7）。 */
export function stripQuotedSpans(line: string): string {
  return line.replace(new RegExp(QUOTED_SPAN_RE.source, 'g'), '')
}

/** 引号内常见的句读（对白内容特征：专名一般不含句读；对白以句读收尾或含句读）。 */
export const SPAN_PUNCT = '。！？，、；：…—,.!?;:'
