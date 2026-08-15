/**
 * PromptSection 命名段注册表（批次 C1 / DSH-16 直抄思想）。
 *
 * system prompt 不再是整段字符串，而是命名段落按 order 升序拼接：
 * - order 是「分层优先级契约」的数值化：小者靠前且约束力更强——
 *   平台约束（输出格式纪律/协议）> 写作风格（钩子/情绪/文风）> 设定数据（书设定注入）。
 *   预算/裁剪场景（C3 设定注入预算）从大 order 端开始丢，平台约束永不被裁。
 * - complete:true 的段独占整份 prompt（dsh 语义：整段即全部）。
 * - `{{variable}}` 渲染期插值（未提供的变量原样保留）。
 *
 * 现有 writer/review/analyst 的段 order 为保持既有字节序（前缀缓存/行为零变化）
 * 采用了各文件的局部值；新增 prompt 优先用下面的标准带。
 */

export interface PromptSection {
  /** 段名（注册表键；同一份 prompt 内唯一） */
  name: string
  /** 升序拼接序；同 order 按传入序（稳定排序） */
  order: number
  /** 段正文（内部换行原样保留） */
  text: string
  /** true = 独占整份 prompt，不允许与其他段同席 */
  complete?: boolean
}

/** 标准分层带（新 prompt 用；数值小 = 靠前 + 约束力强 + 预算裁剪时最后丢） */
export const SECTION_ORDER = {
  /** 人设：角色身份定调（对应 dsh 的 harness 身份位） */
  PERSONA: 0,
  /** 平台约束：输出格式纪律 / 工具协议——最硬，永不被风格/设定覆盖 */
  PLATFORM: 100,
  /** 写作风格：钩子/情绪/文风指南 */
  STYLE: 200,
  /** 工具指引：输出方式段（review 历史字节序里输出方式在焦点段前，用局部值） */
  TOOLING: 300,
  /** 设定数据：书设定注入——最软，预算超限最先丢（对接 C3） */
  SETTINGS: 400,
} as const

/** `{{variable}}` 渲染期插值；未提供的变量原样保留 */
export function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? vars[k]! : m))
}

/**
 * 段组装：order 升序（稳定）→ '\n\n' 拼接。
 * complete 段独占：多段同席含 complete → throw（配置错误显式暴露）。
 */
export function assembleSections(sections: PromptSection[], vars?: Record<string, string>): string {
  const completes = sections.filter((s) => s.complete)
  if (completes.length > 1) throw new Error('complete 段独占：不允许多个 complete 段同席')
  if (completes.length === 1) {
    if (sections.length > 1) throw new Error(`complete 段独占：${completes[0]!.name} 不允许与其他段同席`)
    return interpolate(completes[0]!.text, vars ?? {})
  }
  const sorted = [...sections].sort((a, b) => a.order - b.order) // Array.sort 稳定
  return sorted.map((s) => interpolate(s.text, vars ?? {})).join('\n\n')
}
