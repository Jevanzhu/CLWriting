# 全量代码重评——进度与质量（合并线第十一篇）

- 日期：2026-09-12
- 执行模型：GLM-5.3（主审 = 会话模型；子代理 11 域同模型，无另列）
- 作者指令：「忽略现有的评审文档，重新评审一遍项目所有代码，最后告诉我项目完成进度，完成质量，结果形成一个文档给我。记得编排下任务。」
- 评审对象：mac 线 HEAD `06badf3d`（dev/mac←win 语义并合树）工作树净；版本 `1.0.0-rc.1`
- 规模：src ≈110,907 行（ts/vue 109,205 行〔注释 28,731 = 26.3%〕+ css 等，共 475 个 ts/vue 文件；剔除 web-next 嵌套 node_modules）；test ≈171,342 行（1,130 个 ts 文件；vitest 收集 1,084 个测试文件）
- 独立性声明：全部子代理与主审**未读 Dev/ 下任何既有评审文档**（作者指令「忽略现有的评审文档」逐字执行）；与历史轮次的对照仅在文档链登记时进行（§3.5）
- **结论速览：进度 ≈97% / 质量 A−（0 P1 / P2×5〔主审逐条对码实锤〕/ P3≈78）**；L2 终门九件套主审亲跑全绿（§二）；~~未收口~~ **已收口（2026-09-12 修复批，收口记 = §十，正本已归档 `Archive/`）**

---

## 一、评审方法与编排

- **三波 11 域子代理**（单波 ≤4 在途，遵守作者纪律条；本环境四路并发实跑无中止）：
  - 波 1：SRV 服务端（`src/studio/server` 12,793 行）/ FE 数据层（web-next api·stores·composables·shared ≈12.0k）/ FE 组件层（web-next components ≈21.0k）/ AI 链路（`src/ai` 13,771 行）
  - 波 2：文档域（`src/document`+`state`+`fs` ≈10.0k）/ 进程·事件·驱动·git·metrics（≈10.1k）/ 机检·格式化·评审（`src/check`+`format`+`review` ≈11.4k）/ 桌面壳·安装·导出·缓存（`src/desktop`+`install`+`export`+`cache` ≈9.1k）
  - 波 3：RAG·知识·learn·log（`src/rag`+`knowledge`+`learn`+`log`+`async.ts` ≈4.1k）/ 根配置·打包·CI·脚本（package.json、electron-builder.yml、两 workflow、scripts/×12、三 check 门）/ 测试面质量（test/ 结构化抽样评审：目录映射 + 反查零覆盖 + 脆弱性 grep + 断言强度抽样）
- 每个子代理纪律：域内源码逐文件全读（非抽样）、每条发现先追调用链/读测试再报、精确 file:line、不报 lint 已管项。
- 主审职责：① L2 终门九件套亲跑（§二）；② 对子代理上报的 **P2×7 逐条亲读源码复核**——实锤 5、改判 2（其中 1 条子判据被证伪，如实记档 §3.3）；③ 交叉面抽查（互斥矩阵、锁口径、asarUnpack 四位一体、打包产物）；④ 文档链收口。
- 各域完成度/评级由子代理独立给出，主审对评级依据抽样背书（§四/§五）。

## 二、L2 终门实测（主审亲跑，全部绿）

| 项 | 实测 |
|---|---|
| `tsc --noEmit` | 0 错 |
| `vue-tsc --noEmit`（web-next） | 0 错 |
| `eslint . --max-warnings 0` | 0 err / 0 warn |
| `build:web` | 过 |
| `check:counts` | 过——README 声称值与实测一致：1084 测试文件 / 6984 单测；29 e2e spec / 45 用例 |
| `check:packaging` | 过 |
| `check:knowledge` | 过——知识层 13 条 manifest 条目与磁盘一致，反向扫描无未登记资产 |
| `vitest run` 全量 | **1084 文件 = 6984 过 + 5 跳，0 败〔135.45s〕**（5 跳全部为 win32 平台门） |
| `playwright` e2e | **43 过 + 2 跳〔28.5s〕** |
| `soak`（--expose-gc） | 两段 OK：有界往返 10 万次增长 −0.02MB；RAG 召回 2 万次 +0.05MB（上界均 24MB） |
| `electron-builder --dir` | 出包成功（darwin arm64）；**`app.asar.unpacked/dist/desktop/fontlist` 在位且带执行位**——双线 asarUnpack 修复链在合并树上出包实锤复验 |

