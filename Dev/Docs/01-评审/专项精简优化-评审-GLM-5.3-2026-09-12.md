# 专项精简优化——全仓检视与执行评审

- **执行模型**：GLM-5.3（主审；六路扫查子代理 + 六路执行子代理均同模型，报告头部据实记档）。
- **评审对象**：win HEAD `9d78e6fe`（r0911b 修复批已提交、工作树净；两篇 deepseek 游离件未跟踪不在射程）。
- **任务指令**（作者，2026-09-11）：「现在开始专项精简优化任务，检视所有代码寻找可以优化和精简的，编排下任务做，最后形成一个文档报告。」→ 中止后续作指令（2026-09-12）：「继续，编排下任务，并发做！」
- **日期口径**：任务 2026-09-11 夜启动跨零点执行；代码锚注释与测试前缀统一 **r0911- / 「2026-09-11 精简批」**（按启动日），本报告按落盘日记 **2026-09-12**。
- **性质**：检视 + 执行一体批——检视产出执行清单与残余登记两份交付，执行随批完成并过 L2 终门。报告无 P1/P2 缺陷项（精简批非缺陷批），收口条件 = 执行落地 + L2 全绿，均已满足；归档时点待作者定。

## 一、总评（三行直答）

- **净减账**：产品侧 **−881 行**（跟踪文件 +477/−1432 + 新增单源模块与共享组件 4 件 +74）；测试侧 −207 行（删 3 死文件 + 死区段 ~24 用例 −577/+137，新增 20 用例钉界锚测试 +233）。合计 **−1088 行**。
- **质量门**：L2 终门九件套亲跑全绿（§六，win 口径 1050 文件 = 6739 过 + 80 跳 0 败）。
- **旧账校正**：重评-0911b §四 档一旧清单（估 ~800–1000 行）经六路逐项对码核实，**约半数证实为有意测试资产/等价对照 oracle 而非死代码**（§四，逐项给证据）——本批实际执行 = 旧档一真死码部分 + 档二经复核风险可控的三件（SettingToggle/prefs 表驱动/yieldToEventLoop 单源化）+ 本轮新发现死件。**不删任何有审计登记或等价背书的代码**是本批红线。

## 二、编排记档

- **扫查波（只读，六路）**：Wave1 四路域扫查（E 核心持久化 / FD RAG·检查·AI / SRV 服务端 / AEC 桌面壳+前端数据层）+ Wave2 两路（C2 组件层 / 测试侧死件盘点）。每路产出：既有候选逐项 grep 取证核实 + 全新死码扫查（导出符号全量对四目录消费检索）。全程在途 ≤4（作者纪律条）。
- **执行波（六路 + 主审亲修）**：EX-1 四路文件互斥（E/FD/SRV/AEC）——**执行中撞会话使用限额中止**（2026-09-11 23:36，四路已在盘 53 文件 +220/−1144，残局如实记档）：主审限额重置后接管——①逐域验证在途工作完整性（双 typecheck 抓出 2 处代理残尾：v-round R61-14 区段删半、rag.test 未用 import）；②亲修 provider.ts 注释吞函数残局（`add` 函数文档注释丢闭合 `*/` 致整个函数进注释——createProvider「未用」假象）；③亲补 FD 尾三件（yieldToEventLoop 单源化 / learn 死钩子 / chapterInput 单源化）。EX-2 两路（C2 组件层五件 + prefs 表驱动），各自相关面全绿。
- **主审逐 diff 复核全量**：snapshot 迁移 6 触点 / rag 删除与 materials 直写复刻 / sigStatFor·knowledge 收敛 / 新组件 DOM 形状 / prefs 工厂与 33 setter 去向表 / 注释级涟漪（global-defaults/yaml/api-check 三处路径口径随迁）逐处过目；style.test 自创断言失实一处主审改判（`dialogueTagRatio>0` 对该夹具合法为 0——引语无「说/道」标签，改 `_dialogueLines>0` 等价锚并注记原因）。
- **修账**：eslint 抓 1 处（learn 钩子删除后 `let` 失去改写点 → 常量内联，R30-18 口径注释随改）；README 四处 + win 口径句（差值 75 锚保持：6814 − 6739 = 75）。

