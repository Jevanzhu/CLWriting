# Responses 格式适配 · 设计方案

日期：2026-08-13　状态：**已完成**（2026-08-17 启用批启动——作者拍板，按 R1-R4 实施；R1-R4 已落地、验收清单 11/11 全绿——余 1 项中转网关真机验证于 2026-09-04 经作者中转 CCats（https://ccats.art）实测三模型全部判决「可用」收口，完成记详见实现方案头部 2026-09-04 块）。
执行主方案见《服务商三格式重构-执行方案-2026-08-13.md》。
代码级实施蓝图见《Responses格式适配-实现方案-2026-08-15.md》（8-15 起，缺口编号沿用本文第四节）。

> **2026-08-17 找回**：Z-P2-1 曾于 2026-08-16 拍板「后端拒配」并将本文与实现方案
> 失效归档——系**误判**，作者澄清本意为**暂缓非不做**，两篇自 `Archive/` 找回
> 归位 `03-设计/`，恢复暂缓效力。注意：`responses-adapter.ts` 已随 84e370b 删除，
> 本文第三节「现有适配器已实现」所述骨架启用时先自 git 历史找回
> （`git show 84e370b^:src/ai/provider/responses-adapter.ts`）；当前代码的
> 拒配报错/协议枚举收窄在启用批一并回接。

> **2026-08-17 启用**：作者拍板开工（启用条件：gpt-5/grok 深度使用需求）；
> 文档转 `02-执行/`，实现方案随批注入现状层修订（见其头部 8-17 修订块）。

> **2026-08-14 更新（表驱动重构后）**：第四节缺口清单部分已被填补——
> ① effort 已翻译（responses-adapter 发 `reasoning:{effort}`，档位走 quirks 表；
> 但 grok 顶层 `reasoning_effort` 与 deepseek `output_config.effort` 仍未分家）；
> ② tool_choice 仍未翻译（u 轮 U-P2-4 后置，注释「无此参数」已知有误）；
> assistant 块序倒置已修（t 轮 #11）。

> **2026-08-15 评审修订（对照代码全量重核 + 参考项目印证）**：
> - **UI 事实过时**：`2554c93`（8-13 晚）已删 presets 速填系统 + 类型栏改协议
>   二选一——openai-responses 在 UI **已无入口**（仅后端 parseProviderInput
>   仍接受该值）。第一节第 3 条的 UI 前提失效；原缺口 8（速填条目）作废，
>   改为「协议栏三选一」。
> - **新发现正确性缺口**：`response.failed` / `error` 流事件未处理，失败被
>   流结束兜底 done 伪装成正常完成（providers.ts:311 注释已点名，原清单漏收）；
>   同类还有 incomplete 非 max_output_tokens 原因落空、done 兜底零计量。
> - **原缺口 2（tool_choice）修法升级**：不止适配器补翻译——gen.ts 意图翻译
>   消费 quirks 表而表无协议维度，意图在 responses 线被静默丢弃，需三层联动。
> - **新增隐私缺口**：OpenAI 默认 store=true（响应留存 30 天），书稿全文上行
>   场景须显式 `store:false`（cherry 全线无条件 false 印证）。
> - **参考项目研读**（cherry-studio / deepseek-harness，详见 第六节）产出：
>   encrypted reasoning 回传机制（新 11）、usage 细节计量（新 12）、
>   响应侧归一化（新 18）三条原清单没有的缺口；1-3 修法定型为终止事件契约；
>   6 的表结构定型为「协议格式级 profile × 家族覆盖」。
> - 第四节整体重写（旧编号全部作废），第五节补批次拆解 + 验收清单 + 落点。

## 一、暂缓决策（Jevan 拍板）

- UI 上 Responses API 排最后；默认推荐 Chat 接口
- responses-adapter.ts 现有代码**保留**（骨架可用：流事件解析、
  工具拼装、结构化输出、400 降级均已实现），不删不改
- 协议选项在 UI 保留可选；速填预设不含 Responses 条目
  （**8-15 修订**：presets 已整体删除、协议栏已二选一，本条 UI 前提失效；
  启用时改为协议栏三选一，见缺口 15）