## 三、发现总账

### 3.1 P1：0 条

11 域均未发现现实可触发的核心流程破坏 / 用户数据丢失 / 安全漏洞。鉴权链（回环 + Host + Origin + token 时序比对 + 一次性票）、闸体系（进程内 + 跨进程锁 + 陈锁接管）、删书链（drain→复查→原子墓地→全缓存遗忘）、崩溃安全架构（journal + acknowledge 闭环 + move-pending 自愈）、事件库（SQLite 事务 + 损坏 fail-closed）、掩码（词首断言 + 双词表对账）等高危面逐域核验通过。

### 3.2 P2×5（主审逐条对码实锤，零虚报）

#### [P2-1]〔SRV〕rewrite 端点缺 chat 在途互斥面——全库互斥矩阵不对称
- 位置：`src/studio/server/api/rewrite.ts:87-98`
- 证据：本端点只查 `isSelfHealRunning`（:87，R66-2 补）+ `isSpawnRunning`（:93，R70-3 补）+ 'rewrite' 任务闸（:97）；同族 5 个长任务端点（analyze/outline/onboard-ai/relations.mine/lead-updates）均走含 `isChatRunning`+`hasBackgroundTasks` 的 `orchestrationBusyFor`（`task-gate.ts`）；反方向已封——chat.send/auto-write/chat.clear 均查 `allHeldTaskGatesFor`（'rewrite' 闸在持时对话被 409，`stream.ts` 四处），系统明确意图双向互斥，唯正向漏。修复史自证：R66-2/R70-3 两轮各补一面、chat 面至今未补；测试矩阵（`orchestrator-mutex-gates.test.ts`）无 rewrite×chat 角。
- 影响：纯文本对话在途时编辑器整章改写可并发起跑——分钟级双份 LLM 费用 + 以对话前正文为基线的过期提案（缓解项：chat 嵌套写章工具持同把闸、rewrite 产提案不落盘，故降 P2 不升 P1）。
- 建议：入口补 `orchestrationBusyFor(params['name']!)` 一查（与 lead-updates 同款三行）+ 矩阵测试补 rewrite×chat 角。

#### [P2-2]〔AI〕responses 伪流回填门把 reasoning delta 计入「已有产出」——混合形态网关正文静默丢失
- 位置：`src/ai/provider/responses-adapter.ts:319`（reasoning delta push 入 `outText`）、`:398`（回填门 `if (outText.length === 0)`）、`:419`（`hasOutput` 判据含 `outText.length > 0`）
- 证据：R35-18 伪流回填门与 R74-1 计费口径复用同一 `outText` 数组。网关形态为「reasoning delta 有流出、text delta 全缺、completed.output 带全文」时：回填被跳过（outText 非空）→ 正文永不 yield；`hasOutput` 又因 reasoning 非空判成功 → done 正常收尾。
- 影响：主产出文本静默丢失且不报错不重试（触发面窄：部分 delta 伪流网关，但失败模式为静默丢产出，违背 R35-18 修复本意）。
- 建议：回填门与判空改独立 `textYielded` 布尔（仅 `response.output_text.delta` 置位）；`outText` 保持计费口径；补「reasoning 有 delta + text 仅在 completed」适配器测试钉。

