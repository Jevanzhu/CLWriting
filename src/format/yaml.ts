/**
 * book.yaml 读写 —— 依据 #9 book.yaml 配置 spec。
 *
 * 与 frontmatter.ts 的区别：
 * - book.yaml 是独立 .yaml 文件（无 --- 包裹），机器域英文 key，多层嵌套段
 * - front matter 是中文 key、平铺、--- 包裹
 *
 * 这里手写一个支持「段（顶层 key）+ 缩进子字段」的极简解析，覆盖 #9 第 2 节 schema。
 *
 * 尺度登记：本文件 885 行属 schema 集中型（readBookConfig 及各段
 * 读写的单一事实源），拆 core/typed-schema 两层是结构优化非缺陷——随 rc 后重构批评估，
 * 拆分红线：readBookConfig 返回形状与 book.yaml 写入字节序不得变（fm 保形纪律同源）。
 *
 * 拆分沿革（⑤④产品巨件拆分波1 · 缝 A+B 纯移动拆分）：
 * - 键 schema 表族拆出 → yaml-spec.ts（三面单源：ConfigKeySpec/ConfigSectionSpec、
 *   六个叶键 parse 工厂、scalarLeafEmit、SECTION_SPECS 全表〔表行序 = 字节红线，原注
 *   随表同迁〕、SECTION_BY_NAME、PARSE_SECTION_ORDER、parseSectionSpec/dupChildError/
 *   findChild、parseFiniteNumber/parsePositiveNumber/parseStrictBool/warnBadBool、
 *   renderScalar〔侦察原划归 yaml-patch，因 scalarLeafEmit 依赖 + yaml-patch 反依赖
 *   SECTION_SPECS 会成环，实读调整落位 yaml-spec，代码逐字未动〕）；
 * - 文本级补丁族拆出 → yaml-patch.ts（matchesKeyLine/locateTopSection/patchTopSection/
 *   setTopSectionKey/setSectionKeyBlock/setTopScalarKey/ConfigPatchLeaf/
 *   CONFIG_PATCH_LEAVES/leafEquals/patchBookConfigText），既有导出由本文件末尾
 *   re-export 桥接，全库 import 面零改动；
 * - 残核：DEFAULT_CONFIG、段树解析（parseSections/RawSection）、sectionsToConfig、
 *   公开 API（readBookConfig/parseBookConfig/stringifyBookConfig/writeBookConfig）。
 *   代码纯搬移逐字未改，零行为变化；readBookConfig 返回形状与 book.yaml 写入字节序
 *   红线由 yaml-schema-snapshot 快照族测试锁住。
 */

import { readFileSync, existsSync } from 'node:fs'
import { atomicWriteFile } from '../fs/atomic.js'
import type { BookConfig, ParseError } from './types.js'
import { parseValue, stringifyValue } from './frontmatter.js'
import { stripInlineComment, firstKeyColon } from './frontmatter-core.js'
import { log } from '../log/index.js'
import {
  SECTION_SPECS,
  SECTION_BY_NAME,
  PARSE_SECTION_ORDER,
  parseSectionSpec,
  parseFiniteNumber,
} from './yaml-spec.js'

// ── 默认值（#9 第 3 节，待 beta 的给占位）────────
//
// 书级设定全局托底（13 键）：style 段、auto 段、budget.calls_per_chapter、book.genre
// 从 DEFAULT_CONFIG 摘除——readBookConfig 起步值里带着默认值的话，书文件没写 = 解析结果
// 恒有值，「书级未设 → 回落全局」永远被遮蔽（解析层看不见「未设」）。这些键的默认值
// 迁移到 GLOBAL_FALLBACK_DEFAULTS（format/global-defaults.ts），由运行时合并层
// applyGlobalDefaults 兜底；错误回落分支（readBookConfig !ok）也因此只带必填骨架。
// budget 其余三键（input/summary 长程预算）不进全局托底，照旧在此预填。

