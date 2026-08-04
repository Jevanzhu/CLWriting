/**
 * TaskSpec 任务声明 + runSpec 执行器（A1 声明化）。
 *
 * 收敛 7 条 AI 链路各自手抄的五件套（system/tool/tier/mock/decode 样板），
 * 从每处 20-40 行降至 3 行。声明与执行分离，为 A2 规则挂载提供一等公民。
 *
 * 范围：只收敛静态配置 + 样板消除，不做通用 Pipeline 抽象（YAGNI）。
 */
import type { ChatMsg, ToolDef } from '../provider/types.js'
import type { TaskResult } from '../runner.js'
import { runTask } from '../runner.js'
import { generate, generateTool, GenError } from '../gen.js'
import { rulesToPrompt } from '../rules/index.js'

/** 任务生成模式 */
type GenMode = 'text' | 'tool'

/**
 * 任务声明——收敛五件套静态配置。
 *
 * 动态参数（如 self-heal 的 kind、review 的 lens）通过工厂函数处理：
 * 各 spec 文件导出工厂（如 `selfHealSpec(kind)`），调用方不手抄五件套。
 */
export interface TaskSpec {
  /** 任务名（trace/记账用，如 'self-heal'） */
  name: string
  /** 任务档位 */
  tierKind: 'creative' | 'assistant' | 'chat'
  /** 生成模式：'text' → generate（纯文本），'tool' → generateTool（结构化产出） */
  genMode: GenMode
  /** system prompt（A2 后由规则拼接补充） */
  systemPrompt: string
  /** 工具型：tool 定义 + 名称（genMode='tool' 时必填） */
  tool?: { def: ToolDef; name: string }
  /** mock 快路：工具型（mockTool 名）或文本型（CLWRITING_DRIVER=mock 时生效） */
  mock?: { kind: 'tool'; toolName: string } | { kind: 'text'; text: string }
}

/** runSpec 执行选项 */
export interface SpecOpts {
  userDataPath: string | null
  /** user prompt 文本 */
  userPrompt: string
  /** 书库根路径（trace + 记账用） */
  bookRoot?: string
  /** 章号（仅 self-heal 传；记账 chapter 块用） */
  chapter?: number
  /** 外部传入的 ctrl（如 self-heal 编排级 AbortController） */
  ctrl?: AbortController
  /** 登记 ctrl → driver */
  register?: (ctrl: AbortController) => void
  /** 重试前回调（推 reset 事件清前端缓冲） */
  onReset?: () => void
  /** 文本增量回调（SSE 逐字转发） */
  onText?: (delta: string) => void
  /** 覆盖 spec.systemPrompt（动态场景如 stream 的 role 切换） */
  systemPromptOverride?: string
  /** 覆盖 spec.tool（动态场景如 review 的逐 lens 切换） */
  toolOverride?: { def: ToolDef; name: string }
  /** 覆盖 spec.mock（动态场景如 self-heal 的 kind 切换） */
  mockOverride?: { kind: 'tool'; toolName: string } | { kind: 'text'; text: string }
}

/** runSpec 产出（统一形状，调用方按需取字段） */
export interface SpecOutput {
  /** tool_use 结构化产出（文本型为 null） */
  input: unknown
  /** 纯文本产出 */
  text: string
  /** 停止原因 */
  stopReason: string
}

/**
 * 用 TaskSpec 跑一次 AI 生成。
 *
 * 内部封装 resolveTier + generate/generateTool + runTask 样板。
 * 返回 TaskResult<SpecOutput>，调用方从 output.input / output.text decode。
 */
export async function runSpec(
  spec: TaskSpec,
  opts: SpecOpts,
): Promise<TaskResult<SpecOutput>> {
  // A2：按 spec.name 拼接适用规则的 toPrompt()（写稿查 AI 味、审稿不查，由挂载关系表达）
  const systemPrompt = (opts.systemPromptOverride ?? spec.systemPrompt) + rulesToPrompt(spec.name, opts.bookRoot)
  const tool = opts.toolOverride ?? spec.tool
  const mock = opts.mockOverride ?? spec.mock
  const messages: ChatMsg[] = [{ role: 'user', content: opts.userPrompt }]

  return runTask<SpecOutput>({
    userDataPath: opts.userDataPath,
    tierKind: spec.tierKind,
    task: spec.name,
    bookRoot: opts.bookRoot,
    chapter: opts.chapter,
    promptText: opts.userPrompt,
    ctrl: opts.ctrl,
    register: opts.register,
    onReset: opts.onReset,
    ...(mock?.kind === 'tool' ? { mockTool: mock.toolName } : {}),
    ...(mock?.kind === 'text' ? { mockText: { input: null, text: mock.text, stopReason: 'mock' } as unknown as SpecOutput } : {}),
    run: async (provider, signal, tier) => {
      if (spec.genMode === 'tool' && tool) {
        const r = await generateTool(
          provider,
          { systemPrompt, messages, effort: tier.effort, tools: [tool.def], toolChoice: 'tool', toolName: tool.name },
          signal,
          opts.onText,
        )
        return { input: r.input, text: r.text, stopReason: r.stopReason }
      }
      // 文本型
      const r = await generate(
        provider,
        { systemPrompt, messages, effort: tier.effort },
        signal,
        opts.onText,
      )
      if (r.stopReason === 'max_tokens') {
        throw new GenError('AI 产出达到长度上限被截断，请精简输入提示或稍后重试。', false)
      }
      return { input: null, text: r.text, stopReason: r.stopReason }
    },
  })
}
