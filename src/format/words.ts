/**
 * 字数与章名解析 —— 纯函数，零 Node 依赖（T2.1 抽离）。
 *
 * 从 format/chapters.ts 下沉，与服务端共用同一份口径；供 web-next 浏览器端 import
 * （chapters.ts 因 import node:fs 不可跨入浏览器）。chapters.ts re-export 本文件以保 API 不变。
 */

/** 计算正文字数（中文按字符计，#7 第 2 节）：剥 markdown 标记后按字符计。frontmatter 由调用方先剥。
 *  R31-11（三十一轮）口径备案：剥除集不含标点——对白密集章计数值系统性高于「汉字感」
 *  口径（实测可 +38%），但 _wordCount/短篇字数/字数曲线全链同源自洽，targetWords 为
 *  AI 语义给数（阈值留有弹性），维持现状不改口径（改口径需全链联动与存量曲线迁移）。 */
export function countWords(body: string): number {
  return [...body.replace(/[#>*_`~\-\[\]()!\s]/g, '')].length
}

/** 去目录 + 去 .md 扩展（替代 node:path.basename，零 Node 依赖）。 */
function stripMd(fileName: string): string {
  const last = fileName.split('/').pop() ?? fileName
  return last.endsWith('.md') ? last.slice(0, -3) : last
}

/** 从文件名提取章号（写作/正文/152-北境的雪.md → {章号:152, 标题:'北境的雪'}）。 */
export function parseChapterFileName(
  fileName: string,
): { 章号: number; 标题: string } | null {
  const base = stripMd(fileName)
  const m = base.match(/^(\d+)-(.+)$/)
  if (!m) return null
  // R64-20（十二轮）：16+ 位数字超 2^53 精度错位——isSafeInteger 守卫，非法按无章号
  const no = Number(m[1])
  return Number.isSafeInteger(no) ? { 章号: no, 标题: m[2]! } : null
}

/**
 * M-4（第十一轮）：章号补零宽度写侧单源——长篇 chapter 4 位 / 短篇 piece 3 位。
 * 此前写侧三处分裂（draft 草稿新建 3 位 / service 改名 4 位 / 前端复制 4 位），读侧
 * chapterNamePrefixes 三口径兜底掩盖风险：新增按名定位代码漏走单源即静默 miss。
 * 写侧（草稿新建/改名/复制）一律经此取前缀；与读侧 variants（chapters.ts）同口径，
 * 消费方含 web-next（零 Node 依赖，浏览器端可 import）。
 */
export function chapterFilePrefix(章号: number, kind: 'chapter' | 'piece'): string {
  return `${String(章号).padStart(kind === 'chapter' ? 4 : 3, '0')}-`
}
