/**
 * `##` 段落标题行识别单源（G203，0918三轮修复批）。
 *
 * 此前同一正文有两套 `##` 标题识别器且口径分裂：
 * - check/count.ts（节数守恒）：围栏剔除（matchFenceLine 状态机）+ `^##(?!#)[ \t\u3000]*\S.*$`；
 * - metrics/short-index.ts collectBodyAnchors：无围栏剔除 + `^##\s+(.+)\r?$`。
 * 两个方向都可失真：紧排 `##标题`（R26-43 认可的合法形态）在 metrics 侧全部漏识
 * → 短篇索引「正文缺少 ## 段落锚点」假 issue、anchoredSetupCount 系统性低估；
 * 反向，围栏代码块内的 `## 示例` 在 metrics 侧被照收为锚点 → 假锚点虚增
 * anchoredSetupCount。本模块把「剥围栏 + 识别标题行」收敛单源，两处消费同源。
 *
 * 语义沿革（自 count.ts 原位随迁，注释原文保留）：
 * - R26-43（二十六轮）：`##` 后空白可选（`##标题` 紧排形态此前漏计）；`##` 后须仍有
 *   内容，裸 `##` 行不计。
 * - R27-25（二十七轮）：计数先剥代码围栏（``` / ~~~）内的行——设定/知识块里引用
 *   示例的 `## xxx` 此前被当节标题计入，节数守恒虚高误绿。
 * - R28-9（二十八轮·先证伪后修）：非围栏态遇 ``` 行本就是「开栏」（围栏可无信息串），
 *   无配对时围栏延伸到文末、其内 ## 不计恰是 spec 正确行为。但原 `` ```/~~~ `` 一视
 *   同仁互翻有真实 spec 偏离：CommonMark 要闭栏行与开栏**同字符、长度不小于开栏、
 *   其后只允许空白**——改记开栏字符+长度，闭栏行须三者皆符。
 * - R28-2（二十八轮）：`^##(?!#)` lookahead 排除 `###`/`####` 子标题（误命中 → 节数
 *   虚高 → 短篇 strict 假黄提红拦定稿）。
 * - R37-8（三十七轮）：`\s*` 收窄为 `[ \t\u3000]*` + `\S` 门卫——`\s` 含 `\n`，裸
 *   `##` 行后随换行被跨行吞并、下一行正文顶上；行内空白集保留全角空格（中文输入法
 *   分隔形态），`\S` 强制须有可见标题文字。
 * - R33-1（三十三轮）：尾部 `\r?` 容忍（CRLF 文件按 \n 切行后行尾残留 \r 不破匹配）。
 * - R49-2：围栏行识别收编 format/fence 单源（此前本处手写正则与导出 purifyBody
 *   各自为政、口径漂移）。
 */
import { matchFenceLine, type FenceLineMatch } from './fence.js'

/** 标题行正则（口径沿革见文件头注）：`##` 精确两级 + 紧排可选 + 可见文字门卫。 */
const SECTION_HEADING_RE = /^##(?!#)[ \t\u3000]*(\S.*)$/gm

/** 剥除围栏（``` / ~~~）内的行——R27-25 语义 + R28-9 的同字符/同长/纯空白闭栏判定。 */
export function stripFencedLines(body: string): string {
  let fence: { ch: FenceLineMatch['ch']; len: number } | null = null
  return body
    .split('\n')
    .filter((ln) => {
      const m = matchFenceLine(ln)
      if (fence === null) {
        // 非围栏态：```/~~~ 行（信息串可选）= 开栏（R27-25 语义不变），开栏行剥除
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
 *  （collectBodyAnchors 锚点集）——两处同源，消 G203 口径分裂面。 */
export function extractSectionHeadings(body: string): string[] {
  const stripped = stripFencedLines(body)
  const out: string[] = []
  for (const m of stripped.matchAll(SECTION_HEADING_RE)) {
    out.push((m[1] ?? '').replace(/\r$/, '').trim())
  }
  return out
}
