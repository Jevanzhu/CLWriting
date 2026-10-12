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
 * 按模型的 chars → tokens 实测系数表。
 * 校准来源：`npx tsx scripts/calibrate-tokens.ts` 读事件库 llm/call 的
 * promptMeta.chars × usage.input 成对样本，按模型最小二乘拟合——产出报告后
 * 人工把建议值写进本表并注明测定日期与样本量（低频动作，不做运行时配置）。
 * 匹配规则：模型 id 最长前缀命中（如 'claude-sonnet' 覆盖 'claude-sonnet-4-5'）。
 *
 * 误差上界与方向（本模块的折算口径声明，消费方 ai/provider/usage-estimate.ts 头注同源）：
 * - **表空 = 全局单一系数 0.6（DEFAULT_TOKEN_COEFF）**，误差方向由文本构成决定：
 *   中文正文在现代分词器下约 0.6–1.0 token/码位（字），0.6 落在**下沿 → 中文侧偏低**
 *   （真值取 1.0 时低估至多约 40%）；ASCII 结构字符（JSON 骨架、工具 schema 键名）
 *   约 0.25–0.35 token/码位（3–4 码位/token），同一系数下**高估约 2 倍**。
 * - 分词器边界效应（中英混排、长数字串被切碎）无法被「单一乘性系数」包络，故本口径
 *   **给不出相对真值的严格双向上界**。声明为：对以中文正文为主的输入，误差以**低估**
 *   为主且量级在数十个百分点内；估算是量级与排序口径，不作计费真值。
 * - 长度按码位而非字节 / UTF-16 码元：码位口径的换算误差为零（同库 spill/compaction
 *   同源），此处不引入误差。
 * - **待校准状态**：空表是登记在案的观察项而非代码欠账——系数必须由真实语料拟合，
 *   无样本时任何手填值都是拍脑袋。样本入口与过滤口径见 scripts/calibrate-tokens.ts
 *   与 ai/token-calibration.ts（拟合需 n≥30/模型；chat 轮样本因 promptMeta.chars 只记
 *   末条消息而剔除）。语料到位后跑脚本回填，消费方（预算闸 / 估算入账）自动跟随。
 *
 * 结构性输入（工具 schema、消息外壳等）不属本函数的折算面——它们由估算入口
 * （estimateInputTokens）在调用本函数之前并入文本，理由与残差项见该文件头注。
 */
export const TOKEN_COEFFICIENTS: Record<string, number> = {
  // 首次跑校准脚本后按「模型 id: 系数, //，n=样本量，r=拟合度」回填（测定日期随注释记），形如：
  // 'claude-sonnet': 0.58, //，n=1234，r=0.97
  // 空表是「待校准」状态而非代码欠账——系数必须来自
  // 真实语料拟合（无值可填，属登记观察项）；语料收集到位后跑 calibrate-tokens.ts 回填。
}

/** 全局兜底系数（校准前的既有口径：中文约 0.6 token/字）。
 *  量级参照：中文在现代分词器下约 0.6–1.0 token/码位，0.6 取其下沿；
 *  ASCII 结构字符约 0.25–0.35 token/码位，故同一系数对结构文本高估约 2 倍——
 *  两个方向的定量声明、残余误差来源与「不作计费真值」的边界见上方表头注释。 */
export const DEFAULT_TOKEN_COEFF = 0.6

/** token 粗估（#12 第 5 节）：按模型查实测系数表，未命中回落 0.6。
 * 长度按 code points 计（非分配计数器）——与 spill/compaction 全库
 *  口径统一；此前 text.length 是 UTF-16 码元，含 emoji/增补平面文本预算估长偏差至多 2 倍。
 *  内存核查（a）：Array.from(text).length 换 codePointLength——
 *  预算闸每段至少一调，展开数组是 6-10× 瞬态分配，码位语义不变。
 * 纯函数契约：只折算**传入的文本**，不隐式追加任何结构项（请求体结构由调用方
 *  自行并入——估算入口见 ai/provider/usage-estimate.ts，这样同一纯函数
 *  可服务两种量纲：备料段文本，以及「文本 + 结构增量」的整请求估算）。 */
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