#### [P2-3]〔DOC〕布线锁键缺 NFC 归一：同一布线文件可派生两个锁文件，互斥静默失效
- 位置：`src/document/service.ts:832-846`（`wiringFileLockKey`）、`src/document/lead-finalize.ts:121-123`（`wiringFileLockKeyOf`）、根因 `src/fs/safe-path.ts:159-162`（`platformCaseFold` 只做大小写折叠）
- 证据：「判同」与「互斥」口径分裂——文档身份键 `docJoinKey`（safe-path.ts:180-182，R41-2）叠加 `toNfcName`（明言防「mac APFS 惯存分解形」），NFC/NFD 两拼写判同一文档；但锁键派生两侧均不过 `toNfcName`。保存侧输入清单登记路径（NFC 为主）、终稿侧输入磁盘扫描字节（macOS 外源工具常为 NFD）→ 两侧生成不同 `.lock` 文件名，registered 检查照常通过不 fail-loud。
- 影响：「作者保存伏笔线文件」与「终稿写回同文件」（锁内重读-合并-写回）在「mac + 清单/盘上归一形态不一致 + 两操作并发」时丢失更新窗口静默重开，后写者覆盖先写者，且完全无痕（终稿侧无快照兜底）。
- 建议：两处派生点在 `platformCaseFold` 前统一叠 `toNfcName`（与 docJoinKey 同口径；NFC 多数派键字节不变，与 R45-2 字节稳定不变量相容）；同查 `files.ts` PUT 侧布线锁派生是否同缺口；补「NFC 清单路径保存 × NFD 盘上路径终稿写回」互斥用例。

#### [P2-4]〔PROC〕文风收割异步链残留同步整读 + O(P²) 同步 CPU：大书冷缓存冻结事件循环
- 位置：`src/process/style-harvest.ts:185`（逐 tracked doc `readFileSync` 整读章正文）、`:192-199`（`collectDocSignalsAsync` 内 `compareVersions` O(P²) 段对矩阵同步计算，`format/style-compare.ts` 纯 CPU 无让出）
- 证据：R44-13 已把该链最后一处同步 `spawnSync` 换 `gitAsync`（注释自证「HTTP 链不再同步 spawnSync」纪律），但正文读取仍是裸 `readFileSync`（不走 `readMdTextCachedAsync`）且无指纹缓存；生产调用链唯一 = `server/api/style.ts` harvest 端点（HTTP 事件循环）。200 万字书、数十 tracked doc、缓存全冷时可同步占用事件循环数百 ms 至秒级，SSE 心跳与保存同期停摆——与 R37-5/R40-4 自设纪律同族残留。
- 建议：正文读改 `readMdTextCachedAsync`（book-search.ts 先例）；`compareVersions` 循环按 doc 让出（scanChaptersAsync 每 25 章 yield 同款范式）。

#### [P2-5]〔F〕knowledge manifest 字段类型守卫缺口：非字符串 `target`/`sha256` 使对账门与登记链尾部裸 TypeError 崩
- 位置：`src/knowledge/manifest.ts:123`（`isAbsolute(entry.target)` 对非字符串抛 TypeError）、`:135`（`entry.sha256?.startsWith` 对非字符串抛 TypeError）
- 证据（子代理 tsx 对真实代码 repro 确认，主审对码认可）：条目守卫 `:103` 只拦 null/非对象，字段级类型零校验。`entries:[{"target":123}]` → `check:knowledge` 门裸栈崩而非列 issue；`sha256` 数字形态 → `commitKnowledgeFile` 尾部对账在**登记已落盘后**崩——CLI 报栈但 manifest 实际已写入，作者状态认知错位。同族前作 R40-16（null 条目）/ R73-4（entries 非数组）/ R0912-G1-P2-1（manifest 字面 null）均按「坏形状报 issue 不崩」收口，本条是同序列漏网。
- 影响：fail-loud 不丢数据，故 P2 非 P1；但门禁崩溃形态（裸栈 vs 结构化 issue）与已收口族口径相悖。
- 建议：`validateEntry` 入口对 `typeof entry.target !== 'string'` / `typeof entry.sha256 !== 'string'` 报 issue + continue；补同族用例（含 corpus 数组 null 项——P3-F① 同批）。

### 3.3 主审改判记档（2 条，子代理报 P2 → 复核改 P3）

1. **测试 sleep 竞态窗**：子代理引 `r1010b-srv-documents-bookmoved.test.ts:236-240` 轮询循环「超时后未对 `seen` 断言即继续，存在假绿缝」——主审复核 **:241 即有 `expect(seen).toBe(true)`，该假绿示例不成立（证伪）**。系统性事实成立：全 test/ 真实 `await sleep(` 84 处（含 `await new Promise` 的文件 234 个），窗口失守方向以**假红**（慢环境闪红）为主。按统一分级（测试脆弱性 ≠ 缺陷）改判 **P3**，登记 G 域。
2. **soak 面窄于「200 万字不崩」卖点**：soak.ts 仅钉两条热路径（piece-list 往返 10 万次 / RAG 召回 2 万次），文档清单 jsonl 重写放大、事件库长会话增长、service 索引累积无内存断言——属测试缺口非缺陷，改判 **P3**，登记 G 域（补 soak 段建议随批）。

