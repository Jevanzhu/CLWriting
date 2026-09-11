# 全量代码重评——进度质量与精简优化评审

> 归档记：2026-09-11 重评修复批同日收口（作者指令「全部修复，编排下任务，并发做。」）后自 `01-评审/` 移入 `Archive/` 扁平；历史正文不改写，收口态见头部行与 §八收口记。

- 日期：2026-09-11。执行模型：GLM-5.3（主审；子代理同模型）。作者指令原文：「忽略现有的评审文档，重新评审一遍项目所有代码，最后告诉我项目完成进度，完成质量，以及是否可以精简优化代码，结果形成一个文档给我。记得编排下任务。」
- 评审基线：HEAD `ddf40293`（分支 win，工作树净——除 Dev/Docs 下两篇未入库游离件）。评审范围：src/ 全部产品代码（18 域 + web-next 前端子包，~107k 行）+ test/（~166k 行）+ scripts/ + 根配置/CI + 知识层资产。
- **独立重评声明**：按作者指令忽略既有评审文档——本报告全部结论直接来自代码本身；代码注释中的历史声明一律作为线索经代码核实后采信。与既往台账条目天然重叠的项（如 writePieceList 零接线、switch-provider 无消费者）系本次独立再发现，非采信既往。
- 收口状态：**已收口**（2026-09-11 重评修复批同日办结——作者指令「全部修复，编排下任务，并发做。」，收口记 §八；正本随批归档 `Archive/`）。

## 一、总评（三问直答）

1. **完成进度：约 96%（计划内口径 ~97%）。** 计划基线（总览第三节）阶段 1–23 全部收口；唯一开放任务阶段 24（章节结构操作）方案与执行方案已落盘（2026-09-04）但代码零足迹（本评审 grep 核实：无 fm `序`/`并入` 语义、无 structure/merge|split 端点；其前置能力回收站/软删已在位）。八个评审域完成度 95–98%，无空壳功能、无真 TODO/FIXME 欠账，未完成面全部是「已登记的留白与断头接线」而非隐蔽缺口。
2. **完成质量：A−（生产级 RC 质态）。** 全仓无 P1；新发现 P2×4（全部经主审逐一抽验坐实）：RAG rebuild 端点断头、前端切档假警报、ai→studio 反向依赖、机检剥引号口径分裂——均为局部性问题，无结构性风险。L2 九件套在本树主审亲跑全绿（§3.1）；>300 行产品文件零测试引用数为 0；架构分层纪律与防御密度显著高于常见工程水位。
3. **可否精简优化：可以，但空间有限、宜分三档推进。** 产品侧可直接或拍板后精简约 **2.6k–4.9k 行（≈总量 2.5–4.5%）**，测试侧另有样板收敛 ~1–2k 行量级。**不存在大刀阔斧的空间，不建议为瘦身做结构性重构**；最大单块是 AI 域 454 行零消费 catalog 资产（需拍板去留）。

## 二、完成进度

### 2.1 对照计划基线

| 计划项 | 状态 | 本评审核实 |
|---|---|---|
| 阶段 1–23（总览历史阶段行，含 win 适配/字体系统 F0 等） | 已收口 | 各域代码在位、接线闭环（分域见 §5） |
| **阶段 24 章节结构操作**（留洞制 fm `序`/`并入`、合并/拆分/回收站） | **方案已落盘、实施待作者指令** | 代码零足迹：`并入` 语义 grep 仅命中无关注释；无 structure/merge\|split 路由；回收站/软删/快照等 S3 前置能力已在位（documents.ts 等） |
| 03-设计 暂缓项（字体内嵌线 B/C/E 等） | 作者拍板暂缓 | 不计入缺口（总览 §五 口径） |

### 2.2 分域完成度