## 三、已执行清单（按域；行数为净减）

### E 核心持久化（净 −112 产品侧）

| 项 | 内容 | 行数 | 锚记 |
|---|---|---|---|
| E-1 | `document/snapshot.ts` 兼容别名层整删：12 别名中 5 个零消费直接消亡、其余按原名改道 `version.ts`；非委托物 `readGlobalSnapshotPolicy` 迁入 version.ts；6 个 import 触点迁指（service / draft-pipeline / server/index / api/snapshots / snapshot.test / n1-move-docid-guard.test）；文件清空整删 | −94 | version.ts 头注 O-12 退役收尾行 |
| E-2 | `cache/schema.ts` `DDL_STATEMENTS` 挂名 export 去除（const 本体内部在用） | −1 | — |
| E-3 | `format/reversal-types.ts` `reversalText` 死函数 + ReversalLead import 连删 | −5 | — |
| E-4 | `format/style-entry.ts` 三个零消费测试钩子（`__setEntriesCacheTtlForTest` 族）+ 计数自增删；TTL 表达式常量化（注入链恒 null，行为逐字不变） | −15 | — |

### FD RAG·检查·知识·AI（净 −196 产品侧）

| 项 | 内容 | 行数 | 锚记 |
|---|---|---|---|
| FD-1 | `rag/config.ts` enableRag/writeApiKey/ensureRagSecretGitignore 族整删（readApiKey/envRagApiKey 生产在用保留）；rag.test V-P2-4 describe 4 用例删、H1/R62-27 改等价直写 setup 保留读侧覆盖；materials 两测试文件改 setupRag 本地直写（同款 patchTopSection/stringifyValue 原语，key 绝不入 book.yaml 红线保持） | −83 | yaml.ts V-P2-4 注释改指历史表述 |
| FD-2 | `rag/store.ts` unlinkWithRetry 整删 + `test/rag/r1w11-unlink-with-retry.test.ts` 整文件删（生产重试路径由 deleteRagDbFiles 自身测试锁定） | −30 | R37-39 注释句改写 |
| FD-3 | `metrics/style.ts` formatStyleReport/formatLine/width 族删（CLI 文本出口已退役，展示层归 web-next；avg 漂移计算在用保留）；style.test 6 用例改 trend 数据字段断言、全角对齐用例删 | −73 | — |
| FD-4 | `check/lead-updates.ts` leadUpdatesInScopeForChapter 删（生产同语义内联于 run.ts 预扫闭包，R65-24 覆盖）；v-round R61-14 区段删 | −7 | 锚随函数消亡记档 |
| FD-5 | **yieldToEventLoop 五拷贝单源化**：新建 `src/async.ts`（底层无环依赖位），check/run、document/foreshadow、learn、metrics/style 四处本地定义删改 import；api/progress 改 re-export 保 4 个 api 消费方 + r50 测试零改动；各域 `*_YIELD_EVERY` 粒度常量原地不动 | −6（净） | async.ts 头注记五处收敛谱系 |
| FD-6 | `learn/index.ts` `__setLearnHarvestLockTimeoutForTest` 死钩子删（全仓零消费——测试已删钩未删）；连带 `let` 生效值失改写点 → 常量直用（eslint prefer-const 门抓出，R30-18 口径注释随改） | −8 | R30-18 口径句更新 |
| FD-7 | `ai/tools` chapterInput 双拷贝单源化至 shared.ts（rewrite/tree 两处改 import） | ±0 | shared.ts 头注记 |

### SRV 服务端（净 −30 产品侧）