### 3.4 P3≈78（子代理上报，主审抽查背书；处置建议 §七）

| 域 | 数 | 代表项（明细 file:line 见各子代理报告原文，本表为登记索引） |
|---|---|---|
| SRV 服务端 | 8 | onboard-save 占闸晚于 readJson（onboard.ts:196→209，全库「先闸」纪律唯一漂移）/ API 面 404 vs 静态面 405 语义不一致 / settings GET MISS 全同步扫描（唯一无 async 孪生书键端点）/ tree-issues `warnings[]` 透出但前端零消费 / check-false-positive 语料回路只写不读 / defineRoute parse 采用率 3/110 / draft-save 互斥面只查 self-heal（自记 P3 维持）/ review-verdict 背靠背双 readAnalysis |
| FE 数据层 | 3 | crashedPendingOpIds 注释过期（stream.ts:22-26 声称「服务端尚未透出」，实际 state.ts 已透出且已消费——错误现状记录）/ chat 历史 200 条截断 `truncated/total` 声明零消费（静默截断无提示，api/chat.ts:52-65）/ BOOK_MOVED(409) 无前端专属处理（多窗改名场景错误文案失真，doc.ts:447-456） |
| FE 组件层 | 4 | ChapterMetaDialog 缺 `role="dialog"`/aria-modal（全库 8 模态唯一漏）/ 同组件中文 prop 名 `标题`（全库 96 件唯一例外）/ `.panel` 样式块总览族四处逐字重复（R0912 收敛批未覆盖 OverviewView/RhythmDistPanel/WordCurveChart/ShortProfileGaps）/ 三纯展示抽取件无 mount 直测 |
| AI 链路 | 6 | CHAT_TOOL_NAMES 双份（有意保留登记）/ pricing `'providers.json'` 字面量镜像 / trace-stats durations O(calls) 物化 / calls.ts 同步 IO 冻结权衡（已文档化）/ catalog.gen.ts 123 行零运行时消费（A7 资产）/ chat histories LRU 在途驱逐缺口（Low-5 在案） |
| 文档域 | 7 | 章纲清单 relink 精确匹配未用 docJoinKey（service.ts:1228）/ clearBatchPause 裸 rmSync ×2 / restoreTrash originalPath 无内部区校验（纵深缺口）/ updateDocMetaLocked 过度失效（全量 invalidateTreeIndex）/ 死代码小项 ~60-100 行（generateFolderId、searchForeshadowTrails 等）/ journal pending 快照 256KB 截断（PM-3 在案）/ analysis 锁超时降级裸写（B-15 在案） |
| 进程·事件·驱动·git·metrics | 10 | recordAiVersion(Async) 失败完全静默（git 持续故障下文风收割静默空转零线索——「丢事件必留痕」纪律局部不自洽）/ 同步 git() 超时只 TERM 无 KILL 升级 / validateEventStream 遮蔽校验与真实产流口径劈裂（只能跑人工夹具）/ TOKEN_COEFFICIENTS 空表待校准（R26-106 在案）/ sync-async 孪生双轨 ~500 行（searchBook 同步三件套零生产调用）/ saveDraft 旧文双读 / mock·cc 广播总线 ~180 行逐行重复（R62-40 在案）/ test-only 导出四件 / prepare·summary 找章深度口径不一 / gitAsync kill 窗内僵尸持锁（有界 fail-closed） |
| 机检·格式化·评审 | 7 | checkNewNames 守卫族 ~170 行逐字移植（对拍语料自认三项排除面）/ ReviewTierDecision `ledger_check:'已跑'` 恒写死字段 / leads.ts:326 UTF-16 截断作 grep 锚（增补平面字落边界时伪 lead-evidence-miss 红——功能性，窄触发）/ style-entry 手写 `.md` 后缀检查与单源不符 / tree-issues-cache readdir 失败与空目录不可区分 / isSectionHead 兜底逐次 new RegExp / writePieceList 零接线（R48-51 在案） |
| 桌面壳·安装·导出·缓存 | 8 | bootstrap recent 失效过滤只改内存不落盘 / worker 化 rebuild 章读缓存每作业冷启动（性能项）/ 冷启动竞窗：menu-action 推送无渲染层就绪握手（单次点击丢失可重点）/ linux font-list load 超时不 kill（R48-17 在案，头注备案）/ recent-filter await 窗内 recent 整覆（R0912-A-P3-5 姊妹位）/ 退出窗内可再开子窗（无守卫）/ loadLeadFromCache 生产零调用（测试资产自注）/ 注释考古体量（域内 ~1.3k 行） |
| RAG·知识·learn·log | 12 | knowledge corpus 数组 null 项崩整轮汇总（update.ts:91,98，repro 确认）/ learn `defaultCommitYield` 与 async.ts 同体重复（「五处收敛」漏网）/ 样章块长 UTF-16 口径（同文件金句已改码点——双口径并存）/ 单坏 fm 封死全书收割（与 RAG 坏章跳过口径不一致）/ 样章切分不匹配 CRLF（外部编辑章候选静默全灭）/ 背带掩码缺口（`api-key:`/Basic 头形——纵深非现实面）/ rag 注释失实一处 / readAllChunks 零调用且毒行逻辑双份 / recall() test-only 包装（在案）/ SENTENCE_ENDERS 不含弯引号 / 召回 warn 等值边界文案 / stdoutOnly 分支注释与实际不符 |
| 根配置·打包·CI·脚本 | 6 | electron-smoke 打包态通道（CLW_SMOKE_APP_BIN）建成未接线——desktop.yml 冒烟仍「25s 存活被杀」形态，窗口循环链未进 tag 门【主审判：值得单立，与 G 域 soak 面同批】/ README「26 LTS」与 ci.yml「26=Current」口径漂移 / calibrate-tokens 无 npm 别名 / check-packaging 行扫描对内联数组形态报错文案误导（fail-closed 安全）/ desktop.yml mac 腿 playwright 无缓存 / electron-smoke 冗余 statSync |
| 测试面 | 7（含改判 2） | sleep 竞态窗 84 处系统性脆弱面（假红为主；假绿示例证伪）/ soak 面窄（见 §3.3）/ 前后端契约双侧各自钉无共享单源（兜底 e2e）/ main.test.ts 2661 行巨型文件 / ~118 个 server-boot 测试手写启动样板（缺 withStudioServer 组合 helper，~2.5-3.5k 行）/ 零直测 src 模块 7 个（均间接覆盖）/ 批次号命名碎片化 |