| 域 | 范围 | 完成度 | 主要扣分项 |
|---|---|---|---|
| A 桌面壳 | src/desktop + process + install + 打包链 | ~95% | 同步孪生死代码、DMG 打包态实测留台账 |
| B 服务端 | src/studio/server + fs/git/export/log | ~97% | rag/rebuild 断头（P2）、deleteAiVersions 无出口 |
| C1 前端数据层 | web-next api/stores/composables/shared/editor/pages | ~98% | openTab 假警报（P2）、useDebouncedSource 零消费 |
| C2 前端组件层 | web-next components/views/styles | ~95% | ContextMenu 浏览器回退版键盘不可达（已登记权衡）；设置域样板重复 |
| D AI 链路 | src/ai + driver | ~98% | catalog 零消费、switch-provider 无消费者（均注释自认） |
| E 核心持久化 | src/document/events/format/state/cache | ~96% | writePieceList 写路径零接线（备案）、测试专用导出滞留 |
| F RAG·知识·检查 | src/rag/check/review/knowledge/learn/metrics + 知识层 | ~97% | 机检剥引号口径分裂（P2）、test-only 死导出 ~270 行 |
| G 测试·CI·工具链 | test/ + scripts/ + 配置/CI | ~95% | Electron GUI 交互 e2e 缺位、win32 74 处 skipIf 三腿不实跑、e2e 长尾 4 旅程（均已在台账登记） |

**整体：~96%。** 产品功能面唯一实质断头 = rag/rebuild（§3.3-P2①）；其余未完成面均为已登记留白（有意/待拍板/单立）。

## 三、完成质量

### 3.1 L2 终门九件套实测（主审亲跑，2026-09-11，本树）

| 件 | 结果 |
|---|---|
| vitest 全量 | **1049 文件 = 6720 过 + 80 跳，0 败**〔297.95s，win 口径〕 |
| tsc --noEmit | 0 错 |
| vue-tsc --noEmit | 0 错 |
| eslint --max-warnings 0 | 0/0 |
| check:counts | 过（1049/6720 + 29 spec/45 用例对账一致） |
| check:packaging / check:knowledge | 过 / 过（知识层 13 条 manifest 与磁盘一致） |
| e2e（Playwright） | 43 过 + 2 跳〔48.2s；2 发布 smoke 需环境变量〕 |
| soak 两段 | 绿：有界往返 10 万次 −0.02MB / RAG 召回 2 万次 +0.06MB |

> 附带证据：win 口径实测 1049 文件/6720 过/+80 跳与上批修复批登记的预期值**逐位吻合**（台账 §三 G「win 通过数待 CI 复验」项的本地坐实）。

### 3.2 测试与门禁体系

- test/ 与 src/ 镜像纪律完整（20 个子域目录对应）；**>300 行产品文件零测试引用数 = 0**（全量对账，无孤儿产品文件）。
- coverage 治理：全局 + 分桶阈值门 = 实测基线 −2pp 反回退（vitest.config），governance 反向守卫防 exclude 漂移。
- CI：ci.yml 六腿矩阵（typecheck/vue-tsc/lint/build/packaging/npm-pack/测试/coverage/counts/knowledge 全门 + win 腿收尾竞态重跑兜底）+ 独立 e2e job（release-smoke + Electron xvfb 冒烟 + soak 门）；desktop.yml tag 门全 gate + mac e2e + 打包态拉起冒烟。
- 抽样测试工程质量极高（如 r0911-e-p3-2：hoisted mock + 真实 FS 注入 + realpath 归一 + 确定性分支），断言文化与防御文化一致。

### 3.3 新发现缺陷清单（本次独立重评产出）

**P1：0 条。**

**P2：4 条（全部主审抽验坐实，修复后本报告方可收口）：**

