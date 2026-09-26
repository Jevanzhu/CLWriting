/**
 * 输入预算的 token 折算纯函数单源（自 process/prepare.ts 下沉 shared）。
 *
 * 起因：的 chars→tokens 系数表与 estimateTokens 原居编排层 process/prepare.ts，
 * 而最底层 provider 适配器族（provider/usage-estimate.ts 网关不回 usage 时的兜底折算）
 * 反向依赖编排层——provider→process→ai 的传递依赖把适配器族与编排层卷进同一强连通。
 * 下沉本模块后引用方向恢复单向（provider/process 各自向下引 shared，shared 不引任何上层）。
 *
 * 零内部依赖（仅同目录 text.ts；对齐 short-defaults.ts / text.ts 的 shared 惯例）：
 * 任意层引用均无依赖倒挂与循环风险。函数语义逐位不变（原实现整体随迁，见 git 历史）。
 */
import { codePointLength } from './text.js'

/**
 * 按模型的 chars→tokens 实测系数表（-①）。
 * 校准来源：`npx tsx scripts/calibrate-tokens.ts` 读事件库 llm/call 的
 * promptMeta.chars × usage.input 成对样本，按模型最小二乘拟合——产出报告后
 * 人工把建议值写进本表并注明测定日期与样本量（低频动作，不做运行时配置）。
 * 匹配规则：模型 id 最长前缀命中（如 'claude-sonnet' 覆盖 'claude-sonnet-4-5'）。
 */
export const TOKEN_COEFFICIENTS: Record<string, number> = {
  // 测定日期：尚未实测（建表）。首次跑校准脚本后填入，形如：
  // 'claude-sonnet': 0.58, // ，n=1234，r=0.97
  // （二十六轮·登记不修）：空表是「待校准」状态而非代码欠账——系数必须来自
  // 真实语料拟合（无值可填，属登记观察项）；语料收集到位后跑 calibrate-tokens.ts 回填。
}

/** 全局兜底系数（校准前的既有口径：中文约 0.6 token/字） */
export const DEFAULT_TOKEN_COEFF = 0.6

/** token 粗估（#12 第 5 节）：按模型查实测系数表，未命中回落 0.6。
 *  ：长度按 code points 计（非分配计数器）——与 spill/compaction 全库
 *  口径统一；此前 text.length 是 UTF-16 码元，含 emoji/增补平面文本预算估长偏差至多 2 倍。
 *  内存核查（a）：Array.from(text).length 换 codePointLength——
 *  预算闸每段至少一调，展开数组是 6-10× 瞬态分配，码位语义不变。 */
export function estimateTokens(text: string, model?: string): number {
  let coeff = DEFAULT_TOKEN_COEFF
  if (model) {
    let best = ''
    for (const prefix of Object.keys(TOKEN_COEFFICIENTS)) {
      if (model.startsWith(prefix) && prefix.length > best.length) best = prefix
    }
    if (best) coeff = TOKEN_COEFFICIENTS[best]!
  }
  return Math.ceil(codePointLength(text) * coeff)
}
