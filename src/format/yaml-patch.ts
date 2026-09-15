/**
 * book.yaml 文本级补丁族 —— 自 yaml.ts 拆出（R0916-5e，2026-09-16，⑤④产品巨件拆分
 * 波1 · 缝 B）。
 *
 * 读改写场景不走 stringifyBookConfig 全量重生成（解析模型只保已知字段，作者的 #
 * 注释、未知段、未知子键会静默丢失）——本族只重写目标段/键的行区间，区间外原文
 * 逐字保留。内容（自 yaml.ts 纯搬移，代码与注释逐字未改）：matchesKeyLine/
 * locateTopSection/patchTopSection/setTopSectionKey/setSectionKeyBlock/
 * setTopScalarKey/ConfigPatchLeaf/CONFIG_PATCH_LEAVES/leafEquals/patchBookConfigText
 * （renderScalar 因依赖方向落位 yaml-spec.ts——scalarLeafEmit 调用它而本文件依赖
 * SECTION_SPECS，落此即成环，见 yaml-spec.ts 头注记档）。
 * 既有导出面（TopSectionSpan/locateTopSection/patchTopSection/setTopSectionKey/
 * setSectionKeyBlock/patchBookConfigText）由 yaml.ts 具名 re-export 桥接，全库
 * import 面零改动。依赖方向：yaml-spec（schema 表 + 表派生白名单）+ fs/text-canonical。
 */

import type { BookConfig } from './types.js'
import { canonicalizeText } from '../fs/text-canonical.js'
import { SECTION_SPECS, renderScalar, type ConfigKeySpec } from './yaml-spec.js'

/**
 * 文本级补丁：替换或追加一个顶层段（V-P2-4）。
 *
 * 读改写场景（历史生产例 enableRag 已删，现存直接消费面为补丁族测试）不能走
 * stringifyBookConfig 全量重生成——解析模型只保
 * 已知字段，作者的 # 注释、未知段、未知子键会静默丢失。此函数只重写目标段的
 * 行区间，区间外的原文（含注释与未知内容）逐字保留。
 *
 * @param raw 现有 book.yaml 全文（空串 = 无文件，纯追加）
 * @param section 顶层段名（如 'rag'）
 * @param body 段体行（不含段头行，如 '  enabled: true'）
 */
/** Z-7（第五十八轮）：补丁族段定位的 CRLF 容忍——split('\n') 残留 \r 尾，无值段头
 *  （`book:\r`）两条件均不中会走追加分支在文件尾造重复段（解析取首个段 → 改动静默丢失）。
 *  统一剥 \r 后比对（md 侧 frontmatter 同族口径）。
 *  R37-10（三十七轮）/ R2W-6（win 平台专项复审 R2）双线同旨合并：再补行首 BOM 剥除
 *  （只剥一次）——文件首键行带 UTF-8 BOM（\uFEFF，记事本「UTF-8 with BOM」保存形态）
 *  时段定位同样失明、误走追加分支造重复段/重复键（下次解析撞 fail-loud 重复守卫，
 *  全书配置降级默认；读侧先例 R33D-3；调用方均为 findIndex 直吃 raw 原文，上游无
 *  统一剥除点，故在本函数收口）。 */
function matchesKeyLine(line: string, key: string): boolean {
  const noBom = line.startsWith('\uFEFF') ? line.slice(1) : line
  const bare = noBom.endsWith('\r') ? noBom.slice(0, -1) : noBom
  return bare === `${key}:` || bare.startsWith(`${key}: `)
}

/**
 * P1-6（复审-0914-优化修复批）：补丁族段定位单源——此前 patchTopSection /
 * setTopSectionKey / setSectionKeyBlock（yaml.ts 三处）与 migrate-defaults
 * （matchesKeyLineCRLF + topSectionSpan + 段内最小缩进循环）四处逐字重复
 * 「段头扫描 + 段尾扫描 + 段体最小缩进」骨架；现收编本函数，四处改薄壳/委托。
 *
 * 定位边界语义逐位保留（含 R71-4 / Z-7 修复语义）：
 * - 段头：matchesKeyLine——剥行首 BOM（只一次，R37-10/R2W-6）与行尾 \r（Z-7 CRLF
 *   容忍）后全等 `key:` 或前缀 `key: `；
 * - end = 下一个顶层 key（非缩进、非注释、非空行）之前；段到文件尾 = lines.length；
 * - childIndent = 段体内容行（非空、非注释）最小缩进；段体无内容行 = -1。
 *   （migrate-defaults 侧 matchesKeyLineCRLF 原无 BOM 剥除——其头注自记「同
 *   yaml.ts matchesKeyLine 口径」，本地复制漏 BOM 属口径漂移，单源后按注释意图
 *   对齐为含 BOM 剥除形态；该差异面仅及「BOM 文件首段定位失败走 no-op」一隅，
 *   修后 BOM 存量书迁移恢复生效。）
 */