export const DEFAULT_CONFIG: BookConfig = {
  spec_version: 1,
  host: 'cc',
  book: { title: '' },
  leads: { enabled: [] },
  budget: {
    input_per_chapter: 80000,
    summary_chapter_max: 200,
    summary_volume_max: 500,
  },
  growth: { realm_span_max: 2 },
}

// ── 解析：段 + 缩进子字段 ────────────────────────

export interface RawSection {
  indent: number // 缩进含 tab 时 warn 一次——2 空格缩进协议下 tab 按字符数
  key: string
  value: string // 行内值（子段为空；块列表项后处理时拼成内联数组）
  children: RawSection[]
  listItems?: string[] // dd-块式列表项（`- xxx` 行）暂存，循环后拼进 value
}

/** 解析 YAML 文本为段树（支持 2 空格缩进） */
function parseSections(text: string): RawSection[] {
  const roots: RawSection[] = []
  const stack: RawSection[] = [] // 按缩进维护
  const listNodes: RawSection[] = [] // 收集了块列表项的节点（循环后统一拼值）
  const make = (indent: number, key: string, value: string): RawSection => ({
    indent,
    key,
    value,
    children: [],
  })

  // 上一行产出的键节点——用于「更深缩进行跟在有值键后」的错挂检测
  let lastNode: RawSection | undefined
  // tab 缩进 warn 留痕开关（首个 tab 一次，不刷屏）
  let tabWarned = false
  // 全角空格（U+3000）缩进 warn 留痕开关（同 tab 口径：每 parse 一次）
  let wideSpaceWarned = false
  for (const [lineNo, line] of text.split('\n').entries()) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    // 缩进含 tab 时 warn 一次——2 空格缩进协议下 tab 按字符数
    // 凑合可解析（计数维持现状，改语义风险大），但作者无从知晓文件混入了 tab、
    // 段挂靠类问题难排查；留痕不中断解析。
    if (!tabWarned && line.slice(0, indent).includes('\t')) {
      tabWarned = true
      log.warn(
        'book.yaml',
        `book.yaml 第 ${lineNo + 1} 行缩进含 tab（本协议为 2 空格缩进），已按字符数解析；建议改用空格`,
      )
    }
    // 缩进含全角空格（U+3000）时 warn 一次——tab 同款口径：
    // U+3000 同为 trimStart 认可的空白，按字符数凑合可解析（计数维持现状，与 tab
    // 同待遇），但作者无从知晓文件混入了全角空格、段挂靠类问题难排查；留痕不中断。
    if (!wideSpaceWarned && line.slice(0, indent).includes('\u3000')) {
      wideSpaceWarned = true
      log.warn(
        'book.yaml',
        `book.yaml 第 ${lineNo + 1} 行缩进含全角空格 U+3000（本协议为 2 空格缩进），已按字符数解析；建议改用半角空格`,
      )
    }
    const content = line.trim()
    // （ff）：有值键（`key: v`）不能有缩进子行——真 YAML 里这是语法错误
    // 此前子行会被静默挂到更外层段上（配置无声错位）。改挂前显式报错，宁可红不可错
    if (lastNode && lastNode.value !== '' && indent > lastNode.indent) {
      throw new Error(`第 ${lineNo + 1} 行缩进子行不能挂在有值键「${lastNode.key}:」下（YAML 语法错误）：${content}`)
    }
    // 低级项：块式列表项（`- xxx`）判定先于冒号——`- 惊悚: 高` 含冒号但语义
    // 是列表项文本，原先被当 key 行解析成键「- 惊悚」再被白名单静默吞掉（含冒号的
    // 块列表风格整段无声失效）。挂到最近一个「空值父键」，拼成内联数组值由 parseValue
    // 原生解析
    if (content.startsWith('- ')) {
      const parent = stack.length > 0 ? stack[stack.length - 1] : undefined
      const item = stripComment(content.slice(2)).trim()
      if (parent && parent.value === '' && item) {
        // 段头直挂块列表 warn——顶层段（indent 0）按映射（子键）
        // 解析，列表项被拼进段 value 后所有子键读取全部落空（如 leads: 下直接
        // `- 主线`，作者意图是 leads.enabled，实际 enabled 无声丢失）。留痕不中断。
        if (parent.indent === 0) {
          log.warn(
            'yaml',
            `book.yaml 段头「${parent.key}:」直挂块列表（${content.slice(0, 40)}）——该段按子键解析，列表值不会被子键读到；如需列表请落到列表型子键下（如 leads: 的 enabled:）`,
          )
        }
        parent.listItems = [...(parent.listItems ?? []), item]
        if (!listNodes.includes(parent)) listNodes.push(parent)
      } else {
        // 无处挂靠的块列表项（顶层列表 / 父键已有标量值）此前
        // 静默吞掉——同文件 leads.enabled 未知类有 warn 先例，补齐同款留痕防「配置
        // 写了但不生效」无迹可查
        log.warn('yaml', `book.yaml 块列表项无处挂靠被丢弃：${content.slice(0, 40)}`)
      }
      continue
    }
    // 键位冒号双认 `:`/`：` 取先出现者（firstKeyColon，与 parseFlat
    // 同一实现）——手写全角冒号键行（`title：测试`）此前整行走「无冒号」warn 被丢弃，
    // 段/键无声丢失。值侧 stripComment 等切分后逻辑不受影响。
    const colonIdx = firstKeyColon(content)
    if (colonIdx === -1) {
      // 无冒号残行此前静默吞掉（同款「配置写了但不生效」
      // 风险面）——手写残句/续行无迹消失。warn 留痕不中断解析。
      log.warn('yaml', `book.yaml 无冒号行被丢弃：${content.slice(0, 40)}`)
      continue
    }
    const key = content.slice(0, colonIdx).trim()
    const value = stripComment(content.slice(colonIdx + 1)).trim()

    const node = make(indent, key, value)
    lastNode = node

    // 弹栈到父级（缩进比自己小的最近一个）
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
      stack.pop()
    }
    if (stack.length === 0) {
      roots.push(node)
    } else {
      stack[stack.length - 1]!.children.push(node)
    }
    // 有子段潜力（value 为空且是 map）的入栈
    if (value === '') {
      stack.push(node)
    }
  }
  // 块列表项拼成内联数组——逐项走 stringifyValue 转义（含逗号/括号/引号项加引号），
  // 与解析端 splitInlineArray 的引号跳过（K17）对称；此前裸 join 含逗号项拼完即错位
  for (const node of listNodes) {
    if (node.listItems && node.listItems.length > 0 && node.value === '') {
      node.value = '[' + node.listItems.map((it) => stringifyValue(it)).join(', ') + ']'
    }
  }
  return roots
}