| 项 | 内容 | 行数 |
|---|---|---|
| SRV-1 | `fs/text-canonical.ts` isNfcName 死导出删（toNfcName 生产在用保留）+ 测试断言区段 | −3 |
| SRV-2 | `api/outline.ts` buildOutlinePrompt 薄包装删（端点已用 WithFiles 版；3 测试文件改 `.prompt`，零语义变化） | −7 |
| SRV-3 | sigStatFor 三胞胎收敛（overview/rhythm/settings 三处逐字符同构 → rhythm.ts 单源 export，两处 import；本文件为原注释所引先例位） | −14 |
| SRV-4 | `api/knowledge.ts` isSampleCandidate/isQuoteCandidate 同体双 guard 合一为 `isLearnCandidate<T>` | −6 |
| SRV-5 | `test/helpers/book.ts` seedChapterToCache 零消费 helper 删 | −13（测试侧） |

### AEC 桌面壳 + 前端数据层（净 −139 产品侧）

| 项 | 内容 | 行数 |
|---|---|---|
| AEC-1 | web-next `api/analysis.ts` getAnalysisEnvelope/runAnalyze 死封装 + AnalysisKindFE/EnvelopeGet/AnalyzePost 连删（EnvelopeFE 与四活函数保留）+ api-endpoints-b 区段 | −35 |
| AEC-2 | `composables/useDebouncedSource.ts` 整文件删 + r47 测试整文件删（useDebouncedWordCount 自带本地实现不复用它） | −59 |
| AEC-3 | `stores/provider.ts` ensureModels 死链删（函数 + modelsByProvider/fetchingModelIds 两 ref + 清理写 + return 面；probeModels 保留在用） | −33 |
| AEC-4 | `stores/tree.ts` issuesWarning 只写不读状态删（API 警告原被静默丢弃；api/check.ts 双轨注释随改） | −4 |
| AEC-5 | `stores/ui.ts` aiDriver 只写不读状态删 + ui-store 1 断言 | −4 |
| AEC-6 | `stores/style.ts` pendingCount 无读者 computed 删 + style-store 区段 | −2 |
| AEC-7 | `process/gui-active.ts` STALE_MS 死常量删（判定方自带 30s 窗口，头注随改） | −2 |

### C2 组件层（净 −340 产品侧）

| 项 | 内容 | 行数 |
|---|---|---|
| C2-1 | `ui/ProviderRow.vue` busy 死 prop 删（两消费方均零传入、`.row-busy` 全仓零定义）+ Loader2 import | −5 |
| C2-2 | `ui/SettingsRetention.vue` 双重钳制去冗（调用点预钳与 store setter 同公式逐字符一致，删外层零行为变化；注释口径对齐「clamp 在 store setter」） | ±0 |
| C2-3 | `ui/FontPicker.vue` onBeforeUnmount 重复 clearTimeout 二清合一（R0910-W 与 R1010b-FTC-P3-1 两锚注释保留并记两批语义） | −1 |
| C2-4 | `.rag-prov-select` 两份逐字重复 scoped CSS（22 行×2）迁 `settings-shared.css` 全局单源 | −22 |
| C2-5 | **SettingItem/SettingToggle 抽取**：新组件两件（31+35 行，DOM 结构/类名/aria 逐字保形，`#desc` 插槽透传插值、SettingToggle 收编 `(e.target as HTMLInputElement).checked` 解包）；10 个 Settings*.vue 55 处 setting-item 块全替换（44 常规 + 11 sub；15 switch 形态走 SettingToggle，其余控件本体原样入插槽）；模板 R 锚随块搬运；r66-frontend-guards stub 放行适配 | −340（净，含新组件） |

### C1 前端数据层（净 −34 产品侧）

