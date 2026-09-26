# 全量源码独立重评（2026-09-18）

- **执行模型**：GLM-5.3（主审 = 会话模型；分域评审子代理 ×7 同为 GLM-5.3，主审汇合并对全部 P1/P2 逐条对源码复核锚点，见 §四）。
- **性质**：评审报告——**未收口**。P1/P2 修复 + 回归通过才收口；收口前本件暂存 `01-评审/`，不归档。
- **基线**：git `094043a1`（win/dev/mac 三分支同点）；`src/` 534 文件 / 约 11.6 万行（不含 node_modules）；`test/` 1221 文件 / 约 18.2 万行（1188 `*.test.ts` + 33 `*.spec.ts`，`vitest list` 实测 7459 单测用例）。
- **方法与纪律**：作者指令「忽略掉现有文档，重新评审下当前项目源代码，结果形成一个文档」——**评审全程不读 Dev/Docs 既有文档**（历轮评审/台账/总览一概未参照），结论只基于源码、测试与构建配置本身。分七域派子代理深读（AI 链路 / 文档与数据层 / 运行时与桌面 / Studio 服务端与构建链 / 前端数据流 / 前端组件层 / 测试体系；单波 ≤4 分两波），主审合并裁定分级。问题分级：P1 = 正确性/安全/数据丢失必须修；P2 = 应修；P3 = 低危/一致性。核实不了的旨不报、风格偏好不报。

## 一、总体结论

1. **整体质量**：源码防御密度显著高于同类项目平均水平——失败路径工程化（单点收敛收尾、abort 归因、原子写族、跨进程锁体系、SSE 生命周期管理、竞态守卫单源化）与留痕纪律（码内 60+ 轮批次注释自证沿革）是全库最突出的两项素质。后端四域（AI 链路 / 文档数据 / 运行时桌面 / 服务端构建链）本轮**零 P1**。
2. **唯一 P1 在前端重连回放契约**（E001）：2026-09-17「execRing 两桶分环」批使 cc.ts chat 腿 ring 回放成为重连恢复通道，而前端 chat store 仍按旧契约「重连时后端只补发 chatRunning，不重发 chat_turn」（chat.ts:213 注释）编写——对话中途任何 SSE 重连都会因回放的 `chat_turn` 产生重复气泡与永不完成的孤儿气泡。**属近期改动的连带回归，非存量腐化**，契约两侧（服务端补清屏锚 or 前端重建视图）修法明确。
3. **P2 ×11 的分布主题**：chat 重试组合路径两洞（A001 收缩→换网载荷回退、A002 未预期异常绕过失败收尾纪律）；拆分取号无并发互斥可破「章号永不复用」不变量（B001）；备料链同步全树扫描冻结服务事件循环（C001，与已修的 book-search 同族漏网）；settings 缓存注释宣称的 in-flight 去重性质不存在（D001）；前端 sync.running 口径混入 chat 槽位致对话期假忙三连锁（E002）；前端竞态两处（F001 供应商保存分支 await 后重读 editedId 静默覆盖他行配置、F002 速查插入跨视图悬挂零反馈）；测试覆盖门三盲区（G001 15 域无域级阈值、G002 Anthropic 协议线无真线测试形态、G003 .vue 组件层不入覆盖核算）。
4. **安全面**：回环绑定 + Host 白名单 + 双 token 闸 + 常量时比较 + 路径穿越三重防线（static双侧 realpath / resolveWithinRoot / safeDocId）+ 全库零 `v-html`/`innerHTML` + Electron contextIsolation/sandbox 基线 + 密钥 AES-GCM 信封 + replyError 单出口脱敏——本轮逐文件核验**未见可成立的安全缺陷**。vault 内置密钥材料为混淆级保护（A008）已在码内如实声明威胁模型，本地单机定位下可接受。
5. **性能面**：200 万字场景的内存/复杂度纪律（队列上限、LRU、流式处理、有界缓存、stat 指纹失效）逐点在位；本轮新证事件循环阻塞点一处（C001），量级可接受的三处（B008 结构 plan/apply 三重全书扫描、B009 同步退避无留痕、C002/C003 裸 prepare 重编译）一并登记。

## 二、问题汇总（P1 ×1 / P2 ×11 / P3 ×36）

| 编号 | 级别 | 域 | 标题 |
|---|---|---|---|
| E001 | **P1** | 前端数据流 | SSE 断线重连回放 chat 腿事件，chat store 无幂等去重 → 气泡重复 + 孤儿气泡 |
| A001 | P2 | AI 链路 | chat 换网重试丢弃 A7 收缩结果，发送预算按原网窗口定型 |
| A002 | P2 | AI 链路 | runChatInner 只有 finally 无 catch，未预期异常绕过 finishTurn 失败收尾纪律 |
| B001 | P2 | 文档数据 | 拆分取号无并发互斥，重叠 apply 可产同章号双章 |
| C001 | P2 | 运行时桌面 | 备料链 RAG 命中取回为同步全树扫描，冻结 server 事件循环 |
| D001 | P2 | 服务端构建 | settings/completion-names 缓存壳缺 in-flight 去重，与自身注释宣称相悖 |
| E002 | P2 | 前端数据流 | sync 快照 running 字段混入 chat 槽位 → workbench 假忙三连锁 |
| F001 | P2 | 前端组件 | AiServicePanel save() 的 add→update 分支竞态静默覆盖他行配置 |
| F002 | P2 | 前端组件 | 「设定速查」插入信号在非编辑器视图静默悬挂，点击零反馈 |
| G001 | P2 | 测试体系 | 15 个后端域无域级阈值门，域内塌方对门不可见 |
| G002 | P2 | 测试体系 | Anthropic 协议线无真 HTTP/SSE 测试形态 |
| G003 | P2 | 测试体系 | web-next .vue 组件层零覆盖核算 |
| A003-A009 | P3 ×7 | AI 链路 | 换网前无 chat_reset / 备用网不校验档位 / book.yaml 无缓存读 / 瞬态错误吞作者输入 / learn 单章失败整轮失败 / vault 混淆级保护声明 / claude effort 禁 thinking（详见 §3.1） |
| B002-B010 | P3 ×9 | 文档数据 | undo 乱序合并降级误选源 / 容错版 listTrash 续跑误判 / 章号双轨失配 / 取号正则漂移 / 拆分无健康哨兵 / 死字段 / 三重全书扫描 / 同步退避无留痕 / [object Object] 落 fm（详见 §3.2） |
| C002-C005 | P3 ×4 | 运行时桌面 | events/store 五处裸 prepare / assemble 四处裸 prepare / chat-history 早退缺字段 / book-search 残留 existsSync（详见 §3.3） |
| D002-D005 | P3 ×4 | 服务端构建 | providers 跨进程排队写丢更新残窗 / ci.yml 缓存键未收口 / PR 级无真 asar 冒烟 / check-counts walk 无 symlink 防护（详见 §3.4） |
| E003-E006 | P3 ×4 | 前端数据流 | dev 双基址 rebootstrap 不对称 / interrupt 丢弃 interrupted 字段 / chat_error 不清 notice / chat.clear() 不复位 running（详见 §3.5） |
| F003-F004 | P3 ×2 | 前端组件 | CmHost selectionChange 死契约 / WordCurveChart 死 CSS（详见 §3.6） |
| G004-G009 | P3 ×6 | 测试体系 | 真定时器负载敏感窗 / 44% 批次号命名 / 空洞门粒度 / 源码刮取式锚 / e2e 单 workDir 级联 / 注释钉值漂移（详见 §3.7） |