/** 剥行内注释（原 stripComment）。实现下沉 frontmatter-core.ts
 *  stripInlineComment（与 frontmatter.ts 共用同一函数——经 core 无循环 import），
 *  语义逐字不变：`#` 且前面是空白（或行首）即注释起点，引号内不算；
 *  `endpoint: http://x#y` 的 # 前无空白 → 保留为字面值（与主流 YAML 同语义）。 */
const stripComment = stripInlineComment

/** 段树 → BookConfig（#9 第 2 节）。
 *  全局托底改造：起步值不含 13 个可托底键——书文件没写就保持 undefined，
 *  「未设」语义存活到运行时合并层（applyGlobalDefaults）才回落。
 * 段键解析整体改 schema 表驱动（SECTION_SPECS），
 *  本函数只保留顶层标量三键与段循环骨架；逐键容错语义与 warn 文案随键行迁入表。 */
function sectionsToConfig(roots: RawSection[]): BookConfig {
  // 同名重复顶层段报错——原 find 静默取首个，作者复制粘贴出两个
  // `style:` 段时后段整段无效无提示。fail-loud（parseBookConfig 的 catch 转错误信封）。
  const seenKeys = new Set<string>()
  for (const r of roots) {
    if (seenKeys.has(r.key)) {
      throw new Error(`顶层段「${r.key}」重复：同名段只取首个会静默丢弃后段配置，请合并或删除重复段`)
    }
    seenKeys.add(r.key)
  }
  const cfg: BookConfig = {
    ...DEFAULT_CONFIG,
    book: { ...DEFAULT_CONFIG.book },
    leads: { ...DEFAULT_CONFIG.leads },
    budget: { ...DEFAULT_CONFIG.budget },
    growth: { ...DEFAULT_CONFIG.growth },
  }
  const find = (key: string) => roots.find((r) => r.key === key)

  // spec_version 非法值 warn 留痕（维持回落 1）——此前
  // parseFiniteNumber 静默回落，版本号写错无迹可查
  const sv = find('spec_version')
  if (sv) {
    const parsed = parseFiniteNumber(sv.value, NaN)
    if (Number.isFinite(parsed)) cfg.spec_version = parsed
    else {
      log.warn('book.yaml', `spec_version 值非法（「${sv.value.trim()}」），回落 1`)
      cfg.spec_version = 1
    }
  }

  // kind（#25）：顶层标量，缺省 long；只有显式 kind: short 才路由短篇轨
  const kindNode = find('kind')
  if (kindNode) {
    const k = String(parseValue(kindNode.value))
    if (k === 'short' || k === 'long') cfg.kind = k
    // 坏值静默落默认补 warn 留痕——作者笔误（kind: shrt）时
    // 短篇稿被静默路由长篇轨，无迹可查（对齐 spec_version 的 warn 纪律）
    else log.warn('book.yaml', `kind 值非法（「${kindNode.value.trim().slice(0, 40)}」），已按缺省 long 处理`)
  }

  // host（决策 12）：AI 宿主，缺省 cc；只认 cc/codex
  const hostNode = find('host')
  if (hostNode) {
    const h = String(parseValue(hostNode.value))
    if (h === 'cc' || h === 'codex') cfg.host = h
    // 同 kind——坏值静默回落 cc 无迹可查
    else log.warn('book.yaml', `host 值非法（「${hostNode.value.trim().slice(0, 40)}」），已按缺省 cc 处理`)
  }

  // workflow（§2 已废弃删除）：存量 book.yaml 里的 workflow 行是未知字段，
  // 不解析、不赋值——下次存配置时 stringifyBookConfig 重建 yaml 自然丢弃该行。

  // 段键：schema 表驱动——段序锁历史处理序（PARSE_SECTION_ORDER）
  for (const name of PARSE_SECTION_ORDER) {
    const spec = SECTION_BY_NAME.get(name)
    const sectionNode = find(name)
    if (!spec || !sectionNode) continue
    parseSectionSpec(spec, sectionNode, cfg)
  }

  return cfg
}