| 项 | 内容 | 行数 |
|---|---|---|
| C1-1 | **prefs.ts 33 setter 表驱动**：闭包内泛型工厂（numSetter 界参数化 / boolSetter / strSetter{trim} / setter<T>）产 21 个同构 setter；12 个异形手写保留（applyTheme/apply/applyCompact 副作用族×8、bookOnly 双分支×2、浮点两位截断×1、setUiFontSizeStep 双职×1）；33 个公开名/签名/persist 键零变化（函数引用传递兼容）；**新增 `r0911-prefs-setter-table.test.ts` 20 用例**——11 个 clamp setter 五点钉界 + 取整顺序 + 浮点七点截断 + 函数引用裸调 + persist 异名键锚 + bookOnly 双分支 | −34（+233 测试） |

## 四、旧档一清单核实校正（保留项——证据说话）

重评-0911b §四 档一所列、经本轮逐项对码后**不删**的项（避免后续轮次重复翻案，逐项给证据）：

| 旧候选 | 核实结论与证据 | 处置 |
|---|---|---|
| readAllChunks（rag/store） | 14 个测试文件 40+ 调用点——毒行剔除（R35-40/R1010b）与早停（R37-38）语义测试面全部直挂此函数；R49-19「断言/盘点原语」登记口径成立 | 维持（既有登记） |
| recall 兼容包装（rag/index） | 11 文件 30 处 `await recall(` 断言；R50-B-2 登记「随存量断言改 recallDetailed 的批次一并删」 | 维持（既有登记） |
| appendEvent/writeAnalysis/latestSession | 44/40/6 处测试消费，覆盖会话迁移/单例/ws 排除/envelope 读路等真实行为；latestSession 系 r0911b-E-P3-1 刚拍板保留项 | 维持 |
| recordAiVersion 同步版（git/ai-track） | 生产 0 但测试 fixture 种子面 45+ 处（9 文件）；同步 API 是测试种子的自然形态 | 维持；**r0911b「→H 档一候选」登记建议销账**（删同步版赔本，台账 H 本批改写） |
| books.ts forget 注册表循环 | 21 条调用各带 R 锚注（R67-15/R35-7/R46-40 等），循环化净减仅 ~10 行，锚注归属直观性下降 | 不办（收益 < 代价） |
| strictShort | 旧候选失效：生产活代码（runner.ts:331 promoteStrictShort 消费 + 5 测试文件） | 划掉 |
| writePieceList/stringifyPieceList | 结构操作（阶段 24）未来接线备案（R48-51），读侧在链 | 维持（台账 E-P3-4） |
| A 域同步孪生四件（appendBook/doInit/searchBook/harvestStyleCandidates+collectDocSignals） | 均为等价性对照 oracle（r35/r36-9/r37/r44 五处 sync 对照断言）+ appendBook 系跨进程锁真实子进程并发测试唯一基材 | 维持（有意双轨） |

## 五、残余登记（供作者拍板 / 后续批；出处 = 本报告）

### 需作者拍板（二选一/去留）

| 项 | 体量 | 说明 |
|---|---|---|
| **D 域 catalog 三件套** | ~454–539 行 | MODEL_CATALOG 运行时零消费（Z-P2-4 口径自记），但 2026-08-16 已拍板「A7 seeder 未落地前不删」；A7 不在当前开放任务（总览 §三 唯一开放 = 阶段 24）。生成管线完整可复活（`npm run generate:catalog` 从 model-quirks.ts 再生）。**建议：拍板「删」（git + 一条命令可复活）或「挂 A7」明示时点** |
| SRV-N1 deleteAiVersions | 35 src + 87 test | 文件头宣称「轨迹可查可删」但「删」无任何生产入口——补端点兑现承诺，或删函数+测试承认未接线 |
| AEC-N8 resolveBookRoot CLI 遗产 | 68 src + ~150 test | 「统一入口」头注描述 CLI 时代已退场；留作 CLI 复活面或删 |

### 单立机械批（低风险大批量，本批有意不铺开）

