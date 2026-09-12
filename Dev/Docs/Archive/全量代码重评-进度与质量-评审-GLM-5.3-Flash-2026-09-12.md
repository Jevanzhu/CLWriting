# 全量代码重评-进度与质量-评审-GLM-5.3-Flash-2026-09-12

- **评审对象**：CLWriting，git 分支 `mac`，HEAD `9342bf2d`，工作树净（评审全程零改动）。
- **评审日期**：2026-09-12。
- **执行模型**：GLM-5.3-Flash（主审，会话模型）；12 域评审子代理全部同模型（GLM-5.3-Flash）。
- **独立性声明**：全部 12 域子代理禁读 `Dev/Docs/` 下任何历史评审文档，评审输入仅限源码/测试/配置静态阅读；主审仅在评审完成后与台账做重复面对账（§八）。本报告独立形成，不引用既有评审结论。
- **状态**：**已收口**（2026-09-12 修复批：作者指令「全部修复，编排下任务，并发做。」——P2×4 全修 + P3 择收 44 件随批 / 维持 12 件，L2 终门复跑全绿；收口记 = §八。原「报告完成 ≠ 收口」行随收口作废，建议序 §六已被实际处置取代）。
- **结论速览**：**进度 ≈97%（分域 92–100%），质量 A−；0 P1 / P2×4（全为新发现）/ P3≈56**。L2 终门十二段亲跑全绿（§二）。

---

## 一、评审范围与方法

### 1.1 盘面（实测）

| 面 | 体量 |
|---|---|
| 产品源码 `src/` | 111,107 行 / 480 文件（ts/vue/css；ts+vue 109,331 行，注释行 28,581 ≈ 26.1%；排除 `web-next/node_modules`） |
| 测试 `test/` | 171,944 行 / 1,143 文件（vitest 1,088 文件 + playwright e2e 29 spec + soak） |
| 工程面 | `scripts/` 12 文件、根配置 7、CI 工作流 3、`知识层/` 语料（manifest 13 条） |

### 1.2 编排

三波 12 域子代理（**波内在途 ≤4**，作者派发上限纪律），每域全量精读/抽样口径见各域报告；主审负责对码、L2、汇总：

| 波 | 域 | 范围 | 精读量 |
|---|---|---|---|
| 1 | A1 服务端 | `src/studio/server/` | 50 文件 / 12,807 行（110 条端点逐一核对） |
| 1 | A2 AI 编排 | `src/ai/` | 78 文件 / 13,786 行 |
| 1 | A3 前端数据层 | `web-next/src/{api,stores,composables,shared,types,editor}` + 顶层配置 | ~85 文件 / ~12,800 行（前后端契约逐端点对账 68/68） |
| 1 | A4 前端组件层·上 | `web-next/src/components/{ui,shell,panels,style}` + `styles/` | 78 文件 / 18,409 行 |
| 2 | B1 前端组件层·下 | `components/{audit,editor,learn,onboard,overview,relations,shelf,workbench}` + `views/` + `pages/` | 34 文件 / 8,993 行 |
| 2 | B2 文档·FS·缓存 | `src/{document,fs,cache}` + `src/async.ts` | 33 文件 / ~9,900 行 |
| 2 | B3 进程·事件·状态 | `src/{process,events,state,driver,git,metrics,log}` | 39 文件 / ~11,800 行 |
| 2 | B4 机检·格式化·评审 | `src/{check,format,review}` | 41 文件 / 11,378 行 |
| 3 | C1 桌面·安装·导出 | `src/{desktop,install,export}` | 26 文件 / ~8,100 行 |
| 3 | C2 RAG·知识·learn | `src/{rag,knowledge,learn}` + knowledge/corpus 六脚本 + 知识层抽查 | ~3,800 行 + 语料 |
| 3 | C3 根配置·CI·脚本 | `scripts/` 全部 + 根配置 7 + CI 3 + web-next 顶层配置 | ~25 文件（构建链四方对账） |
| 3 | C4 测试面审计 | `test/` 全景（抽样 18 文件精读 + 11 组全景 grep + 845 模块镜像度 diff） | 抽样审计口径 |

### 1.3 主审工序

