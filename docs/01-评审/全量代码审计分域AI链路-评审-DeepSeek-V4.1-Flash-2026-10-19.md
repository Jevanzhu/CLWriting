# 域1 审计报告:AI 链路与编排(src/ai 等)

- 定位：**全量代码审计（2026-10-19 第一轮）分域附档**——域1 AI 链路与编排（`src/ai` 及 cache/metrics/diagnostics/learn/review） 的证据面与问题清单；主档 = `全量代码审计-评审-DeepSeek-V4.1-Flash-2026-10-19.md`（同槽位）。不属于本档：汇总结论、修复落地记录与作者拍板。
- 执行模型：DeepSeek-V4.1-Flash（`ccats/deepseek-v4.1-flash`）域审员子 agent。

- 审计员:audit-ai(域审员) · 日期:2026-10-19 · 范围:src/ai(84 档)+ src/cache、src/metrics、src/diagnostics、src/learn、src/review;对照 test/ai(168 档)等
- 方法:git ls-files 排行定位热点 → 精读核心链路(runner / provider 三协议 / self-heal / chat turns / 流式与记账)→ 红标结构扫描 → 交叉对照测试档名与实现。
- 证据面:仅源码、配置、测试、提交记录(docs/、知识层/、README.md 一律未采信)。**未修改任何源码/配置/测试;未跑测试与 coverage**。

> 口径说明:任务书给出的档行数(runner 1200 / calls 753 / self-heal 904 / turns-phases 837 / store 867)与本轮 read 实测总行数(1261 / 790 / 949 / 881 / 931)**不一致**,差异来自统计口径(是否计空行;我首轮的 `Measure-Object -Line` 不计空行)。引用行号一律以 read 实测行号为准,可复核。

---

## A. 问题清单

