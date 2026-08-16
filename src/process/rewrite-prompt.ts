/**
 * 改写 prompt 组装 + 续写拼稿 + 行级 diff（P1-8 架构下沉：从 studio/server/api/rewrite 下沉内核）。
 */

/** 行级 diff 结果（add/del/same） */
export interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
}

/** 组改写 prompt(local 选段 / whole 整章，AI 自愈 + rewrite 端点共用)。
 *  A4：strategyHint 非空时作独立段注入（连续相同红项的「换策略」提醒，不拦截）。 */
export function buildRewritePrompt(
  mode: 'local' | 'whole',
  original: string,
  selection: string,
  instruction: string,
  reviewIssues: string[],
  chapter: number,
  kind: 'long' | 'short',
  strategyHint?: string,
): string {
  if (mode === 'local') {
    return [
      '## 原文(选中段落)',
      selection,
      '',
      '## 改写指令',
      instruction,
      '',
      '## 要求',
      '只改写选中段落,不动其他;保持正文纯文本(段落+空行,禁 MD 标题/格式)。',
    ].join('\n')
  }
  const unit = '章'
  const parts = [
    '## 任务',
    `按指令${reviewIssues.length ? ' / 审稿意见' : ''}重写第 ${chapter} ${unit}正文。`,
    '',
    `## 原${unit}正文`,
    original,
    '',
    '## 改写指令',
    instruction,
  ]
  if (reviewIssues.length) {
    parts.push('', '## 审稿意见(逐条采纳)', ...reviewIssues.map((s, i) => `${i + 1}. ${s}`))
  }
  if (strategyHint) {
    parts.push('', strategyHint)
  }
  parts.push(
    '',
    '## 要求',
    kind === 'short'
      ? '按指令重写整章正文(8000-20000 字,单章完整开合:铺垫→反转→收尾)。正文以 ## 标题分五段(## 开头钩子 / ## 铺垫 / ## 升级 / ## 反转 / ## 余韵,与节数机检同口径),段内纯叙事文本。'
      : '按指令重写整章正文(2000-4000 字,单章一主场景,章尾留钩)。',
  )
  return parts.join('\n')
}

/** 组续写 prompt(M2 续写解选区:全文作语境,只输出续写部分,不复述原文)*/
export function buildAppendPrompt(original: string, instruction: string): string {
  return [
    '## 正文全文(语境)',
    original.trim() || '(本章尚无正文,从头开写)',
    '',
    '## 续写指令',
    instruction,
    '',
    '## 要求',
    '在正文之后继续写。只输出续写部分,不要复述或改动原文任何内容;保持正文纯文本(段落+空行,禁 MD 标题/格式),延续当前文风与情节。',
  ].join('\n')
}

/** append 续写拼稿:原文(去尾换行)+ 空行 + 续写;空白页直接用续写 */
export function appendRewritten(original: string, produced: string): string {
  const base = original.replace(/\n+$/, '')
  return base ? `${base}\n\n${produced}` : produced
}

/** 行级 LCS diff → DiffLine[](export 供测试)*/
export function lineDiff(a: string, b: string): DiffLine[] {
  const la = a.split('\n')
  const lb = b.split('\n')
  const n = la.length
  const m = lb.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const ai = la[i] ?? ''
      const bj = lb[j] ?? ''
      dp[i]![j] = ai === bj ? (dp[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const ai = la[i] ?? ''
    const bj = lb[j] ?? ''
    if (ai === bj) {
      out.push({ type: 'same', text: ai })
      i++
      j++
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      out.push({ type: 'del', text: ai })
      i++
    } else {
      out.push({ type: 'add', text: bj })
      j++
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: la[i] ?? '' })
    i++
  }
  while (j < m) {
    out.push({ type: 'add', text: lb[j] ?? '' })
    j++
  }
  return out
}