- 本文档记录启用时需要补的全部缺口，避免知识丢失

## 二、支持面（2026-08-13 调研）

| 家 | /v1/responses | 备注 |
|---|---|---|
| OpenAI | ✓ | gpt-5 系列官方主推；cherry 侧已是其默认线 |
| Grok | ✓ | 官方称首选；cherry 侧同为默认线（含 CLI 代理线） |
| DeepSeek | ✓ | 有兼容差异清单（见 16）；无现成参考实现（dsh 也只桥到 Chat 线） |
| GLM | ✗ | 两份 OpenAPI spec 均无此端点 |
| Kimi | ✗ | 文档未提及 |

## 三、现有适配器已实现

- input 数组组装（developer 角色 / function_call /
  function_call_output 往返；assistant 块序 t 轮 #11 已修）
- 流事件：output_text.delta、function_call_arguments.delta、
  output_item.done、completed、incomplete
- 结构化输出 text.format json_schema + 400 降级
- max_output_tokens、usage、stopReason 归一
- effort → `reasoning:{effort}`（8-14 起，档位走 quirks 表）

## 四、启用时需补的缺口（2026-08-15 重写，旧编号作废）

### A. 正确性——不修会把失败伪装成成功

**统一修法原则（dsh 终止事件契约，stream.ts 参照）**：流必须以
completed / incomplete / failed 之一收尾；无终止事件 = 传输截断
（报错，不发 done）；error 终止事件也带 usage 照常入账；
completed 但零 output = 退化完成，判错不判成功。

1. **`response.failed` / `error` 流事件未处理**（providers.ts:311 已点名）：
   事件 switch 只认 5 种，failed/error 落穿后由流结束兜底发
   `done{stop:'stop',usage:0/0}`——失败被记成正常空产出。修法：
   failed → yield error 事件（response.error details 脱敏后带上），
   不再走 done 兜底；SDK `error` 事件同理。
2. **`response.incomplete` 只认 max_output_tokens**：content_filter 等
   其他 incomplete_details.reason 同样落空 → 兜底 'stop' 伪装成功。
   修法：非 max_output_tokens 原因归一为 error（或明确 stopReason）。
3. **done 兜底零计量**：网关不发 completed 的场景兜底发 0/0+'stop'——
   与 1/2 同根（X-P2-10 计量漏账的 responses 面）。修法按上述契约：
   无终止事件报传输截断错误；dsh 另把「completed 零内容」也判
   EMPTY_RESPONSE 错误，一并抄。
4. **reasoning 事件接入**：`response.reasoning_text.delta`（Grok）与
   `response.reasoning_summary_text.delta`（OpenAI summary）→ GenEvent
   reasoning（契约侧已就绪）。cherry 将 openai-responses 列为原生
   reasoning 通道（无需 inline 标签提取，reasoningExtraction.ts）；
   回传侧见缺口 11。

### B. 参数翻译——quirks 增 responses 协议维度

**表结构定型（cherry 参照）**：推理档位 wire 按**协议格式**建 profile
（cherry reasoningProfiles.ts：`openai-responses` = effort 目标 +
reasoningSummary 目标），家族/端点用 reasoningFormat 覆盖（grok
responses 端点声明 type + effortMap），模型级 dialect 再覆盖——
比往 FamilyQuirks 塞第三协议字段更干净，effort/tool_choice/structured
三个维度的扩维都按此结构。

5. **tool_choice 三层联动**：现状 gen.ts:157-174 意图翻译按
   quirksFor(model) 判 toolChoiceMode，表无协议维度——gpt 走
   responses 时 ='named'，gen 把 requireTool 翻成 toolChoice 后适配器
   直接丢弃，意图静默丢失。修法三层一起改：① quirks 增协议覆盖
   （gpt/grok responses=named、deepseek=required）；② 适配器翻译
   auto / required / `{type:'function',name}`；③ 顺修两处错误注释
   （responses-adapter.ts:15「无此参数」、model-quirks.ts:58 'none' 注释）。
6. **effort 参数名分家**：openai `reasoning.effort`（+可选
   `reasoning.summary` 档位控制，cherry reasoningSummary 目标）/
   grok 顶层 `reasoning_effort`（两处均可）/ deepseek
   `output_config.effort`（low/high/max）——按上述格式级 profile 落表，
   档位映射随家走（grok 400 兜底沿用降级链）。