| ID | 严重度 | 类型 | 证据(file:line) | 影响 | 建议 | 置信度 |
|---|---|---|---|---|---|---|
| D1-01 | P2 | 记账口径分裂/事件低估 | `src/ai/orchestrate/chat/turns-phases.ts:472-476`(自陈「外层 out.attemptsUsage 只聚合末次发送的 attempt 链,首发消耗不并入封套」);重发点 `:513-516`(超窗收缩)、`:595`(换网);消费点 `:701-708`、`:792-801`(done/assistant 事件取 `attemptsUsage`) | chat 两类一次性重发(收缩/换网)的**首次失败调用**用量只进 `.cache/ai-calls.json`,不进封套 → SSE `chat_done` 与 assistant 事件的用量/成本系统性低于账本;前端「这场对话花了多少」与账本长期分裂,成本展示不可信 | 编排层把两次发送的用量合并进回合用量(或在事件里显式记「另有首发消耗」),或把两类重发收进单一累计器 | 高 |
| D1-02 | P2 | 语义矛盾/内存态不可回退 | `src/ai/orchestrate/chat/state.ts:109-112`(无条件先删 histories/msgSeqMap/activeBranchByBook/compactionSuppressed)vs `:137-145`(开库之后才跑 `opts.gate`,拒绝即 `return blocked`) | 调用方据返回值转 409「未清库」,但内存历史已被清 → 「拒清应保持原状」不成立;在途回合持有的只是数组引用,`getHistory` 下次重新建空数组,尾部消息不进视图(事件库因拒清未清,可重放恢复,故非数据丢失) | gate 复查前置到内存清理之前;或在拒绝分支按快照回填四 Map | 高 |
| D1-03 | P2 | 自检锚随实现漂移 | `src/ai/calls.ts:290` 与 `:300`(`AI_CALLS_MUTEX_SCOPE_NOTE` 文案声明锁文件为 `bookRoot/.cache/ai-calls.lock`)vs `:362`(实际 `${budgetPath(bookRoot)}.lock`,即 `.cache/ai-calls.json.lock`) | 该常量被注释声明为「防声明随实现漂移后无人察觉」的对外契约锚(测试断言串),**锚自身已漂移** → 后续锁实现变更不会再被它抓住;审计/排障按常量去 `.cache/` 找锁文件找不到 | 文案由 `budgetPath` 单源拼出(或删除文件名细节),并把该锚纳入测试断言防漂移 | 高 |
| D1-04 | P2 | 铁律①缺口(模型可见⟺已记录) | `src/ai/orchestrate/self-heal.ts:470-471`(成功才登记 `工作区/本章写作材料.md`)、`:477-479`(注释声明清理旧章材料的目的正是防「上一章材料注入本章」)、`:480-485`(`rmSync` 失败被**空 catch 静默吞掉**,连 warn 都没有) | 备料失败 + 旧材料文件清理失败(Win 侧 EACCES/EBUSY 可达)时:盘上仍留上一章材料 → `buildDraftPrompt` 照旧注入「备料」段,而 `promptFiles` 返回空集 → **模型可见却事件库零登记**,恰是该段代码自陈要防的形态 | 该 catch 补 `log.warn` 留痕(与同函数 `:476` 同口径);清理失败时同步清掉/标记材料段来源以便登记 | 中 |
| D1-05 | P3 | 重放口径缺口(请求参数面) | `src/ai/runner.ts:599-637`(llm/call 落 promptMeta/model/effort/timeoutMs/maxTokens/degraded/quirksVersion/firstByteTimeoutMs)+ `src/events/types.ts:141-157`(LlmCallData 字段面)+ `src/ai/gen.ts:311-326`(`requireTool` 派生 `toolChoice`,适配器据表发 `tool_choice`),适配器侧 `anthropic-adapter.ts:163-177`、`openai-adapter.ts:176-178,236-241`(另发 `stop` 与 `response_format`/`output_config.format`) | 事件库无 `toolChoice`(含 requireTool 派生结果)/`stopSequences`/`structured` 字段 → 仅凭事件无法精确重建请求参数面(与项目「默认值显式 resolve,重放可精确重建」的纪律有缺口);实测 `grep 'structured:|stopSequences:'` 无生产写入方(仅降级剥除逻辑),故目前是**潜在**缺口,toolChoice 则是已存在的生产路径 | 把 toolChoice 意图(含 requireTool/派生)作为加性字段随 llm/call 落库,与 effort/maxTokens 同款 | 高(字段缺失)/中(实际影响) |
| D1-06 | P3 | 注释卫生(失效行号锚点) | `src/ai/runner.ts:954`「外层 if 已收窄 e instanceof GenError(640)」而第 640 行是 `const ctx: RunCtx = {`;`runner.ts:1000`「abort(566)/终态失败(621)」而 566 是类型别名行、621 是 `}`;`src/ai/calls.ts:425`「本函数是锁外快照读(208)」而 208 行在 `readRecord` 内 | 行号锚点随编辑失效,读者按锚找不到语义 → 反向误导;与项目注释纪律(只写作用与约束,修复史归 git)相悖 | 删行号锚点,改函数名/符号名锚 | 高 |
| D1-07 | P3 | 结构脆弱性(隐式全局前提) | `src/ai/calls.ts:287`(模块级 `inWriteSegment` 布尔)+ `:369-371`(`segmentFlag` 直接赋值)+ `src/fs/lock-file.ts:133-137,148-152`(仅 `doWrite` **同步**执行段置真) | 该标志语义是「是否处于**任一**书写段」,`readRecord:104-113` 据此选「锁内内联迁移写」。当前正确性依赖「doWrite 全同步、且不跨书回调记账」这一未显式声明的不变量;若将来 doWrite 内出现 await 或跨书写,B 书的锁外读会误判为锁内 → **无锁写**(正是注释自称要防的丢账形态) | 改为 per-bookRoot 标志或把「锁内」由参数显式传入,去掉模块级感应 | 高(事实)/中(危害可达性) |
| D1-08 | P3 | 敏感信息展示面 | `src/ai/provider/store.ts:918-922`(`maskKey` 保留前 4 后 4,仅 <8 位全掩)+ `src/studio/server/api/providers-ops.ts:76`、`src/studio/server/api/rag-providers.ts:41`(经 HTTP 下发 `apiKeyMasked` 到渲染进程/前端状态) | 20 位 key 暴露 8 个字符,掩码值长期驻留前端;`vault-key.ts:16-27` 自陈防护为**混淆级**(不防持制品者与内存转储),两者叠加使「脱敏」的边际价值有限 | 掩码降到 2-3 位前缀或只回 `hasKey` 不回掩码;在事件/日志面维持 `redactSecret` 全掩 | 高(事实)/中(风险) |
| D1-09 | P3 | 纪律不一致(实例化/LRU) | `src/ai/orchestrate/chat/turns.ts:70-71`(每场对话为取 `contextWindow` 调 `resolveProvider` → `createProvider` 实例入 registry LRU 容量 8)vs `src/ai/orchestrate/chat/turns-phases.ts:564-569`(明确「不实例化 provider、不进 LRU」的同域纪律) | 同域两处纪律相反;白建 SDK 客户端并占据 LRU 槽,可能挤出真实实例(容量 8) | 改为 `loadProviders` + `modelConfOf` 只读模型行,或复用已解析结果 | 高 |
| D1-10 | P3 | 状态机/内存不变量(自陈维持) | `src/ai/orchestrate/chat/state.ts:72-86`(LRU 上限 8,注释自陈在途对话可被逐出,>8 本并发对话触发,**不修**) | 桌面单用户不可达;多书并写时在途回合尾部消息不进视图(事件库可重放) | 登记维持;若开放多书并写则引入在途引用计数 | 高(自陈) |
| D1-11 | P3 | 预算闸竞态(既定取舍) | `src/ai/calls.ts:422-436`(check 为锁外快照读;注释自陈超额上界 = 并发写者数,不承诺精确配额);`effectiveRemainingCalls:523-533` 同源 | 并发写者可少量超额(单机桌面可忽略) | 维持;若需精确配额须引入预占/退款事务(五条失败出口) | 高 |
| D1-12 | P3 | 缓存陈旧窗(既定取舍) | `src/ai/provider/store.ts:350-363`(`mtimeMs` 同毫秒内外部改写 → 命中陈旧缓存) | 读侧一次陈旧,下一次 load 自愈;写侧另有 revision 复验兜底 | 维持;如需强一致改内容指纹(已有 ino/size 先例可借) | 中 |
| D1-13 | P3 | 注释与代码不符 | `src/ai/orchestrate/self-heal.ts:405-408`(注释称 `?? ''` 死防御已删)vs `:412` 仍写 `reds: run.reds ?? []`,而 `ChapterRun` 契约 `:319` 该字段必填 | 读者据注释以为该模式已清;死防御掩盖契约(与相邻注释自相矛盾) | 删 `?? []` 或改注释如实 | 高 |
| D1-14 | P3 | 自引用/可读性 | `src/ai/orchestrate/self-heal.ts:253-262`(`ChapterCtx` 初始化式内的默认 check 闭包读取同一个正在构造的 `ctx.config`) | 依赖「闭包延迟调用」才不触 TDZ;若有人在构造表达式内调用 check 即 ReferenceError;改读者需额外推理活跃读取语义(与批内 `ctx.config` 重读是耦合设计) | 以显式参数/`getConfig` 回调表达活跃读取,或注释登记该不变量 | 高(事实)/低(危害) |