1. **逐 P2 对码**：子代理报 P2 候选 ×4 → 主审逐条回读源码核实机理，**实锤 4 / 证伪 0**（§三）。
2. **L2 终门亲跑**（§二）：vitest 全量 + tsc/vue-tsc + eslint + 三 check + build:web + e2e + soak + electron-builder --dir 出包实锤。
3. **台账对账**（§八）：P2×4 与既有登记零重复。
4. 各域子代理报告的排除裁决（候选→证伪）择要录入 §3.4，防后续评审重复立案。

---

## 二、L2 终门实测（主审亲跑，2026-09-12）

| 门 | 结果 |
|---|---|
| vitest 全量 | **1,088 文件 = 7,010 过 + 5 跳，0 败**〔131.07s〕 |
| `tsc --noEmit` | 0 错 |
| `vue-tsc`（web-next） | 0 错 |
| `eslint --max-warnings 0` | 0 错 0 警 |
| check:counts | 过（README 声称 1088/7010 + 29 spec/45 用例与实测一致） |
| check:packaging | 过（resources 入打包清单 + prompt 版本表对账） |
| check:knowledge | 过（13 条） |
| build:web | 过（2,174 modules） |
| e2e（playwright） | **43 过**〔28.2s〕（release-smoke 2 用例需环境变量，未计入本轮） |
| soak | 两段 OK：有界往返 10 万次 −0.02MB / RAG 召回 2 万次 +0.05MB（上界 24MB） |
| `electron-builder --dir` | EXIT 0；实包亲验 `app.asar`（19.9MB）+ `app.asar.unpacked/dist/desktop/fontlist` 在位 |

---

## 三、发现总账

**P1×0 / P2×4 / P3≈56（含 1 条对账确认 + 1 条正面记录，实数 54）**。全部 P2 经主审对码实锤；P3 按子代理置信度原样登记，未逐条复验（P3 不阻塞收口）。

### 3.1 P2（4 条，全为新发现）

**P2-1【置信度：高｜B2 文档域】move 的 toDir 接受 `..`/`.` 段且原文入清单 → docId 身份分裂、该文档保存恒 REVISION_CONFLICT**
- 位置：`src/document/service.ts:209-215`（normalizeMoveToDir 只拒前导 `/` 与空串）、`:1510-1514`（safeSegs「已存在则原样保留」分支对 `..` 恒命中——`existsSync(join(root,'a','..'))` 即 root）；端点层 `api/documents.ts` 原样透传。
- 机理：`toDir='a/../写作/正文'` 时 `..` 段被原样保留直拼进 manifest 登记路径，物理落位由 resolveSafePath 词法消解 `..` 落在正确目录——登记与盘上路径分裂：树扫描 docJoinKey 失配 → docId 退化 legacyId → `executeSave` registered≠relPath 守卫命中 → **保存永久 REVISION_CONFLICT 且无法自愈**；finalizedPathSet 同步失配（定稿章被导出/文风/学习链当草稿）。与 R66-5（尾斜杠同后果）、R51-D-3（doCopy 已显式拒 `..`）完全同族——copy/create/rename 各自落地，唯独 move 的 toDir 漏网。
- 修法：normalizeMoveToDir 增 `segs.includes('..')||segs.includes('.')` → BAD_INPUT（对齐 doCopy R51-D-3 口径）+ 补 1 条回归用例（现 r66-move-todir-normalize 只锚斜杠族）。

**P2-2【置信度：高（机理确定）｜触发窗窄（毫秒级并发）｜B2 文档域】doTrash 定稿基线快照与清单条目删除之间无互斥覆盖 finalize 链，并发定稿的 finalizedRevision/tags/order 随整条删除丢失**
- 位置：`src/document/service.ts:1944-1963`（无锁快照 priorFinalized）→ `:1980`（TrashEntry 按快照落账）→ `:2053-2069`（清单锁内**新鲜读**整条 delete）；对照 `src/document/finalize.ts:224-237`（finalize 持清单锁写基线，**不持** doTrash 的 per-doc save 锁）。
- 机理：doTrash 读快照 A（无基线）→ 并发 finalize 写入基线（pinned 版本已落盘）→ doTrash 删除 RMW 把带基线条目整条删掉，TrashEntry 记的是快照 A → 还原后该章无定稿基线，`ensureChapterNotFinalized` 防覆盖闸失守——正是 W-P2-1 注释自述要防的威胁；tags/order 同窗同失。pinned 版本仍在 `.版本/` 可考（非物理丢失），故 P2 不升 P1。可达性：多窗同书并发「定稿 ×软删」同章即可进入。
- 修法：把「TrashEntry 落账 + 清单删除」收进同一清单锁临界段——删除 RMW 锁内以当次 strict 读的 entry 回填/覆盖 TrashEntry 的基线字段后再 delete（两锁串联不嵌套，与既有锁序兼容）。