### 3.5 交叉收敛观察

- 本批 5 条 P2 **均为新发现**，与台账 §三 既有登记零重复（互斥矩阵既有「stream 互斥矩阵（备案权衡）」行为 chat↔spawn 族备案，rewrite×chat 正向角不在其列）。
- TOOL 域子代理独立复核 asarUnpack 链「配置 ↔ 门禁 ↔ 运行时改写 ↔ 实包产物」四位一体通过 + 主审 `electron-builder --dir` 出包实锤——双线合并后的修复链在实包上复验成立。
- SRV 域自查确认 0911c 中断语义族四条修复全在位（七端点 register-ctrl + /interrupt 如实附 interrupted + watchdog driver.interrupt + 强释放留册至 settle）；FE 数据层确认 openTab 切档链与 RAG rebuild 三形态接线在位——前轮修复链合并后无回退。

## 四、进度评估：≈97%

| 域 | 完成度 | 依据 |
|---|---|---|
| SRV 服务端 | ~98% | 110 条路由全注册可达；零 TODO/FIXME；三项自记债务（parse 迁移 3/110、语料回路查询侧、warnings 前端消费） |
| FE 数据层 | ~98% | 契约抽样 12 端点族零错配；无未接线 store/composable；crashed-pending/rag-rebuild/openTab 链全闭环 |
| FE 组件层 | ~98% | 96 件零死组件（逐一反查引用）；0 TODO；共享抽取件迁移等价 |
| AI 链路 | ~97% | 功能闭环完整（多协议→重试→记账→编排→mock 隔离）；1 窄边界 P2 |
| 文档域·state·fs | ~97% | 三条红线（章不丢/版本不误删/回收站不断链）无现实触发；1 归一化交点 P2 |
| 进程·事件·驱动·git·metrics | ~95% | 全域 0 TODO；TOKEN_COEFFICIENTS 待校准在案；1 事件循环阻塞 P2 |
| 机检·格式化·评审 | ~95% | 规则引擎完备；两处「已写未接线」R48-51 备案；0 P2 |
| 桌面壳·安装·导出·缓存 | ~97% | 0 TODO；linux 字体残留头注备案 |
| RAG·知识·learn·log | ~95% | 生产接线完整（端点/召回/收割/CI 门/CLI）；1 守卫 P2 + 双源漂移尾巴若干 |
| 根配置·打包·CI·脚本 | ~97% | 三 check 门真实机对账；CI 五腿完备；打包态冒烟接线单立 |
| 测试面 | 基建 A | 1084 文件 6984 用例全绿；治理门密度同类最高档 |