// ── 公开 API ────────────────────────────────────

/** 读 book.yaml（容错：缺文件/坏文件返回默认 + 错误） */
export function readBookConfig(
  filePath: string,
): { ok: true; config: BookConfig } | { ok: false; config: BookConfig; error: ParseError } {
  // 错误分支返回默认配置的深拷贝——共享单例引用一旦被调用方 mutate 即串污染后续所有读
  const freshDefault = (): BookConfig => structuredClone(DEFAULT_CONFIG)
  if (!existsSync(filePath)) {
    return {
      ok: false,
      config: freshDefault(),
      error: { file: filePath, line: 0, message: 'book.yaml 不存在（用默认配置）' },
    }
  }
  let text: string
  try {
    text = readFileSync(filePath, 'utf-8')
  } catch (e) {
    return {
      ok: false,
      config: freshDefault(),
      error: { file: filePath, line: 0, message: `读取失败：${e instanceof Error ? e.message : String(e)}` },
    }
  }
  return parseBookConfig(text, filePath)
}

/** 从 YAML 文本解析 BookConfig（readBookConfig 的字符串版）。
 *  供文本级读改写场景（migrate-defaults 等）在内存里判定配置值，免落盘临时文件。 */
export function parseBookConfig(
  text: string,
  file = '<text>',
): { ok: true; config: BookConfig } | { ok: false; config: BookConfig; error: ParseError } {
  try {
    // 解析最外层文本入口剥前导 BOM 一次（窄剥——不引 canonicalizeText，
    // 它会连带归一行尾，而解析器对 CRLF 已容忍〔逐行 trim 剥 \r 尾〕，不必徒增行为面）。
    // 此前首行 \uFEFF 全凭 trim 恰好剥 ZWNBSP 才不出键名事故，且首行缩进被多计 1
    // （trimStart 剥 BOM 计入缩进字符数）——首个段的 1 空格/tab 缩进子行被弹栈提为
    // 顶层键后静默丢弃。同缺陷族先例：frontmatter-core.ts splitFrontMatter /
    // install/books.ts readBooksStrict/ 本文件 matchesKeyLine，
    // 解析器本体在此收口。
    const roots = parseSections(text.replace(/^\uFEFF/, ''))
    return { ok: true, config: sectionsToConfig(roots) }
  } catch (e) {
    return {
      ok: false,
      config: structuredClone(DEFAULT_CONFIG),
      error: { file, line: 0, message: `解析失败：${e instanceof Error ? e.message : String(e)}` },
    }
  }
}