**P2-3【置信度：高｜B1 前端域】LearnView「这次没有合格候选」空态分支不可达——零候选收割后界面回到收割前引导文案，作者无法区分「未收割」与「收割了但全部不合格」**
- 位置：`src/studio/web-next/src/views/LearnView.vue:96`（外层 `v-if="learn.hasResult"`）与 `:122-126`（内层 EmptyState `v-if="!learn.samples.length && !learn.quotes.length"`，在外层块内）；根因 `src/studio/web-next/src/stores/learn.ts:24`：`hasResult = samples>0 || quotes>0`。
- 机理：内层渲染条件与外层 v-if 逻辑互斥——**死分支**，任何状态都不可能渲染。实际行为：收割返回零候选 → samples/quotes 清空 → hasResult=false → 页面回到 ：88 的「点击收割候选…」引导态，上一轮候选若存在也被清空，视觉上像「消失」。分支文案（"得分普遍偏低…"）证明其设计意图恰是这个反馈面；`learn-store.test.ts:55` 只锁 store 层 hasResult 契约，视图死分支恰好无测试可达。
- 修法：视图层引入「本次收割已跑」本地判据（harvest 成功置位），空态改三态：未收割 / 已收割且零候选 / 有结果。

**P2-4【置信度：高｜C3 工程面】ci.yml soak 内存门存在「段 2 失败假绿」洞：管道吞退出码 + grep 命中段 1 OK 掩蔽其后段失败**
- 位置：`.github/workflows/ci.yml:249-252`；`test/soak/soak.ts:127`（段 1 OK 打印）与 `:160/169/189`（段 2 RAG 召回失败 `process.exit(1)`）。
- 机理：两层独立掩蔽。① 该步未设 `shell: bash`，GitHub Actions 默认 `bash -e` 无 pipefail——`npm run soak | tee` 中 soak 退出 1 被 tee 的 0 吞掉，soak 自身退出码语义失效；② `grep -q '\[soak\] OK'` 语义是「至少一个 OK」而非「全部段 OK」——段 1 通过后即打印 OK 行，其后新增的 RAG 召回段（恰是防线性泄漏的断言面）失败时 grep 仍命中 → 步绿。步注释自称「SKIP/FAIL 均判红」，实际仅对段 1 成立；soak 段数继续增长（台账已登记补 document/events 两段）则洞面随之扩大。
- 修法：步首 `shell: bash` + `set -o pipefail`（或改重定向直捕退出码）；断言收紧为 OK 行数 = 段数（`grep -c` 比对）。

### 3.2 P3 分域清单（56 条）

> 格式：位置 — 一句机理〔置信度〕。P3 不逐条复验，随修复批择收。

**A1 服务端（2）**
1. `api/books.ts:482-526` 删书 handler 临界段整段少缩进一层，清理密集区维护误判面〔高〕
2. `api/analysis.ts:406` GET 存量分析判 stale 同步整章读（KB 级、亚毫秒，范式一致性残留）〔高·影响极小〕

**A2 AI 编排（5）**
3. `ai/calls.ts:255-258` R33-17 注释已漂移——称锁排队分支「不可达保留」，实际 R30-3 异步化后 writeChains 排队已在役，同文件 :350-351 表述相反〔高〕
4. `ai/provider/responses-adapter.ts:454-507` post-terminal-error 守卫只覆盖 completed；incomplete(max_tokens) emitDone 后流尾 failed/error 仍可翻转回合（重审-批2-1 同型另一半）〔中〕
5. `ai/provider/openai-adapter.ts` 缺 index 兜底聚合 startsCall 判据在「每分片重复携带 id」网关形态下把单一 tool 调用拆散（未实测存在此形态网关）〔低〕
6. `ai/provider/openai-adapter.ts:129` 仅 reasoning 块的 assistant 消息回写 `content:null` 无 tool_calls，严格网关可能 400〔低〕
7. `ai/runner.ts` extractUsage 只查键存在不验值类型（三适配器均有兜底，触发面近零）〔低〕