7. **structuredMode 消费**：适配器硬编码 text.format json_schema；
   按 quirks 表消费后与 Chat 线口径一致（deepseek 表值 json_object →
   不发 format 走 prompt 约束，避免首发 400 再降级）。
8. **grok max_output_tokens 含推理 token**：需定换算策略。校准数据源：
   响应 `usage.output_tokens_details.reasoning_tokens`（Responses
   usage 单列推理 token，dsh codex fixture 印证）——首版可保守透传 +
   探测 details 提示，积累 reasoning_tokens 观测后再定换算；并核实
   openai 侧 max_output_tokens 是否同含推理 token（若含则统一做）。
   参照：cherry grok-cli 线对 CLI 代理模型覆写 30k 输出上限
   （registry overrides，limits 维度）。
9. **store:false 显式下发**：OpenAI 默认 store=true（响应留存 30 天）——
   书稿全文上行场景必须显式 false（cherry openai 线无条件
   `store:false`，options.ts:401；codex 后端甚至强制）。DeepSeek 恒
   false 天然兼容；grok 无状态。
10. **stop_sequences**：无对应参数，静默忽略——探测 details 提示。

### C. 回合状态与计量——多轮工具调用的推理延续

11. **encrypted reasoning 回传**（cherry codex.ts / grokCli.ts 印证，
    原清单完全缺失）：`store:false` + 工具调用时，OpenAI 靠
    `include:['reasoning.encrypted_content']` 让响应携带加密推理项、
    下轮请求把 reasoning item 回传（置于 function_call 前）维持推理
    状态；ChatGPT codex 后端强制此机制。Grok CLI 代理相反——拒绝
    回传 reasoning item（cherry 剥除处理）。修法：GenRequest 为
    assistant 轮建模 reasoning 附件（Responses 线的 echoReasoning
    等价物），适配器组装 input 时回插；quirks 按家记「回传/剥除」。
    cherry 网关解析侧：reasoning item 的 content 优先、summary 兜底。
12. **usage 细节计量**：`input_tokens_details.cached_tokens` 与
    `output_tokens_details.reasoning_tokens`（dsh mapUsage 把
    cacheRead/cacheWrite 独立入账）——TokenUsage 扩字段与 8-15 计划
    D4（统一词汇 + cache token 记账）同批落，reasoning_tokens 同时
    是缺口 8 的校准源。
13. **verbosity（低优可选）**：Responses 独有 `text.verbosity`
    （low/medium/high）；cherry 按 model×provider 能力双闸下发。
    启用批次可不含，留 quirks 字段位。

### D. 周边接线

14. **降级记忆**（评审 P3「responses 线…降级无记忆」）：chat 线 400 降级
    命中写 providers.json 记忆、下次首发即剥；responses 线每次付重试。
    修法：createOpenAIResponsesProvider 接 store 参数（probe.ts
    createProvider 唯独 responses 分支没传 store，接线点在此）。
15. **UI 协议栏三选一**（替代原 8 速填条目——presets 已删）：AiServicePanel
    协议栏加 openai-responses 第三选项（排最后）+ 说明文案；后端
    parseProviderInput 已兼容。顺修 providers.ts:310-311 悬空编号注释
    （D1/D2/D6/D7 为 8-14 旧计划编号，8-15 计划仅 D1-D4）。
16. **DeepSeek Responses 差异测试**：流式无 `data:[DONE]`（事件驱动
    天然兼容，测试确认）；stream_options/parallel_tool_calls/store
    等静默忽略；custom 工具名 400；恒 store:false。注意：dsh 也只把
    Codex 桥到 DeepSeek **Chat 线**消费（deepseek-responses-bridge.ts），
    官方 /v1/responses 无现成参考实现，只能自测。
17. **探测链提示**：probe details 对 responses 协议补提示——stop 忽略、
    store 语义、effort 参数名差异（providers.ts:311「补全探测链」的落点）。
