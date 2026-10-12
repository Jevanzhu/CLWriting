/**
 * 正文格式机检（黄）——「正文是纯叙事文本」的可判定面。
 *
 * 三个判据此前只有 prompt 侧声明（writer-long.md「仅用段落与空行，禁 markdown」；
 * draft-pipeline 的任务段）而零机检，模型违反无任何反馈：
 * - 套式句式：毒级 AI 句式（不是A而是B / 万能状语「，带着…」/ 无情绪声线 / 直告认知）
 *   —— 判定单源在 `src/check/ai-patterns.ts`（词表 + 句式表同处，改一处两面同步）；
 * - 正文带 markdown 语法：加粗/斜体/行内代码（标题按体裁放开——短篇正文以
 *   `## 五段标题` 分节是既定写作规范，见 draft-pipeline 短篇分支的要求段）；
 * - 正文混入写作工程词：写作过程词（细纲/伏笔/读者…）出现在正文里即叙述者出戏
 *   （角色不会说「伏笔」）；「第 N 章」不在判定面——章号既是场内可用的时间锚点
 *   （「比第一章那三秒」），也确有角色在世界内读章名，字面无法判。
 *
 * 全黄项「只报不拦」：格式违反不阻断写稿链，只把事实摆进机检面板与自愈建议。
 *
 * 判断面（为何要改、改了往哪个方向）在语料 `知识层/去味/文风与格式速查.md` 与
 * `知识层/去味/去AI味判断速查.md`；本文件只判定，不含取舍判断。
 */
import type { CheckSectionResult, CheckItem } from './types.js'
import { bodyOf } from '../shared/frontmatter-core.js'
import { AI_PATTERN_RULES, CLICHE_WORDS } from './ai-patterns.js'

/** 正文写作工程词表（写作过程词；角色不会在故事内说这些） */
export const ENGINEERING_WORDS: readonly string[] = [
  '本章',
  '本回',
  '上一章',
  '上章',
  '前一章',
  '前文',
  '后文',
  '伏笔',
  '细纲',
  '大纲',
  '读者',
  '本章节',
] as const

/** 正文出现的 markdown 行内语法（标题除外——标题按体裁另判） */
export const BODY_MARKDOWN_RE = /\*\*|__|`[^`]+`|\n- |\n\* |\n\d+\. |\n> |\n\|[^\n]*\|/u

/** 行首缩进（全角空格/半角空格/制表符）——正文段落不缩进，缩进即排版痕迹 */
export const BODY_INDENT_RE = /^[ \t\u3000]/mu

/** 各级标题行 */
const HEADING_RE = /^#{1,6}\s/gmu

/** 短篇正文允许的段标题（五段结构，见 draft-pipeline 短篇要求段与 checkSectionCount） */
export const SHORT_SECTION_HEADINGS: readonly string[] = [
  '## 开头钩子',
  '## 铺垫',
  '## 升级',
  '## 反转',
  '## 余韵',
] as const

/**
 * 正文格式机检。
 *
 * @param body 正文（可带 front matter——本函数自剥）
 * @param opts.allowSectionHeadings 是否放行 `## ` 段标题（短篇正文为是）
 */
export function checkBodyFormat(body: string, opts?: { allowSectionHeadings?: boolean }): CheckSectionResult {
  const items: CheckItem[] = []
  const prose = bodyOf(body)
  const headings = opts?.allowSectionHeadings ? SHORT_SECTION_HEADINGS : []
  // 标题以外的 markdown：先去标题行再判行内语法
  const withoutHeadings = headings.length > 0 ? prose.replace(/^## .*$/gmu, '') : prose
  if (BODY_MARKDOWN_RE.test(withoutHeadings)) {
    items.push({
      checkId: 'body-markdown',
      level: 'yellow',
      message: '正文含 markdown 语法（加粗/斜体/行内代码/列表/引用/表格）——正文是纯叙事文本，改用段落与空行承担',
    })
  }
  for (const m of prose.matchAll(HEADING_RE)) {
    const line = prose.slice(m.index).split('\n')[0]!
    if (headings.some((h) => line.trim() === h)) continue
    items.push({
      checkId: 'body-heading',
      level: 'yellow',
      message: `正文含标题行「${line.trim().slice(0, 20)}」——${
        headings.length > 0
          ? '短篇正文只允许五段标题（开头钩子/铺垫/升级/反转/余韵）'
          : '长篇正文不分节，标题由章节 front matter 承载'
      }`,
    })
  }
  if (BODY_INDENT_RE.test(prose)) {
    items.push({
      checkId: 'body-indent',
      level: 'yellow',
      message: '正文段落行首有缩进（空格/全角空格/制表符）——段落不缩进，段首一律顶格',
    })
  }
  const engineering = ENGINEERING_WORDS.filter((w) => prose.includes(w))
  if (engineering.length > 0) {
    items.push({
      checkId: 'body-engineering-word',
      level: 'yellow',
      message: `正文混入写作工程词「${engineering.join('、')}」——改成角色能感知的事件锚点或相对时间`,
    })
  }
  const cliches = CLICHE_WORDS.filter((w) => prose.includes(w))
  if (cliches.length > 0) {
    items.push({
      checkId: 'body-cliche-word',
      level: 'yellow',
      message: `正文命中 AI 高频套话「${cliches.join('、')}」——删除或替换为具体描写`,
    })
  }
  for (const p of AI_PATTERN_RULES) {
    const hit = prose.match(p.re)
    if (hit) {
      items.push({
        checkId: 'body-ai-pattern',
        level: 'yellow',
        message: `正文命中套路句式「${hit[0].trim().slice(0, 24)}」——${p.fix}`,
      })
    }
  }
  return { name: '正文格式', items }
}
