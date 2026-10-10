/**
 * 写稿面方法选材（随包语料 → 按章信号选判断类速查）。
 *
 * 语料形态 = 随包子集 `resources/knowledge/`（与 `知识层/` 同名文件逐字节相等，
 * check:knowledge 对账）：语料随安装包走，对每本书默认生效——不走「书根自带」那条
 * （书级副本会各自漂移且应用升级刷不到；chat 面仍读书根的 `知识层/`，两口径并存）。
 *
 * 选材规则（确定性，可测）：
 * - 基础篇恒选 1：长篇＝章节钩子速查（留钩是硬要求）、短篇＝反转设计速查（核心是反转）；
 * - 追加篇至多 1，按固定优先级取首个命中：节奏与升级感速查（高潮/升级/爽点/节奏/
 *   期待/转折）→ 人物与对话技法速查（对话/人物/关系/感情线/对手戏）；
 * - 信号 = 本章细纲 + 章纲原文（含 front matter 键值，钩子类型/情绪定位/场景等声明
 *   天然成为命中词）；合计 ≤2 篇、单篇 ≤2000 码点、合计 ≤3000 码点（比 chat 面
 *   6000 紧：首稿 prompt 已有细纲/章纲/备料/设定/样章五段料，方法段只补判断类技法）。
 *
 * 容错：单篇读失败/缺失 → 跳过该篇留痕（方法参考是增强，绝不阻断写稿）；全空返回
 * 空段（注入方按「空段不入 prompt 不登记」契约处置）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { bundledResource } from '../fs/resources.js'
import { bodyOf } from '../format/frontmatter-core.js'
import { clipByCodePoints, codePointLength } from '../shared/text.js'
import { log } from '../log/index.js'

/** 合计篇数帽 / 单篇码点帽 / 合计码点帽 */
export const METHOD_MAX_FILES = 2
export const METHOD_FILE_CAP = 2000
export const METHOD_TOTAL_CAP = 3000

/** 内置语料相对路径（镜像 知识层/ 的目录结构；两处同构 = 对账门可按 rel 直接比对） */
export const METHOD_FILE_HOOKS = '追读力/章节钩子速查.md'
export const METHOD_FILE_REVERSAL = '爽点/反转设计速查.md'
export const METHOD_FILE_RHYTHM = '追读力/节奏与升级感速查.md'
export const METHOD_FILE_CHARACTER = '方法论/人物与对话技法速查.md'

/** 注入源登记前缀（bundled 资源不在书根下，files 清单以此前缀标记，永不与书内路径混同） */
export const METHOD_SOURCE_PREFIX = '知识层(内置)/'

/** 基础篇：长篇留钩是硬要求 → 钩子速查；短篇核心是反转 → 反转速查 */
function baseFileOf(kind: 'long' | 'short'): string {
  return kind === 'short' ? METHOD_FILE_REVERSAL : METHOD_FILE_HOOKS
}

/** 追加篇（固定优先级，每章至多追加 1 篇） */
const EXTRA_PICKS: ReadonlyArray<{ file: string; hit: RegExp }> = [
  { file: METHOD_FILE_RHYTHM, hit: /高潮|升级|爽点|节奏|期待|转折/ },
  { file: METHOD_FILE_CHARACTER, hit: /对话|人物|关系|感情线|对手戏/ },
]

export interface MethodInjection {
  /** 注入段全文；未选中/全篇读取失败为空串（不注入） */
  text: string
  /** 注入源登记名（`知识层(内置)/…`，注入序） */
  sources: string[]
}

/** 选篇：基础 1 篇 + 首个命中的追加篇（≤METHOD_MAX_FILES） */
export function pickMethodFiles(kind: 'long' | 'short', signals: string): string[] {
  const picks = [baseFileOf(kind)]
  for (const extra of EXTRA_PICKS) {
    if (picks.length >= METHOD_MAX_FILES) break
    if (extra.hit.test(signals)) picks.push(extra.file)
  }
  return picks
}

/** 读单篇 → 剥 fm + 单篇帽；缺失/读失败 return null（调用方跳过留痕） */
function readMethodBody(file: string): string | null {
  const abs = bundledResource('knowledge', file)
  if (!existsSync(abs)) {
    log.warn('knowledge-select', `随包语料缺失，跳过该篇：${file}`)
    return null
  }
  try {
    const body = bodyOf(readFileSync(abs, 'utf-8')).trim()
    if (body === '') return null
    return codePointLength(body) > METHOD_FILE_CAP ? `${clipByCodePoints(body, METHOD_FILE_CAP)}\n…（超长截断）` : body
  } catch (e) {
    log.warn('knowledge-select', `随包语料读取失败，跳过该篇：${file}（${e instanceof Error ? e.message : String(e)}）`)
    return null
  }
}

/**
 * 组装写稿方法参考段。段头口径与 chat 面知识层注入同源（「冲突时以设定为准」）——
 * 方法参考是写作纪律，不得覆盖本书设定的硬事实。
 */
export function buildMethodInjection(args: { kind: 'long' | 'short'; signals: string }): MethodInjection {
  const parts: string[] = []
  const sources: string[] = []
  let total = 0
  for (const file of pickMethodFiles(args.kind, args.signals)) {
    const body = readMethodBody(file)
    if (body === null) continue
    const len = codePointLength(body)
    if (total + len > METHOD_TOTAL_CAP) {
      log.warn('knowledge-select', `方法参考合计超帽（${METHOD_TOTAL_CAP} 码点），本篇不入段：${file}`)
      continue
    }
    total += len
    const title = file.slice(file.lastIndexOf('/') + 1).replace(/\.md$/, '')
    parts.push(`### ${title}\n${body}`)
    sources.push(`${METHOD_SOURCE_PREFIX}${file}`)
  }
  if (parts.length === 0) return { text: '', sources: [] }
  return {
    text: `## 写作方法参考(按本章自动选取,冲突时以本书设定为准)\n${parts.join('\n\n')}`,
    sources,
  }
}