**严重度合计:P0 = 0、P1 = 0、P2 = 4、P3 = 10(共 14 项)。**

**为什么没有 P0/P1**:本轮所有「看起来像 P1」的候选都能在代码里找到显式声明与兜底,属既定取舍而非缺陷——重试链记账(`runner.ts:997-1001,1043-1047`,失败/中断/退避各 attempt 均按次入账)、截断不伪装成功(`gen.ts:272-280,358-366`;`stream-finalize.ts:153-155` 传输截断报可重试错误)、预算闸临界超额(`calls.ts:425-433`)、锁内同步 fsync 冻结事件循环(`lock-file.ts:112-124`)、在途对话 LRU 逐出(`state.ts:74-78`)。dsh 未发现可导致数据丢失或花费失控的可达路径。

---

## B. 实现完成度

| 模块 | 判定 | 一行证据 |
|---|---|---|
| provider 抽象 + 三协议适配 | 完成(Responses 线未逐行核) | `src/ai/provider/registry.ts:1-151` 按 protocol 路由;三适配器就位(`anthropic-adapter.ts` 534 行 / `openai-adapter.ts` 598 行 / `responses-adapter.ts` 320 行);公共面单源 `adapter-errors.ts`(400 降级链)+ `stream-finalize.ts`(流尾收口) |
| 重试/退避/错误决策表 | 完成 | `retry-policy.ts:32-64` 指数退避+对称抖动+Retry-After 封顶;`failure.ts:93-118` code→action 决策表,`shouldRetryError:67-70` 单源消费 |
| 超时体系(总量/逐 chunk) | 完成 | `runner.ts:860-867` 档位 `timeoutMs ?? 600_000` 内部 ctrl;`gen.ts:91-157` 逐 chunk 挂起时限 + `onStall` abort 在途 HTTP(注释载明 timer.refresh 失效的勘误) |
| 用量记账(章块/任务块/成本) | 完成(口径缺口见 D1-01) | `calls.ts:745-789` 一次锁内 RMW 同改两块;`pricing.ts`+`runner.ts:1165` 调用时钉价;`addUsage:603-616` 累加单源;`estimated` 粘性标记 |
| 预算闸 | 完成 | `calls.ts:422-516` 三口径(次数/token/cost);`runner.ts:741-788` chat 按书次数闸,坏档 fail-closed;写稿链闸在编排层两道 |
| 编排 runTask | 完成 | `runner.ts:574-582` 三段式(prepareRun/runAttemptLoop/finalizeRun);五路失败出口均带 `attemptsUsage/model`;mock 快路契约对齐(`:681-729`) |
| self-heal 自愈闭环 | 完成 | `self-heal.ts:840-915` 单章闭环;`:330-434` 批量连写同源;五终态出口(`:737-834`);goal/todo/check 事件化 |
| chat turns 状态机 | 完成(记账缺口见 D1-01) | `turns.ts:73-91` for turn 骨架;`turns-phases.ts:177-194/635-750/765-881` 三段;工具派发闸序(:817-866 轮首 abort → 未知工具 → 写风险确认 → 持 rewrite 闸执行) |
| 流式解析与 usage 兜底 | 完成 | 两条线流式消费(`anthropic-adapter.ts:320-459`、`openai-adapter.ts:345-499`);网关吞 usage 时按同源系数估计入账并标 `estimated`(`usage-estimate.ts:74-85`、`stream-finalize.ts:157-169`) |
| 凭据 vault | 部分完成(分级明示) | `vault-key.ts:16-27` 自陈**混淆级** + v2 OS 通道(`os-kek.ts`);落盘剥离明文、0600+fsync(`store.ts:673-718`);明文 bak 残留有 roundtrip 清洗(`:567-592`)。展示面扣分见 D1-08 |
| 链路可追溯(铁律①②) | 完成(边路径缺口 D1-04、参数面缺口 D1-05) | `promptMeta(system/prompt hash+files+tools)` 落 llm/call(`runner.ts:613-637`);血缘事件与 step/start 同批(`:663-666`);chat 侧消毒改动与注入快照各留事件(`turns-phases.ts:274-281,234-257`) |
| metrics / diagnostics / learn / review / cache | 未判定(见 D 节) | 仅红标扫描(无 TODO/any/空 catch);`src/diagnostics/zip.ts:21` 明示有意边界(zip64/压缩方法 8/加密/数据描述符未实现);`src/metrics/short-index.ts:111` 注释自陈「设计期占位、从未有生产/测试引用」的死码残留未独立复核 |

