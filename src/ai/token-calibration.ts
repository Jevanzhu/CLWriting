/**
 * C4（批 3）token 系数实测校准——拟合逻辑（纯函数，脚本/测试共用）。
 *
 * 模型口径：tokens ≈ coeff × chars（过原点最小二乘：coeff = Σ(c·t) / Σ(c²)）。
 * 过原点而非带截距：chars=0 必然 tokens=0（系统提示外的空 prompt 不存在计量），
 * 且预算闸只需要单系数可解释（「每字多少 token」），带截距反而不利人读。
 * 样本来源：事件库 llm/call 的 promptMeta.chars（系统+用户 prompt 字数）× usage 全口径
 * token（input + cacheRead + cacheWrite，M-1 归一后；calibrate 脚本按此口径喂入——预算
 * 闸同口径，系数直接可比。注意不是裸 usage.input）。
 */

export interface CalibrationSample {
  model: string
  /** prompt 字数（promptMeta.chars） */
  chars: number
  /** 输入 token（由调用方喂入；calibrate 脚本喂 M-1 全口径 input+cacheRead+cacheWrite，非裸 usage.input） */
  inputTokens: number
}

export interface CoefficientFit {
  /** 建议 coeff（样本不足/退化 → null） */
  coeff: number | null
  /** 样本量 */
  n: number
  /** Pearson 相关（拟合度；过原点回归下可略低于带截距，作参考不作门槛） */
  r: number | null
  /** 样本 chars 范围（报告用） */
  charsRange: [number, number] | null
}

/**
 * 按模型分组拟合。过滤口径：
 * - chars ≤ 0 或 tokens ≤ 0 的行丢弃（记账缺失/异常）；
 * - 样本 < 30 不给建议值（n 太小拟合不稳，报告仍列出样本量供判断）。
 */
export function fitCoefficients(samples: CalibrationSample[]): Map<string, CoefficientFit> {
  const byModel = new Map<string, { c: number; t: number }[]>()
  for (const s of samples) {
    if (s.chars <= 0 || s.inputTokens <= 0) continue
    const arr = byModel.get(s.model) ?? []
    arr.push({ c: s.chars, t: s.inputTokens })
    byModel.set(s.model, arr)
  }
  const out = new Map<string, CoefficientFit>()
  for (const [model, rows] of byModel) {
    const n = rows.length
    const sumCT = rows.reduce((a, r) => a + r.c * r.t, 0)
    const sumCC = rows.reduce((a, r) => a + r.c * r.c, 0)
    const meanC = rows.reduce((a, r) => a + r.c, 0) / n
    const meanT = rows.reduce((a, r) => a + r.t, 0) / n
    // Pearson r（判断线性程度）
    let num = 0
    let denC = 0
    let denT = 0
    for (const r of rows) {
      num += (r.c - meanC) * (r.t - meanT)
      denC += (r.c - meanC) ** 2
      denT += (r.t - meanT) ** 2
    }
    const r = denC > 0 && denT > 0 ? num / Math.sqrt(denC * denT) : null
    const charsSorted = [...rows].map((x) => x.c).sort((a, b) => a - b)
    out.set(model, {
      coeff: n >= 30 && sumCC > 0 ? sumCT / sumCC : null,
      n,
      r,
      charsRange: [charsSorted[0]!, charsSorted[charsSorted.length - 1]!],
    })
  }
  return out
}

/** 拟合结果 → 人读报告（markdown）；脚本 stdout 与测试快照共用 */
export function renderCalibrationReport(fits: Map<string, CoefficientFit>, measuredAt: string): string {
  const lines = [
    '# token 系数校准报告（C4）',
    '',
    `- 测定日期：${measuredAt}`,
    '- 口径：tokens ≈ coeff × chars（过原点最小二乘；chars = promptMeta.chars，tokens = usage 全口径 input+cacheRead+cacheWrite，M-1 归一后）',
    '- 建议值写进 src/process/prepare.ts 的 TOKEN_COEFFICIENTS（注明测定日期与样本量）',
    '',
    '| 模型 | 样本量 | 建议 coeff | 相关 r | chars 范围 |',
    '|---|---|---|---|---|',
  ]
  const models = [...fits.keys()].sort()
  for (const m of models) {
    const f = fits.get(m)!
    lines.push(
      `| ${m} | ${f.n} | ${f.coeff === null ? '—（样本不足）' : f.coeff.toFixed(4)} | ${f.r === null ? '—' : f.r.toFixed(3)} | ${f.charsRange ? `${f.charsRange[0]}–${f.charsRange[1]}` : '—'} |`,
    )
  }
  if (models.length === 0) lines.push('|（无样本——事件库里没有可用的 llm/call 记账对）| | | | |')
  return lines.join('\n')
}