| # | 位置 | 问题 | 影响 |
|---|---|---|---|
| ① | `src/studio/server/api/rag.ts:170`（端点）vs 前端 `web-next/src/api/books.ts:139-140`（只接 build） | **rag/rebuild 断头接线**：服务端有完整 rebuild 端点（R26-16 登记），前端零消费者；而 `src/rag/index.ts:387/593/717` 三处失配错误文案明确引导「POST /rag/rebuild」——GUI 用户被指向一个界面上不存在的操作 | embedding 模型/维度变更后 RAG 无法自愈（死路）；SettingsBookAnalysis.vue 失败提示文案亦与实际调用的 build 语义不符 |
| ② | `web-next/src/stores/workspace.ts:297` + `stores/doc.ts:387` | **切档假警报**：openTab 切文档遇旧文档保存在途，`save(id,'autosave')` 对 saving 态直接返 false → 弹「切换文档时自动保存失败」toast，实为在途保存正常进行、内容不丢；doDelete 已用 `waitInflightSave`（doc.ts:701）解决同型问题，openTab 未同步 | 误导性 warning，自愈无数据损失；修法现成 |
| ③ | `src/ai/orchestrate/chat/turns.ts:46` | **ai→studio 反向依赖**：`import { acquireTaskGate } from '../../../studio/server/api/task-gate.js'`，与「ai 是底层、studio 是消费方」分层相悖（注释自认分层债并写明迁移触发条件；task-gate 现依赖 node:fs/cross-process-lock/ai-log，搬层非平凡） | 形态债非正确性缺陷：studio 侧改动可静默波及 chat 编排，重构耦合 |
| ④ | `src/check/count.ts:869`（checkBodyParts）/`:926`（checkSimile） | **机检剥引号口径分裂**：同文件禁词(:119)/意象(:483)/开头环境(:1061) 均 `stripQuotedSpans`，唯身体部位/比喻密度吃原文——对白里「眼睛×6」「像…一样」计入密度报黄；短篇 strict 升红（runner.ts:374-378）可致对白密集章被误打回重写 | 误报 → 自动重写白烧模型调用；无注释声明有意为之 |

**P3：约 30 条**（分域清单见 §5，要点）：A 域 5 条（重复注释块/缩进跳变/变量遮蔽等格式类 + font-cache 超时不杀子进程已知限制）；B 域 4 条（analysis kind 无白名单、IoCtx/KnowledgeCtx token 死字段、ai-track 同步孪生零调用、isNfcName 仅测试）；C1 域 4 条（boot initialBook 未验型、seedHistory 空历史跳过分支等）；C2 域 4 条（AuditView 模板复制、4 处 v-for index 键、variantGroups O(n×m)、全局 css）；D 域 6 条（recordAiCall 生产零调用、writeChains 不可达排队段、switch-provider/catalog 留白、chapter ?? 0、守则校验 opt-in）；E 域 4 条（latestSession 裸 prepare、中部 import×2、isPieceBody 同步重读、writePieceList 误接线陷阱）；F 域 2 条（dialogue-tag 堆叠项同族漏剥、Math.max spread 栈压）；G 域 1 条（main.test.ts 2583 行单文件可拆）。

**交叉印证**（独立再发现，与代码注释自认一致）：writePieceList 生产零接线（E）、switch-provider 无消费者 + MODEL_CATALOG 零消费（D）、同步孪生双轨（A/E/B）、ContextMenu 键盘不可达（C2）——历轮登记的非改不可信度经本次独立复核全部成立。

### 3.4 架构与代码形态总评

- **分层**：桌面壳（desktop 纯壳）→ 服务端（node:http + 手写路由/schema 注册表）→ 前端（视图薄编排、组件纯渲染、数据层无状态）→ AI 链路（三协议适配器 + 表驱动 quirks + TaskSpec 声明化）→ 核心持久化（format 纯解析 / document 编排 / events 账本）→ RAG/检查（防御纵深）。依赖方向基本一致，唯 ai→studio 一处反向（P2③）。
- **防御密度**：竞态（代守卫/入口快照/在途锁/书注册重验）、原子性（tmp+fsync+rename/锁序统一/锁内复核）、自愈（损坏库删建/毒向量剔毒/journal 恢复/healthCheck 哨兵）、平台分支（win 大小写折叠/GBK/超长路径）成体系；注释即审计链（R 批号可回溯）。
- **代价**：注释密度高（部分文件近半）；同步/异步双轨孪生散布（多为等价性对照测试资产，属有意口径）；>800 行文件 13 个（最大 desktop/main.ts 2227 行）。

## 四、可否精简优化（第三问详答）

**总量判断：产品侧 2.6k–4.9k 行（≈107k 的 2.5–4.5%），测试侧样板收敛 ~1–2k 行量级。空间真实但有限；以下按风险分三档，另附「不建议动」清单。**

### 档一：低风险机械批（拍板后可直接做，合计 ~800–1000 行）

