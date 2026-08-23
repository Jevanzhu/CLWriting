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