## 三、分域详报

### 3.1 AI 链路（src/ai · driver · review · rag · knowledge · learn · metrics，约 2.5 万行）

**架构**：studio HTTP 端点按 bookName 过入口互斥闸 → 编排层（chat：pendingChats 队列 + 20 轮 agent 循环 + 15 工具 + 失败收尾/压缩/历史恢复；self-heal：写章 draft→check→rewrite 闭环）→ runner.runTask 单漏斗（mock 快路 → chat 预算闸 → resolveProvider → 决策表驱动重试循环 → 用量记账）→ 三适配器（anthropic / openai-chat / responses）统一产 GenEvent 流，adapter-errors 400 降级链。支撑：provider/vault 密钥信封、prompts、tasks/spec、retry-policy 单源；rag（node:sqlite 向量库、增量索引、断点续传）、knowledge/learn 候选制、metrics。

**优点**：失败出口单点收敛 finishTurn 且自身不抛（finish.ts:69-76）；中断/超时语义工程化（外部/内部 ctrl 分离 + abortCause 触发序归因 runner.ts:555-586、deadline 强制定时器覆盖嵌套 self-heal 与确认闸 chat.ts:226-229）；记账口径严密（usage 末见 wins + attemptsUsage 跨 attempt 累计 + 失败调用也入账 + 记账 IO 故障降级不吞生成结果）；数据落盘原子性（全仓 atomicWriteFile 纪律 + RAG 事务包裹续传）；安全面成体系（路径闸、工具注册表原型链守卫、redactSecret 全出口、密钥 AAD 绑定）；「模型可见 ⟺ 已记录」四层贯穿（prompts/restore/turns/runner）。

**问题**：

- `[P2-A001]` chat 换网重试丢弃 A7 收缩结果：turns.ts:406-426——时序「首发超窗 → A7 收缩重发（:377-397）→ 重发回 AUTH 族」时，:422 换网重发载荷用首发 `toSend`（未收缩）而非 `retryToSend`；且 sendBudget 在轮循环外按主 provider 窗口 resolve，备用网窗口可能更小，换网重发再超窗已无收缩兜底。影响：白烧一次大概率注定失败的全量调用，极端时会话卡死需手动清史。修法：换网重发取当前最新实发载荷，或换网路径同接一次收缩。
- `[P2-A002]` runChatInner 只有 finally 无 catch（chat.ts:265-302）：全部已建模失败出口都经 finishTurn（回滚 history + 全会话遮蔽 + chat_error），未预期异常（如 restore.ts:145 createSession 裸 INSERT 遇 SQLITE_BUSY）穿透时 finally 只做清理，history 悬挂 user 消息、事件库留未终结会话、无 chat 终态事件。修法：finally 前补 catch 按 `{error}` 掩码走 finishTurn 同款收尾后再重抛。
- `[P3-A003]` 换网重发前无 chat_reset（turns.ts:418-422 对照 :388 A7 分支），首发已流出部分文本时前端重复错接（低概率：换网族多为建连期失败）。
- `[P3-A004]` 备用供应商选择不校验其 chat 档可用性（turns.ts:411-416 取第一个异 id 即用），未配 chat 档时用户先见「已切换」warning 紧接配置错误，误导排障。
- `[P3-A005]` chat 预算闸每次 runTask 同步全量读 book.yaml（runner.ts:519-520 → yaml.ts:236-259 无缓存），对照 loadProviders/resolveModelPricing 均有 mtime 指纹缓存先例；高频回合下事件循环重复同步 IO。
- `[P3-A006]` 六类失败出口回滚并遮蔽用户消息（turns.ts:459-462 等出口 → finish.ts:52-81），瞬态 provider 错误（429 耗尽/断网）也把作者刚输入的指令从内存与事件库双双清除，须整段重打。建议保留 user 消息补合成 error 回复，或 chat_error 回显原文。
- `[P3-A007]` learn 收割对单章解析失败整轮失败（learn/index.ts:188-191），与 RAG「坏文件跳过+告警」（rag/build.ts:298-307）口径相反；一本坏 frontmatter 章节致 learn 全家失效，且错误不带文件路径。
- `[P3-A008]` vault 内置密钥材料为混淆级保护（vault-key.ts:1-52，XOR 分片），码内已如实声明「防顺手 grep 不防定向攻击」；本地单机定位下可接受，未来多用户/远程形态即升 P1，建议 UI 侧明示加密强度。
- `[P3-A009]` claude 家族 effort 档显式禁用 thinking（anthropic-adapter.ts:184-186，R36-2 事件链路无签名回传载道），按码内登记推进签名回传后解除。

**契约观察**：runTask 是全部 AI 调用单漏斗（llm/call、ai-calls 账本、预算闸三口径汇聚；mock 不进账本自洽）；driver ctrl 按 owner 分槽 + 入口互斥闸双层防跨编排抢占（新增 chat 侧 runTask 调用点必须带同款 owner）；事件库引用计数 + 活跃登记是孤儿修复前置契约（三处入口都走 openSessionStoreAsync 孪生 + close 释放 + dispose 兜底）；task-gate 端口倒置未注册时 no-op 放行（生产缺注册静默失去互斥，有测试源锚软约束）；readBookConfig 失败不抛返回默认配置的信封约定被大量消费方依赖（改 throw 会连锁炸）。

**测试观察**：域内约 213 个测试文件，批次码命名可追溯；A7 收缩与换网重试各自有测，但**组合路径**（首发超窗→收缩重试回 AUTH→换网重发未收缩载荷）无用例——恰是 A001 缺陷面；runChatInner 未预期异常路径无测试；provider 降级链/usage 边界/截断检测覆盖密集；RAG 36 文件覆盖自愈与增量口径；未见「千章书 × chat 长会话（压缩+收缩+换网叠加）」soak 级组合压力。

### 3.2 文档与数据层（src/document · format · export · git · fs · state · shared · cache · log · async，约 1.9 万行）

**架构**：「文件本位」——盘上 markdown 唯一权威，`项目/文档清单.jsonl` + `工作区/.journal`（崩溃账本）+ `.版本`（快照）+ `.trash`（软删）四套簿记；所有写入收口 DocumentService（per-docId 串行队列 + 跨进程三级锁序 + revision OCC + journal 配对）；结构操作走「留洞制」（章号 append-only + 被并章软删 + `并入` 映射 + 崩溃半成态幂等续跑）；格式层手写零依赖受限解析器，规范形 LF+无 BOM、读容忍写归一。

**优点**：崩溃恢复三层闭环（journal pending 全文快照 → settled best-effort → 进门 reconcileSavePending 指纹消解 state/health.ts:588）；原子写族扎实（tmp+fsync+rename+目录 fsync fs/atomic.ts:142、独占创建 :240、崩溃 tmp 清扫带 pid 存活判定 :377）；路径安全纵深（resolveWithinRoot 双侧 realpath + 断链 symlink 段探测 safe-path.ts:38、safeDocId 全写点强制）；合并崩溃不变量成熟（`并入` 单跳化折叠、两形态幂等续跑 structure-merge.ts:172-201）；锁工程认真（全仓单向锁序、清单锁 async 重入排队 + 自等死锁 fail-loud manifest.ts:476-556）；平台差异系统性收口（win 保留名/NFC/case-fold/EPERM 退避单源）；解析边界覆盖全面（BOM/CRLF/块标量/全角冒号均有对照测试）。