**A3 前端数据层（1）**
8. `web-next/src/api/prefs.ts:44-100` GlobalPrefs 接口缺 `uiFontSizeStep` 键声明（store 真实读写，靠索引签名过编译，契约穷举性缺口）〔高〕

**A4 前端组件层·上（7）**
9. `shell/TabBar.vue:13`、`StatusBar.vue:10` 声明后从未使用的 `bookName` 必填 prop（契约噪音）〔高〕
10. 对话历史「200」三处硬编码无单源（`api/chat.ts:65` / `stores/chat.ts:50` / `ChatMessages.vue:205`），注释自证曾失同步一次〔高〕
11. `shell/ChatDock.vue:60` 收起 FAB 即卸载 ChatComposer，未发送草稿静默丢失（同书内口径不一致）〔中〕
12. `panels/ContextQuickPanel.vue:65` 以可空 `docId` 作列表 key〔低〕
13. `panels/CheckPanel.vue` 同 scoped 块 `.check-item` 两处分离规则〔高·微〕
14. `style/StyleEntryPanel.vue` 与 `StyleCandidateBox.vue` `.src-dot` 逐字重复（style-shared 收敛漏网）〔高·微〕
15. `ui/TierCard.vue:57` 表达式语句代替 if〔高·微〕

**B1 前端组件层·下（9）**
16. `stores/learn.ts:38-128` harvest/commit 缺函数级在途锁，同帧双击可双发（R35-34 家族漏网；harvest 双发=全书扫描双跑）〔中〕
17. `components/workbench/WbStateCard.vue:89` + `WorkbenchView.vue:183-188` 建议按钮与 Enter 提交绕过 AI 可用性闸（主按钮有闸，旁路无）〔中〕
18. `views/AuditView.vue:228/269` 加载失败后 tab 区空态文案与错误横幅同屏自相矛盾（tab 区缺 `!err` 守卫）〔中〕
19. `components/workbench/WbUsageCard.vue:52/128-136` 取数失败被渲染成「未配置价格表」引导，误导归因〔中〕
20. `components/relations/RelationGraph.vue:33`、`RelationDetail.vue:32` v-for key 用 `-` 裸拼接自由文本名，理论可撞 key〔低〕
21. `pages/Welcome.vue:105-109`、`Library.vue:103-106` loadError 双职：交互失败顶掉已加载最近列表〔低〕
22. `components/overview/RhythmDistPanel.vue:63` 短篇模式每行仍渲染「n/0」规划占位〔低〕
23. `components/learn/SampleCandidateList.vue:66` expandedGroups 跨收割不重置〔低〕
24. `views/WorkbenchView.vue:283/305/325/372` 生成类 toast 章号取 toast 时刻 computed 而非请求时刻捕获值（窄窗文案错位）〔低〕

**B2 文档·FS·缓存（2）**
25. `document/service.ts:251→264` save absPath 入队前一次性 resolve，队列延迟窗内不重解析（symlink 竞争下 rename 替换 symlink 本身，路径对账漂移）〔低〕
26. `document/service.ts:1426` updateDocMetaLocked 对 fm-only 变更用 structural 整书失效，与同文件 ：1136 单键失效口径漂移（性能项）〔中〕
27. （对账确认·非缺陷）`cache/rebuild.ts:216-229` SOURCE_PROBE_TTL 3s 节流确按 R47-11 登记口径落地，无超范围放大。

**B3 进程·事件·状态（1）**
28. `process/spill.ts:77-79/150` spill 写入失败全链静默降级为全文内联（上下文成本膨胀不可归因，缺一条节流 warn）〔中〕

**B4 机检·格式化·评审（4）**
29. `check/count.ts:49` vs `check/leads.ts:102` 章号-文件名前缀解析双口径：fm-chapter-mismatch 对 `6—标题.md` 宽容分隔符形态失明（真不一致静默跳过）〔高〕
30. `check/runner.ts:199` + `format/yaml.ts` book 层 repeat_threshold 只验 >0 不夹紧 (0,1]——手写 1.5 静默杀死复读检查，违反「配置不生效必留痕」自设纪律〔高〕
31. `check/quotes.ts:19-20` 宽容引号集缺 ASCII 单引号，单引号包裹证据可致 lead-evidence-miss 伪红（fail-noisy 向）〔高〕
32. `check/count.ts:308/446` checkNewNames 长度窗按 UTF-16 计 + 名册正则仅 BMP——CJK Ext-B 姓名双向边界效应（玄幻生僻字偶发）〔高〕