export interface TopSectionSpan {
  start: number
  end: number
  childIndent: number
}

export function locateTopSection(lines: readonly string[], section: string): TopSectionSpan | null {
  const start = lines.findIndex((l) => matchesKeyLine(l, section))
  if (start === -1) return null
  // 段区间末尾 = 下一个顶层 key（非缩进、非注释、非空行）之前
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (l.trim() !== '' && !l.trimStart().startsWith('#') && !/^\s/.test(l)) {
      end = i
      break
    }
  }
  // 直接子键缩进 = 段体内容行最小缩进（嵌套更深的行不是本段的直接子键）
  let childIndent = -1
  for (let i = start + 1; i < end; i++) {
    const l = lines[i]!
    if (l.trim() === '' || l.trimStart().startsWith('#')) continue
    const ind = l.length - l.trimStart().length
    if (childIndent === -1 || ind < childIndent) childIndent = ind
  }
  return { start, end, childIndent }
}

export function patchTopSection(raw: string, section: string, body: string): string {
  // 平台规范化批（2026-09-03）：输出规范形（LF）——MP2-4 的「新行随原文行尾」语义
  // 随规范形拍板翻转；未触碰行原样保留（含注释），其 CRLF 残尾随整输出归一剥除。
  const lines = raw.split('\n')
  const span = locateTopSection(lines, section) // P1-6：段定位委托单源
  if (!span) {
    // 追加：空文件直接写；有内容则补齐结尾换行 + 空行分隔（对齐 stringify 的段间风格）。
    const sectionLines = [`${section}:`, ...body.split('\n')]
    if (raw === '') return `${sectionLines.join('\n')}\n`
    const prefix = raw.endsWith('\n') ? raw : `${raw}\n`
    return canonicalizeText(`${prefix}\n${sectionLines.join('\n')}\n`)
  }
  const { start, end } = span
  // 保留旧段尾部的空行 run（段间分隔）——替换体本身无尾空行，不补会与下一段粘连
  let blanks = 0
  for (let i = end - 1; i > start; i--) {
    if (lines[i]!.trim() === '') blanks++
    else break
  }
  return canonicalizeText(
    [
      ...lines.slice(0, start),
      `${section}:`,
      ...body.split('\n'),
      ...Array.from({ length: blanks }, () => ''),
      ...lines.slice(end),
    ].join('\n'),
  )
}

/**
 * GG-P2-8：文本级替换顶层段内单个子键行（只动 `key:` 那一行，段内其余行含未知子键、
 * 缩进注释逐字保留；段外内容更是零触碰）。
 *
 * 与 patchTopSection（整段替换）的取舍：改名/单项改值场景单键行替换更小更稳——
 * 整段替换须重排段体（未知子键会丢），单键行替换天然保形。区间口径与 patchTopSection
 * 一致（下一个顶层 key 之前）；直接子键缩进 = 段体内容行最小缩进（嵌套更深的行不碰）。
 *
 * 键不存在 → 插在段头之后（body 空时用 2 空格惯例）；段不存在 → 追加只含该键的段
 * （与 patchTopSection 追加分支同风格）。title 行若带行尾注释会随行重写丢失（值本身
 * 罕见带注释，接受；整段保注释的目标由「其余行不动」达成）。
 */