**问题**：

- `[P2-B001]` 拆分取号无并发互斥（structure-split.ts:129 apply 同 :83 plan）：`maxUsedChapter+1` 无跨请求锁，planHash 重算只拦 plan→apply 串行失配（:131-133）；两个拆分 apply 并发重叠时各算得同一章号、目标文件名不同 → createDocument 双双成功，正文区两个 fm `章号: N`，破坏 D1「章号永不复用」不变量（cache/sync.ts:128 重复入库仅 warn，按号定位/导出/取号下限全部歧义）。修法：取号+落位段套全局结构锁，或 doCreate 后复查全书章号冲突即回滚。
- `[P3-B002]` undo 降级路径以 max(并入) 当「最近一次合并」（structure-merge.ts:362-373）：乱序合并 + 事件副录缺失时 undo 选错源章，回滚到全部合并之前，较早并入成果从目标正文消失且盘面无 structurePending 报告。建议按回收站 trashedAt 最新反推源章号。
- `[P3-B003]` 合并续跑判定用容错版 listTrash（structure-merge.ts:172、:260），回收站瞬态读失败被吞成空表 → ②后崩溃续跑对已删源重跑 trashDocument 误报 ENOENT；同仓 trash 消费面已按 R42-7 全量 strict 化，此两处应对齐 readTrashManifestStrict。
- `[P3-B004]` 章号双轨口径混用：readChapterState 取 fm 章号（structure-core.ts:102）vs maxUsedChapter/违规检测/取号下限按文件名前缀（structure-core.ts:171-184、structure.ts:77-94）；作者外部改名后 `并入` 登记号与检测/定位互相失配。建议结构操作入口统一校验 fm ≡ 文件名前缀，失配 fail-loud。
- `[P3-B005]` maxFileNameChapter 窄正则（health.ts:785 要求 `\d+-标题`）与 chapterNoFromName 宽正则（format/filename.ts:138 认裸尾数字）漂移：裸数字名计入取号「已用」集却不计入 nextChapter 下限，靠 draft-path 覆盖守卫兜底报错而非正确取号。
- `[P3-B006]` 拆分两步间崩溃无健康哨兵（structure-split.ts:141-162，与合并的 structurePending 不对称）：①截断后 ②创建失败，迁出段仅存强制版本，作者不看版本面板难以察觉章尾丢失。
- `[P3-B007]` StructureViolation.targetDocId 恒 null 死字段（structure.ts:88-105 实现从不查清单，对照 :55 接口注释与 health.ts:339 死臂），契约漂移，删字段或补反查。
- `[P3-B008]` 结构 plan/apply 各付三重全书同步扫描（structure-split.ts:129-130），千章书冷缓存单次数百 ms 同步 IO 在 HTTP 路径；建议 apply 复用 plan 已算值（planHash 已含二者）。
- `[P3-B009]` 服务进程写路径同步退避（fs/atomic.ts:40-42 Atomics.wait 被 renameWithRetry 引用）win 瞬时 EPERM/EBUSY 时最长 350ms 阻塞事件循环——有意取舍但无耗时留痕，建议超一档退避即 log.warn。
- `[P3-B010]` updateDocMeta 非标量值落 `[object Object]` 进 fm（service-meta.ts:507-511 → frontmatter.ts:128 String(val)），PATCH 传对象不拒收、读回字符串无警告；建议 patchFlatFm 入口对非标量 fail-loud。

**契约观察**：StructureRagPort 端口反转干净（document 零 rag import）；结构操作强制走 svc.save origin external-merge/restore（「禁裸 atomicWriteFile」是头注纪律非类型约束）；拆分 cursorOffset 契约 = 盘上原文 UTF-16 偏移，GET /file 侧须钉死「原文透传」（任一环规范化则拆分点错位且 planHash 同源错算不可察觉）；undo 主路径依赖事件库、null 时静默降级盘面启发式（与 B002 叠加才成险）；structure-merge 跨域消费 check 域读取源（document→check 出边，测试需连带夹具）。

**测试观察**：结构端点级覆盖扎实（split 30 / merge 16 / crash 4，含 TOCTOU PLAN_STALE 与崩溃续跑），但并发拆分取号（B001）与事件缺失+乱序合并 undo（B002）无用例；frontmatter 解析族覆盖密度高且有往返模糊等价；清单锁重入/超时/死锁有专项回归；跨进程真并发仅少量专项，结构操作层无并发用例。

### 3.3 运行时与桌面（src/process · desktop · check · events · install，约 2 万行）

**架构**：Electron 主进程纯壳（单实例双锁 → bootstrap → 安全窗口）fork utilityProcess 子进程承载 studio server（127.0.0.1 随机端口，parentPort 握手协议，token 经 env）；事件存储每书一 SQLite 库（append-only events 表 + 全局单调 seq，投影纯函数 foldSurface 重放消息视图，compaction/end 以 replace 遮蔽区间实现）；崩溃退避自动重启（0/5s/15s 三档 3 次封顶）+ 多级预算优雅停机链；跨进程锁体系（开口标记/迁移墓碑/manifest/book.yaml/books.jsonl 各司其职）；check/ 零 token 机检引擎（红黄分级 + 树红点增量双指纹缓存）；install/ 书架登记、建书 scaffold 与三条一次性迁移。

**优点**：事件存储血缘语义显式化（INSERT RETURNING 取真实 seq + 双语义拆分 + API 边界「宁可红不可错」store.ts:672-675，多段遮蔽单事务 + 遮蔽区间连续化）；子进程状态机完备（starting 互斥通道 fail-closed + 三旗分工 + kill 升级纪律覆盖全部四条路径 + 'error' 事件必监听）；Electron 安全配置到位（webPreferences 安全项置于展开 opts 之后防覆盖 windows.ts:296-298、IPC sender 白名单单点守卫、show-in-folder 三重防穿越）；跨进程锁与崩溃恢复成体系（全部 RMW 持锁 + 锁内重读复核、开口标记 30s 续期 + 死 pid GC + 孤儿会话事务内复核）；ROLLBACK 纪律统一（全回滚吞 ROLLBACK 自身异常保原始错误上抛）；Windows 特化细致（trueCasePath 逐段/字体 GBK+reg 回落/rename 退避/env 大小写不敏感清除）；prepared 语句缓存 ephemeron 环断链关库单源；防御皆有留痕。

**问题**：