/** BookConfig → YAML 文本（#9 第 2 节格式；短篇集走精简字段，#25）。
 * 逐键条件落行改 schema 表驱动——段体 = 表行 emit
 *  拼接（行序 = 表序 = 历史落行序），段门 gate / 段间空行 / 头部三行保持历史语义；
 *  新增键只触表一行。字节红线由 yaml-schema-snapshot 快照钉住。 */
export function stringifyBookConfig(cfg: BookConfig): string {
  const isShort = cfg.kind === 'short'
  const lines: string[] = [
    `spec_version: ${cfg.spec_version}`,
    // kind 只在 short 时输出（长篇缺省不写，现有仓库零改动红线，#25）
    ...(isShort ? ['kind: short', ''] : ['']),
    `host: ${cfg.host ?? 'cc'}`,
  ]
  for (const spec of SECTION_SPECS) {
    // 段体 = 该段全部键行（emit 空数组键不落行；「有行才落段」型段由 gate 判 body）
    const body = spec.keys.flatMap((k) => (k.emit ? k.emit(cfg) : []))
    if (!spec.gate(cfg, body)) continue
    // book 段紧随 host 无段间空行；其余段前置空行分隔（历史段间风格）
    if (spec.name !== 'book') lines.push('')
    lines.push(`${spec.name}:`, ...body)
  }
  return lines.join('\n') + '\n'
}

/** 写 book.yaml */
export function writeBookConfig(filePath: string, cfg: BookConfig): void {
  // 平台：恒 LF——的「按盘上主导行尾整文件渲染」随规范形
  // 拍板废止（CRLF 存量由启动迁移 v4 归一）；stringifyBookConfig 本就恒 LF，输出即规范形。
  atomicWriteFile(filePath, stringifyBookConfig(cfg))
}

// ── 拆分桥接：yaml-patch.ts 既有导出面原名 re-export，
//    全库消费方 import 路径零改动（仍从 format/yaml.js 取用）──
export {
  locateTopSection,
  patchTopSection,
  setTopSectionKey,
  setSectionKeyBlock,
  patchBookConfigText,
} from './yaml-patch.js'
export type { TopSectionSpan } from './yaml-patch.js'