**总体 ≈97%**。功能面：产品功能全部实装且接线（无死代码路径 / 无半成品分支 / 实质 TODO=0——全仓唯一 grep 命中为误报汇总草稿模板占位行 `knowledge/update.ts:123`）。收口面：P2×5 + 台账既有挂账（含阶段 24 章节结构操作已拍板待实施指令、darwin DMG 打包态实测单立、deepseek 游离件两篇待作者定夺）。版本 `1.0.0-rc.1`——距 RC 转正 = 本批 P2 修复批 + 上述挂账拍板。

## 五、质量评估：A−（0 P1 / P2×5 / P3≈78）

| 域 | 评级 | 一句话依据 |
|---|---|---|
| SRV 服务端 | A− | 五层鉴权 + 双层闸 + 删书 TOCTOU 毫秒级关窗 + 脱敏单出口；扣分 = 互斥矩阵留一反向缺口 + 四处口径漂移/半闭环 |
| FE 数据层 | A− | 代守卫贯穿全异步链 + 保存协议完整闭环 + SSE 三层自愈；扣分 = 1 条错误现状注释 + 死契约字段 + 复杂度高度集中 |
| FE 组件层 | A− | 竞态守卫/渲染上限/IME/焦点圈体系化；扣分 = a11y 一致性缺口 + `.panel` 收敛残留 |
| AI 链路 | A− | 铁律①②闭合完整 + 反向依赖为零 + 经典 bug 类系统性清偿；扣分 = 1 条静默丢产出窄边界 |
| 文档域·state·fs | A− | 崩溃安全架构罕见完整（journal+ack+自愈+原子墓地）；扣分 = 归一化纪律未贯穿键派生层 |
| 进程·事件·驱动·git·metrics | A− | 边界处理密度最高档 + 事件库 ~70 轮加固；扣分 = 收割链事件循环冻结残留 + ~500 行双轨维护面 |
| 机检·格式化·评审 | A− | 七个 P2 级猎场逐一排除 + 500 章规模门；扣分 = 结构性毛边（移植副本/死字段/码点截断窄触发） |
| 桌面壳·安装·导出·缓存 | A− | 高危形态全有防线且带回归锚；扣分 = 注释考古体量 + main.ts 2,240 行单文件 |
| RAG·知识·learn·log | A− | 损坏窄识别/事务回滚/ephemeron 断环全双钉；扣分 = 守卫序列漏字段类型一环 + 双源漂移尾巴 |
| 根配置·打包·CI·脚本 | A− | 全仓纪律性最高域（声称值全被门锚定）；扣分 = 打包态冒烟零消费 + 两处文案漂移 |
| 测试面 | A | 治理门密度 + 断言密度 3.1/用例 + truthy 仅 1.7% + 零 only/无条件 skip；未到 A+ = sleep 脆弱面 + soak 落差 |

**总体 A−**。测试:源码 ≈1.54:1；每个历史缺陷修复带轮次锚注释与命名回归测试，可追溯性为同类罕见水准。扣住 A 的共性：五条 P2 中四条（互斥角/回填门/锁键归一/字段守卫）均落在**各域自建纪律的边界外一寸**处——纪律本身执行极好，但「同族收口」的最后一环（矩阵最后一个角、计费与回填共用数组的口径分家、身份键与锁键的归一口径、守卫序列的最后一层）系统性偏弱，是下一批修复与防回归测试的主攻方向。

