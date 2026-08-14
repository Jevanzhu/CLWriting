/**
 * 分句工具 —— 全项目统一按 。！？\n 切句（P2-BE-6 DRY）。
 *
 * 原先 check/count.ts / metrics/style.ts / learn/index.ts / ai/rules/style-remedy.ts
 * 各自内联 split，且 learn 少了 \n 口径不一致（可能漏检跨行）。统一收口到此模块。
 */

/** 分句：按中文句末标点（。！？）+ 换行切，去空白。includeColon 时额外按 ；切（对话/排比场景）。 */
export function splitSentences(body: string, includeColon = false): string[] {
  const re = includeColon ? /[。！？；\n]/ : /[。！？\n]/
  return body.split(re).map((s) => s.trim()).filter((s) => s.length > 0)
}
