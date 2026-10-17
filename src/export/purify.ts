/**
 * 导出净化面：#% 作者批注剥除（purifyBody）、Markdown 呈现层剥除（stripMarkdownMarks）
 * 与双形态载荷组装（exportPayload）。
 *
 * 不变量：围栏行识别与机检同源（format/fence 的 matchFenceLine，只认反引号围栏）；
 * 围栏未闭合时按无围栏重剥（净化优先，批注零泄漏）；两处剥除共用两遍收口口径。
 */
import { canonicalizeText } from '../fs/text-canonical.js'
import { matchFenceLine } from '../format/fence.js'
import type { ExportOutput } from './types.js'
/** CJK 字符类与「内容以 CJK 起」判定（批注形态收紧用）。
 *  覆盖：CJK 统一区/部首/注音假名（2E80-9FFF 含 3000-30FF）、谚文（1100-11FF、
 *  AC00-D7AF）、相容表意（F900-FAFF）、全角形式（FF00-FFEF）。 */
const CJK_CHAR_RE = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/
/** `#%` 后允许前导空白再接 CJK（紧贴分支用：`x = 1#% 中文批注` 形态；`#%…` URL 片段不中）。 */
const CJK_LEAD_RE = /^\s*[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/

export function purifyBody(body: string): string {
  /** 单遍剥除。respectFence=false 时忽略围栏状态（未闭合回退遍用）。
   *  返回 unclosed = 遍历结束后仍处围栏内（有未闭合围栏）。 */
  const strip = (respectFence: boolean): { text: string; unclosed: boolean } => {
    let inFence = false
    const text = body
      .split('\n')
      .map((line) => {
        // fenced 代码块围栏行翻转状态；块内行原样保留（#% 是代码字面量非批注）
        // 围栏行识别收编 format/fence 单源（CommonMark 0-3 空格缩进口径，与
        // 机检 checkSectionCount 同源）——原 trimStart.startsWith('```') 对任意缩进
        // 翻转，缩进代码块（4+ 空格）内的 ``` 行被误当围栏开关，误开栏成对闭合时其
        // 间真实 `#%` 批注被当围栏内容整段保留漏进导出稿。只认反引号围栏（~~~ 不扩
        // 大识别范围口径不变）：单源只共享「围栏行识别」，开/闭栏语义两侧各自
        // 保留（机检侧同类同长才闭栏，本侧简单翻转）。
        if (respectFence) {
          const fence = matchFenceLine(line)
          if (fence !== null && fence.ch === '`') {
            inFence = !inFence
            return { keep: true, out: line }
          }
          if (inFence) return { keep: true, out: line }
        }
        if (line.trim() === '') return { keep: true, out: line } // 原空行保留（分段）
        // E-9f：仅内部标记形态才作为批注起点——①`#%` 前只有空白（含行首）
        // ②紧贴正文（前一个字符非空白，即 `正文#%批注` 贴附写法）。
        // `#` 前是空白但前面有正文的行中字面量保留。
        // ②由「前置非空白」收紧为「前置 CJK，或前置非空白且
        // 批注内容以 CJK 起」——AI 贴附批注的正文与批注内容均为中文；ASCII 紧贴
        // 且 ASCII 内容的 `#%`（URL 片段 `…/wiki/#%%88%86%%%BB`、代码字面
        // `a#%b`）不是批注，原「非空白即剥」把 URL 从 `#%` 起整段静默截断。
        // 内容判定只作用于紧贴分支：`#` 前带空白的行中字面（`达标线 #%=95%` /
        // `const a = 1 #% 松散字面`）维持 E-9f 登记口径一律保留；紧贴分支
        // 的 `x = 1#% 中文批注`（前置 ASCII、内容中文）仍按批注剥——宁误剥字面
        // 不泄漏批注的口径不回退。
        // -（全量代码）：遍历行内全部 `#%` 出现位，取**首个满足
        // 上述标记形态判定的位置**截断——只看首个出现位时，首处是保留的行中字面量
        // （`达标线 #%=95% 才放行正文甲#%批注`）会让整行原样保留，行内后续紧贴真批注
        // 泄入导出稿；全部出现位均不满足则整行保留（E-9f 存留口径不变）。
        let cut = -1
        for (let i = line.indexOf('#%'); i !== -1; i = line.indexOf('#%', i + 1)) {
          const marker =
            line.slice(0, i).trim() === '' ||
            (!/\s/.test(line[i - 1]!) && (CJK_CHAR_RE.test(line[i - 1]!) || CJK_LEAD_RE.test(line.slice(i + 2))))
          if (marker) {
            cut = i
            break
          }
        }
        // 截断行保留原行尾——replace(/\s+$/) 会把 \r 一并剥掉，
        // 截断行落成 LF 混行尾（保留行原样带 \r，口径对齐）
        const hadCr = line.endsWith('\r')
        const out = cut === -1 ? line : line.slice(0, cut).replace(/\s+$/, '') + (hadCr ? '\r' : '')
        return { keep: out.trim() !== '', out }
      })
      .filter((r) => r.keep)
      .map((r) => r.out)
      .join('\n')
      .trim()
    return { text, unclosed: inFence }
  }
  const first = strip(true)
  // 首遍末态仍处围栏内 = 存在未闭合围栏 → 按无围栏重剥（批注零泄漏优先）
  return first.unclosed ? strip(false).text : first.text
}

/** 纯文本（txt）产物净化：剥 Markdown **呈现层**标记，正文语义零改写。
 *  口径（拍板定案）：只剥下列确定形态——
 *  ①行首 ATX 标题标记（`## 标题` → `标题`，闭尾 `#` 一并剥）；②行首引用标记（`> `，
 *  含嵌套）；③行内成对标记：`` `码` ``（去反引号）、`**粗**`、`*斜*`、`~~删~~`、
 *  `[文字](链接)`/`![文字](链接)`（留文字）。
 *  代码围栏（``` 行，行识别收编 format/fence 的 matchFenceLine 单源、与同文件
 *  purifyBody 同口径）行与围栏内行整段跳过——围栏内是代码字面量，行首 `#`、
 *  `a[1](b)` 一类不是呈现层标记，剥除即改写代码；只认反引号围栏（``` 与 ~~~ 的
 *  取舍同 purifyBody 现状：~~~ 不扩大识别范围）。
 *  围栏未闭合（首遍末态仍在围栏内）按无围栏重剥——围栏边界不可信时以净化优先
 *  （宁剥不错留，与 purifyBody 的两遍收口一致）。
 *  **不碰**：列表标记（`- `/`1. `——中文正文罕见，且行首短横线可能是作者自用）、
 *  `---` 分隔线（可能是作者的场景分隔）、表格（正文无表格；投稿视图不进 txt 面）。
 *  行内标记要求成对且紧贴内容（开标记后、闭标记前均非空白；单 `*` 另要求闭标记后
 *  非词字符）——`a * b * c`、`3*4*5`、`- *强调*` 一类算式/字面不被误剥
 *  （保守优先：宁留标记不伤正文）。 */
export function stripMarkdownMarks(text: string): string {
  /** 单行剥除：行首标题标记（0-3 空格缩进的 CommonMark ATX 口径）+ 行首引用标记 +
   *  行内成对标记。逐行施加——各标记式均不跨行（内容类不含 \n），行内标记的判据
   *  锚点（`^`/前置字符）在行边界处与整串施加同解。 */
  const stripLine = (line: string): string =>
    line
      .replace(/^(\s{0,3})#{1,6}[ \t]+(.*?)[ \t]*#*$/, '$1$2')
      .replace(/^(\s{0,3})(?:>[ \t]?)+/, '$1')
      .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '$1')
      .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '$1')
      .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
  /** 单遍剥除。respectFence=false 时忽略围栏状态（未闭合回退遍用）。
   *  返回 unclosed = 遍历结束后仍处围栏内（有未闭合围栏）。 */
  const strip = (respectFence: boolean): { text: string; unclosed: boolean } => {
    let inFence = false
    const out = text.split('\n').map((line) => {
      // 围栏行翻转状态；围栏行与围栏内行整段原样保留（代码字面量不经呈现层剥除）
      if (respectFence) {
        const fence = matchFenceLine(line)
        if (fence !== null && fence.ch === '`') {
          inFence = !inFence
          return line
        }
        if (inFence) return line
      }
      return stripLine(line)
    })
    return { text: out.join('\n'), unclosed: inFence }
  }
  const first = strip(true)
  // 首遍末态仍处围栏内 = 存在未闭合围栏 → 按无围栏重剥（围栏边界不可信，净化优先）
  return first.unclosed ? strip(false).text : first.text
}

/** 产物载荷单源（md/txt 双形态）——md 为现口径逐字节不变；txt 标题不带 `#`，
 *  章界由全本段的段落空行与分章文件切分承担。 */
export function exportPayload(output: ExportOutput, title: string, body: string): string {
  return output === 'txt'
    ? canonicalizeText(`${title}\n\n${stripMarkdownMarks(body)}`)
    : canonicalizeText(`# ${title}\n\n${body}`)
}