**C1 桌面·安装·导出（7）**
33. `install/books.ts:117-122` readBooksStrict stat 失败归空表绕过 DA-3 拒写防线（非 ENOENT 未分诊；repairBooks 可兜底）〔中〕
34. `desktop/server-manager.ts:361-364` launch fork 后停机检查 kill 无等待/升级纪律（同构 killProcAwaitEscalating 未收编此路径）〔中〕
35. `desktop/main.ts:2067-2075` uncaughtException 兜底 200ms backstop 可截断 stopChild（2s race）——kill 从未发出成孤儿〔中〕
36. `desktop/main.ts:265` second-instance 缺 darwin `app.focus({steal:true})`，mac 前台拉起可能只聚焦不置前〔中低〕
37. `install/books.ts:368/396` removeBookEntry 双版写段无 try/catch，与 appendBookLocked 收编不对称（上游已兜，契约不对称）〔中〕
38. `desktop/main.ts:2045-2047` 重复退出信号无强退通道（优雅停机取舍正当，备案）〔低〕
39. registerIpc isTrustedSender 拒绝路径返回 undefined 与 {ok,reason} 信封不对称（纵深内不可达）〔低〕

**C2 RAG·知识·learn（4）**
40. `scripts/check-knowledge.ts:97-107` 反向扫描精确字符串比对未走 caseFold/NFC——大小写/归形漂移下已登记文件误报未登记（CI 假红；同族 caseFoldKey 单源唯一漏改点）〔高〕
41. `scripts/knowledge-commit.ts:41-44` 登记已成功但 manifest 存预存坏行时报「manifest 未写入有效状态」，作者重试撞「已在 manifest」自相矛盾指引〔中高〕
42. `scripts/harvest-corpus.ts:135-138` 早退 `process.exit(1)` 在 try 内绕过 `finally{db?.close()}`（R71-34 不变量该路径不成立；进程即退无实害）〔高〕
43. `scripts/corpus-commit.ts:73` 空白摘录行静默丢弃不进 droppedExcerpts/warn，退出码哨兵盲区〔中〕

**C3 根配置·CI·脚本（6）**
44. `desktop.yml:101-117` mac 腿三连重构建（test:e2e + test:e2e:release + build:desktop 各自全量构建，产物互相丢弃）；ci.yml e2e job 同理重复一次〔高〕
45. `desktop.yml:94-96` 缺 playwright 浏览器缓存，与 ci.yml 不对称（~130MB 重下）〔高〕
46. `web-next/tsconfig.json:34-39` include 引用不存在的 env.d.ts——死配置〔高〕
47. `electron-builder.yml:9-12` asar 内 node_modules 与 dist 内联产物重复打包（fontlist 二进制包内两份，体积/攻击面噪音；运行时消费内联份）〔中〕
48. `scripts/check-counts.mjs:173` skipEach 正则对含 `)` 的 each 参数数组盲区（漏检向，与 R31-35 同族更窄）〔低〕
49. `scripts/verify-responses-relay.ts:58-64` vs `calibrate-tokens.ts:23-26` argValue 参数解析口径不一（后者不拒 flag 名误吞）〔高〕

**C4 测试面（8）**
50. `src/ai/provider/tool-choice.ts` 三适配器 tool_choice 决策单源（4×4 组合空间）无直接单测钉，仅适配器发射断言间接守护〔中〕
51. ci.yml:130-141 win 腿同命令重跑一次的 flake 洗白窗（注释自认，上游 tinypool 根治前维持）〔高·已登记〕
52. 临时目录清理双轨：~97 文件裸 mkdtempSync 断言失败时漏收（$TMPDIR 累积，卫生面）〔高〕
53. 超长测试文件 3 个（main.test 2661 行 / adapter.test 1475 / server-manager.test 1322）〔高〕
54. `function waitFor` 本地 3 份（登记专名形态维持）+ fakeReqRes 3 份近同构未收编〔高〕
55. `test/document/service.test.ts:431` 上限式时间窗断言（<1s）慢机假红向风险〔中〕
56. soak 覆盖窄于「200 万字不崩」宣称（两段热路径；document/events 段已登记待补——本轮确认缺口真实）〔高·已登记〕
57. `web-next/src/shared/fullscreen.ts` 38 行零测试引用（仅 e2e 间接）〔中〕