- `[P2-C001]` 备料链 RAG 命中取回为同步全树扫描（process/materials.ts:65-97——:75 walkMdEach 同步遍历 + :78 readFile 同步整读），prepareMaterials 在 studio server 子进程事件循环内 await 调用（ai/orchestrate/self-heal.ts:406）；与 book-search.ts:200-207（R46-3）已修问题同族漏网——大书每章备料一次数百 ms 至秒级同步阻塞，期间 SSE 心跳/保存/其他书请求全部冻结。修法：对齐 book-searchAsync 形态（walkMdAsync 孪生 + 缓存异步读，生成器核心单源双驱动范式现成）。
- `[P3-C002]` events/store.ts 五处裸 db.prepare（:744-751 firstBranchMetaSeq〔chat-history 尾窗每请求调用，最热〕、:831-844、:852-855、:876-879 循环内、:989-990），同文件其余热路径均已走 prepared() 缓存（latestSession :807-808 注释自证此为已修反模式）。
- `[P3-C003]` process/assemble.ts 四处裸 db.prepare（:96、:102、:124-126、:150-153），同族场景 check/runner.ts:166-169 已按 R0917-6-P3-8 收编，本文件未跟进。
- `[P3-C004]` chat-history 无事件库早退分支缺 truncated/total 字段（chat-history.ts:131），前端 chat.ts:493-494 消费 historyTotal 落 null（「未知」）而非 0；建议补 `truncated: false, total: 0`。
- `[P3-C005]` book-search 异步孪生残留同步 existsSync（book-search.ts:143），与文件头注「全链 fs.promises」宣称不符；网盘卷单 stat 可达百 ms 级，可并入注入 io 的 listMd 失败按空处理顺带删除。

**契约观察**：chat-history 是 events 三原语唯一生产消费者，firstBranchMetaSeq 的 LIKE 匹配依赖 JSON 序列化形态（失效方向安全：多取不少取）；prepareMaterials 的 AbortSignal 已贯穿 RAG embed 与自愈补漏链，同步 IO 面是两域接缝唯一阻塞点；check ↔ self-heal 三态降级与未来章基准单点收口两侧口径统一；install ↔ desktop --book 直达链依赖建书侧 NFC 归一不变量；迁移链与 manifest 锁无交叉锁序面；token 文件 mode 0600 不防本机进程系头注如实记档的有意取舍（威胁模型排除本机恶意进程）。

**测试观察**：五域 200+ 测试文件，修复轮次几乎都有同名测试钉住；events 核心风险面扎实（迁移竞态/墓碑/孤儿修复/坏行降级/pending 上限/prepared 断链）；desktop 用 fork 依赖注入 + main-process-harness 测状态机（时序路径可注入缩短）；chat-history 真尾窗等价性守护放在 test/ai/ 而非 events/（按域查找易漏，组织问题）；事件循环冻结类问题（同步 IO 阻塞面）无测试暴露——现有测试断言行为正确性而非调度公平性。

### 3.4 Studio 服务端与构建链（src/studio/server · scripts · 配置与 CI，约 1.6 万行）

**架构**：裸 node:http 手写零依赖框架（router.ts `:param` 段正则分发 + defineRoute parse 声明层）；单入口 `/api/*` REST + SSE（driver async generator + 30s 心跳 + 连接即发 sync 快照 + 1MB/240 次背压双判死），其余静态托管 dist/web；安全面仅回环监听 + Host 白名单防 DNS rebinding + 写端点 Origin+token 双闸 + GET token 闸（boot 与 SSE 显式豁免、SSE 三凭据闸）；API 域 40 文件按域缝拆分，ttl-cache/serial-chain/task-gate 三通用件收敛同构面。构建：tsup 双 config（desktop ESM 六入口含 3 worker + preload CJS）→ electron-builder asar（files 白名单 + !node_modules + asarUnpack fontlist）；CI 双工作流（ci.yml 3 OS×Node 24/26 + 四门 + coverage 单腿 + e2e + release-smoke + Electron 冒烟 + soak 内存门；desktop.yml tag/手动双 OS 出包 + 版本一致性门 + SHA256 清单 + 打包态冒烟）。

**优点**：安全基线同类本地服务最高档（Host 校验/双 token 闸/常量时比较/absolute-form 拒收/大小写变体 404 兜底/body 排空单挂点 index.ts:338-486 全链可考）；路径穿越防御三重 fail-closed（static.ts:104-122，win 保留设备名与 AppleDouble 均拦截）；SSE 生命周期无泄漏面（句柄化记账/鉴权前移防书名探测/ticket 预检消费两段防烧票/early-return 泄漏防护）；错误处理纪律化（replyError 单出口统一脱敏、500 不透传内部细节、日志只记路径段）；并发治理系统化（per-book 任务闸 + 跨进程文件锁 + 编排互斥矩阵 + 五站写端点不变链 + 删书改名五连 drain）；esbuild 钉版因由与覆盖面在 package.json:67 如实记档。

**问题**：

- `[P2-D001]` settings/completion-names 缓存壳缺 in-flight 去重，与自身注释宣称相悖（settings.ts:134-150 创建处无 `inFlight: true`，:146-147 与 :160 注释却宣称「并发 MISS 经 in-flight 去重只扫一次」；去重只在 ttl-cache.ts:201 的 opts.inFlight 分支生效；同族 search.ts:58、rhythm.ts:74、foreshadows.ts:83 均有）。/settings 是全书最重扫描端点，MISS 窗内并发请求各自全量重扫；注释失实会诱导后续消费方依赖不存在的性质。修法：两壳补 `inFlight: true`（一行）或改注释。
- `[P3-D002]` providers.json 排队写窗口的并发丢更新残窗（providers.ts:251-253 注释宣称三段同步即原子、:288 await 落盘；provider/store.ts:350-374 + ai/calls.ts:336-395 实现跨进程锁争用时快路转异步排队，后到请求读旧 revision 双双过闸，队列序落盘后到者覆盖先者编辑）——双进程同时编辑供应商时静默丢一次配置。修法：saveProvidersLocked 写前对盘上 revision 复验。
- `[P3-D003]` ci.yml e2e 的 chromium 缓存键未随 desktop.yml 同批收口（ci.yml:200-204 仍用 lockfile 哈希键，desktop.yml:106-117 已改版锚 + restore-keys 并注明缺陷）——根依赖任何升级打爆 ubuntu e2e 腿缓存，双工作流同题不同解。
- `[P3-D004]` PR 级 CI 无真 asar 打包冒烟（check-packaging.mjs:5-9 自认静态锚；ci.yml 无 electron-builder 步，desktop.yml 仅 tag/manual）——「静态门可过但打包崩」形态最早 tag 出包才暴露。建议 ci.yml e2e job 增补一腿 `electron-builder --dir` + 解包冒烟（ubuntu 单腿摊销）。
- `[P3-D005]` check-counts 的 walk 不设 symlink 防护（check-counts.mjs:275-292 statSync 跟随 + isDirectory 递归），环 symlink 未捕获爆栈；对照 check-knowledge.ts:60-78（R71-39）同型问题已 fail-closed，双标。修法：lstatSync 判型 + symlink 跳过。

**契约观察**：`?token=` SSE 兼容通道双侧挂账耦合（stream.ts:246-252 ↔ useSse 回退拼接，单侧移除即静默断流）；boot/token 信任模型三端闭合（按 Origin 回传 ↔ 401/403 re-boot 仅 token 变化重放 ↔ 桌面态持久化 token）；错误信封全链一致（replyError ↔ apiJson 分型，特例码均有消费面）；双保存协议由服务端白名单钉住（writablePath 禁 `写作/正文` files.ts:301 强制正文走乐观锁协议）；spawn role 白名单单消费方（扩角色须双侧同步）；SSE sync 快照 ↔ 前端 running 状态机（E1c 后台继续语义依赖重连快照 + ring 回放——见 E001/E002 两处契约缺口）。