| 项 | 净减 | 说明 |
|---|---|---|
| SRV-N6 书键 TTL 结果缓存族 12 处同构壳 | ~100–120 | 先统一 R47-18 过期逐出口径（rhythm 有/settings 无——收敛即语义统一须记档）再抽 helper；两级探针成员单独形态 |
| SRV-N8 resolveBook 双行样板 ×72 | ~65 | 72 点全在路由入口，分文件批（4–5 批）各跑 L1 |
| B 域 defineRoute parse 迁移 | ±0（纪律收口） | 存量 44 处内联 readJson；分 4 批（写核心/配置/AI 编排/其余）——此批不为减行 |
| 临时目录清理双轨收敛 | 测试侧 ~1k 量级 | 现状实测：裸 mkdtempSync 506 处/341 文件 vs 托管 590 处/246 文件（台账 §三 G 既有单立批，数字本批更新） |

### 低优先登记（收益/风险比一般或随重构批）

- yaml.ts 补丁族公共 helper（−30~35，字节级保形路径，rc 后重构批）；service.ts 锁样板 helper（−30，锁序敏感面）；documents.ts runX 五处样板（−30~40，伏笔串行链 09-09/09-10 刚收口的并发关键路径）；win-fonts/font-cache spawn 骨架收敛（−30~40，kill 竞态文案被测试钉死需参数化）；SRV-N3 lensToRole（5+10，先核 review 端点是否本应经它选角色文件）；C2 CSS 重复族（composer 孪生 −34·刻意契约/`.panel`×8 −63/`.btn`×13 −45——scoped→全局类名唯一性须先核）；isPlaceholder/avg 同体微收敛（−4/−2）；档三结构项（13 件大文件拆分、ai↔studio 解环、main.test 拆分）维持重评-0911b 建议不变。
- 测试侧本轮清点：**零新增死件**（1080 文件四层机械核对：import 目标存在性/命名导入对照/mock 路径/字符串引用），无主 skip = 0（check-counts 静态门结构性防新增），scripts/ 零死脚本（calibrate-tokens 头注自记手动工具，有意保留）。

## 六、L2 终门九件套实测（主审亲跑，2026-09-12，win 口径，收口态）

vitest **1050 文件 = 6739 过 + 80 跳 0 败**〔320.04s〕（基线 9d78e6fe：1051/6743+80——文件 −1〔删 3 死文件 + 增 1 锚测试〕/用例净 −4〔删 ~24 死件用例 + 新增 20 锚用例〕）+ tsc/vue-tsc 0 错 + eslint **0 err/0 warn**（--max-warnings 0 门）+ 三 check 过（counts 1050/6739 + 29 spec/45 用例对账一致；packaging；knowledge 13 条一致）+ build:web 过 + e2e **43 过 2 跳**〔46.0s，reporter 零报错〕+ soak 两段绿（有界往返 10 万次 −0.02MB / RAG 召回 2 万次 +0.06MB，上界 24MB）。根 README 修账 1051/6818 → **1050/6814** 四处 + win 实跑口径句更新（差值 75 锚保持）。

## 七、处置建议

1. **catalog 拍板**（§五首项）：最大单块 ~454 行，零消费 + 全可再生——建议删除，A7 若落地一命令复活；如作者倾向挂 A7，请在台账 H 行明示时点。
2. **三大机械批单独立批**：TTL 缓存族（−110）/ resolveBook 72 处（−65）/ defineRoute 44 处（纪律）——各有先统一口径/分文件 L1 的前置，不适合混入其他批。
3. **档三结构项**维持重评-0911b §四建议（大文件拆分随重构批、ai↔studio 解环单立）。
4. 本报告收口条件已满足（执行落地 + L2 全绿），归档时点待作者定；残余登记正本 = 本报告 §五 + 台账 H 节（本批已同步改写）。

---

*本报告为检视 + 执行一体交付物；执行明细以源文件 r0911- 锚注释与 git 工作树 diff 为准（零提交，工作树留作者）。*
