// 与服务端共享的字数/章名纯函数（T2.1）：从主仓 src/format/words.ts re-export。
// words.ts 零 Node 依赖，浏览器端可直接 import；chapters.ts 因 import node:fs 不可跨入。
export { countWords, parseChapterFileName } from '../../../../format/words'

/**
 * 剥 frontmatter（--- ... ---）取正文 body。
 * 与服务端 format/frontmatter.splitFrontMatter 同逻辑；不直接 re-export，
 * 因 format/frontmatter 顶层 import node:fs（readFile/writeFile）不可跨入浏览器。
 */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content
  const lines = content.split('\n')
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') return lines.slice(i + 1).join('\n')
  }
  return content
}

/**
 * 解析 frontmatter 字段为 key→value（纯字符串；浏览器安全）。
 * 与服务端 format/frontmatter.parseFlat 同逻辑但不做值类型推断（前端表单用 string 足够）。
 * 无 frontmatter → 空对象。
 */
export function parseFmFields(content: string): Record<string, string> {
  if (!content.startsWith('---')) return {}
  const lines = content.split('\n')
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return {}
  const out: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return out
}

/** 文档路径 → 结构化表单类型（右栏按此切表单）。非表单文档 → null。 */
export function formKindOf(
  path: string,
):
  | 'chapter-outline' | 'volume-outline' | 'synopsis'
  | 'character' | 'worldview' | 'item' | null {
  if (path.startsWith('大纲/章纲/')) return 'chapter-outline'
  if (path.startsWith('大纲/卷纲/')) return 'volume-outline'
  if (path === '大纲/总纲.md') return 'synopsis'
  if (path.startsWith('定稿/设定/角色/')) return 'character'
  if (path === '定稿/设定/世界观.md') return 'worldview'
  if (path.startsWith('定稿/设定/物品/')) return 'item'
  return null
}