**测试观察**：门禁密度罕见（全量 vitest + 双 typecheck + eslint 0 警告 + check-counts 多层 AST 门 + packaging 静态锚 + knowledge 双向对账 + e2e 双探针 + release-smoke + Electron 冒烟 + soak 门 + 分域阈值）；SSE 面直测厚（背压双判死/连接计数/watchdog/工厂同步抛错）；缺口：真 asar 冒烟只在 tag（D004）、coverage 单腿 win skipIf 用例不进口径、settings 并发 MISS 行为无测试钉（D001 两可态不可见）。

### 3.5 前端数据流层（src/studio/web-next：api · stores · composables · editor · shared · types · pages/views，约 1.5 万行）

**架构**：api/（apiJson 统一封装：token 注入、401/403 re-boot 重放、超时暂停表、错误信封→ApiError）→ stores/（Pinia setup store：workspace/doc 编辑缓存〔LRU 20，dirty 永不逐〕/workbench 事件态/chat 对话态/prefs）→ composables（useSse：POST 换 ticket → EventSource → JSON 按族分流 chat_*/其余；fail-closed 0ms 换票重连 + 心跳看门狗 resync）→ views。编辑器数据流：CmHost 以 lastLocalEmit 区分本视 emit 与外部变更，外部变更卸载重挂防 undo 栈污染；保存乐观锁 PUT + 冲突出「重载/覆盖」双出路；localStorage 节流脏镜像崩溃兜底。

**优点**：useStaleGuard 把全库「请求代守卫」收敛单源；apiJson 是罕见完备实现（401 自愈重放一次/重放前 cancel 旧流/监听器摘除/坏体上抛 MALFORMED_RESPONSE）；CmHost IME 组合期挂起-消费机制与 undo/redo 真重置是编辑器同步的正确做法；切书链（Z-8 冲突预检→flushDirty→F1 失败守卫→R37-1 复查 + adjudicated 台账防二次弹窗）对不可恢复丢失的防御完整；doc LRU + dirty 镜像兼顾内存与崩溃恢复；prefs 双级写入链多窗口语义清晰；SSE 层 fail-closed/429/ticket 回退/半开看门狗均有锚定测试。

**问题**：

- `[P1-E001]` SSE 断线重连回放 chat 腿事件，chat store 无幂等去重：chat.ts:240-245 `chat_turn` 无条件 push 新气泡；cc.ts:232-239 新消费者接入即回放 `ch.chat.ring`（chat 腿活跃期累积的 chat_start/turn/text 协议单元）；而 chat.ts:213 注释宣称的旧契约「重连时后端只补发 chatRunning，不重发 chat_turn」已被 2026-09-17 execRing 两桶分环改动打破（ring 回放成为重连唯一恢复通道）。机理：对话进行中任何 SSE 重连（网络抖动换票/心跳看门狗 resync/server-restarted）→ 服务端先发 sync（此时因旧气泡未 done 跳过重建）→ 随后回放 chat_turn 再 push 新气泡、回放 chat_text 从头重建全文 → 旧半截气泡（done 恒 false）与新完整气泡并存；chat_turn 已被 200 槽 ring 挤出而 text 残留时整段回放文本拼进旧气泡造成同气泡重复。刷新路径可自愈，**重连保态路径无自愈**；孤儿气泡永久「生成中」，变体定位/重新生成挂点失真。修法（三选一）：服务端为 chat 腿回放补合成 `chat_reset`+索引重置锚；或前端 sync(chatRunning=true) 且存在未完成气泡时切「待回放重建」模式（清空后由回放重建，等价刷新路径）；或 chat store 消费回放前按 sync 的 chatRunning 与未完成回合决断。
- `[P2-E002]` sync 快照 `running` 字段混入 chat 槽位：cc.ts:341-349 isRunning 遍历全部 owner 槽位（chat 以 `chat:<book>` owner 全程注册 ctrl，仅 finish 时注销 chat.ts:301）→ stream.ts:360 sync 的 `running=driver.isRunning()` → workbench.ts:126 置真；workbench 只被写手腿终态事件复位（workbench.ts:181-183），chat_done/chat_error 永不到达（useSse 按 chat_ 前缀分流）。对话中重连的 resync 携 running:true 置 workbench.running=true，对话结束永久滞留 → ①输入框 busy 禁用（useChatComposer.ts:85）、E1a steer 失效；②WorkbenchView genBusy 全按钮假忙；③textIncomplete 连带置真，draft 保存被 F4 门误拦。修法：前端最小修（chat_done/chat_error 连带复位 wb.running）；根治在服务端把 sync running 口径收窄为写手腿（chatRunning 已单独供给）。
- `[P3-E003]` dev 401 自愈通道双基址不对称（client.ts:46 boot 走相对路径经 proxy vs useSse.ts:59 ticket 直连 DEV_API_BASE）：proxy 目标 ≠ 直连基址时 rebootstrap 从 proxy 实例取 token，SSE 直连实例仍 401，自愈空转三轮才进 R59 连记告警。
- `[P3-E004]` interrupt() 丢弃服务端 `interrupted` 如实上报字段（api/workbench.ts:53-55 返回 void vs stream.ts:536,549 返回 {ok,interrupted}），interrupted=false（本无在途）时点击「停止」零反馈。
- `[P3-E005]` chat_error/chat_done 不清 notice（chat.ts:315-329、:297-313），「已加入队列」提示与错误同屏悬挂至下一回合。
- `[P3-E006]` chat.clear() 不复位 running（chat.ts:650-670）：旧书对话在途时切书，seedHistory 被守卫拦下转 pendingReseed，全靠链尾 resync 补种；resync 进退避则新书对话区持续空白且假显示停止按钮。建议 clear() 内置 false（sync 权威校正，与 M-12 同口径）。

**契约观察**：sync 快照 running 与 chatRunning 的边界模糊是 E002 根因（写端点 409 闸用独立查询不受影响）；SSE 无 seq/事件 id，写手腿靠回放头清屏锚保证 textOut 幂等而 **chat 腿无对等契约**（E001 根因）；对账通过的端点（GET /file、PUT content、chat history/branches、POST chat、auto-write、check、rewrite、stream-ticket）前后端类型逐字段一致；ticket 消费时序（预检不烧票 + fail-closed 0ms 换票）配合正确——也因此浏览器自动重连吃 403 是设计内路径，E001 触发面覆盖一切中途断连；interrupted 双通道（cc.interrupt 推 interrupted + chat finish 推 chat_error）各自收口正确，sync 通道恰好绕开这对终态事件。

**测试观察**：test/studio/webnext/ 280+ 文件（useSse 退避/429/ticket/401 自愈、chat/doc/prefs/provider store、CmHost 守卫、api client 重放）；缺口：SSE 重连 mid-turn 的 chat 腿回放场景无测试（E001 正落于此）、sync.running 与 chat 并存语义前后端均无钉（E002）、双腿并发回放分流无前端测试、interrupted:false 前端消费零接线（E004 同源）。

### 3.6 前端组件层（src/studio/web-next：components 103 件约 2.1 万行 · styles）