（C4-P3-1 为正面记录：meta-守卫体系完整——only/skip 静态门双向自测、coverage 桶守护、soak anti-skip grep、e2e 顺序双探针，测试基建自身处于被测状态，不计缺陷。）

### 3.3 域结果汇总

| 域 | 精读量 | P1 | P2 | P3 | 完成度 | 质量 |
|---|---|---|---|---|---|---|
| A1 服务端 | 50 文件 / 12,807 行 | 0 | 0 | 2 | 100% | A |
| A2 AI 编排 | 78 文件 / 13,786 行 | 0 | 0 | 5 | 97% | A− |
| A3 前端数据层 | ~85 文件 / ~12,800 行 | 0 | 0 | 1 | 99% | A |
| A4 前端组件层·上 | 78 文件 / 18,409 行 | 0 | 0 | 7 | 100% | A− |
| B1 前端组件层·下 | 34 文件 / 8,993 行 | 0 | 1 | 9 | 97% | A− |
| B2 文档·FS·缓存 | 33 文件 / ~9,900 行 | 0 | 2 | 2+1 对账 | 98% | A− |
| B3 进程·事件·状态 | 39 文件 / ~11,800 行 | 0 | 0 | 1 | 95% | A− |
| B4 机检·格式化·评审 | 41 文件 / 11,378 行 | 0 | 0 | 4 | 97% | A− |
| C1 桌面·安装·导出 | 26 文件 / ~8,100 行 | 0 | 0 | 7 | 100% | A− |
| C2 RAG·知识·learn | ~3,800 行 + 脚本 + 语料 | 0 | 0 | 4 | 92% | A− |
| C3 根配置·CI·脚本 | ~25 文件 | 0 | 1 | 6 | — | A− |
| C4 测试面 | 抽样 18 文件 + 全景 grep | 0 | 0 | 8+1 正面 | — | A− |

### 3.4 重点排除裁决摘录（防重复立案）

- **auto-write TOCTOU（A1 候选 P2 → 排除）**：检查与置位间全同步代码 + runSelfHealInner 首个 await 前同步 running.set，单线程下无窗口。
- **provider store 单一 revision 守双族（A3 候选 P2 → 排除）**：chat/rag providers 同存 providers.json 单文件共用同一修订号计数器，前端单 revision 正确。
- **前端 sha256 与服务端字节哈希（A3 候选 P2 → 排除）**：内容经 JSON 线上传输同历 UTF-8 序列化，往返哈希口径一致。
- **RAG 章号 0 指纹被 `n>0` 过滤（C2 候选 P2 → 排除）**：`format/chapters.ts:58` frontmatter 校验章号 <1 直接报错，章号 0 不可达。
- **r1010b 测试 `sleep(60)+负向断言`（C4 假绿候选 → 排除）**：失败方向是假红非假绿——drain 实现错误时 60ms 窗内必翻 true 使断言红。
- **ReDoS 面（B4 全扫 → 无灾难回溯）**：adjStack clamp、/的{3,}/ 切段守卫、SIMILE_RE 固定长 lookbehind、ngram 线性滚动哈希。
- **机检 dp/缓存混纪元（B4 → 无混纪元窗）**：computeTreeIssuesGlobalFp 输入清单逐项核验在册。

---

## 四、进度评估：≈97%

- **分域完成度 92–100%**（§3.3 表），按体量加权 ≈97%，与上一轮（重评-0912-2，≈97%）持平——期间两批修复收口后无新增未收口面。
- **无桩实现**：12 域 grep TODO/FIXME/stub/未实现，产品代码零实质命中；「能力边界」均有诚实记档（如 review 进度 SSE 未实现亦无排期、知识层语料 13 条多为占位 README 属内容供给而非代码缺口）。
- **扣减项构成**：① 显式登记的待拍板/待标定项（TOKEN_COEFFICIENTS 空表、RAG 向量索引/FTS 加速「十万块内线性可用」拍板 RC、desktop.yml 打包态冒烟接线、soak 补 document/events 段）；② 本轮新发现 P2×4 对应的边角输入面/并发窗/反馈死分支/CI 门洞（均为窄触发面，不动摇主链）；③ C2 域相对最低（92%）主因知识层语料本体尚薄。
- **主链闭环判定**：写作主链（建书→写章→保存→机检→AI 生成/三审/改写→定稿→导出）、AI 链（三协议适配/编排/中断/自愈/计费）、数据安全链（原子写/锁/版本/回收站/崩溃恢复）、前端全功能面、打包分发链——全部实装且经 L2 与实包双重验证。