| 项 | 位置 | 预计删行 | 风险 |
|---|---|---|---|
| F 域 test-only 死导出（enableRag/writeApiKey 族 ~70、recall 兼容包装 ~22、unlinkWithRetry ~25、readAllChunks ~67、formatStyleReport 族 ~75、leadUpdatesInScopeForChapter ~7、strictShort ~2——均 grep 核实生产零调用，配套测试同删） | rag/config.ts:115-194、rag/index.ts:990-1001、rag/store.ts:150-170/410-476、metrics/style.ts:401-473 等 | ~270 | 低 |
| E 域 snapshot.ts 兼容别名层整删（5 触点机械改名指 version.ts；头注 O-12 退役登记在案） | src/document/snapshot.ts | ~111 | 低 |
| E 域测试专用导出退役（writePieceList+stringifyPieceList、appendEvent/latestSession、writeAnalysis 同步壳等 ~205 行，多数属刻意测试资产，收益有限） | events/store.ts:130,898,1012 等 | ~205 | 低 |
| A/B 小件：win-fonts 与 font-cache spawn 骨架同构收敛、books.ts forget 20+ 条改注册表循环、IoCtx/KnowledgeCtx token 死字段、ai-track 同步 recordAiVersion | 见分域节 | ~100 | 低 |

### 档二：需作者拍板（收益更大或牵动口径，合计 ~1.5k–2.6k 行）

| 项 | 位置 | 预计收益 | 说明 |
|---|---|---|---|
| **D 域 catalog 资产去留**（MODEL_CATALOG + catalog.gen 全仓零消费） | ai/provider/catalog.ts + catalog.gen.ts | ~454 行（最大单块） | RC 后随 A7 接线，不接则整删——须拍板 |
| A 域同步孪生死代码（appendBook/doInit/searchBook/harvestStyleCandidates 同步版生产零调用，主审 grep 复核坐实） | install/books.ts、init.ts、process/book-search.ts、style-harvest.ts | ~240 | 属「等价性对照」有意双轨口径，删除是拍板项非纠错 |
| B 域写端点内联校验双轨迁 defineRoute parse | schema.ts:19 自记「存量 104 处」 | ~200–400 | RC 后分批，触碰全部写端点 |
| C2 域 Settings 开关样板抽 SettingToggle（~10 处手写 setting-item+switch） | ui/Settings 族 | ~250–400 | 防御注释密集，回归面大 |
| C1 域 prefs.ts 29 个同构 setter 表驱动 | stores/prefs.ts（890 行） | ~150–200 | 收益/风险比一般 |
| G 域临时目录清理双轨收敛（台账已登记 328 处机械批）+ check-counts 门禁 AST 化 | test/、scripts/check-counts.mjs | 测试侧 ~1k 量级 | 已在台账 §三 G 单立 |
| E 域 yaml.ts 补丁族公共 helper + service.ts 锁样板 helper | format/yaml.ts、document/service.ts | ~160–250 | service 拆分锁序敏感需回归 |

### 档三：结构性（随重构批，不减行、降复杂度）

- 超大文件拆分 13 件：main.ts 2227 / service.ts 1959（拆保存链+结构操作+meta PATCH 三模块）/ events/store.ts 1358 / yaml.ts 1163 / check/count.ts 1074（短篇项+对白启发式两文件）/ server/api/stream.ts 1072（spawn/chat/SSE 三块）/ desktop/server-manager.ts 1039 / ai/orchestrate/self-heal.ts 1038 / state.ts 1021 / rag/index.ts 1001 / chat/turns.ts 951 / prefs.ts 890 / server/api/books.ts 848。
- ai↔studio 解环（P2③ 的根治）：task-gate 搬层或引共享内核层。
- B 域 documents.ts「快照→op→差分」5 处 runX 样板抽公共 helper（伏笔链语义需保真）。
- G 域 main.test.ts（2583 行）拆分。

### 明确不建议动（权衡备案）

foreshadow 同步孪生（有等价测试背书）/ RagProviderEditor 与 AiProviderEditor 合并（协议异构，强合反增复杂度）/ R 编号审计注释（审计链文化资产）/ mock-cc 分叉与全屏书架无上限等台账既有【维持】【有意】项 / B 域「注释占行比例极高」的行数瘦身——「行数瘦」≠「信息瘦」，只动真死代码。

## 五、分域详评

### 5.1 A 桌面壳（src/desktop 15 文件 5818 行 + process 18 文件 4099 + install 8 文件 2378 + 打包链 3 件）

