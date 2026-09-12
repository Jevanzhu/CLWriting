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

/** 证据提取专用宽容字符集（双体系 + ASCII 直引号 + ASCII 单引号）。R62-8：V-P2-12「证据匹配宁宽
 *  勿漏」口径此前散落在 leads.ts 正则字面量里、与「全部检查器从这里取字符集」的
 *  单源宣言分裂——收编为导出常量两文件同源。正文 span 检测（QUOTED_SPAN_RE）刻意
 *  不收 ASCII 引号（行为维持定谳，见六十二轮报告 R62-8）：span 面收紧/放宽波及
 *  golden 语料门与全部检查器行为，证据面宽容只影响 grep 截取。
 *  R0912-3（2026-09-12 全量重评修复批）：补 ASCII 单引号（'）——单引号包裹的证据
 *  此前两头落空（CORE 取不到内文、edge/all 剥不掉引号），正文以无引号形式写同文时
 *  grep 整组 miss → lead-evidence-miss 伪红（fail-noisy 向，宁宽勿漏口径内的漏字）。
 *  误剥面评估：本集只供证据面正则（leads.ts EVIDENCE_* 族与 setting-rule 候选抽取）
 *  ——stripQuotedSpans 用字面 QUOTED_SPAN_RE（无 ASCII 引号），禁词/意象/比喻/身体
 *  部位/开头等剥引号消费面对 it's 类撇号文本行为零变化；中文小说语境 ASCII 单引号
 *  几乎只作包裹用，证据针串多候选（任一命中即算）对撇号边缘形态亦有兜底。 */
export const QUOTE_OPEN_LENIENT = QUOTE_OPEN + '"\''
export const QUOTE_CLOSE_LENIENT = QUOTE_CLOSE + '"\''

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

const QUOTED_SPAN_GLOBAL_RE = new RegExp(QUOTED_SPAN_RE.source, 'g')

/** 剥除行内全部引号片段，返回引号外文本（对话标签判定只看提示语，V-P1-7）。
 *  R26-47（二十六轮）：本函数按行高频调用、原每次 new RegExp 提升为模块级常量
 *  （String.replace 对 g 正则每调用重置扫描位，共享常量安全，语义逐字不变）。
 *  R0912-F-P3-1（2026-09-12 独立重评修复批）：2-slot 引用 memo——runAllChecks 每
 *  章对同一章 body 重复调用 6 处（count.ts 禁词/意象/文风标签/身体部位/比喻/开头
 *  窗口），剥引号全量重扫白付；最近两次入参 string === 命中即直接返回缓存结果。
 *  刻意不用 Map/WeakMap 长队列：string 键会持有大正文引用，无界缓存 = 常驻内存
 *  泄漏面——只留 2 个有限槽位（先例 frontmatter-core splitFrontMatter memo），
 *  命中靠 === 全等（字符串不可变，缓存恒正确），不持有额外引用面之外无内存代价。 */
const STRIP_MEMO_SLOTS = 2
const stripMemoKeys: Array<string | undefined> = new Array(STRIP_MEMO_SLOTS)
const stripMemoVals: Array<string | undefined> = new Array(STRIP_MEMO_SLOTS)
let stripMemoNext = 0

export function stripQuotedSpans(line: string): string {
  for (let i = 0; i < STRIP_MEMO_SLOTS; i++) {
    if (stripMemoKeys[i] === line) return stripMemoVals[i] as string
  }
  const out = line.replace(QUOTED_SPAN_GLOBAL_RE, '')
  const slot = stripMemoNext
  stripMemoNext = (stripMemoNext + 1) % STRIP_MEMO_SLOTS
  stripMemoKeys[slot] = line
  stripMemoVals[slot] = out
  return out
}

/** 引号内常见的句读（对白内容特征：专名一般不含句读；对白以句读收尾或含句读）。 */
export const SPAN_PUNCT = '。！？，、；：…—,.!?;:'