## 六、精简总账

| 侧 | 估算 | 构成 |
|---|---|---|
| 产品侧（src） | **≈3.6–4.4k 行（≈3–4%）** | SRV handler 三元组样板/TTL 缓存壳泛型 ≈0.6–0.8k / 进程域同步孪生 + mock·cc 总线 + test-only 导出 ≈0.5k / 机检守卫族抽共享 ≈0.17k / RAG 毒行逻辑收敛 + recall 包装 ≈0.07k / 文档域死码 ≈0.1k / 桌面域 font fallback 合并等 ≈0.03k / AI 域 calls.ts 死入口等 ≈0.15–0.25k / 注释考古冻结（desktop ~1.0k + export/cache/install ~0.33k + AI 1.5–2k 理论值）——**应按项目冻结纪律移 Archive 冻结件而非删**，上表已单列 |
| 测试侧（test） | **≈3.0–4.5k 行（≈2–3%）** | withStudioServer 组合 helper 收编 ~118 文件启动样板 ≈2.5–3.5k（最大头）/ r-批次小文件按域归并 ≈0.5–1.0k / main.test.ts 拆分（0 行，纯可维护性） |

依赖面零闲置（TOOL 域核证）；前轮专项精简批（−881 行）后产品侧存量空间已收敛至上述结构项，不建议为减行而减行。

## 七、处置建议（供修复批编排参考）

- **P2×5 修复批**（可四路文件互斥并发 + 主审集成，全程在途 ≤4）：SRV（P2-1 三行 + 矩阵测试）/ AI（P2-2 textYielded 分家 + 适配器钉）/ DOC（P2-3 toNfcName 叠加 + files.ts 同源排查 + 互斥用例）/ PROC（P2-4 缓存读 + 分段让出）/ F（P2-5 validateEntry 字段守卫 + corpus null 项同批）。
- **P3 择收建议**（随修复批顺手，高价值项）：stream.ts:22-26 过期注释改写（违反「已记录」纪律的注释，5 分钟）/ chat truncated 提示接线或删死字段 / learn 样章 CRLF + 码点口径（数据丢失面：候选静默全灭）/ leads.ts:326 码点截断（伪红面）/ ChapterMetaDialog a11y 两件 / `.panel` 总览族接入 style-shared。
- **单立建议**：desktop.yml 冒烟接线 `CLW_SMOKE_APP_BIN` + soak 补 document/events 两段（打包态窗口循环链 + 「200 万字不崩」卖点面）/ checkNewNames 守卫族抽共享模块。
- **维持登记**：各域自记债务（见 §3.4 表内「在案」项）照旧。

## 八、与前轮关系

本批为作者指令下的独立重评（第十一篇，合并线首篇全量重评），评审方法与前轮（重评-0911b/0911c/0912）同构但结论独立得出：5 条 P2 全为新发现、3 条前轮修复链（中断语义族/openTab/rag-rebuild/asarUnpack）独立复验在位。篇号沿用全量重评系列顺延（合并线起引用以篇名 + 日期为准——沿用双线篇号歧义注口径）。

## 九、收口条件与状态

- ~~状态：在库未收口~~ → **已收口（2026-09-12 修复批）**：P2×5 全修 + P3 择收七件随批 + L2 终门九件套复跑全绿，收口记 = §十；报告正本随批归档 `Archive/`。

## 十、收口记（2026-09-12 修复批）