完成度 ~95%；P1/P2 无。高危面全闭合：IPC sender 白名单+工厂窗 WeakSet 兜底（main.ts:776-822）、窗口安全五件套（main.ts:862-870）、fork/kill/restart 互斥+SIGKILL 升级+pid 复用防护（server-manager.ts:499-777）、close/quit/session-end 三链 flush 互斥、书名/穿越/NUL/win 保留名防线。P3×5（注释块重复、缩进跳变、变量遮蔽、v3 迁移边角、font-cache 超时不杀已知限制）。可精简 300–360 行（同步孪生为主，档二）。总评：全仓质量最高区域之一。

### 5.2 B 服务端（src/studio/server 50 文件 ~12.5k + fs 1.5k + git 0.7k + export 0.8k + log 0.4k）

完成度 ~97%（109 条路由全真实实现；107/109 端点有前端消费者）；P2×1（rag/rebuild 断头，见 §3.3①）；P3×4。高危面闭合：Origin/Host/token 三重闸 + DNS rebinding 防御（index.ts:336-421）、readJson 1MB 上限（http.ts:121-241）、SSE 背压双判死（stream.ts:97-148）、路径穿越 fail-closed（safe-path.ts:37-92）、删书墓地原子改名+ULID。可精简 350–550 行。总评：高密度淬炼代码，唯一实质问题是 rebuild 断头。

### 5.3 C1 前端数据层（web-next api 28 文件 2436 + stores 16 文件 5019 + composables 18 文件 3301 + shared/editor/pages/types ~4k）

完成度 ~98%（client ~60 端点与路由面 100% 对齐、114 个导出全有消费点）；P2×1（openTab 假警报，§3.3②）；P3×4。SSE 链闭环完整（ticket→退避→401 自愈→代数防悬挂→心跳 resync）。可精简 100–300 行（useDebouncedSource 零消费 60 行、prefs 样板）。总评：分层纪律极好，竞态自愈成体系。

### 5.4 C2 前端组件层（components 十二子目录 40+ 文件 21.2k + views 3k + styles）

完成度 ~95%（90 组件零死件、空态/断联/错误三件套一致）；P1/P2 无；P3×4（AuditView 模板复制、v-for index 键×4、variantGroups 嵌套、全局 css）。正面核实：23 处 addEventListener 全配对清理、2 处 setInterval 卸载停表、RENDER_CAP=100 惯例、IME 让渡、aria 106 处 + roving tabindex + 焦点陷阱。可精简 400–600 行（档二 Settings 样板为主）。总评：生产级，建议仅做低风险去重。

### 5.5 D AI 链路（src/ai 76 文件 13.6k + driver 5 文件 694）

完成度 ~98%；P2×1（ai→studio 反向依赖，§3.3③）；P3×6。两条 AI 守则在代码层有实质保障（promptMeta 落事件 + CLW_VERIFY_VISIBLE 抽查；默认值逐层显式 resolve + quirks 版本号）。正面确认：三适配器流式边界、重试幂等、资源泄漏防护、确认闸闭环、中断/续写防御均完善。可精简 750–900 行（catalog 454 为最大单块，档二拍板项）。总评：显著高于常见工程水位，遗留项全部有记档与处置口径。

### 5.6 E 核心持久化（document 17 文件 7089 + events 8 文件 3127 + format 25 文件 6421 + state 1149 + cache 1007）

完成度 ~96%；P1/P2 无；P3×4。读写链/迁移/自愈三链全闭环且幂等可重试（保存四锁序、定稿 pinned+防吃书闸、journal 双保险、healthCheck 三哨兵）。未接线写路径 writePieceList 系备案留置（陷阱已注明）。可精简 480–780 行（snapshot 别名层 111 + yaml 补丁族 helper + 测试导出退役）。总评：生产级成熟，剩余工作是瘦身而非补洞。

### 5.7 F RAG·知识·检查（rag 6 文件 2109 + check 14 文件 3995 + review 930 + knowledge 542 + learn 513 + metrics 1149 + 知识层 13 资产）

完成度 ~97%（RAG 链闭环+毒向量三道闸+NOTADB 自愈三路径；机检 11+7 项全接；知识层 13 条 manifest 脚本实算 sha256 全匹配）；P2×1（剥引号口径分裂，§3.3④）；P3×2。可精简 ~270 行（档一主力）。另：count.ts 拆两文件、isPlaceholder/yieldToEventLoop 多份同体收敛单源。总评：防御纵深罕见完整，无 P1。

