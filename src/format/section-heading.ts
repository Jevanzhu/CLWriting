/**
 * `##` 段落标题行识别单源（剥围栏 + 识别标题行），check/count.ts 与
 * metrics/short-index.ts 两处消费同源。
 *
 * 不得退回双识别器口径：紧排 `##标题`（认可的合法形态）会被漏识 → 短篇索引
 * 「正文缺少 ## 段落锚点」假 issue、anchoredSetupCount 系统性低估；围栏代码块内的
 * `## 示例` 会被照收为锚点 → 假锚点虚增。
 *
 * 识别口径（每条都带失败后果）：
 * - `##` 后空白可选（`##标题` 紧排合法），裸 `##` 行不计（须有可见标题文字）。
 * - 计数先剥代码围栏（``` / ~~~）内的行——设定/知识块里引用示例的 `## xxx` 被当节标题
 *   计入即节数守恒虚高误绿。
 * - 围栏可无信息串；无配对时延伸到文末、其内 ## 不计是 spec 正确行为。闭栏行按
 *   CommonMark 须与开栏**同字符、长度不小于开栏、其后只允许空白**——`` ```/~~~ ``
 *   一视同仁互翻是 spec 偏离。
 * - `^##(?!#)` lookahead 排除 `###`/`####` 子标题（误命中 → 节数虚高 → 短篇 strict
 *   假黄提红拦定稿）。
 * - `\s*` 收窄为 `[ \t\u3000]*` + `\S` 门卫——`\s` 含 `\n`，裸 `##` 行后随换行被
 *   跨行吞并、下一行正文顶上；行内空白集保留全角空格（中文输入法分隔形态）。
 * - 尾部 `\r?` 容忍（CRLF 文件按 \n 切行后行尾残留 \r 不破匹配）。
 * - 围栏行识别单源 format/fence（本处手写正则与 purifyBody 必须同源，分家即漂移）。
 */
import { matchFenceLine, type FenceLineMatch } from './fence.js'

/** 标题行正则（口径见文件头注）：`##` 精确两级 + 紧排可选 + 可见文字门卫。 */
const SECTION_HEADING_RE = /^##(?!#)[ \t\u3000]*(\S.*)$/gm

/** 剥除围栏（``` / ~~~）内的行——语义 +的同字符/同长/纯空白闭栏判定。 */
function stripFencedLines(body: string): string {
  let fence: { ch: FenceLineMatch['ch']; len: number } | null = null
  return body
    .split('\n')
    .filter((ln) => {
      const m = matchFenceLine(ln)
      if (fence === null) {
        // 非围栏态：```/~~~ 行（信息串可选）= 开栏（语义不变），开栏行剥除
        if (m) fence = { ch: m.ch, len: m.len }
        return !m
      }
      // 围栏态：仅同类同长且其后只有空白的行 = 闭栏；其余（异类/更短/带信息串）
      // 是围栏内容，照旧剥除不计
      if (m && m.ch === fence.ch && m.len >= fence.len && m.info.trim() === '') {
        fence = null
      }
      return false
    })
    .join('\n')
}

/** 提取正文全部 `##` 段落标题文字（剥围栏后识别；标题两端 trim、剥行尾 \r）。
 *  消费方：check/count.ts（节数守恒按标题数）与 metrics/short-index.ts
 * （collectBodyAnchors 锚点集）——两处同源，消口径分裂面。 */
export function extractSectionHeadings(body: string): string[] {
  const stripped = stripFencedLines(body)
  const out: string[] = []
  for (const m of stripped.matchAll(SECTION_HEADING_RE)) {
    out.push((m[1] ?? '').replace(/\r$/, '').trim())
  }
  return out
}
