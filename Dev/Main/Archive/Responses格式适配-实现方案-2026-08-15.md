# Responses 格式适配 · 实现方案

> **归档记**（2026-09-11 归档批，作者指令「已经完成的文档，归档。」）：本方案已完成收口（2026-09-04），自 `02-执行/` 移入 `Archive/`（扁平）；总览 1.1 原行随批冻结 `Archive/总览历史明细-归档-2026-09-08.md`；历史正文不改写。

日期：2026-08-15　状态：**已完成**（2026-08-17 启用批落地；2026-09-04 中转网关真机验证通过，验收 11/11 全绿收口）。
设计依据：《Responses格式适配-设计方案-2026-08-13.md》（下称「设计」）。缺口号沿用设计第四节 1-18；批次沿用设计第五节 R1-R4。

> 本文把设计缺口翻译为代码级改动。**未开工**——所有「现状」行号为 2026-08-15 dev 分支实况。

> **2026-08-17 找回**：Z-P2-1「后端拒配」拍板（2026-08-16）系误判，作者澄清本意为
> **暂缓非不做**；本文与设计方案自 `Archive/` 找回归位 `03-设计/`，恢复暂缓效力。
> 文中所引 `responses-adapter.ts` 及各文件行号为 8-15 实况——该适配器已随 84e370b
> 删除，启用时先自 git 历史找回骨架（`git show 84e370b^:src/ai/provider/responses-adapter.ts`）
> 再叠加本文改动；types/registry/providers API 的拒配收窄同批回接。

> **2026-08-17 现状层修订（启用批主线程审核结论，如实收录）**：正文所述行号与
> 接线点为 8-15 实况，实施以本块为准——
> - **架构变化**：批次 D2 后 adapter 创建迁至 `registry.ts` 声明式注册表
>   （store 统一传参），`probe.ts` 已无 createProvider 分支——缺口 14
>   「probe.ts:23 补传 store」接线点**失效**，改为 registry `ADAPTER_REGISTRY`
>   注册一行 + adapter 签名对齐 `(conf, client?, store?)`；降级记忆照抄对象
>   更新为 openai-adapter 当前 271-296 行（lookupDegraded 新鲜读 +
>   persistDegraded 落盘双写）。
> - **拒配回接面（文档原遗漏）**：`types.ts` Protocol 枚举恢复、
>   `registry.ts:129` 拒配报错删、`providers.ts` parseProviderInput 拒配 400 删、
>   `index.ts` 补导出；测试反转：`test/studio/providers-api.test.ts` 187-205
>   两拒配用例、`test/ai/provider/registry.test.ts` 61-71 摘除/迁移报错用例。
> - **行号漂移**：gen.ts 查表 91/152→124/206、意图翻译 157-174→211-226；
>   chat.ts 组装点 402→**两处**（工具路径约 727-732 + asstBlocks 约 755-758），
>   R3 接线两处都带。
> - **R4.2「顺修 providers.ts:310-311 悬空注释」子项作废**（原位置已被 Z-P2-1
>   拒配注释取代，删拒配块即覆盖）。
> - **缺口 5③ 的 model-quirks 'none' 注释已被 Z-P2-1 批重写**（现约 74 行），
>   启用批按新文案修。
> - **前置收口**：批次 D1-D4 已全部落地（2026-08-15）——R2a 前置（D3 归一化）
>   满足；TokenUsage 字段名随 D4 定稿无冲突（cacheReadTokens 已存在，
>   R3 仅新增 reasoningTokens）。
> - **新约束（catalog 三件套 D1）**：ResponsesWireQuirks 子表必须保持**纯数据**
>   （无函数维度），否则 catalog 探测白名单需同步扩 + 重新 generate:catalog
>   （catalog-sync 双向校验红线）。
> - **w0-serialize.test.ts** 自述「两协议线」，responses 回接后核验是否扩三线
>   （随 R4 验证）。
>   ✔ 已扩三线（2026-08-17 收尾批）：+9 用例（基础参数 / 缺口 11 重排 / 回插双条件 /
>   stop 忽略 / include+effort / tool_choice 三形态），12→21。

