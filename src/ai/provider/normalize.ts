/**
 * 模型 id 归一化管线（批次 D3，学 cherry-studio normalize.ts）。
 *
 * 产出三种键（三键索引，供 detectFamily 二道解析 / 未来目录行匹配）：
 * - raw   原文（trim 后）
 * - sized 保留参数尺寸键（`gpt-oss:20b` → `gpt-oss-20b`，不塌缩到 `gpt-oss-120b`）
 * - norm  尺寸无关键（再剥参数尺寸段：`qwen3-235b-a22b` → `qwen3`）
 *
 * 三条踩坑注释（照抄 cherry，防翻车）：
 * ① 后缀剥离必须**不动点循环**而非单趟——尾部日期会遮住内层变体后缀
 *   （`model-20260815-preview` 单趟剥 `-preview` 后日期才暴露）。
 * ② 日期快照后缀要求合法月份 01-12 / 日期 01-31——`gpt-4-0125`（1月25日）剥，
 *   `gpt-4-9900`（非法月份）永不剥；`glm-4-9b`、`qwen3-235b` 根本不匹配日期形态。
 * ③ 变体后缀表**刻意保守**：只收 `-latest` / `-preview`，不含 `-medium`（真 tier 名）、
 *   `-mini`（o3-mini 是真型号）——剥错 stem 比多留一段后缀更糟（宁缺勿错）。
 */
export interface ModelIdKeys {
  raw: string
  sized: string
  norm: string
}

/** 剥组织前缀（`deepseek-ai/deepseek-chat`、`zai-org/glm-4.7`、`openrouter/deepseek/...`）——循环剥净嵌套 */
function stripOrgPrefix(id: string): string {
  let out = id
  while (true) {
    const next = out.replace(/^[a-z0-9][a-z0-9._-]*\//, '')
    if (next === out) return out
    out = next
  }
}

/** 尺寸冒号变体 → 连字符（`gpt-oss:20b` → `gpt-oss-20b`；registry-tag 形态统一到连字符形态） */
function colonSizeToHyphen(id: string): string {
  return id.replace(/:(\d+(?:\.\d+)?[bm])$/, '-$1')
}

/** YYYYMMDD 是否真实日历日期（月份 01-12 / 日期 01-31——踩坑②；月=第5-6位、日=第7-8位） */
function isValidYYYYMMDD(s: string): boolean {
  const month = Number(s.slice(4, 6))
  const day = Number(s.slice(6, 8))
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
}

/** MMDD 是否真实日期（同上口径） */
function isValidMMDD(s: string): boolean {
  const month = Number(s.slice(0, 2))
  const day = Number(s.slice(2, 4))
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
}

/** 量化后缀（vLLM 部署形态：q4_0 / q8_0 / int8 / fp8 / awq / gptq） */
const QUANT_RE = /-(?:q\d+(?:_\d+)?|int8|fp8|awq|gptq)$/

/** 参数尺寸段（`-20b` / `-235b` / `-a22b` 激活参数 / `-4.7b`）——仅 norm 键剥（sized 键保留） */
const SIZE_RE = /-a?\d+(?:\.\d+)?[bm]$/

/** 单趟剥一个尾部后缀；返回 null = 无可剥（不动点循环出口，踩坑①） */
function stripOneSuffix(id: string, keepParameterSize: boolean): string | null {
  // 日期快照：YYYYMMDD（2026 前后年份——20250219 / 260815 形态都在真实目录出现）
  let m = id.match(/-(\d{8})$/)
  if (m && isValidYYYYMMDD(m[1]!)) return id.slice(0, -m[0].length)
  // 日期快照：MMDD（gpt-4-0125 = 1月25日；9900 非法月份不剥，踩坑②）
  m = id.match(/-(\d{4})$/)
  if (m && isValidMMDD(m[1]!)) return id.slice(0, -m[0].length)
  // 变体后缀（保守表，踩坑③）
  if (/(?:-latest|-preview)$/.test(id)) return id.replace(/-(?:latest|preview)$/, '')
  // 量化后缀
  if (QUANT_RE.test(id)) return id.replace(QUANT_RE, '')
  // 参数尺寸段（仅尺寸无关键）
  if (!keepParameterSize && SIZE_RE.test(id)) return id.replace(SIZE_RE, '')
  return null
}

/**
 * 归一化模型 id。管线：小写 → 剥组织前缀 → 冒号尺寸转连字符 →
 * 不动点循环剥尾部后缀（日期/变体/量化/尺寸）→ 下划线折叠为连字符。
 *
 * @param opts.keepParameterSize true = 保留参数尺寸段（sized 键）；
 *                                false/缺省 = 连尺寸一起剥（norm 键）
 */
export function normalizeModelId(id: string, opts?: { keepParameterSize?: boolean }): string {
  const keep = opts?.keepParameterSize ?? false
  let out = colonSizeToHyphen(stripOrgPrefix(id.trim().toLowerCase()))
  while (true) {
    const next = stripOneSuffix(out, keep)
    if (next === null) return out.replace(/_/g, '-')
    out = next
  }
}

/** 三键一次算齐（detectFamily / 未来目录查找共用） */
export function modelIdKeys(id: string): ModelIdKeys {
  return {
    raw: id.trim(),
    sized: normalizeModelId(id, { keepParameterSize: true }),
    norm: normalizeModelId(id),
  }
}
