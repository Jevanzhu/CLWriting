/**
 * 纯字符串 frontmatter 提取（零 Node 依赖，浏览器/服务端共用）。
 *
 * 从 frontmatter.ts 拆出，消除 web-next/shared/words.ts 手写副本的漂移风险。
 * 仅含 --- 分隔逻辑；值类型推断（parseValue/parseFlat）留在 frontmatter.ts（服务端专用）。
 */

/** 从 markdown 文本提取 front matter 段（--- 之间）与正文。无 fm 或未闭合 → null */
export function splitFrontMatter(
  content: string,
): { fmRaw: string; body: string } | null {
  // 去 UTF-8 BOM：带 BOM 的文件 startsWith('---') 失败 → frontmatter 整段丢失（章号/枚举/机检 fm 项全失效）
  const src = content.replace(/^﻿/, '')
  // R-12（第十六轮）：起始判定收紧为整行精确 ---（容忍 \r 尾）——原先 startsWith('---')
  // 把 `----`/`--- 分隔` 也当 fm 开，与闭合判定 /^---\r?$/ 不对称，裸 md 首行正文被误剥
  if (!/^---\r?(?:\n|$)/.test(src)) return null
  const lines = src.split('\n')
  // 找闭合 ---
  let endIdx = -1
  for (let i = 1; i < lines.length; i++) {
    // Q-16（第十五轮）：闭合 --- 判零缩进（容忍 \r 尾）——此前 trim() 会把块标量值内的
    // 缩进 `  ---` 误判为 fm 结束，多行值写盘再读即截断损坏；零缩进与块缩进（≥1 空格）
    // 天然错开，无需另判
    if (/^---\r?$/.test(lines[i]!)) {
      endIdx = i
      break
    }
  }
  if (endIdx === -1) return null
  const fmRaw = lines.slice(1, endIdx).join('\n')
  const body = lines.slice(endIdx + 1).join('\n')
  return { fmRaw, body }
}

/** 剥 frontmatter 取正文（countWords 口径要求纯正文；裸 md 无 fm 原样返回）。 */
export function bodyOf(raw: string): string {
  const s = splitFrontMatter(raw)
  return s ? s.body : raw
}

/**
 * 剥值行内注释（单一实现）：`#` 且前面是空白（或行首）即注释起点，引号内 `#` 不剥；
 * `endpoint: http://x#y` 的 # 前无空白 → 保留为字面值（与主流 YAML 同语义）。
 * N-4（第五十四轮）：原 frontmatter.ts stripInlineComment（E-3，第五十三轮）与
 * yaml.ts stripComment（ii 批）是同算法双份维护——防循环 import 的顾虑已随
 * frontmatter-core.ts 拆出而不成立（core 零依赖，二者均无环），下沉至此共享，
 * 语义逐字不变（引号感知 / # 前空白或行首判定 / URL 字面 # 保留）。
 */
/**
 * R31-2（三十一轮）：键位冒号探测——双认半角 `:` 与全角 `：`，取先出现者为键值切分点。
 * 此前只认半角冒号：中文键手写全角冒号（`章号：152`、细纲 `推进：[悬念-001]`）整行
 * 被静默跳过（parseFlat/yaml.parseSections 的无冒号分支），键无声丢失 → 整章必填字段
 * 假缺、细纲推进声明失明。键名保留切点前原文（trim 后即正常键名）；值侧内容不动
 * （值含全角冒号不误切——半角键位先出现时切点仍是半角，见回归 r31b-fullwidth-colon）。
 * 返回 -1 = 两式皆无（非键行，维持调用方既有的跳过/warn 路径）。
 */
export function firstKeyColon(line: string): number {
  const half = line.indexOf(':')
  const full = line.indexOf('：')
  if (half === -1) return full
  if (full === -1) return half
  return Math.min(half, full)
}

export function stripInlineComment(s: string): string {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote === '"') {
      if (c === '\\') i++ // 跳过转义字符
      else if (c === '"') quote = null
      continue
    }
    if (quote === "'") {
      if (c === "'") quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i).trimEnd()
  }
  // B-17（第六十轮）：值内未配对引号（`备注: "中文 # 注释`）——引号状态机永不闭合，
  // 引号后的 # 全被吞进引号语境不剥（fail-safe 方向但注释剥除失效）。行末引号未
  // 闭合 → 回落无引号感知的裸扫；配对引号路径（上方循环自然走完 quote===null）行为不变
  if (quote !== null) {
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!
      if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i).trimEnd()
    }
  }
  return s
}
