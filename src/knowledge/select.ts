/**
 * 写稿面方法选材策略(书级 > 随包语料 → 按章信号选判断类速查)。
 *
 * 语料形态 = 书级优先、随包兜底(每篇按 rel 先查书根 `知识层/<rel>`,缺失/为空回落
 * 随包 `resources/knowledge/<rel>`;解析单源 = src/knowledge/corpus.ts)。随包兜底 =
 * 存量书/未播种书逐字等于旧行为(零影响)。
 *
 * 本模块只留**选材策略**(选哪些篇、帽值多少、为何入选);装配(解析/截断/计量/
 * 拼段/登记/超帽处置)单源 = src/knowledge/inject.ts。
 *
 * 选材规则(确定性,可测):
 * - 基础篇恒选 1:长篇=章节钩子速查(留钩是硬要求)、短篇=反转机制速查(核心是反转);
 * - 追加篇至多 1,按**本档候选表**的固定优先级取首个命中(见 KIND_PICKS);
 * - 信号 = 本章细纲 + 章纲原文(含 front matter 键值,钩子类型/情绪定位/场景等声明
 *   天然成为命中词);合计 ≤2 篇、单篇 ≤3000 码点、合计 ≤6000 码点(与对话面同帽:
 *   语料篇目按 ≤3000 码点改写,帽低于此值会把每篇尾部自检清单系统性截掉)。
 *
 * 候选取篇按 `kind` 分表:长篇篇只进长篇书、短篇篇只进短篇书——两档的语料在
 * 「钩子落在哪、反转何时闭口」上口径相反,混装即跨档口径污染(语料档 §四.3)。
 *
 * 容错:单篇读失败/两级皆缺 → 跳过该篇留痕(方法参考是增强,绝不阻断写稿);全空返回
 * 空段(注入方按「空段不入 prompt 不登记」契约处置)。
 */
import { assembleKnowledge, type KnowledgeAssembly } from './inject.js'
import {
  GENERAL_FILE_CHARACTER,
  GENERAL_FILE_DIALOGUE,
  LONG_FILE_CORE,
  LONG_FILE_EMOTION,
  LONG_FILE_GENRE,
  LONG_FILE_HOOKS,
  LONG_FILE_OPENING,
  LONG_FILE_OUTLINE,
  LONG_FILE_REVERSAL,
  LONG_FILE_RHYTHM,
  LONG_FILE_SUSPENSE,
  SHORT_FILE_EMOTION,
  SHORT_FILE_GENRE,
  SHORT_FILE_HOOKS,
  SHORT_FILE_PARAGRAPH,
  SHORT_FILE_REVERSAL,
  SHORT_FILE_SUSPENSE,
} from './catalog.js'

/** 合计篇数帽 / 单篇码点帽 / 合计码点帽 */
export const METHOD_MAX_FILES = 2
export const METHOD_FILE_CAP = 3000
export const METHOD_TOTAL_CAP = 6000

/** 段头(整块前缀,含其后换行——换行形态是测试锚定面,由本面逐字给全) */
const METHOD_HEADING = '## 写作方法参考(按本章自动选取,冲突时以本书设定为准)\n'

/** 选篇结果:篇目 + 入选理由 */
interface MethodPick {
  rel: string
  reason: string
}

/** 追加篇候选:命中词 + 入选理由(报告面人话);表序即优先级 */
interface ExtraPick {
  file: string
  hit: RegExp
  reason: string
}

/**
 * 长篇追加篇候选(章级关切在前:节奏/反转/悬念/情绪 → 人物/对话 → 开篇/卖点/大纲/题材)。
 *
 * 章纲的 front matter 键(钩子类型/情绪定位/场景)与细纲用语天然构成命中面;
 * 「场景: 对话」这类声明直接命中人物/对话两篇。
 */