> **2026-08-17 遗留清偿记录（启用批复审 P3 收尾）**：
> - **grok / deepseek 真机联调——作者裁定免验**：两族 responsesWire 子表均照
>   cherry 实跑通过的实现编码，照写即认（作者 2026-08-17 拍板）。
> - **中转网关兼容**：加密推理项已随 assistant 消息事件落记录（chat.ts
>   recorder.add(assistantMessageEvent)，「模型可见 ⟺ 已记录」闭环），无需补
>   记录；新增一次性真机验证脚本 `scripts/verify-responses-relay.ts`
>   （两轮工具对话测 store:false / include / parallel_tool_calls 容受 +
>   推理延续三态判决），待作者经自有中转跑一次留证。
> - **w0 三线**：如上 ✔。文档状态「已开工→已完成」待中转验证一次通过后翻转。
>   ✔ 已翻转（2026-09-04，见下方 2026-09-04 中转验证完成记）。

> **2026-09-04 中转网关真机验证完成记（阶段 13 收口）**：
> - 作者中转 CCats（`https://ccats.art`，openai-responses 协议）经
>   `scripts/verify-responses-relay.ts` 真机两轮工具对话实测——glm-5.3-flash /
>   deepseek-v4-flash / hy3 三模型全部判决**可用**：两轮可达、强制工具调用成功、
>   tool_use + tool_result 回插被接受、store:false 恒发未见 400。
> - 如实记档：三模型均非 gpt 家族档，适配器按 quirks 子表本就不下发
>   include / parallel_tool_calls / 指名 tool_choice——include 容受与加密推理项
>   透传/回插路径**未测到**（仅 gpt 家族触发；本中转模型清单无 gpt 家族）。推理
>   延续三态判决「关」均系客户端不发、非中转吞参（脚本判决已逐模型标注）。
> - 凭据经 vault 原位解出注入 env（CLW_RELAY_API_KEY，全程不打印不落盘）；
>   判决日志留证：%APPDATA%/CLWriting/logs/relay-verify-glm-5.3-flash.log +
>   relay-verify-rest.log（deepseek/hy3）。验收 11/11 全绿，本方案与设计方案
>   状态同步翻转「已完成」，总览阶段 13 行同步收口。

## 〇、改动面总表

| 文件 | 改动 | 缺口 | 批 |
|---|---|---|---|
| `src/ai/provider/types.ts` | ContentBlock.reasoning 扩字段；GenEvent 增 reasoning_item；TokenUsage 扩 2 字段 | 11、12 | R3 |
| `src/ai/provider/model-quirks.ts` | 新增 ResponsesWireQuirks 子表 + responsesQuirksFor + 修正 58 行注释 | 5-8、11、13 | R2 |
| `src/ai/gen.ts` | 两处查表改协议感知 | 5 | R2 |
| `src/ai/provider/responses-adapter.ts` | 流循环终止契约 + toParams 全量翻译 + store 接线 | 1-9、11-12、14 | R1-R4 |
| `src/ai/provider/probe.ts` | createProvider responses 分支补传 store；探测 details 提示 | 14、17 | R4 |
| `src/ai/provider/index.ts` | 导出 responsesQuirksFor | 5 | R2 |
| `src/ai/orchestrate/chat.ts` | assistant 轮组装带 encrypted 附件（402 行附近） | 11 | R3 |
| `src/studio/web-next/src/components/ui/AiServicePanel.vue` | 协议栏三选一 | 15 | R4 |
| `src/studio/server/api/providers.ts` | 修正 310-311 行悬空注释 | 15 | R4 |
| `test/ai/provider/*` + e2e | 第六节测试矩阵 | 全部 | 各批 |

## 一、类型与表（R2a 先行，R1 可并行）

### 1.1 quirks 协议维度：ResponsesWireQuirks 子表（缺口 5/6/7/8/11/13）

设计定型「格式级 profile × 家族覆盖」。落到本项目最小同构 = **FamilyQuirks 家族表内嵌 responses 子表**（不建独立注册表）：

```ts
/** Responses 线（/v1/responses）格式档——家族表内嵌，Chat/Anthropic 线不受影响 */
export interface ResponsesWireQuirks {
  toolChoiceMode: 'named' | 'required' | 'auto'   // 三值语义同 FamilyQuirks，无 'none'
  effortWire: 'reasoning-effort' | 'reasoning_effort' | 'output_config'
  structuredMode: 'json_schema' | 'json_object' | 'none'
  /** 多轮工具调用的推理延续（缺口 11） */
  echoReasoning: 'encrypted' | 'strip' | 'none'
  /** Responses 独有 text.verbosity 支持（缺口 13，初版只留位不发） */
  verbosity: boolean
  /** max_output_tokens 是否含推理 token（缺口 8，grok=true；首版只标记不换算） */
  maxTokensIncludesReasoning: boolean
}
```