---

## C. 简洁与优雅度(结构性)

1. **注释体量压过代码体量,已成为改读成本的第一大头**:`runner.ts` 1261 行里 `prepareRun`(:589-828)与 `runAttemptLoop`(:835-1087)两段几乎逐句带 3-8 行注释;`calls.ts` 790 行、`turns-phases.ts` 881 行同型。改一行要读上下三十行。
2. **注释携带修复史与内部编号,读者无从解析**:`runner.ts:291,307`(`R34D-7`/`R37-7` 类)、`:539-541`(`RC:`)、`calls.ts:99-103`(`Y-1`)、`turns-phases.ts:893`(`E-9g`)、`turns-tools.ts:29-38`(`低-2`/`§四/§六批2`)、`self-heal-registry.ts:2`(`(54产品巨件拆分 波3)`)。与项目注释纪律(不写来历与出处,修复史归 git)直接冲突;且 `ee-`/`kk-`/`hh §八-16` 之类前缀在行首无解释点。
3. **注释内行号锚点批量失效**(见 D1-06):三处以上锚点指向无关代码。
4. **超长函数与深嵌套**:`runAttemptLoop`(:835-1087)约 250 行、4 层以上嵌套的 try/if 组合;`prepareSendHistory`(turns-phases.ts:265-337)在 70 行内混入 4 处阈值常量与 3 段 warn 文案构造;`executeChatTool`(turns-tools.ts:134-364)230 行 switch + 注册表分支。
5. **头注与实现篇幅倒挂**:`shrinkRetryOnOverflow`(turns-phases.ts:482-529)头注 38 行解释 48 行函数;`buildDegradeAttempts` 头注 12 行对 30 行实现。信息本身有价值,但缺少「先结论后细节」的层次。
6. **魔法值与阈值分层不清**:`runner.ts:129` 600_000、`turns-phases.ts:75` 20、`finish.ts:25` 10、`state.ts:60` 8、`calls.ts:384` 5_000、`usage-estimate.ts:54` 24 码位外壳、`turns-phases.ts:305-306` 的 96k/20k 预算——同域常量无集中表(单点可查,但跨档对账靠 grep)。
7. **同构重复但已声明有意**:openai 与 anthropic 各一份 `settleStream` 判定(产出面已抽到 `stream-finalize.ts`,判定面注释声明有意不共用,理由成立);turns-phases 两类一次性重发的守卫结构同构。
8. **小的文本缺陷**:`turns-phases.ts:756-757` 头注同一句「tool_result blocks 组成 user 消息入 history」重复出现两次。
9. **可读性尚可的点**:`runTask` 壳只留三段调用(:574-582)、`finalizeRun` 穷尽 switch 无 default、`addUsage`/`applyTaskUsage` 等单源化改造彻底(注释中多处「原 N 处手抄已删除」可验证为真:`calls.ts:588-616`)。