**架构**：App.vue → 路由四页；pages/Book.vue 常驻挂 WorkspaceShell（Ribbon + 左右栏 + 中央 TabBar/视图区 + StatusBar + ChatDock + 全局浮层），视图按 activeView v-if 切换；编辑器 = EditorView 内嵌 CmHost（CodeMirror 6 细封装，mode/readonly/typewriter/history 各走 Compartment）；组件层无独立状态，全部读 Pinia stores，取数竞态统一 useStaleGuard；无 600 行级巨型组件。

**优点**：XSS 面干净（全库零 v-html/innerHTML，用户可控内容一律文本插值，审计 JSON 也 `<pre>` + 4KB 截断）；CmHost 集成成熟（切文档真清撤销栈/全量替换保留多光标/剪贴板 await 后复检防删错/组合态双判守卫）；监听器定时器清理逐对配平（14 处全平）；竞态防御成体系（切书切档入口捕获 + await 后复检覆盖成功与 catch 双路径）；大列表面 RENDER_CAP=100 惯例遍及树/搜索/审阅/命令面板且切片单源；双击防重在途锁全域成对；每击键 O(n) 面收敛 150ms 防抖单源；可访问性投入实（roving tabindex/focus-visible/IME 让渡全域一致）。

**问题**：

- `[P2-F001]` AiServicePanel save() 的 add→update 分支竞态（AiServicePanel.vue:162-163）：`const addId = editedId.value ? null : await store.add(input)` 在 POST 在途窗口内，用户点任一行「编辑」置 `editedId = 该行id`（AiProviderList.vue:106 编辑钮无 disabled）；:163 恢复执行时**重新求值** editedId → 走 store.update(editedId, input)，把新增表单草稿（含 apiKey）整包写进刚被打开编辑的那行提供方——静默配置损坏。同函数 saveRag（:289）把三元判据与调用写在同一表达式天然免疫，两处不对称即机械成因。修法：await 前捕获 `const wasEdit = !!editedId.value` 后按 wasEdit 分支（与 saveRag 同构），或保存期间禁用行编辑钮。
- `[P2-F002]` 「设定速查」插入信号在非编辑器视图静默悬挂（ContextQuickPanel.vue:48-55 仅无 activeDocId 时 toast；SidebarRight.vue:118 速查面板全视图常驻；Book.vue:367 EditorView 仅 editor 视图挂载；EditorView.vue:224-232 pendingInsert 唯一消费点）：用户在总览/关系图/工作台点「插入到正文光标处」，入槽后无人消费，点击当刻零反馈，切回编辑器才补插在数分钟前旧光标位。修法：onInsert 增加 activeView !== 'editor' 分支（禁用+提示或 toast 挂起说明）。
- `[P3-F003]` CmHost 的 selectionChange 事件死契约（CmHost.vue:36 声明、:199 每次 emit，全 src 无消费者），删除或接上消费方。
- `[P3-F004]` WordCurveChart 残留死 CSS 规则（.empty，:142；R72-11 已删内层空态分支），随手清。

**契约观察**：CmHost ↔ EditorView 每击键全文串往返（emit → patch → splitFrontmatter 拷贝 → props 回流 → O(n) 全串比较；单章 5k 字无感，超大单章约 3×O(n)，值得基准化）；store 内 catch 置 error 的隐式契约（组件裸 await 不 try/catch，store 改 rethrow 即成 unhandled rejection）；pendingInsert 单槽 last-wins 三处补消费已闭环（唯跨视图悬挂见 F002）；armed 单门与 useStaleGuard 两套过期守卫并存（新组件易选错，建议头注补选型指引）；SettingsModal provide 串行队列 + revision 乐观锁契约健康（keep-alive tab 轮询须复刻停表/续表模式的隐式门槛）。

**测试观察**：269 个测试文件 mount 级覆盖主流交互件 + r29 零覆盖兜底门；coverage 桶 components/composables/stores 分列防稀释；缺口：AiServicePanel save()/activate() 编排只有卡片开合测试（F001 恰在盲区）、CmHost.clipboardPaste await 后复检无直测、ContextQuickPanel→pendingInsert→EditorView 消费链无端到端直测（F002 不可被回归捕获）、ExportDialog/Ribbon 等静态展示件零直测（可接受）。

### 3.7 测试体系（test/ 1221 文件 18.2 万行 · 门禁 · coverage · e2e · soak）

**概述**：分布 studio 474（内含 webnext 268）/ ai 144 / document 112 / format 70 / check 57 / process 51 / desktop 38 / rag 36 / e2e 31 / install 31 / events 28 / 其余小域；ci.yml 五腿 + coverage 单腿阈值门 + check-counts（.only/.skip AST 拒绝 + 空洞文件门 + pageerror 接线门 + spec 顺序快照 + 双包版本漂移）+ e2e job（33 spec 串行 + release-smoke + Electron 冒烟 + soak 内存门）。expect 总量 22879，抽样域断言强度普遍为高。

**优点**：check-counts 是罕见的「元测试门」（.only/无条件 .skip 已 AST 化）；helpers 基建成熟（mkdtempTracked 失败也回收/startServerSafe 防受限端口抖动/waitFor 轮询单源/bootStudio 一站式 harness）；全局 token 注入助手把「自动注入救活 403 断言」的假绿升级为硬失败；事件库测试强度标杆级（SQLite 触发器注入故障验证事务原子性与半态回滚）；fake timers 纪律严格（70 个用文件全带 useRealTimers 还原，0 漏）；soak 方法学干净（固定输入/幂等底座防空转假绿/GC 后 5 采样取最小）；e2e 发布态三件套齐且全接 CI（global-setup 陈旧产物 fail-closed）；governance 域把架构约束常驻化（import 方向/KNOWN_ACTIONS 对账/coverage glob 双向锁/「模型可见⟺已记录」管线级校验器）。

**问题**：

