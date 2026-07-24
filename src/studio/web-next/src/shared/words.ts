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
