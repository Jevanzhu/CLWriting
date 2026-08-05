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
  // 首行必须是 ---
  if (!src.startsWith('---')) return null
  const lines = src.split('\n')
  // 找闭合 ---
  let endIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      endIdx = i
      break
    }
  }
  if (endIdx === -1) return null
  const fmRaw = lines.slice(1, endIdx).join('\n')
  const body = lines.slice(endIdx + 1).join('\n')
  return { fmRaw, body }
}