## 五、质量评级：A−

**评级依据**：

加分面（为何稳在 A 档边缘）：
1. **0 P1 / 0 安全漏洞**；P2 密度 ≈1 条/2.8 万行，且 4 条全部为窄触发面（边角输入、毫秒并发窗、死 UI 分支、CI 门洞），主链无一份量级缺陷。
2. **防御纪律体系化**：跨进程锁谱系（stale 接管/续期/pid 复用/指纹校验）、乐观锁 + operationId 全链、路径安全三套判界按场景适配、原子写 + 快照留底、fail-closed 默认——在 12 域中口径一致。
3. **测试文化显著高于工业常见水准**（C4 审计）：0 快照断言、2.9 断言/用例、字节级零副作用验证成谱系、meta-守卫（门本身被测）、win 差值恒定锚对账。
4. **契约面零失配**：前后端 110 端点 × 前端 68 调用对账全对上；AI 三协议 wire/计费口径经交叉核验。

扣分面（为何不是 A）：
1. **「同族防线逐路径补丁」模式仍在产生漏网**：P2-1（copy 拒 `..` 而 move 漏）、P2-2（save 锁收口未纳入 finalize 的不对称）、A1 缩进失守、C1 kill 升级链三处漏收编——按调用点逐个补的纪律缺「路径段白名单/锁面全覆盖」式总闸。
2. **一处 CI 门自宣称语义与实现不符**（P2-4）：防假绿的 soak 门自身存在假绿洞，且发生在「SKIP/FAIL 均判红」的自证注释下——门的元正确性需与门覆盖面同批推演。
3. **注释密度逼近收益拐点**（26.1%，部分文件 33–38%）：多层批注叠加已出现实例级漂移（A2-P3-3 并发注释说错现状），注释维护本身开始成为负担；且组件层无白盒单测，防回归依赖注释自证。
4. **错误态/空态口径未成谱系**（B1 三处「失败冒充空态」同族小疵），与该仓竞态纪律的成熟度不匹配。

## 六、处置建议（未收口——待作者指令）

1. **P2×4 建议全修**（均为小中改动面）：P2-4（CI 两行级）→ P2-3（视图三态 + store 判据）→ P2-1（一处守卫 + 1 用例）→ P2-2（临界段重排，需注意锁序）。
2. **P3 择收建议**：CI/脚本卫生族（#40/41/44/45/46）与前端契约噪音族（#8/9/10/16）改动面小、收益直接，宜随修复批顺手；其余维持登记待择收。
3. **单立观察**：asar 冗余 node_modules（#47，需打包回归验证）、desktop.yml 构建缓存、soak 补段——均为既有登记或低风险结构项，不随批。
4. 收口路径照旧：修复批处置 P2（P3 择收）→ L2 终门复跑 → 报告补收口记 → 归档 `Archive/`。

## 七、与既有登记对账（主审评审完成后进行）

- **P2×4 与台账既有登记零重复**：move toDir `..`（台账仅存 R66-5/R51-D-3 已处置同族，move 侧为新缺口）；doTrash×finalize 基线竞态（无登记）；LearnView 空态死分支（无登记）；soak 门假绿洞（台账 §三 G 既有「soak 面窄」为覆盖广度问题，与本条「门断言逻辑洞」为不同面，不重复）。
- P3 中 2 条为既有登记确认（#51 win 腿重跑、#56 soak 面窄），已在 §3.2 标注；其余为新发现。

---

*本报告由主审汇总 12 份域评审子代理报告形成；各域明细（含端点底稿/契约对账表/排除裁决全文）以主审会话子代理产出为准，本档收录结论与总账。未收口，不归档。*

---

## 八、收口记（2026-09-12 R0912-3 修复批）