家族填表（出处见设计第六节）：

| 家 | toolChoiceMode | effortWire | structuredMode | echoReasoning | verbosity | 含推理 |
|---|---|---|---|---|---|---|
| gpt | named | reasoning-effort | json_schema | encrypted | true | 待核实 |
| grok | named | reasoning_effort（顶层） | json_schema | strip（CLI 代理语义；官方线实测后翻） | false | true |
| deepseek | required | output_config | json_object（不发 format） | none（未测） | false | 待核实 |
| 其他/unknown | auto（不发） | reasoning-effort | none | strip | false | false |

配套改动：

- `quirksFor(model)` **签名与行为不动**（Chat/Anthropic 线零风险）；新增导出：

```ts
/** responses 协议视图：基表 + responsesWire 覆盖 toolChoiceMode/structuredMode 并挂子表 */
export function responsesQuirksFor(model: string): FamilyQuirks & { responsesWire: ResponsesWireQuirks }
```

- gen.ts 两处查表改协议感知（91 行 generate / 152 行 generateTool）：

```ts
const q = provider.conf.protocol === 'openai-responses'
  ? responsesQuirksFor(provider.conf.model ?? '')
  : quirksFor(provider.conf.model ?? '')
```

  意图翻译三分支逻辑不变——responses 线自此拿到真实 toolChoiceMode（gpt/grok=named、deepseek=required），缺口 5 的「gen 层静默丢弃」消除。
- 修正两处错误注释：responses-adapter.ts:15（「无 tool_choice 参数」）与 model-quirks.ts:58（'none' 注释）。

### 1.2 回合状态类型（缺口 11）

```ts
// ContentBlock——reasoning 块扩载体（Chat 线 reasoning_content 回传不受影响，字段可选）
| { type: 'reasoning'; text: string; encrypted?: string; itemId?: string }

// GenEvent——加密推理项透出（适配器 → gen 收集 → orchestrate 存回消息）
| { type: 'reasoning_item'; encrypted: string; itemId?: string }
```

GenResult 增 `reasoningEncrypted?: string` 与 `reasoningItemId?: string`；orchestrate/chat.ts:402 组装 asstBlocks 时带上（`{ type: 'reasoning', text, encrypted, itemId }`）。

### 1.3 TokenUsage 扩字段（缺口 12）

```ts
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number   // usage.input_tokens_details.cached_tokens
  reasoningTokens?: number   // usage.output_tokens_details.reasoning_tokens（缺口 8 校准源）
}
```

字段名以 8-15 计划 D4（统一词汇 + cache token 记账）定稿为准，冲突则随 D4 改名；Responses 线无 cacheWrite。

## 二、R1 流循环正确性（缺口 1-4）

**终止事件契约**（dsh stream.ts 语义）：流必须以 completed / incomplete / failed 之一收尾。

```
let terminal: 'completed' | 'incomplete' | 'failed' | 'none' = 'none'
```

事件 switch 增补（现有五 case 不动）：

1. **`response.failed`**：`terminal='failed'` → yield error（message =
   redactSecret(response.error?.message ?? status)，retryable=false），**不发 done**。
2. **`error`**（SDK ResponseErrorEvent，流中错误）：同 failed。
3. **`response.completed` 增判空**（EMPTY_RESPONSE）：`!r.output?.some(item =>
   item.type==='message' || item.type==='function_call')` 且无已产出 tool →
   yield error「模型返回空产出」(retryable=false)，不发 done。probe 流式探测
   （「回复OK」）与结构化产出不受影响。
4. **`response.incomplete`**：reason==='max_output_tokens' → 现状 done(max_tokens)；
   其他 reason（content_filter 等）→ yield error（message 带 reason），不发 done。
5. **reasoning 事件**：`response.reasoning_text.delta`（Grok）与
   `response.reasoning_summary_text.delta`（OpenAI summary）→ yield
   `{type:'reasoning', delta}`。