- `[P2-G001]` 15 个后端域无域级阈值门（vitest.config.ts:116 主桶 glob 与 :128-135 自认稀释机理）：cache/check/desktop/document/export/format/fs/git/install/knowledge/learn/log/process/rag/state 仅落 ~89% 池化均值桶，小域覆盖腰斩推不动均值；项目已为 metrics/driver/review 立过同论证子桶却未推广，且三个既有子桶只钉 lines/branches。建议按 −2pp 规则逐域补地板。
- `[P2-G002]` Anthropic 协议线无真 HTTP/SSE 测试形态（test/ai/fake-provider.ts:2-4 只造 OpenAI 兼容格式、test/studio/fixtures.ts:177 硬编码 protocol:'openai'；anthropic-adapter 仅经进程内假 client 间接行使）：anthropic SDK 线级 SSE 解析、/v1/messages 拼接、双认证头阻断只有源码刮取锚。实配 Claude/中转网关用户的实际主链路端到端不触网。建议 fake-provider 加 anthropic 线格式（本地 /v1/messages stub）。
- `[P2-G003]` web-next .vue 组件层零覆盖核算（vitest.config.ts:87 coverage include 仅 `src/**/*.ts`，SFC script 块不入报告不入门；聚合桶 lines 门 43 远低于域内实况）：views/组件内编排逻辑回归无机器门。建议开启 .vue 插桩或给 views 域立桶。
- `[P3-G004]` 真定时器有序截止链用例负载敏感窗（test/ai/runner.test.ts:508-525 P-5 三级实定时序、:376-409 R42-20 中断须落入 Retry-After 窗）：满载跑批 setTimeout 次序可翻转，归因断言偶发红。建议 fake timers 或事件驱动同步点。
- `[P3-G005]` 44% 批次号命名 + 批队文件按轮次聚簇（全量 basename 统计：`^r[0-9]` 542/1221 = 44.4%，放宽批次语缀 47.3%；gen-stream-integrity-guards.test.ts（原 r26-batch-a.test.ts）一文件混四个不相关主题）：2026-09-16 已立行为命名新规，建议对同名主题散多文件优先归并。
- `[P3-G006]` 空洞测试门是「每文件 ≥1 断言」粒度（check-counts.mjs:231-235），恒真断言不在射程；建议口径下沉到每 it 至少一断言。
- `[P3-G007]` 源码文本刮取式静态锚断言（test/ai/provider/provider-usage-pins-and-wire-guards.test.ts（原 r38-batch-d.test.ts:177-191，源码刮取锚已行为化）slice(indexOf(...)) 钉构造参数与导出签名），格式化/重排即碎或漏；对比 governance 域同类扫描有明确边界论证，此处裸 slice 更脆。
- `[P3-G008]` e2e 单一 workDir 顺序契约的级联脆弱性（playwright.config.ts:23-32 workers:1 + retries:0 + 共享 workDir）：前序 spec 崩溃连坐下游；快照 + spec-order 探针双守卫已到位，新增 spec 建议默认走 short-full-flow 的独立 server+tmp 模式逐步收缩共享依赖面。
- `[P3-G009]` 注释钉值漂移（playwright.config.ts:16「31-spec 契约」与 ci.yml e2e job 注释「29 spec 串行」落后实测 33，机器门是对的）；另 runner.test.ts:618-619 用 mtime 相等证未写盘属弱预言，宜辅内容指纹。

**体系性缺口**：①Anthropic/CC 网关线端到端无触网形态（G002）；②覆盖核算三盲区（scripts 显式豁免 / .vue / src/shared 无独立桶）；③域级阈值门未铺满（G001）；④性能预算门只钉两个规模点（树红点 + RAG 召回），studio API 面与 SSE 吞吐无时延上界断言；⑤真供应商响应无金样本/录音回放机制（响应面全靠手写合成事件追赶，replay-anchor 未上升为通用形态）；⑥多开/并发用户形态无测试位（e2e 单 workDir 串行是缩影，双端同开无系统性并发套件）。

## 四、主审核验记录

主审对全部 12 条 P1/P2 逐条对源码复核，锚点全部证实：

- E001：chat.ts:240-245（chat_turn 无条件 push）+ cc.ts:232-239（新消费者回放 chat 腿 ring）+ chat.ts:213 注释旧契约——三点互证成立。
- A001：turns.ts:422 `sendTurn(toSend, ...)` 确用首发未收缩载荷（对照 :390 A7 路径用 retryToSend）。
- A002：chat.ts:265-302 try/finally 无 catch 实证。
- B001：structure-split.ts:129 取号无锁、:131-133 planHash 仅拦串行失配，实证。
- C001：materials.ts:75-81 walkMdEach + readFile 同步实证，调用链 self-heal 在 server 事件循环内。
- D001：settings.ts:134-150 创建选项无 inFlight、:146-147/:160 注释宣称去重——注释与实现不符实证。
- E002：cc.ts:341-349（isRunning 全槽位）+ stream.ts:360（sync running）+ workbench.ts:126/:129（置真连带 textIncomplete）+ chat 族终态不达 workbench（useSse 分流）——四点互证成立。
- F001：AiServicePanel.vue:162-163 await 后重读 editedId 实证（:289 saveRag 同函数内同构写法对照成立）。

P3 ×36 由子代理 file:line 锚定、主审抽核（B002/B005/C002/D003/G005 抽查属实），未逐条复读。

## 五、修复优先级建议与收口条件

1. **第一批（P1 + 连带面）**：E001（chat 腿回放幂等，建议服务端补锚 + 前端重建模式双保险）与 E002（sync.running 口径收窄）同批——两者同属「2026-09-17 分环/快照契约演进后前端未跟上」主题，修一及二成本低。
2. **第二批（正确性 P2）**：A001/A002（chat 重试组合路径 + 异常收尾，同一函数域顺手修）、B001（拆分取号加锁）、C001（备料链异步化，范式现成）、F001（一行捕获分支）。
3. **第三批（应修 P2 其余 + P3 顺手项）**：D001（一行补 inFlight 或改注释）、F002、G001-G003（覆盖门补盲区）；P3 按域触达渐进。
4. **收口条件**：P1/P2 全量修复 + 回归通过（L1 相关面逐批 + 收口批 L2 全量九门）后收口，本件随收口批归档 `Archive/`（扁平）。修复实施时建议每条问题建立对应回归测试（§3 各域「测试观察」已指明盲区位置）。

## 六、处置记（2026-09-18 0918独立重评修复批，作者指令「全部修复！」）

**L2 九门实录（mac，终树一次全绿）**：vitest 全量 1210 文件 = 7546 过 + 8 跳 0 败（一次全绿 142.77s）+ tsc 0 + vue-tsc 0 + eslint 0/0 + 三 check 过（counts 1210/7546/33/54 README 修账后对账绿 / packaging / knowledge）+ e2e 51 过 3 跳 40.0s（跳 = 发布门 spec 预期口径）+ coverage 阈值门全量三跑终态红 0 条。净 +22 文件/+87 用例（回归测试 22 新件行为命名 + 既有件扩例）；差值锚 64 维持，win 预期 7482 过 + 72 跳待实跑核对。**本件随批收口归档 `Archive/`（扁平）**，批记 = `Dev/Docs/Archive/README.md`（2026-09-19 撤档，git `02c52430` 可取）。

### P1×1 / P2×11 —— 全量真修（12/12）