---

## D. 无法判断项

1. **Responses 线整体**:`responses-adapter.ts`(320 行)与 `responses-stream.ts`(447 行)未逐行读,只从测试档名(`responses-empty-output-error-usage` / `responses-post-terminal-error-ignore` / `responses-pseudostream-backfill` / `responses-stream`)与注释看到「终止四态」「yield error 后 return」等声明 → 该线是否与另两线等价守住「截断不伪装 done / 空产出必须报错」无法判断。
2. **src/cache(5 档,含 rebuild.ts 577 行)、src/metrics(short-index.ts 637 行)、src/diagnostics(index.ts 486 行)、src/learn、src/review(run.ts 513 行)** 只做了红标扫描(无 TODO/any/空 catch/未实现标记,仅 zip 边界与一处占位注释),未逐行读 → 具体缺陷面未判定。
3. **真机/线上行为**:非标网关的 usage 形态与 blank `usage:{}`、429 `Retry-After` 实际头、Responses 真机终止事件、claude+effort 思考块 400 频率(`anthropic-adapter.ts:190-192` 自陈「真机验证登记:400 实际频率待验证」)→ 只能按代码路径推断,无实测证据。
4. **运行时量级**:锁内同步 fsync 冻结事件循环(`lock-file.ts:112-124` 自陈已知代价)、LRU 逐出在途对话、每次 `checkAiCallBudget` 全量读盘的成本 → 缺基准数据,无法判断实际影响。
5. **密钥链落地**:`vault-key.ts` 自陈混淆级、`os-kek.ts` 依赖 env `CLW_OS_KEK`;主进程 safeStorage 侧实现不在本域,「v2 通道是否真在生产形态生效、v1 存量是否清零」无法从本域判断(注释自陈需监控盘上 v1 vault 归零)。
6. **测试面**:未跑任何测试(禁令 + 16GB 内存风险),`test/ai` 168 档的实际红绿、断言是否锚对外可观察面未验证 —— 覆盖面判断仅来自档名与实现注释(域内档名与热点高度对应:runner/retry/usage/stream/degrade/vault/budget/turns 均有专档)。
7. **提交史热点**:只抽读了域内近 160 条提交的**首行摘要**(正文极长),R3x/R6x/R7x 多轮反复提及 runner / self-heal / usage / 截断口径,可判定这些面是返工热点,但未逐条回落到 diff,「反复修复的具体位置」未能定位到 file:line。
8. **未覆盖的横切面**:未审计 `events/`(事件库)、`fs/cross-process-lock.ts`(真锁实现本体)、`driver/`(SSE 出口)三个与本域强耦合的邻域,故 D1-02/D1-03/D1-07 的**实际影响面**只能止于本域视角。