6. **循环后兜底改写**：toolAccum 残留 flush 保留；删除「兜底 emitDone」——
   `terminal==='none'` → yield error「传输截断：流结束无终止事件」(retryable=true)。

## 三、R2 参数翻译（缺口 5-8、13）

toParams 全量改造（`const rw = responsesQuirksFor(model).responsesWire`）：

1. **tool_choice**（缺口 5，学 anthropic-adapter 分档写法）：

```ts
if (req.toolChoice && rw.toolChoiceMode !== 'auto') {
  if (rw.toolChoiceMode === 'named') {
    // any→required；tool→{type:'function',name}；auto→'auto'
  } else { // required（deepseek：指名意图降级 required，400 防线同 Chat 线）
    // 非 auto 意图一律 'required'
  }
}
```

2. **effort 分家**（缺口 6）：档位映射复用基表 reasoningEffort（gpt/grok 透传、
   deepseek trimEffort），落点按 rw.effortWire：`reasoning:{effort}` /
   顶层 `reasoning_effort` / `output_config:{effort}`。
3. **structuredMode 消费**（缺口 7）：rw 为 json_schema 才发 text.format；
   json_object/none 不发（prompt 约束兜底，与 Chat 线口径一致）。
4. **store:false**（缺口 9）：`params.store = false` 无条件下发（cherry 印证）。
5. **max_output_tokens**（缺口 8）：首版保守透传（现状），rw.maxTokensIncludesReasoning
   仅标记 + 探测提示；换算待 reasoningTokens 观测积累后另批。
6. **verbosity**（缺口 13）：不发参数，注释留位（rw.verbosity===true 的家才可能发）。
7. **include**（缺口 11 前半）：`rw.echoReasoning==='encrypted' && req.tools?.length`
   → `params.include = ['reasoning.encrypted_content']`。

## 四、R3 回合状态与计量（缺口 11-12）

**请求侧（input 组装）**：assistant 消息的 reasoning 块按 rw.echoReasoning 分档——

- `encrypted`：回插 `{type:'reasoning', id: itemId, encrypted_content: encrypted,
  summary: []}`，**置于该 assistant 的 text/function_call 之前**（Responses 语义：
  reasoning item 先于其产出的 function_call）；
- `strip` / `none`：跳过该块（grok CLI 代理拒绝回传；deepseek 未测）。

**响应侧**：`response.output_item.done` 增 case——`item.type==='reasoning'` 且
`item.encrypted_content` 存在 → yield `{type:'reasoning_item', encrypted, itemId}`；
gen.generate() 收集入 GenResult（1.2 节）。

**计量**（缺口 12）：completed/incomplete 的 usage 提取
`input_tokens_details.cached_tokens` / `output_tokens_details.reasoning_tokens`
入 TokenUsage 新字段。

## 五、R4 周边接线（缺口 14-18）

1. **降级记忆**（缺口 14）：`createOpenAIResponsesProvider(conf, client?, store?)`
   增第三参；建流 attempts 数组照抄 openai-adapter 219-262 行（记忆命中首发即剥、
   仅剥除重试成功才写 store.modelCaps + persistDegraded）。接线点：
   probe.ts:23 `case 'openai-responses'` 补传 store（runner.ts:113 已传，改一行即通）。
2. **UI 协议栏三选一**（缺口 15）：AiServicePanel.vue selectProtocol 增
   'openai-responses' 分支（auth 定 bearer）；protocol-toggle 增第三按钮排最后
   （label「Responses」+ 说明文案「OpenAI 新线，gpt-5/o 系列用；日常推荐 Chat 兼容」）。
   providers.ts:310-311 注释改写：去 8-14 旧编号（D1/D2/D6/D7），指向本文档。
3. **探测链提示**（缺口 17）：probeCapabilities 尾部，protocol 为 openai-responses
   时 details.push 一行：「Responses 线提示：stop 序列被忽略；响应不留存
   （store:false）；effort 参数名按厂商自动适配」。
4. **响应侧归一化接缝**（缺口 18）：初版**不建改写框架**——responses-adapter
   事件循环入口与 toParams 尾部各留一行注释标记「网关偏差挂点：某网关 400 或缺字段时，
   按 cherry ark.ts 模式（请求剥 include / 响应补 annotations）加 per-family patch」。
   设计文档第六节已记录模式，触发时再实装。

