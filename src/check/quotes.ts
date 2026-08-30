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

/** 证据提取专用宽容字符集（双体系 + ASCII 直引号）。R62-8：V-P2-12「证据匹配宁宽
 *  勿漏」口径此前散落在 leads.ts 正则字面量里、与「全部检查器从这里取字符集」的
 *  单源宣言分裂——收编为导出常量两文件同源。正文 span 检测（QUOTED_SPAN_RE）刻意
 *  不收 ASCII 引号（行为维持定谳，见六十二轮报告 R62-8）：span 面收紧/放宽波及
 *  golden 语料门与全部检查器行为，证据面宽容只影响 grep 截取。 */
export const QUOTE_OPEN_LENIENT = QUOTE_OPEN + '"'
export const QUOTE_CLOSE_LENIENT = QUOTE_CLOSE + '"'

/** 成对引号包裹的片段（跨体系配对：任一开 + 任一闭）。对话行/引文判定用。
 * R61-12（第六十一轮）：补单弯引号 ‘’——QUOTE_OPEN/QUOTE_CLOSE 常量自含 ‘’，
 * 此前本正则漏收，‘他低声道’ 一类单引号嵌套对白不构成 span（剥除/证据面漂移）。
 * R30-1（三十轮）：内部字符类补排换行（`[^」』”’\n]`）——引号片段不跨行，与中文
 * 对话按行组织的既有口径一致（本文件下方 stripQuotedSpans「按行高频调用」同口径）。
 * 契约变更：跨行引号片段不再构成 span。原字符类天然匹配换行，checkBannedWords/
 * checkOpeningNoEnv 对整 body 调 stripQuotedSpans 时，某段对白漏写闭引号（AI 草稿
 * 常见）会把从该开引号到下文任意闭引号（可隔多段）之间的全部叙述当对白剥除——
 * 禁词红闸对被吞叙述静默漏报（63 字实测剥掉 60 字）。补排换行后漏写闭引号的
 * 段内文本回到叙述面参与机检（宁误报不漏报）；单行消费方（对话行识别/新专名
 * 逐行 span 抽取）行为逐字不变。 */
export const QUOTED_SPAN_RE = /[「『“‘][^」』”’\n]*[」』”’]/

/** 剥除行内全部引号片段，返回引号外文本（对话标签判定只看提示语，V-P1-7）。
 *  R26-47（二十六轮）：本函数按行高频调用、原每次 new RegExp 提升为模块级常量
 *  （String.replace 对 g 正则每调用重置扫描位，共享常量安全，语义逐字不变）。 */
const QUOTED_SPAN_GLOBAL_RE = new RegExp(QUOTED_SPAN_RE.source, 'g')

export function stripQuotedSpans(line: string): string {
  return line.replace(QUOTED_SPAN_GLOBAL_RE, '')
}

/** 引号内常见的句读（对白内容特征：专名一般不含句读；对白以句读收尾或含句读）。 */
export const SPAN_PUNCT = '。！？，、；：…—,.!?;:'