| 项 | 处置 |
|---|---|
| E001 | 真修：cc.ts `buildRingReplay` 回放头补 `chat_replay_begin` 锚（DriverEvent 联合登记；writer 单腿回放不插、chat ring 空不插）+ 前端 chat store rebuild 模式（移除在途未 done 气泡 + pendingReseed 复用自愈通道，ring 截断形态经重播种恢复 = 等价刷新路径）；anchor 5 例 + rebuild 5 例双端钉，锚单判与 REPLAY_RESET 语义不变实证 |
| E002 | 真修：driver 接口加 `isWriterRunning`（cc = 非 `chat:` 前缀活跃槽位；mock 齐平恒 false）+ stream.ts sync 快照改用；isRunning 全调用点核查——仅 /interrupt 两处保留全腿口径（中断语义本意）；前端验证零改动（两 store 字段独立，chat 终态从不触碰 wb.running） |
| A001 | 真修：`effectiveToSend` 穿线（A7 收缩实发处同步），换网重发取收缩后载荷且指纹按实发重算；组合链（超窗→收缩→回 AUTH→换网）用例钉恰 3 请求 + 第 3 请求载荷 = 收缩后 |
| A002 | 真修：runChatInner 补 catch（prepared/completedOk 双标记防双收尾——runAgentTurns 六出口调 finishTurn 后同步 return，「finishTurn 后再抛」窗口不存在；completedOk 后逃逸只 warn 防 R69-10 同型「成功后报错」；准备期抛 best-effort chat_error；rethrow 对外契约不变）3 例 |
| B001 | 真修：applyChapterSplit 取号临界段（重读→校验→取号→planHash 锁内重算复核→截断→落位）套 per-bookRoot 进程内互斥（serial-chain 同构；recordStructureEvents 移锁外保「互斥内不取跨进程锁」纪律）；并发双 apply 章号唯一 + 串行重放 PLAN_STALE 2 例 |
| C001 | 真修：readChapterBodiesByNumbersAsync 异步孪生（新增 walkMdEachAsync + fs/promises 读，frontmatter 解析单源复用）+ prepareMaterials 改调；同步版随批删（grep 证唯一消费链）；mergedIntoMap 同步段有界留痕登记 |
| D001 | 真修：settings/completion-names 两壳补 `inFlight: true`（ttl-cache 头部收敛映射表随批修账防账实漂移）；`__settingsScanCountForTest` 钩子钉并发 MISS 单飞 4 例（修复前实测 3/4 红） |
| F001 | 真修：save() 首个 await 前钉死 `editTarget`（比建议的 wasEdit 更进一步钉目标 id——否则在途窗口改点他行时 update 仍漂移）；add 在途点编辑 / update 在途改点两形态 2 例 |
| F002 | 真修：onInsert 增 activeView 判断——非 editor 视图 toast「已挂起：回到编辑器视图后自动插入」+ 照常 requestInsert（消费点 immediate watch / onMounted / nextTick 三处核实闭环，切回必补插）；2 例 |
| G001 | 真修：15 域阈值地板（观测值 −2pp 四指标，cache 90/86/94/90 … state 91/85/98/91）+ metrics/driver/review 补 statements/functions（兑现 R0916-6-P3-12「随实测收紧」注）；governance coverage-threshold-globs 镜像同步（.ts+.vue 双收 526 文件落桶实证绿） |
| G002 | 真修：fake-provider 增 Anthropic 线 stub（独立工厂，SSE `event:` 行白名单系 SDK `Stream.fromSSEResponse` 硬约束——通读 SDK 源码发现）+ withFakeProvider protocol 参数；真线全链 4 例（文本流+认证头 / tool_use input_json_delta 增量拼装 / max_tokens 映射 / SSE error 事件），**src 零改动** |
| G003 | 真修：coverage include 扩 `src/studio/web-next/src/**/*.vue`（SFC 插桩实证可行：ReviewPanel S100/B88 等产数正常、行号映射吻合 SFC 边界）；聚合桶扩面 pages/views + 根 App.vue 单列桶（观测 98.33/64.29 → 地板 96/62） |

### P3×36 —— 随批修复 24 / 维持 4 / 待拍板 2 / 缓办 6

**随批修复（24）**：A003 换网重发前补 chat_reset／A004 备用供应商 chat 档预检 + 无可用文案如实／A007 learn 坏章跳过 + 逐章 warn 带路径（对齐 rag/build.ts 口径，全坏才失败）／B002+尾项 undo 降级 trashedAt 择最新 + locateMergeByBody 重写为①后形态签名定位并前置（判定非纯 fail-loud：重号脏盘面会错选无辜章静默回滚；≥2 存活歧义收紧 fail-loud）／B003 合并续跑 readTrashManifestStrict ×2（失败映射 WRITE_ERROR）／B005+尾项 maxFileNameChapter 收编 chapterNoFromName 剥茎单源 + finalizedChapterNumbers 双实现归一 bare-name 盲区／B007 targetDocId 死字段删 + health 死臂收／B009 fs 退避 ≥100ms 恰一次 warn 留痕／B010 isFmWritableValue 白名单闸（非标量 BAD_INPUT）／C002 events/store 五处 prepared 收编／C003 assemble 四处 prepared／C004 chat-history 早退补 truncated/total／C005 book-search existsSync 删（walkMd 空返天然覆盖，头注「全链 fs.promises」自此成立）／D002 saveProvidersLocked 写前盘上 revision 复验 → ProviderRevisionConflictError → 409（两个残余洞如实登记）／D003 ci.yml chromium 缓存键对齐 desktop.yml／D004 ci.yml e2e job 补 electron-builder --dir + asar 冒烟（mac 本地实证 EXIT=0：main 入口在 / prompts 在 / node_modules 零混入）／D005 check-counts walk lstat + symlink 跳过（改前后计数逐位一致；实测崩法为 ELOOP 非爆栈，注释按实测措辞）／E003 401 自愈空转截断（reboot 后仍 401 达 2 次提前进 R59 指引，token 真过期一次自愈不受影响）／E004 interrupted 如实反馈 toast／E005 chat_error 清 notice／E006 clear() 复位 running（Q-8 存量两用例按新契约改写）／F003 CmHost selectionChange 死契约删／F004 WordCurveChart 死 CSS 删／G009 31/29-spec 陈旧注释修 33（快照为机检真值）+ runner mtime 弱预言补字节级指纹。

**维持（4，报告自认）**：A008 vault 混淆级保护（本地单机定位下可接受，码内已声明威胁模型）／A009 claude effort 禁 thinking（待签名回传接通，码内已登记）／G005 批次号命名渐进（治理口径：随触达改名、不立专项批）／G008 e2e 单 workDir 顺序契约（设计取舍，快照+探针双守卫在位）。

**待拍板（2，落总览 §五）**：A006 瞬态失败回滚并遮蔽作者输入（改「保留 user 消息」动 P1-S4/R1a「防连续 user 400」既有拍板语义，属产品行为决策）／B004 结构操作入口强制校验 fm 章号 ≡ 文件名前缀（fail-loud 会拒存量失配书的结构操作，产品取舍）。

**缓办（6，理由在案）**：A005 book.yaml mtime 缓存（mtime 粒度与 RMW 正确性风险大于 µs 级收益；读侧高频成本量级本可接受）／B006 拆分两步间健康哨兵（healthCheck 新增探测面宜单立小批）／B008 结构 plan/apply 三重全书扫描（stat 缓存兜底量级可接受，planHash 复核语义依赖重算）／G004 真定时器有序截止链（时序测试改写有回归风险，注册在案负载敏感族本轮不触）／G006 空洞门粒度下沉每 it（门禁收紧或致存量红，需先全树扫描评估）／G007 provider-usage-pins-and-wire-guards（原 r38-batch-d）源码刮取锚行为化（测试改写单立）。

### 批内如实记档

- **连带四败自清**（L2 前发现，域内 L1 未覆盖的跨文件并合面）：pricing.test.ts ×3（D002 复验正确拦截测试 revision:0 陈旧基线——`withDiskRev` 助手取盘上实况）+ r29-doc-versions-migrate-warn ×1（B009 fs 留痕 warn 合法先发——断言改两条并按内容定位）。
- **批内自纠**：子代理调试残留探针两件（zz-probe3/4，chat-store 测试整份复制混入树且被 vitest 收集）收口前删除，删除后全量重跑取终数。
- **E002 连带核实**：isRunning 运行时消费者仅剩 /interrupt（anyRunning/stillRunning）——全腿口径系中断语义本意，保留未动。
- **范围外顺带观察转处置**：document 域 locateMergeByBody 与 finalizedChapterNumbers 两处同族残留（B002/B005 尾项）经主审裁定随批修复（证据链与判定过程见源码锚注）。
