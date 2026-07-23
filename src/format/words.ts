/**
 * 字数与章名解析 —— 纯函数，零 Node 依赖（T2.1 抽离）。
 *
 * 从 format/chapters.ts 下沉，与服务端共用同一份口径；供 web-next 浏览器端 import
 * （chapters.ts 因 import node:fs 不可跨入浏览器）。chapters.ts re-export 本文件以保 API 不变。
 */

/** 计算正文字数（中文按字符计，#7 第 2 节）：剥 markdown 标记后按字符计。frontmatter 由调用方先剥。 */
export function countWords(body: string): number {
  return body.replace(/[#>*_`~\-\[\]()!\s]/g, '').length
}

/** 去目录 + 去 .md 扩展（替代 node:path.basename，零 Node 依赖）。 */
function stripMd(fileName: string): string {
  const last = fileName.split('/').pop() ?? fileName
  return last.endsWith('.md') ? last.slice(0, -3) : last
}

/** 从文件名提取章号（定稿/正文/152-北境的雪.md → {章号:152, 标题:'北境的雪'}）。 */
export function parseChapterFileName(
  fileName: string,
): { 章号: number; 标题: string } | null {
  const base = stripMd(fileName)
  const m = base.match(/^(\d+)-(.+)$/)
  if (!m) return null
  return { 章号: Number(m[1]!), 标题: m[2]! }
}
