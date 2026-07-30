// 与服务端共享的字数/章名纯函数（T2.1）：从主仓 src/format/words.ts re-export。
// words.ts 零 Node 依赖，浏览器端可直接 import；chapters.ts 因 import node:fs 不可跨入。
export { countWords, parseChapterFileName } from '../../../../format/words'
// splitFrontMatter 从 frontmatter-core.ts re-export（零 Node 依赖，服务端/浏览器共用），
// 消除此前手写 --- 查找逻辑的漂移风险。
import { splitFrontMatter } from '../../../../format/frontmatter-core'

/**
 * 剥 frontmatter（--- ... ---）取正文 body。
 * 复用 format/frontmatter-core.splitFrontMatter（单一源码）。
 */
export function stripFrontmatter(content: string): string {
  const split = splitFrontMatter(content)
  return split ? split.body : content
}

/**
 * 合并 fm 头与新 body（stripFrontmatter 的逆）：保留 full 原有 fm，拼接 body。
 * 编辑区剥离 fm 后，用户改 body → patch 时用它拼回全文（fm 不动）。
 * 无 fm 或 fm 未闭合 → 返回 body；body 去前导空行（fm/body 分隔空行），本体原样保留（含末尾换行，往返一致）。
 */
export function mergeFm(full: string, body: string): string {
  const split = splitFrontMatter(full)
  if (!split) return body
  return `---\n${split.fmRaw}\n---\n\n${body.replace(/^\n+/, '')}`
}

/**
 * 解析 frontmatter 字段为 key→value（纯字符串；浏览器安全）。
 * 与服务端 format/frontmatter.parseFlat 同逻辑但不做值类型推断（前端表单用 string 足够）。
 * 无 frontmatter → 空对象。
 */
export function parseFmFields(content: string): Record<string, string> {
  const split = splitFrontMatter(content)
  if (!split) return {}
  const lines = split.fmRaw.split('\n')
  const out: Record<string, string> = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      i++
      continue
    }
    const idx = line.indexOf(':')
    if (idx === -1) {
      i++
      continue
    }
    const key = line.slice(0, idx).trim()
    const valRaw = line.slice(idx + 1).trim()
    // 块标量 key: |（literal）或 key: >（folded）—— 多行值
    if (valRaw === '|' || valRaw === '>') {
      const folded = valRaw === '>'
      const block: string[] = []
      i++
      while (i < lines.length) {
        const bl = lines[i]!
        if (bl.trim() === '') {
          block.push('')
          i++
          continue
        }
        const indent = bl.length - bl.trimStart().length
        if (indent === 0) break
        block.push(bl.slice(indent))
        i++
      }
      out[key] = folded
        ? block.join(' ').replace(/  +/g, ' ').replace(/ +$/, '')
        : block.join('\n').replace(/\n+$/, '')
      continue
    }
    out[key] = valRaw
    i++
  }
  return out
}

/** 文档路径 → 结构化表单类型（右栏按此切表单）。非表单文档 → null。 */
export function formKindOf(
  path: string,
):
  | 'chapter' | 'piece-body' | 'chapter-outline' | 'volume-outline' | 'synopsis'
  | 'character' | 'worldview' | 'item' | 'foreshadow' | null {
  if (path.startsWith('定稿/正文/')) return 'chapter'
  if (path.startsWith('篇/') && path.endsWith('/正文.md')) return 'piece-body'
  if (path.startsWith('大纲/章纲/')) return 'chapter-outline'
  if (path.startsWith('大纲/卷纲/')) return 'volume-outline'
  if (path === '大纲/总纲.md') return 'synopsis'
  if (path.startsWith('定稿/设定/角色/')) return 'character'
  if (path === '定稿/设定/世界观.md') return 'worldview'
  if (path.startsWith('定稿/设定/物品/')) return 'item'
  if (path.startsWith('定稿/设定/伏笔/')) return 'foreshadow'
  return null
}

/** 是否正文文档（长篇 chapter / 短篇 piece-body）—— 统一标题可编辑 + 可分析/review/check 判定。 */
export function isBodyKind(path: string): boolean {
  return path.startsWith('定稿/正文/') || (path.startsWith('篇/') && path.endsWith('/正文.md'))
}