## 六、测试矩阵（对应设计第五节验收清单）

落点：`test/ai/provider/adapter.test.ts`（新增「Responses R1-R4」describe）、
`model-quirks.test.ts`（子表断言）、`probe.test.ts`（details 提示）、e2e（协议三选一）。

| # | 用例 | 断言 | 批 |
|---|---|---|---|
| T1 | mock 流只发 failed | error 事件且无 done | R1 |
| T2 | mock 流无终止事件（delta 后直接结束） | 传输截断 error，无 done | R1 |
| T3 | completed 且 output 全空 | EMPTY_RESPONSE error，无 done | R1 |
| T4 | incomplete reason=content_filter | error 含 reason，不落 'stop' | R1 |
| T5 | reasoning_text.delta + summary_text.delta | GenEvent.reasoning 拼装 | R1 |
| T6 | toParams：gpt+effort+tools | reasoning.effort / store:false / include encrypted_content | R2 |
| T7 | toParams：grok | 顶层 reasoning_effort | R2 |
| T8 | toParams：deepseek | output_config.effort 且值域 low/high/max；不发 text.format | R2 |
| T9 | toParams：tool_choice | named 三值 / required 降级两形态 | R2 |
| T10 | toParams：多轮 tool 往返含 reasoning 块 | reasoning item 回插于 function_call 前（gpt）；grok 剥除 | R3 |
| T11 | output_item.done(reasoning, encrypted_content) | reasoning_item 事件 → GenResult.reasoningEncrypted | R3 |
| T12 | completed usage 带 details | cacheReadTokens / reasoningTokens 提取 | R3 |
| T13 | 首发结构化 400 → 剥除重试成功 | store.modelCaps 写入；二次请求首发即剥 | R4 |
| T14 | gen.generateTool：responses 协议 + requireTool | 意图按 responsesWire.toolChoiceMode 翻译不再丢弃 | R2 |
| T15 | mock 流无 data:[DONE] 仅 completed | 正常收尾（deepseek 差异） | R4 |
| T16 | e2e：AiServicePanel | 协议三选一可选 responses + 保存持久化 | R4 |

## 七、实现顺序与依赖

```
R2a 表与类型（1.1-1.3 节，纯新增零行为变化）
 → R1 流循环（二节，只动 adapter）
 → R2b toParams 翻译（三节）
 → R3 回合状态（四节，依赖 R2a 的 echoReasoning 字段）
 → R4 接线与验证（五节 + T13-T16 + 全矩阵回归）
```

- 与 8-15 计划批次 D 的关系：建议 R2a 排在 D3（归一化索引）之后顺势接；
  T12 的字段若与 D4 定稿冲突，随 D4 改名（仅两处消费）。
- 均不阻塞现网 Chat/Anthropic 线：quirksFor 签名不动、responses 分支改动
  不影响另两协议。

## 八、风险与未决

| 风险 | 影响 | 缓解 |
|---|---|---|
| OpenAI max_output_tokens 是否含推理 token 未核实 | 缺口 8 换算方向 | 首版不换算；T12 观测 reasoningTokens 积累后定 |
| Grok 官方线 reasoning item 回传语义未知 | echoReasoning 首版 strip 可能保守 | 实测后翻档（改表一行） |
| DeepSeek Responses reasoning/工具轮回未测 | 缺口 16 | T15 + 真机联调批次内完成 |
| EMPTY_RESPONSE 误伤合法空产出 | probe/纯文本场景 | 判据限定 output item 类型；T3 锁定 |
| failed 事件 retryable 定 false 可能过严 | 少数可重试失败不自愈 | 上层 10min/重试链兜底；观测后调整 |
| TokenUsage 字段名与 D4 冲突 | 返工两处 | 1.3 节已标注随 D4 |

## 九、转档流程（启用条件触发后）

1. 设计第五节启用条件满足 → 本文档评审（重点核第八节未决项的实测结论）；
2. 状态改「已开工」：本文档 + 设计文档移 `02-执行/`，总览 1.1 加行、第三节加阶段、
   README 计数同步（CLAUDE.md 文档操作链）；
3. 按第七节顺序分 PR（R2a+R1 / R2b+R3 / R4 三笔），测试矩阵全绿收口。
