/**
 * markdown 围栏行识别单源 —— R49-2。
 *
 * CommonMark fenced code blocks 口径：围栏行 = 0-3 空格缩进 + ≥3 个 ` 或 ~ 连写
 * （信息串可选）；4+ 空格缩进属 indented code block，不是围栏行。
 *
 * 消费方各自保留开/闭栏行为语义，只共享「围栏行识别」这一步：
 * - check/count.ts checkSectionCount：开/闭栏配对（同类同长才闭栏），围栏行剥除后计节数
 * - export/index.ts purifyBody：``` 简单翻转跳过 #% 剥除（只认反引号，~~~ 不扩大识别）
 *
 * 此前两侧各自手写判定且口径分裂（导出侧 `trimStart().startsWith('```')` 对任意缩进
 * 翻转），缩进代码块内 ``` 行在导出侧被误当围栏开关，误开栏成对闭合时真实 `#%`
 * 批注被当围栏内容漏进导出稿（机检侧本就是本文件口径，无此病）。
 */

/** 围栏行识别结果。ch = 围栏字符；len = 围栏字符连写长度；info = 信息串（围栏
 *  字符连写后的行内剩余内容；闭栏判定需「其后只允许空白」时由消费方自行 trim）。 */
export interface FenceLineMatch {
  ch: '`' | '~'
  len: number
  info: string
}

/**
 * 判定一行是否 markdown 围栏行（``` / ~~~；0-3 空格缩进；CRLF 尾容忍——R33-1：
 * 行尾残 \r 不破匹配，`.` 不匹配 \r 故信息串不含 \r）。非围栏行（含 4+ 空格缩进
 * 的 indented code block 内容）返回 null。
 */
export function matchFenceLine(line: string): FenceLineMatch | null {
  const m = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)\r?$/)
  if (!m) return null
  // 围栏字符连写 ≥3 且只含 `/~（正则保证），首字符安全
  return { ch: m[1]![0]! as '`' | '~', len: m[1]!.length, info: m[2] ?? '' }
}