### 5.8 G 测试·CI·工具链（test/ 1095 文件 ~166k + scripts/ 12 + 配置/CI——主审亲评）

完成度 ~95%（结构/覆盖/门禁见 §3.2；缺口 = 台账已登记的 Electron GUI 交互 e2e、win32 skipIf 74 处、e2e 长尾 4 旅程）；P1/P2 无新增；P3×1（main.test.ts 2583 行可拆）。scripts/ 12 个全在用（calibrate-tokens 有专测）。可精简 = 档二测试样板收敛。总评：测试工程体系（镜像纪律、基线−2pp 反回退门、九件套终门、顺序契约守卫）为全仓质量底盘。

## 六、评审方法与证据链（编排记档）

- **编排**：波 1 四路并发子代理（A/B/D/C1）→ 波 2 四路（C2/E/F/G）。波 2 中 C2/E/G 三路于 18:54 撞账号 5 小时使用限额中止（F 赶在限额前返回）；19:00:38 限额重置后重派 E/C2 两路，G 域转主审亲评（主审已亲跑全套 L2，一手数据最全）。全程在途并发 ≤4（作者纪律条）。
- **主审抽验**：四条 P2 全部逐条对码坐实（rebuild 断头引用面、openTab saving 分支、task-gate 反向 import、stripQuotedSpans 口径分裂）；同步孪生死代码（appendBook/doInit/searchBook）、MODEL_CATALOG 零消费、snapshot.ts 别名层三组「可精简」关键声明 grep 复核吻合；阶段 24 零足迹 grep 核实。
- **L2 实测**：§3.1 九件套全部主审亲跑（vitest 全量在评审代理并发负载下 297.95s 完成）。
- 各域规模数字：`find + wc` 实算；覆盖对账：>300 行产品文件 × test/ 全文 grep 引用。

## 七、处置建议（供作者拍板）

1. **修复批（本报告收口条件）**：P2×4——① rebuild 前端接线（SettingsBookAnalysis 改调 rebuild 或 build 失败后引导重建 + RagStatus 类型补 indexModelMismatch/indexState）＋② openTab 改用 waitInflightSave ＋④ checkBodyParts/checkSimile 补 stripQuotedSpans（对齐同文件三处先例 + 语料回归）；③ ai→studio 反向依赖为形态债，建议**登记单立重构批**不随修复批强改（迁移条件注释已自记）。P3 ~30 条可随批收或维持登记。
2. **精简批建议分两步**：先做档一机械批（~800–1000 行，风险低，配套测试同删）；档二各项逐项拍板（catalog 去留为最大单块）。
3. **测试侧**：临时目录双轨 328 处机械批（台账已单立）可与档一合并编排。

---

*本报告为评审交付物，未含任何代码改动（L0 零测试面批）。收口记待修复批后补 §八。*

## 八、收口记（2026-09-11 重评修复批）

作者指令：「全部修复，编排下任务，并发做。」同日办结本报告 P2×4（按 §七 建议：修 3 + 单立 1）与 P3 随批收；零提交（工作树留作者）。

**P2 处置**：
- ① rag/rebuild 断头【已修 R0911b-P2①】：前端 `triggerRagRebuild` 接线 POST `/api/books/:name/rag/rebuild`（api/books.ts）+ RagStatus 补 `indexState`/`indexModelMismatch` 实测字段 + SettingsBookAnalysis 失配三分支「重建索引」入口（复用 ragBuilding 锁 + 轮询）+ R28-22 误挂记忆修正（build 成功不再置重建提示）+ 失败提示文案改指重建；+白名单/失配直测。如实记档残留：库文件级损坏时 /rag/status 500 拿不到失配标记不出按钮——build 损坏自愈（上批 D-P3-1）可达，无死路。
- ② openTab 切档假警报【已修 R0911b-P2②】：openTab 先 `waitInflightSave(prevId)` 落定 → 复查 dirty/saving → 补存 → 仅按 R49-25 判式（真失败）notify，保留 bookAtEntry 守卫与 `.catch(notify)`；+4 回归用例。
- ③ ai→studio 反向依赖【按 §七 建议登记单立重构批，不随修复批强改】（台账 §三 D）。
- ④ 机检剥引号口径分裂【已修 R0911b-P2④】：checkBodyParts/checkSimile 调用点补 `stripQuotedSpans`（SIMILE_RE 本体不动——scripts/harvest-corpus.ts 复用该正则直扫原文，剥引号由消费方各自决定）+ style-dialogue-tag 堆叠项对齐（F-P3-1 同批收）；语料锚 fire/silent 逐锚核实零翻转 + r0911b-quoted-span 7 用例双向钉定。