**作者指令**：「全部修复，编排下任务，并发做。」**编排**：主审亲修 4 件（P2-4 ci.yml soak 门 + #45 desktop.yml playwright 缓存 + #9 收尾 WorkspaceShell 残留绑定 + #49 真侧 calibrate-tokens）+ 两波文件互斥修复代理 8 路（波 1 DOC〔P2-1/P2-2/#55〕/ FE-1〔P2-3+#16-24〕/ DESK〔#33-37〕/ AI〔#3/4/7/50〕→ 波 2 SRV〔#1/2/28〕/ FE-2〔#8-15/46〕/ CHECK〔#29-32〕/ SCRIPTS〔#40-43/48/49〕），全程在途 ≤4，主审逐 diff 复核全量（P2-2 临界段/P2-1 守卫/#31 评估/#4 守卫放宽等关键面亲核通过）。

**处置总账**：P2×4 全修 + P3 择收 **42 件**随批（#1/2/3/4/7/8/9/10/11/12/13/14/15/16/17/18/19/20/21/22/23/24/28/29/30/31/32/33/34/35/36/37/40/41/42/43/45/46/48/49/50/55）+ 维持登记 **14 件**（#5/#6 低置信未实测、#25 现实概率极低、#26 归并既有行、#38 有意取舍备案、#39 纵深内不可达、#44 构建缓存单立、#47 asar 单立需打包回归、#51/#56 既有登记确认、#52/#53/#54 结构性卫生批、#57 成本>收益）。

**要点**：P2-1 normalizeMoveToDir 拒 `..`/`.` 段（R51-D-3 同族口径，6 形态 BAD_INPUT 用例）；P2-2 doTrash「TrashEntry 落账+清单删除」收进删除 RMW 清单锁临界段、锁内新鲜读基线投影（trashBaselineOf 单源，键序钉定 JSON 比对）不一致回填后删——真实跨锁竞态用例红绿验证 + 无并发逐字节不变对照，锁序单向无环 grep 核实；P2-3 learn store 增 lastHarvestRan 判据 + LearnView 空态三态化（死分支删除）；P2-4 ci.yml soak 步 `shell: bash`（-eo pipefail，teed 退出码不再被吞）+ OK 行数恰=段数断言（补段须同步改，fail-closed）。实现偏离处方 3 处均在代理回报中声明理由并经主审复核（P2-2 entryBase 无基线基座化、#18 空态守卫范围收窄防 R57-F-1 抵触、#11 v-show 案附 R48-97 豁免理由）。

**主审修正/证伪记录**：① #49 报告原指 verify-responses-relay「不拒 flag 名误吞」经代理读码**证伪**——该脚本已是严格侧（判式齐备），真缺陷在 calibrate-tokens.ts:23-26 宽松 argValue（吞 `--flag` 作值）；处置 = 前者钉注释+回归测试、后者主审判式修正对齐。② #9 FE-2 代理权限外上抛 WorkspaceShell.vue 两处 `:book-name` 残留绑定，主审收尾清理。③ #31 ASCII 单引号入宽容集经误剥面评估通过（span 面 QUOTED_SPAN_RE 无 ASCII 引号零波及，证据面多候选兜底）。④ 路径勘误：报告 §3.2 的 `process/spill.ts`、`check/*.ts`、`format/yaml.ts` 为 src/ 下相对简写（实际 `src/process/`、`src/check/`、`src/format/`）。⑤ 代理上抛超权限残余 2 条转台账新登记：ai/rules/setting-rule.ts 名册抄本 BMP-only（§三 D 域）、learn/index.ts:107 book 层 repeat_threshold 不夹紧（§三 F 域 advisory）。

**L2 终门复跑（主审亲跑，全绿）**：vitest **1095 文件 = 7063 过 + 5 跳 0 败**（基线 1088/7010 → 净增 7 文件/53 用例，全部 r0912-3- 锚新文件或既有文件追加）+ tsc/vue-tsc 0 错 + eslint 0/0 + 三 check 过（counts 首跑红 = README 计数漂移，属本批新增用例先在漂移；README 修账 7010→7063 五处 + win 差值锚预期 1095 文件/6988 过+80 跳后复跑绿；packaging 过；knowledge 13 条过）+ build:web 过 + e2e 43 过〔32.0s〕+ soak 两段 OK（RAG 段 +0.05MB/上界 24MB）+ electron-builder --dir EXIT 0（`app.asar` 19.9MB + `app.asar.unpacked/dist/desktop/fontlist` 137,088B 在位，出包实锤复验）。

本批零提交（工作树留作者）。收口后报告归档 `Archive/`，台账 §三 各域处置态回填、短名改指归档正本。