- 作者指令：「全部修复，编排任务做。」——**P2×5 全修 + P3 择收七件随批**，编排 = 波 1 四路文件互斥修复代理（SRV / AI / DOC / PROC）→ 波 2 四路（KNOW / CHECK / LEARN / FE），全程在途 ≤4，主审逐 diff 复核全量 + L2 终门九件套亲跑。
- **P2×5 修复明细**：
  - **P2-1**（SRV）：`rewrite.ts` 入口补 `orchestrationBusyFor` 检查（lead-updates 同款，409 BUSY 透传家族文案），注释锚重评-0912-2 P2-1；矩阵测试补 rewrite×chat 角（`orchestrator-mutex-gates.test.ts`，锚 r0912-2）。
  - **P2-2**（AI）：`responses-adapter.ts` 引入独立 `textYielded` 布尔（仅 text delta 实际 yield 置位）——回填门改 `!textYielded`、hasOutput 正文面判据同步改，`outText` 保持 R74-1 计费口径；reasoning-only 流回归空产出报错。+2 用例（混合形态恰回填一次 / reasoning-only 报错），既有 R35-18/R26-4 用例零回归。
  - **P2-3**（DOC）：`wiringFileLockKey`（service.ts）/ `wiringFileLockKeyOf`（lead-finalize.ts）折叠前补 `toNfcName`（与 docJoinKey 同序，NFC 输入键字节不变、R45-2 不变量相容）；**同源排查抓出第三处同型缺口同批修齐**——`files.ts` `wiringLockKeyForPut`（PUT 直写链）；新增 `r0912-2-wiring-lock-nfc.test.ts` 6 用例（三侧 NFC/NFD 同键字节钉定 + 真实跨进程锁行为级互斥 + R45-2 防回归 + 静态序扫描）。
  - **P2-4**（PROC）：`style-harvest.ts` 异步链裸 `readFileSync` → `readMdTextCachedAsync`（缓存面 = 原始文本逐位等价，读失败 null 映射既有 continue 口径）+ 循环按 doc `yieldToEventLoop`（async.ts 单源）；同步孪生不动（测试资产）。+2 用例（缓存命中证明 + 改道输出口径逐位一致），同步/异步等价对照 9 文件 65 用例全绿。
  - **P2-5**（F）：`manifest.ts` `validateEntry` 入口补 target/sha256 字段类型守卫（报 issue 不崩，对齐 ：103 降级口径）；**随批 P3**：`update.ts` corpus 数组 null/非对象项剔除 + warn 留痕不崩整轮。+4 用例（两类字段崩点 / commit 链落盘不抛 / corpus 坏项）。
- **P3 择收七件随批**：FE 四件（stream.ts 过期现状注释修账 / chat 历史 truncated 提示接线〔store 透出 historyTruncated/historyTotal + ChatMessages 顶部条件提示行，+6 用例〕/ ChapterMetaDialog 补 role="dialog"+aria-modal+aria-label 与 prop「标题」→title〔调用方 ChapterTreePanel 同步，+2 用例，既有 3 测试文件同步改前口径〕/ `.panel` 总览族四处重复块删除走 style-shared 全局）+ CHECK 一件（leads.ts:326 前缀截断改码点，+1 用例钉增补平面字边界）+ LEARN 三件归两用例（样章切分 `(?:\r?\n){2,}` 认 CRLF / 块长过滤改码点并与金句 R0912-7 口径收敛 `codePointLength` 文件内单源 / `defaultCommitYield` 收敛 `yieldToEventLoop` 单源）。其余 P3 维持登记（台账 §三 各域行）。
- **L2 终门九件套复跑全绿（主审亲跑）**：vitest **1088 文件 = 7010 过 + 5 跳 0 败**〔130.87s；净增 4 文件/26 用例全 r0912-2- 锚，无新增平台门〕+ tsc/vue-tsc 0 错 + eslint 0/0 + 三 check 过（counts 修账 1084/6984 → 1088/7010 后绿，win 按差值 75 锚预期 1088 文件 / 6935 过 + 80 跳待 CI 实跑；packaging；knowledge 13 条）+ build:web 过 + e2e 43 过 2 跳〔27.7s〕+ soak 两段 OK。
- 文档链收口：本报告补 §十 后归档 `Archive/`；主 README 修账四处 + win 口径句；Dev/Docs README 计数 01-评审 2→1 / Archive 19→20；总览 §1.3 行收口；台账 §一 行移出冻结（`Archive/台账历史明细-归档-2026-09-08.md` §八）+ §三 B/D/E/F P2 行处置态回填【已处置·R0912-2】。改动面：src 15 文件（+192/−71 约）+ test 改 10 + 新增 4；单立项维持（desktop.yml 冒烟接线 + soak 补两段 / checkNewNames 守卫族抽共享——台账 §三 G/AEC）。零提交（工作树留作者）。