export function setTopSectionKey(raw: string, section: string, key: string, value: string): string {
  // 平台规范化批：输出规范形（LF）——MP2-4 行尾保真语义翻转（patchTopSection 同款）
  const lines = raw.split('\n')
  const span = locateTopSection(lines, section) // P1-6：段定位委托单源
  const keyLine = (indent: number): string => ' '.repeat(indent) + `${key}: ${value}`
  if (!span) {
    const sectionLines = [`${section}:`, keyLine(2)]
    if (raw === '') return `${sectionLines.join('\n')}\n`
    const prefix = raw.endsWith('\n') ? raw : `${raw}\n`
    return canonicalizeText(`${prefix}\n${sectionLines.join('\n')}\n`)
  }
  const { start, end, childIndent } = span
  if (childIndent === -1) {
    // 段体无内容行 → 键插在段头后
    lines.splice(start + 1, 0, keyLine(2))
    return canonicalizeText(lines.join('\n'))
  }
  const pad = ' '.repeat(childIndent)
  // R71-4：键行匹配剥 \r（上方 matchesKeyLine 同口径，Z-7 同族）——CRLF book.yaml 的
  // 裸键行（`  thresholds:\r`）两条件均不中会被判「键不存在」，替换走插入分支残留
  // 旧块成重复段
  const isKeyLine = (l: string): boolean => {
    const bare = l.endsWith('\r') ? l.slice(0, -1) : l
    return bare === `${pad}${key}:` || bare.startsWith(`${pad}${key}: `)
  }
  for (let i = start + 1; i < end; i++) {
    if (isKeyLine(lines[i]!)) {
      lines[i] = keyLine(childIndent)
      return canonicalizeText(lines.join('\n'))
    }
  }
  // 键不在段内 → 插在段头后首行（先于既有子键，与 stringify 的 title 首位习惯一致）
  lines.splice(start + 1, 0, keyLine(childIndent))
  return canonicalizeText(lines.join('\n'))
}

// ── kk-P1-5：PUT /config 的文本级补丁写 ──────────

/**
 * 文本级替换/删除/插入段内单个子键块（键行 + 其块列表 `- ` 项 / 嵌套映射子行）。
 *
 * setTopSectionKey 只重写键行本身——值是块列表（`- 项`）或嵌套映射（thresholds）
 * 时，旧块行会残留成孤儿。本函数把键行连同其块行整段换掉；区间/缩进口径与
 * setTopSectionKey 一致（下一个顶层 key 之前；段体内容行最小缩进 = 直接子键缩进）。
 *
 * @param keyLine 键行内容（不含缩进，如 `title: 新书名` / `thresholds:`）；null = 删除整个键块
 * @param blockLines 键行后的块体行（不含缩进，函数按子键缩进+2 落位；仅嵌套映射用）
 */
export function setSectionKeyBlock(
  raw: string,
  section: string,
  key: string,
  keyLine: string | null,
  blockLines: string[] = [],
): string {
  // 平台规范化批：输出规范形（LF）——MP2-4 同族连带语义翻转（patchTopSection 同款）
  const lines = raw.split('\n')
  const span = locateTopSection(lines, section) // P1-6：段定位委托单源
  if (!span) {
    if (keyLine === null) return raw
    const body = [`  ${keyLine}`, ...blockLines.map((l) => `    ${l}`)]
    if (raw === '') return `${section}:\n${body.join('\n')}\n`
    const prefix = raw.endsWith('\n') ? raw : `${raw}\n`
    return canonicalizeText(`${prefix}\n${section}:\n${body.join('\n')}\n`)
  }
  const { start, end, childIndent } = span
  const pad = ' '.repeat(childIndent === -1 ? 2 : childIndent)
  if (childIndent !== -1) {
    // R71-4：键行匹配剥 \r（上方 matchesKeyLine 同口径，Z-7 同族）——CRLF book.yaml 的
    // 裸键行（`  thresholds:\r`）两条件均不中会被判「键不存在」：删除模式静默丢改
    // （原样返回）、替换模式在段头后再插一份残留重复块
    const isKeyLine = (l: string): boolean => {
      const bare = l.endsWith('\r') ? l.slice(0, -1) : l
      return bare === `${pad}${key}:` || bare.startsWith(`${pad}${key}: `)
    }
    for (let i = start + 1; i < end; i++) {
      if (!isKeyLine(lines[i]!)) continue
      // 块体吞并：同缩进 `- ` 列表项（YAML 允许列表与键同列）或更深缩进的内容行
      let blockEnd = i + 1
      while (blockEnd < end) {
        const l = lines[blockEnd]!
        if (l.trim() === '' || l.trimStart().startsWith('#')) break
        const ind = l.length - l.trimStart().length
        if ((l.trimStart().startsWith('- ') && ind >= childIndent) || ind > childIndent) blockEnd++
        else break
      }
      const replacement =
        keyLine === null ? [] : [pad + keyLine, ...blockLines.map((l) => pad + '  ' + l)]
      lines.splice(i, blockEnd - i, ...replacement)
      return canonicalizeText(lines.join('\n'))
    }
  }
  // 键不在段内：插入模式插在段头后；删除模式无键可删，原样返回
  if (keyLine === null) return raw
  lines.splice(start + 1, 0, ...[pad + keyLine, ...blockLines.map((l) => pad + '  ' + l)])
  return canonicalizeText(lines.join('\n'))
}