18. **响应侧归一化**（cherry ark.ts 印证）：网关偏差不只在请求参数面——
    Ark 对不支持的 include 400（请求侧剥 `web_search_call.action.sources`），
    响应侧还有结构缺字段（output_text.annotations 缺失需补 []）。预留
    normalize 系钩子：请求改写（include/参数剥除）与响应修补分离，
    按家挂接。

## 五、启用条件与批次（2026-08-15 补）

**启用条件**（不变）：满足其一再启用：作者侧有明确 gpt-5/grok 深度使用
需求；或 Chat 侧出现 Responses 独占能力依赖（如 gpt-5 系列某些工具/推理
特性仅 Responses 提供）。

**批次拆解**（一个独立批次内分四子批；建议排在 8-15 计划批次 D
表驱动深化之后，quirks 扩维顺势接；缺口 12 的计量字段随 D4）：

| 子批 | 内容（缺口号） | 落点 |
|---|---|---|
| R1 正确性 | 1-4：failed/error、incomplete 归一、零计量兜底、reasoning | responses-adapter.ts |
| R2 quirks 协议维度 | 5-8、13：tool_choice 三层、effort 分家、structuredMode、grok maxTokens、verbosity 留位 | model-quirks.ts + gen.ts + responses-adapter.ts |
| R3 回合状态与计量 | 11-12：reasoning 附件建模 + 回传、usage 细节（随 D4） | types.ts + responses-adapter.ts |
| R4 接线与验证 | 14-18 + 验收清单全跑 | probe.ts + AiServicePanel.vue + providers.ts + test/ai/provider/* |

**验收清单**（全绿才算启用完成）：

- response.failed → error 事件且**不发** done（mock 流单测）
- 流无终止事件 → 传输截断错误（不发 done；dsh STREAM_CLOSED 语义）
- completed 零 output → 判错（EMPTY_RESPONSE 语义）
- incomplete(content_filter) 不落 'stop' 伪装
- reasoning_text.delta / reasoning_summary_text.delta → GenEvent.reasoning
- toParams 断言：tool_choice 三值翻译 / store:false / include
  encrypted_content / grok reasoning_effort / deepseek output_config.effort
- 多轮工具调用：reasoning item 回传位置（function_call 前）断言
- usage 细节：cached_tokens / reasoning_tokens 提取断言
- 降级记忆：首发 400 后二次请求首发即剥（断言 store.modelCaps 写入）
- deepseek 无 [DONE] 流：completed 正常收尾
- e2e：UI 协议三选一可选 responses + 测试连接通过

## 六、参考实现对照（2026-08-15 研读，出处以文件为准）

| 主题 | cherry-studio | deepseek-harness | 落到缺口 |
|---|---|---|---|
| 线路定位 | openai / grok 的 defaultChatEndpoint 均 openai-responses（Responses 为生产默认线） | llm-pi-ai 走 pi SDK（Responses 原生）；DeepSeek 仅桥到 Chat 线 | 支持面表；成熟度可信，启用后可再议默认线 |
| 推理档位 | 格式级 wire profile（reasoningProfiles.ts：openai-responses = effort + reasoningSummary）× 端点 reasoningFormat 覆盖 × 模型 dialect | — | 6（表结构定型） |
| 终止语义 | — | 无终止事件 → STREAM_CLOSED（TRANSPORT）；completed 零内容 → EMPTY_RESPONSE；error 事件带 usage 入账 | 1-3（修法原则） |
| store/隐私 | openai 线无条件 store:false（options.ts:401）；codex 后端强制 | — | 9 |
| reasoning 回传 | include encrypted_content + reasoning item 回传（codex.ts）；grok-cli 剥回传（grokCli.ts）；网关解析 content 优先 summary 兜底 | — | 11 |
| 网关偏差 | ark：请求剥 include + 响应补 annotations；grok-cli：instructions 提升/空轮剥除/effort 422 | 错误文本分类学（AUTH/QUOTA/…/TRANSPORT，stream.ts） | 18（toErrorEvent 分类可后续批） |
| 计量 | — | cacheRead/cacheWrite 独立入账（stream.ts mapUsage） | 12 |
| Grok 输出上限 | grok-cli 线模型覆写 30k（registry overrides） | — | 8 |
