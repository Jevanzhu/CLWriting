/**
 * 写稿面方法选材策略(书级 > 随包语料 → 按章信号选判断类速查)。
 *
 * 语料形态 = 书级优先、随包兜底(统一批):每篇按 rel 先查书根 `知识层/<rel>`
 * (作者可编辑、按书不同、随书写更新),缺失/为空回落随包 `resources/knowledge/<rel>`
 * (恒在基线,与 知识层/ 同名件逐字节相等,check:knowledge 对账)。随包兜底 =
 * 存量书/未播种书逐字等于旧行为(零影响)。解析单源 = src/knowledge/corpus.ts。
 *
 * 本模块只留**选材策略**(选哪些篇、帽值多少、为何入选);装配(解析/截断/计量/
 * 拼段/登记/超帽处置)单源 = src/knowledge/inject.ts。
 *
 * 选材规则(确定性,可测):
 * - 基础篇恒选 1:长篇=章节钩子速查(留钩是硬要求)、短篇=反转设计速查(核心是反转);
 * - 追加篇至多 1,按固定优先级取首个命中:节奏与升级感速查(高潮/升级/爽点/节奏/
 *   期待/转折)→ 人物与对话技法速查(对话/人物/关系/感情线/对手戏);
 * - 信号 = 本章细纲 + 章纲原文(含 front matter 键值,钩子类型/情绪定位/场景等声明
 *   天然成为命中词);合计 ≤2 篇、单篇 ≤2000 码点、合计 ≤3000 码点(比 chat 面
 *   6000 紧:首稿 prompt 已有细纲/章纲/备料/设定/样章五段料,方法段只补判断类技法)。
 *
 * 容错:单篇读失败/两级皆缺 → 跳过该篇留痕(方法参考是增强,绝不阻断写稿);全空返回
 * 空段(注入方按「空段不入 prompt 不登记」契约处置)。
 */
import { assembleKnowledge, type KnowledgeAssembly } from './inject.js'
import {
  METHOD_FILE_CHARACTER,
  METHOD_FILE_HOOKS,
  METHOD_FILE_REVERSAL,
  METHOD_FILE_RHYTHM,
} from './catalog.js'

/** 合计篇数帽 / 单篇码点帽 / 合计码点帽 */
export const METHOD_MAX_FILES = 2
export const METHOD_FILE_CAP = 2000
export const METHOD_TOTAL_CAP = 3000

/** 段头(整块前缀,含其后换行——换行形态是测试锚定面,由本面逐字给全) */
const METHOD_HEADING = '## 写作方法参考(按本章自动选取,冲突时以本书设定为准)\n'

/** 基础篇:长篇留钩是硬要求 → 钩子速查;短篇核心是反转 → 反转速查 */
function baseFileOf(kind: 'long' | 'short'): string {
  return kind === 'short' ? METHOD_FILE_REVERSAL : METHOD_FILE_HOOKS
}

/** 追加篇候选(固定优先级,每章至多追加 1 篇):命中词 + 入选理由(报告面人话) */
const EXTRA_PICKS: ReadonlyArray<{ file: string; hit: RegExp; reason: string }> = [
  { file: METHOD_FILE_RHYTHM, hit: /高潮|升级|爽点|节奏|期待|转折/, reason: '信号命中:节奏' },
  { file: METHOD_FILE_CHARACTER, hit: /对话|人物|关系|感情线|对手戏/, reason: '信号命中:人物' },
]

/** 选篇结果:篇目 + 入选理由 */
interface MethodPick {
  rel: string
  reason: string
}

/** 选篇:基础 1 篇 + 首个命中的追加篇(≤METHOD_MAX_FILES) */
function pickMethodPieces(kind: 'long' | 'short', signals: string): MethodPick[] {
  const picks: MethodPick[] = [
    { rel: baseFileOf(kind), reason: kind === 'short' ? '基础篇-短篇' : '基础篇-长篇' },
  ]
  for (const extra of EXTRA_PICKS) {
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