**P3 随批收 13 项**（A×3/B×2/C1×3/C2×2/E×2/F×1；源文件锚注释 R0911b- 为准）：A-P3-1 重复注释块去重、A-P3-2 server-manager 缩进（`git diff -w` 空验证）、A-P3-3 catch 变量遮蔽改名；B-P3-1 GET /analysis kind 显式白名单（**定性修正：白名单必须含 'review'**——照「对齐 ANALYSIS_KINDS」字面落地将回归 review 信封读路，+2 用例钉死）、B-P3-2 IoCtx/KnowledgeCtx token 死字段删除；C1-P3-1 boot initialBook 验型、C1-P3-2 seedHistory 空历史分支修正（多窗清史路径可达，非死分支）、C1-P3-4 doc.ts 缩进；C2-P3-1 AuditView 抽 AuditEventList 组件（−195 行，锚测试 ×3）、C2-P3-2 v-for 稳定键 ×5 处逐处核定；E-P3-1 latestSession 改道 prepared 缓存、E-P3-2 中置 import 上提（核实无循环依赖缘由，ESM 提升语义下中置无意义）；F-P3-1 并入 P2④。

**维持登记 13 项**（台账 §三 各域新行/归并）：A-P3-4 migrate-layout-v3 EISDIR 边角、A-P3-5 font-cache 超时不杀；B ai-track 同步孪生零调用 + isNfcName 仅测试（→H 档一候选）；C1 useChatTier 模块级单例、C2 variantGroups O(n×m)、C2 settings-shared.css 全局注入；D recordAiCall 生产零调用（→H 档一）、writeChains 不可达防御段、chapter `?? 0` 兜底、守则校验 CLW_VERIFY_VISIBLE opt-in（设计取舍）；E isPieceBody 同步重读；F-P3-2 Math.max spread 栈压（700 章量级未证实可触发）；G-P3-1 main.test.ts 2583 行（→H 档三）。另 3 项归并既有台账行（switch-provider 无消费者 / MODEL_CATALOG 零消费 / writePieceList 零接线——本评审独立再发现与既有登记并一）。

**编排记档**：波 1 四路文件互斥并发代理（F 机检 / C1 前端数据层 / SRV 服务端+P2①接线 / AE 桌面壳+核心）→ 波 2 单路 C2 组件层；全程在途 ≤4（作者纪律条）。C2 路于收尾验证期模型请求失败中止——结构性改动（AuditEventList 抽取 + 5 文件）已完整在盘，主审接手逐 diff 复核并补锚测试 3 用例；其余四路主审逐 diff 复核全量。改动面：src 22 文件（21 改 + 1 新 AuditEventList.vue）+ test 10 文件（8 改 + 2 新：r0911b-quoted-span / r0911b-audit-event-list）+ 根 README 修账。

**L2 终门九件套亲跑全绿（收口态 2026-09-11，win 口径）**：vitest **1051 文件 = 6743 过 + 80 跳 0 败**〔305.45s〕+ tsc/vue-tsc 0 错 + eslint 0/0 + 三 check 过（counts 1051/6743 + 29/45 对账一致；packaging；knowledge 13 条 manifest 一致）+ e2e 43 过 2 跳〔46.4s，reporter 零报错〕+ soak 两段绿（有界往返 10 万次 −0.02MB / RAG 召回 2 万次 +0.06MB）。根 README 修账 1049/6795 → 1051/6818 四处 + win 实跑口径句更新（本批实测 6743 过 + 80 跳，「实测差 75 恒定」对账锚保持）。

§七 收口条件（批 1 修复 + L2 回归绿）满足，报告随批归档 `Archive/`；精简两档（批 2/批 3 建议）维持待拍板不在本批范围。