const LONG_EXTRA_PICKS: readonly ExtraPick[] = [
  { file: LONG_FILE_RHYTHM, hit: /高潮|升级|爽点|节奏|期待|转折/, reason: '信号命中:节奏' },
  { file: LONG_FILE_REVERSAL, hit: /反转|打脸|揭示|埋线|反派|冲突/, reason: '信号命中:反转' },
  { file: LONG_FILE_SUSPENSE, hit: /悬念|信息差|线索|伏笔|谜/, reason: '信号命中:悬念' },
  { file: LONG_FILE_EMOTION, hit: /情绪|感情线|压抑|憋屈|燃|虐/, reason: '信号命中:情绪' },
  { file: GENERAL_FILE_CHARACTER, hit: /人物|人设|角色|对手戏|配角/, reason: '信号命中:人物' },
  { file: GENERAL_FILE_DIALOGUE, hit: /对话|台词/, reason: '信号命中:对话' },
  { file: LONG_FILE_OPENING, hit: /开篇|第一章|开头|黄金三章/, reason: '信号命中:开篇' },
  { file: LONG_FILE_CORE, hit: /卖点|核心梗|金手指/, reason: '信号命中:卖点' },
  { file: LONG_FILE_OUTLINE, hit: /大纲|卷纲|主线/, reason: '信号命中:大纲' },
  { file: LONG_FILE_GENRE, hit: /题材|流派/, reason: '信号命中:题材' },
]

/** 短篇追加篇候选(情绪/钩子是单篇语境的章级关切,其余同理) */
const SHORT_EXTRA_PICKS: readonly ExtraPick[] = [
  { file: SHORT_FILE_EMOTION, hit: /情绪|释放|回报|压抑|憋屈|燃|虐/, reason: '信号命中:情绪' },
  { file: SHORT_FILE_HOOKS, hit: /钩子|开篇|收尾|结尾/, reason: '信号命中:钩子' },
  { file: SHORT_FILE_PARAGRAPH, hit: /段落|中段|节奏/, reason: '信号命中:段落' },
  { file: SHORT_FILE_SUSPENSE, hit: /悬念|信息差|线索|伏笔/, reason: '信号命中:悬念' },
  { file: GENERAL_FILE_CHARACTER, hit: /人物|人设|角色|对手戏|配角/, reason: '信号命中:人物' },
  { file: GENERAL_FILE_DIALOGUE, hit: /对话|台词/, reason: '信号命中:对话' },
  { file: SHORT_FILE_GENRE, hit: /题材|配方/, reason: '信号命中:题材' },
]

/** 各档候选表 */
const KIND_PICKS: Record<'long' | 'short', readonly ExtraPick[]> = {
  long: LONG_EXTRA_PICKS,
  short: SHORT_EXTRA_PICKS,
}

/** 基础篇:长篇留钩是硬要求 → 钩子速查;短篇核心是反转 → 反转机制速查 */
function baseFileOf(kind: 'long' | 'short'): string {
  return kind === 'short' ? SHORT_FILE_REVERSAL : LONG_FILE_HOOKS
}

/** 选篇:基础 1 篇 + 首个命中的追加篇(≤METHOD_MAX_FILES) */
function pickMethodPieces(kind: 'long' | 'short', signals: string): MethodPick[] {
  const picks: MethodPick[] = [{ rel: baseFileOf(kind), reason: kind === 'short' ? '基础篇-短篇' : '基础篇-长篇' }]
  for (const extra of KIND_PICKS[kind]) {
    if (picks.length >= METHOD_MAX_FILES) break
    if (extra.hit.test(signals)) picks.push({ rel: extra.file, reason: extra.reason })
  }
  return picks
}

/** 选篇(篇目序;策略直测面) */
export function pickMethodFiles(kind: 'long' | 'short', signals: string): string[] {
  return pickMethodPieces(kind, signals).map((p) => p.rel)
}

/**
 * 组装写稿方法参考段。段头口径与 chat 面知识层注入同源(「冲突时以设定为准」)——
 * 方法参考是写作纪律,不得覆盖本书设定的硬事实。
 *
 * bookRoot 缺省(直调/测试路径)→ 只读随包,逐字等于统一批前行为。
 * `enabled === false`(书级开关关停)→ 不读盘,段与登记一并空。
 */
export function buildMethodInjection(args: {
  kind: 'long' | 'short'
  signals: string
  bookRoot?: string
  enabled?: boolean
}): KnowledgeAssembly {
  const picks = pickMethodPieces(args.kind, args.signals)
  return assembleKnowledge({
    bookRoot: args.bookRoot,
    rels: picks.map((p) => p.rel),
    heading: METHOD_HEADING,
    fileCap: METHOD_FILE_CAP,
    totalCap: METHOD_TOTAL_CAP,
    enabled: args.enabled,
    reasonOf: (_rel, i) => picks[i]!.reason,
  })
}
