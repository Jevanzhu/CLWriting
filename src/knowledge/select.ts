/**
 * 写稿面方法选材(书级 > 随包语料 → 按章信号选判断类速查)。
 *
 * 语料形态 = 书级优先、随包兜底(统一批):每篇按 rel 先查书根 `知识层/<rel>`
 * (作者可编辑、按书不同、随书写更新),缺失/为空回落随包 `resources/knowledge/<rel>`
 * (恒在基线,与 知识层/ 同名件逐字节相等,check:knowledge 对账)。随包兜底 =
 * 存量书/未播种书逐字等于旧行为(零影响)。解析单源 = src/knowledge/corpus.ts。
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
import { clipWithNotice, codePointLength } from '../shared/text.js'
import { resolveCorpusFile, BUNDLED_SOURCE_PREFIX } from './corpus.js'
import { log } from '../log/index.js'

/** 合计篇数帽 / 单篇码点帽 / 合计码点帽 */
export const METHOD_MAX_FILES = 2
export const METHOD_FILE_CAP = 2000
export const METHOD_TOTAL_CAP = 3000

/** 内置语料相对路径(镜像 知识层/ 的目录结构;两处同构 = 对账门可按 rel 直接比对) */
export const METHOD_FILE_HOOKS = '追读力/章节钩子速查.md'
export const METHOD_FILE_REVERSAL = '爽点/反转设计速查.md'
export const METHOD_FILE_RHYTHM = '追读力/节奏与升级感速查.md'
export const METHOD_FILE_CHARACTER = '方法论/人物与对话技法速查.md'

/** 注入源登记前缀(bundled 资源不在书根下,files 清单以此前缀标记,永不与书内路径混同)。
 *  统一批后单源在 corpus.ts(书级走书根相对路径,随包走此前缀)。 */
export const METHOD_SOURCE_PREFIX = BUNDLED_SOURCE_PREFIX
/** 基础篇:长篇留钩是硬要求 → 钩子速查;短篇核心是反转 → 反转速查 */
function baseFileOf(kind: 'long' | 'short'): string {
  return kind === 'short' ? METHOD_FILE_REVERSAL : METHOD_FILE_HOOKS
}

/** 追加篇(固定优先级,每章至多追加 1 篇) */
const EXTRA_PICKS: ReadonlyArray<{ file: string; hit: RegExp }> = [
  { file: METHOD_FILE_RHYTHM, hit: /高潮|升级|爽点|节奏|期待|转折/ },
  { file: METHOD_FILE_CHARACTER, hit: /对话|人物|关系|感情线|对手戏/ },
]

export interface MethodInjection {
  /** 注入段全文;未选中/全篇读取失败为空串(不注入) */
  text: string
  /** 注入源登记名(书级 = `知识层/<rel>`;随包 = `知识层(内置)/<rel>`,注入序) */
  sources: string[]
}

/** 选篇:基础 1 篇 + 首个命中的追加篇(≤METHOD_MAX_FILES) */
export function pickMethodFiles(kind: 'long' | 'short', signals: string): string[] {
  const picks = [baseFileOf(kind)]
  for (const extra of EXTRA_PICKS) {
    if (picks.length >= METHOD_MAX_FILES) break
    if (extra.hit.test(signals)) picks.push(extra.file)
  }
  return picks
}
/**
 * 读单篇 → 剥 fm + 单篇帽(截断+标注单源 = shared/text.clipWithNotice)。
 * 书级优先、随包兜底(解析单源 corpus.ts);两级皆缺/读失败 → null(调用方跳过留痕)。
 */
function readMethodBody(bookRoot: string | undefined, file: string): { body: string; source: string } | null {
  const resolved = resolveCorpusFile(bookRoot, file)
  if (resolved === null) {
    log.warn('knowledge-select', `语料两级皆缺,跳过该篇:${file}(书级 知识层/${file} 与随包均不可读)`)
    return null
  }
  return { body: clipWithNotice(resolved.body, METHOD_FILE_CAP), source: resolved.source }
}

/**
 * 组装写稿方法参考段。段头口径与 chat 面知识层注入同源(「冲突时以设定为准」)——
 * 方法参考是写作纪律,不得覆盖本书设定的硬事实。
 *
 * bookRoot 缺省(直调/测试路径)→ 只读随包,逐字等于统一批前行为。
 */
export function buildMethodInjection(args: {
  kind: 'long' | 'short'
  signals: string
  bookRoot?: string
}): MethodInjection {
  const parts: string[] = []
  const sources: string[] = []
  let total = 0
  for (const file of pickMethodFiles(args.kind, args.signals)) {
    const picked = readMethodBody(args.bookRoot, file)
    if (picked === null) continue
    const len = codePointLength(picked.body)
    if (total + len > METHOD_TOTAL_CAP) {
      log.warn('knowledge-select', `方法参考合计超帽(${METHOD_TOTAL_CAP} 码点),本篇不入段:${file}`)
      continue
    }
    total += len
    const title = file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/, '')
    parts.push(`### ${title}\n${picked.body}`)
    sources.push(picked.source)
  }
  if (parts.length === 0) return { text: '', sources: [] }
  return {
    text: `## 写作方法参考(按本章自动选取,冲突时以本书设定为准)\n${parts.join('\n\n')}`,
    sources,
  }
}