/** 顶层标量键（spec_version/kind/host）的替换/删除/插入（无缩进，含锚定插入） */
function setTopScalarKey(raw: string, key: string, line: string | null): string {
  // 平台规范化批：输出规范形（LF）——MP2-4 同族连带语义翻转
  const lines = raw.split('\n')
  const idx = lines.findIndex((l) => matchesKeyLine(l, key))
  if (idx !== -1) {
    if (line === null) lines.splice(idx, 1)
    else lines[idx] = line
    return canonicalizeText(lines.join('\n'))
  }
  if (line === null) return raw
  // 插在 spec_version 行后（文件头惯例位置）；无则文件首行
  const anchor = lines.findIndex((l) => matchesKeyLine(l, 'spec_version'))
  lines.splice(anchor === -1 ? 0 : anchor + 1, 0, line)
  return canonicalizeText(lines.join('\n'))
}

/** 补丁叶子：段内单键 + 取有效值（undefined = 该键不落行——归一口径对齐 stringifyBookConfig） */
interface ConfigPatchLeaf {
  section: string
  key: string
  get: (c: BookConfig) => unknown
}

// P1-5（复审-0914-优化修复批）：补丁白名单改 schema 表派生（有 get 的键行即补丁叶，
// 派生序 = 表序 = 历史 stringifyBookConfig 落行序）。历史两次漏登事故（D3+C1+A3
// 双口径/开关/深度键、R52-E-2 机检阈值五键：parse/stringify 已收而白名单漏登，
// PUT /config 改这些键会静默不落盘）自此结构性杜绝——parse 收的键表里必有行。
// leads.thresholds 动态映射无叶键 get（patchBookConfigText 特例块处理）。
// 派生结果与历史手写登记表逐行等价（无新增/删减），yaml-schema-snapshot 快照锁。
const CONFIG_PATCH_LEAVES: readonly ConfigPatchLeaf[] = SECTION_SPECS.flatMap((spec) =>
  spec.keys
    .filter((k): k is ConfigKeySpec & { get: (c: BookConfig) => unknown } => k.get !== undefined)
    .map((k) => ({ section: spec.name, key: k.key, get: k.get })),
)

function leafEquals(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * kk-P1-5：PUT /config 的文本级补丁——对比旧解析值与新配置，只重写发生变化的键行，
 * 其余原文（作者手写注释、未知段、未知子键、块列表/嵌套块的排版）逐字保留。
 *
 * 此前 PUT 走 stringifyBookConfig 全量重生成，与 migrate-defaults 修掉的红线同款：
 * 解析模型只保已知字段，作者注释/未知段静默丢失。调用方须传「同一文件解析出的
 * 旧配置」当基线（解析烘焙的默认值两边一致，diff 只会浮出用户真实改动——缺段
 * 文件不会被默认值污染出一堆新行）。
 */
export function patchBookConfigText(raw: string, oldCfg: BookConfig, newCfg: BookConfig): string {
  let text = raw
  const top = (key: string, from: unknown, to: unknown): void => {
    if (leafEquals(from, to)) return
    text = to === undefined ? setTopScalarKey(text, key, null) : setTopScalarKey(text, key, `${key}: ${renderScalar(to)}`)
  }
  top('spec_version', oldCfg.spec_version, newCfg.spec_version)
  // Y-25（第五十七轮·登记说明）：short→long 时此处写显式 `kind: long`，与
  // stringifyBookConfig「long 缺省不写」口径不一——文本补丁是单键外科替换，改成
  // 删除行需重排注释邻接结构，风险大于收益；解析侧认 long（语义无损），维持显式写。
  top('kind', oldCfg.kind, newCfg.kind)
  top('host', oldCfg.host ?? 'cc', newCfg.host ?? 'cc')

  for (const leaf of CONFIG_PATCH_LEAVES) {
    const from = leaf.get(oldCfg)
    const to = leaf.get(newCfg)
    if (leafEquals(from, to)) continue
    text = setSectionKeyBlock(text, leaf.section, leaf.key, to === undefined ? null : `${leaf.key}: ${renderScalar(to)}`)
  }

  // thresholds 嵌套映射：键行 + 子行整块换（含删除）
  const thFrom = oldCfg.leads.thresholds
  const thTo = newCfg.leads.thresholds
  if (!leafEquals(thFrom, thTo)) {
    text = setSectionKeyBlock(
      text,
      'leads',
      'thresholds',
      thTo === undefined ? null : 'thresholds:',
      thTo === undefined ? [] : Object.entries(thTo).map(([k, v]) => `${k}: ${v}`),
    )
  }
  return text
}
