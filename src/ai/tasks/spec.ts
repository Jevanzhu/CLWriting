/**
 * TaskSpec 任务声明 + runSpec 执行器（A1 声明化）。
 *
 * 收敛 7 条 AI 链路各自手抄的五件套（system/tool/tier/mock/decode 样板），
 * 从每处 20-40 行降至 3 行。声明与执行分离，为 A2 规则挂载提供一等公民。
 *
 * 范围：只收敛静态配置 + 样板消除，不做通用 Pipeline 抽象（YAGNI）。
 */
import type { ChatMsg, ToolDef, TokenUsage } from '../provider/types.js'
import type { TaskResult } from '../runner.js'
import { runTask } from '../runner.js'
import { generate, generateTool, GenError } from '../gen.js'
import { rulesPromptParts } from '../rules/index.js'
import { resolveBuiltinSystemPrompt } from '../prompts/resource.js'

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
  /** 外部传入的 ctrl（如 self-heal 编排级 AbortController）；与 signal 同时传时 ctrl 优先 */
  ctrl?: AbortController
  /**
   * Z-P1-1：外部中断信号（如 chat 编排级 signal）——内部桥接为 ctrl 传入 runTask，
   * 嵌套生成随调用方中断同步中止。调用方只持有 AbortSignal（工具层透传场景）时用这个，
   * 免去各调用点手抄 signal → AbortController 桥接。
   */
  signal?: AbortSignal
  /** 登记 ctrl → driver */
  register?: (ctrl: AbortController) => void
  /** 重试前回调（推 reset 事件清前端缓冲） */
  onReset?: () => void
  /** 重试回调（可重试错误退避前触发）——推 warning 告知前端「AI 响应异常，重试中」 */
  onRetry?: (attempt: number, error: string) => void
  /** 文本增量回调（SSE 逐字转发） */
  onText?: (delta: string) => void
  /** 覆盖 spec.systemPrompt（动态场景如 stream 的 role 切换） */
  systemPromptOverride?: string
  /** 覆盖 spec.tool（动态场景如 review 的逐 lens 切换） */
  toolOverride?: { def: ToolDef; name: string }
  /** 覆盖 spec.mock（动态场景如 self-heal 的 kind 切换） */
  mockOverride?: { kind: 'tool'; toolName: string } | { kind: 'text'; text: string }
  /** C1（批 2）：prompt 引用的材料文件（相对书根）——随 llm/call 事件 promptMeta.files
   *  登记，满足「模型可见 ⟺ 已记录」（备料注入的章摘要等可回溯到源文件） */
  promptFiles?: string[]
}

/** runSpec 产出（统一形状，调用方按需取字段） */
export interface SpecOutput {
  /** tool_use 结构化产出（文本型为 null） */
  input: unknown
  /** 纯文本产出 */
  text: string
  /** 停止原因 */
  stopReason: string
  /** token 用量（V-P2-8：必须回传——runner 据此记 trace/任务账/前端计数；
   *  此前丢失导致真实链路 usage 全程为 0，只有 mock 路径有值） */
  usage?: TokenUsage
  /** Q-13（第十五轮）：适配器 resolve 后上线输出上限——runner 提取落 llm/call（铁律②重放口径） */
  resolvedMaxTokens?: number
}

/**
 * Z-P1-1：signal → AbortController 桥接——runTask 形参是 ctrl（控制器），
 * 而工具层只能拿到编排方的 AbortSignal（chat 把 state.ctrl.signal 下发到 ToolContext），
 * 在此单点桥接，调用方不各抄一份。已 aborted 的信号直接落 abort（不发请求）。
 * 二轮复审（低级）：detach 供 runSpec 收尾摘监听——长寿命编排 signal（chat/self-heal
 * 跨章）上正常完成的调用不摘会在 signal 上逐次累积 listener（ee-P1-2 同构，once 触发后为 no-op）。
 */
function ctrlFromSignal(signal: AbortSignal): { ctrl: AbortController; detach: () => void } {
  const ctrl = new AbortController()
  const onAbort = (): void => ctrl.abort()
  if (signal.aborted) ctrl.abort()
  else signal.addEventListener('abort', onAbort, { once: true })
  return { ctrl, detach: () => signal.removeEventListener('abort', onAbort) }
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
  // C2：内置 prompt 运行期精确匹配——spec.systemPrompt 命中内置（任意历史版本）哈希时
  // 换成 overlay/当前内置（用户覆盖层优先）；rulesToPrompt 拼接段与动态 prompt 不受影响
  const base = resolveBuiltinSystemPrompt(opts.systemPromptOverride ?? spec.systemPrompt, opts.userDataPath ?? undefined) ?? ''
  // A8（五十九轮）：注入文本与登记清单同一次读盘派生（rulesPromptParts 单源）——此前
  // rulesToPrompt 与 rulesPromptFiles 各自独立读盘，微观窗口注入与登记可撕裂
  const parts = rulesPromptParts(spec.name, opts.bookRoot)
  const systemPrompt = base + parts.prompt
  // Y-2（第五十七轮）：rules 注入段源文件并入 promptFiles（铁律①「模型可见⟺已记录」——
  // AI味词表条目库与 rule-hits.json 为可变文件，仅入哈希不可重建，登记后事件可溯源）
  const promptFiles = [...new Set([...(opts.promptFiles ?? []), ...parts.files])]
  const tool = opts.toolOverride ?? spec.tool
  const mock = opts.mockOverride ?? spec.mock
  const messages: ChatMsg[] = [{ role: 'user', content: opts.userPrompt }]

  // 二轮复审（低级）：桥接监听随调用收尾摘除——正常完成的调用不再把 listener
  // 留在 chat/self-heal 的长寿命 signal 上逐次累积
  const bridge = !opts.ctrl && opts.signal ? ctrlFromSignal(opts.signal) : null
  try {
    return await runTask<SpecOutput>({
      userDataPath: opts.userDataPath,
      tierKind: spec.tierKind,
      task: spec.name,
      bookRoot: opts.bookRoot,
      chapter: opts.chapter,
      // N-10（第十二轮）：动态 system（内置解析 + rules 拼接终值）落 trace——promptMeta
      // 哈希此前只有 userPrompt（铁律②重放口径：resolve 出的最终 system 不进哈希 = 不可
      // 精确重建）；chat 轮（turns.ts）与 checkpoint（finish.ts）已传，此处漏
      systemPrompt,
      promptText: opts.userPrompt,
      promptFiles,
      ctrl: opts.ctrl ?? bridge?.ctrl,
      register: opts.register,
      onReset: opts.onReset,
      onRetry: opts.onRetry,
      ...(mock?.kind === 'tool' ? { mockTool: mock.toolName } : {}),
      ...(mock?.kind === 'text' ? { mockText: { input: null, text: mock.text, stopReason: 'mock' } as unknown as SpecOutput } : {}),
      run: async (provider, signal, tier) => {
        if (spec.genMode === 'tool' && tool) {
          const r = await generateTool(
            provider,
            { systemPrompt, messages, effort: tier.effort, tools: [tool.def], requireTool: true, toolName: tool.name },
            signal,
            opts.onText,
          )
          return { input: r.input, text: r.text, stopReason: r.stopReason, usage: r.usage, resolvedMaxTokens: r.resolvedMaxTokens }
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
        return { input: null, text: r.text, stopReason: r.stopReason, usage: r.usage, resolvedMaxTokens: r.resolvedMaxTokens }
      },
    })
  } finally {
    bridge?.detach()
  }
}
