# 全量代码重审与进度质量评估（评审）

> **归档记**（2026-09-11 归档批，作者指令「已经完成的文档，归档。」）：本报告已收口，自 `01-评审/` 移入 `Archive/`（扁平）；台账 §一 原行随批冻结 `Archive/台账历史明细-归档-2026-09-08.md`；历史正文不改写，开放残留项以台账 §三 现行为准。

- 日期：2026-09-09
- 执行模型：GLM-5.3（builtin:bigmodel-coding-plan/GLM-5.3，主审 = 会话模型）；九路评审子代理同模型，不另列
- 基线：dev HEAD `8aaae5d6`，工作树干净；评审全程只读，未改任何文件、未跑被评审代码以外的写操作
- 性质：**全量独立重评**——按作者指令「忽略现有的评审文档，重新评审一遍项目所有代码」。九路子代理与主审全程**禁读** `Dev/Main/01-评审/`、`Dev/Main/Archive/` 全部文档与台账历史评审引用；对照输入仅限代码本身 + 计划类正本（根 `README.md`、`Dev/Main/README.md`、`00-总览与实施路线-2026-08-15.md`、`00-未收口与挂账-台账-2026-09-04.md`、`package.json`）
- 方法：① 主审亲跑客观质量门（typecheck / lint / vitest 全量 / 三 check / e2e）；② 九路领域深度评审子代理（general-purpose×7：AI 链路 / 服务端 / 文档格式 / 桌面壳 / 前端核心 / 前端组件 / 知识RAG工具链；Explore×2：测试体系与工程配置、计划-代码进度对照——后者在派发上限调整与限流重发后补齐）；③ 主审对**全部 P1/P2 逐条 file:line 亲验**、P3 抽验后收录
- 规模底数：`src/` 104,037 行（465 个 .ts/.vue，不含 .d.ts）——其中 web-next 前端 38.0k、AI 链路 13.4k、服务端 12.0k、文档/格式/写作编排 18.4k、桌面壳 4.4k、知识/RAG/校验/工具链 ~17k；测试 1,019 个文件（990 单测 + 29 e2e spec）

## 一、结论速览

| 维度 | 结论 |
|---|---|
| **完成进度** | **≈95%（区间 93–97%）**——计划承诺的 27 个功能面全部有真实成品实现（防御深度远超骨架级）；唯一「计划有、代码无」的主体块 = 阶段 24 章节结构操作（方案已拍板落盘、实施待作者指令，与总览口径一致）；知识层管线闭合但素材以占位为主；台账 6 项开放挂账与代码实况逐条吻合，**无完成度注水** |
| **完成质量** | **A-**——客观门全绿（vitest 990 文件 = 6,437 过 + 4 跳 0 败；tsc/vue-tsc/eslint 0 错；三 check 过；e2e 43 过 + 2 跳）；正文资产保护链（原子写 + journal + 快照 + 回收站 + 乐观锁）与并发防御纵深（TOCTOU 复验 / 代数守卫 / 跨进程锁族）为同类项目罕见水平；扣分在 P1×1 + P2×6 与单文件体量 |
| **问题总量** | **P1×1 + P2×6 + P3×42**。P1 = 前端启动直进死代码（lastBook 恢复与 `--book` 首启直进恒不触发，回归测试 mock 钉死死行为——主审亲验成立）；P2 中 3 条为代码内已记档缺口本轮复核确认（A7 未接线 / PM-10 全量读 / 锁超时降级裸写×4），3 条为本轮新发现（chat 重连不收尾气泡 / manifest 锁重入不变量靠纪律 / quit 路径不落窗口状态） |
| **收口条件** | ~~未收口~~ → **已收口（2026-09-09 修复批同日办结，收口记 §九）** |

## 二、客观质量门（主审亲跑，2026-09-09）

| 门 | 命令 | 结果 |
|---|---|---|
| 根类型检查 | `tsc --noEmit` | 0 错 |
| 前端类型检查 | `typecheck:web-next`（vue-tsc） | 0 错 |
| Lint | `eslint .` | 0 错 0 警 |
| 三 check | `check:counts` / `check:packaging` / `check:knowledge` | 全过（counts 与根 README 对账一致） |
| 单测全量 | `vitest run` | **990 文件 = 6,437 过 + 4 跳 0 败**（152.03s） |
| e2e | `playwright test`（build:web 产物） | **43 过 + 2 跳**（27.5s） |

九件套与上一批收口记口径一致，无回退。

## 三、完成进度评估（93–97%，中值 ≈95%）

### 3.1 计划-代码对照结论

从五份计划正本提取 30 项功能面逐一核实（证据为 file:line 级，全表存评审过程记录，此处摘要）：

- **已实现（27 项，权重 ~95%）**：建书引导、设定表单/大纲、CM6 编辑器（自动保存 + 409 冲突二出路 + 快照恢复）、全自动写章（self-heal 报红打回闭环）、机检六面、长短篇三审、定稿 + 防吃书闸、伏笔追踪、字数曲线双轨、文风系统、选中改写/分析、对话助手（agent 工具 + 确认闸）、版本快照、RAG、导出（含批注剥除）、书库/换机迁移/LF+BOM 规范化/坚果云冲突检测、三协议 provider（含信封加密）、事件审计、安全四层（loopback + Host 精确匹配 + Origin 白名单 + SSE ticket）、win NSIS 适配、mac dmg 打包、字体系统（枚举熔断 + 排版预设组）、学习/语料/知识层管线、用量成本统计——全部为带防御细节的成品实现，非骨架。
- **仅方案未实施（1 项，权重 3–5%）**：**阶段 24 章节结构操作**——`structure.merge/split/renumber` 全 src 零命中，现有树操作仅新建/重命名/移动/删除（`useChapterTreeActions.ts:17-20`）；与总览「执行方案已落盘、实施待作者指令」完全一致，属**待开工而非烂尾**。
- **知识层内容（部分）**：管线（manifest 校验 / commit 登记 / CI 对账门）完整闭合，但 `知识层/` 素材多为 scaffold 占位——「能力就绪、内容待养」，不计入代码缺口、计入运营成熟度。
- **台账挂账 6 项与代码逐条吻合**：P3-4 SSE `?token=` 兼容通道仍在（移除条件未满足）、P3-5 audit 折叠暂缓、P3-6 parse 迁移在途、P3-20 读侧关联词待拍板、PM-10 尾读未立项、PM-12 kill 未接线（熔断已生效）。

### 3.2 计划-代码偏差（仅列核实过的）

- **文档漂移 1 处**：P3-6 存量数字三处不互洽——台账「45 处」、`api/schema.ts:12` 注释「104 处」、实测 api 目录内联 `readJson` 引用 77 行。方向一致（迁移确在途），数字口径未统一，属文档漂移非虚报。
- **抽查的「已完成」声明与代码全部一致**，未发现虚报完成。
- **代码有、计划未提**：人物关系图（RelationsView 族）、文档回收站（trash.ts + 三端点 + TrashPanel）、对话分支管理（branch-tree + chat-branches）、打字机模式、命令面板、专注模式、启动通知——一级能力面未入根 README/总览，建议随下一批文档整理收编（不影响完成度判定，只影响能力清单完整性）。

## 四、完成质量评估（分域）

| 域 | 架构 | 错误处理 | 类型 | 可维护性 | 一句话 |
|---|---|---|---|---|---|
| AI 链路（src/ai + driver + events + prompts） | A | A- | B+ | B+ | 分层单向依赖 + 失败决策表 + 事件溯源单源；「模型可见⟺已记录」工程闭环完整；单体偏大 + 5 处同源双实现 |
| 服务端（src/studio/server） | A- | A- | B+ | B | TOCTOU 防御纵深教科书级；统一错误信封 + 密钥卫生；读侧缓存族 5+ 同构变体 |
| 文档与格式（document/format/process/export） | A- | A | B+ | A- | 正文资产 fail-closed 保护链基本无懈可击；锁序全仓统一；三套章定位并存 |
| 桌面壳（desktop + 打包） | A | A- | B+ | B+ | server 生命周期显式状态机 + 停机不变量机制化；「编辑永不静默丢失」三链体系；main.ts 1967 行认知负担重 |
| 前端核心（stores/api/composables/editor） | A- | A- | B+ | B | 代数守卫纪律贯穿 13 store；脏镜像崩溃恢复体系完整；P1 死代码 + chat 收尾缺口 |
| 前端组件（components/views/pages） | A | A | A- | A- | View 收口编排态 / 组件纯受控分层严明；IME 守卫全链覆盖；长列表渲染预算意识全域一致 |
| 知识/RAG/校验/工具链 | A | A | A- | A- | 「脚本层确定性判定 vs 宿主模型调用」分离；崩溃/并发面防御纵深完整；「假通过」系统性封堵 |
| 测试体系与工程配置 | A- | — | A-（tsconfig 顶格） | A- | 行为级断言 + 四重机器门防假绿；CI 三 OS 矩阵 + 打包态冒烟；dev 分支 CI 空窗 + 单 chromium 腿 |

**总评 A-**：以「200 万字不崩、数据不丢、全程可回溯」三条产品红线衡量——数据面（原子写/journal/快照/回收站/乐观锁）与可回溯面（事件溯源/promptFiles 注入登记/审计）是最厚的两块；前端数据消费面（本轮 P1 所在）与个别「已记档待接线」缺口是当前短板。

## 五、问题清单

> 分级：P1 = 确定性缺陷（核心功能错误）；P2 = 显著缺陷或高风险；P3 = 轻微/代码健康。P1/P2 全部经主审亲验 file:line；P3 为子代理确证 + 主审抽验。

### 5.1 P1×1（主审亲验成立）

**P1-1 启动直进死代码：lastBook 恢复与 `--book` 首启直进在真实路由下恒不触发**
- 位置：`src/studio/web-next/src/App.vue:61-65` + `src/studio/web-next/src/router.ts:8`
- 机理：`router.ts:8` 配置 `{ path: '/', redirect: '/shelf' }`；vue-router 4 的 `isReady()` 在初始导航（**含 redirect**）完成后 resolve，此刻 `currentRoute.value.path` 必为 `/shelf`，`App.vue:62` 的 `=== '/'` 恒假。
- 影响链：① lastBook 恢复直进失效——`LAST_BOOK_KEY` 全库唯一读点即 `App.vue:51`（写侧 Shelf.vue:68 / ShelfModal.vue:94 活着，读侧死代码）；② `--book` 首启直进失效——`desktop/main.ts:1080` → `/api/boot` → `getLastInitialBook` 同样汇入此死分支。净效果：**应用启动永远落 /shelf**，注释宣称的「initialBook > lastBook > 默认 /shelf」三级（App.vue:47）前两级确定性失效。二次实例 `--book` 不受影响（走 `desktop:navigate` IPC → `router.push`，App.vue:37-39）。
- 回归测试钉死死行为：`test/studio/webnext/r50-d1-app-lastbook-route.test.ts:22-47` 整体 mock vue-router（`isReady` 空转、`currentRoute` 手持 `'/'`），从未经过真实 redirect 链；其用例 2 标题自认「redirect 到 /shelf → 不 replace」——而那正是真实环境的唯一路径。
- 修复方向：判据改 `currentRoute.value.redirectedFrom?.path === '/'`（或 router install 前记录初始 URL）；回归测试改走真实 router 实例或 mock 建模 redirect 语义。

### 5.2 P2×6（主审亲验/抽验成立）

**P2-1 chat SSE 重连 sync 快照不收尾在途气泡：永久「生成中」+ 破坏恢复不变量**〔新发现，亲验〕
- `src/studio/web-next/src/stores/chat.ts:187-197`：重连收到 `chatRunning=false` 只复位 `running`/`regenPending`，未对齐 `chat_error` 的收尾口径（chat.ts:300-308 显式 `done=true` + `currentIdx=-1`，注释自明「防永久生成中+后续文本错位」）。
- 服务端重连必补快照（`src/studio/server/api/stream.ts:498`），漏收 `chat_done/chat_error` 后重连即触发：`ChatMessages.vue:203` 对未 done 气泡永久渲染 typing；`:109-112` 重新生成按钮要求 `last.done` 被锁死；更深一层——「未完成气泡只属于在途回合」的 P2-9 恢复前提（chat.ts:200-215）被打破，此后运行中新回合 + 错过 `chat_turn` 的重连会把新回合文本追加进旧气泡（跨回合并文）。workbench 的 sync 分支已正确做残留复位，唯 chat 缺口。

**P2-2 manifest 锁重入分支对 async fn 同进程互斥失效，不变量仅靠注释纪律**〔新发现，亲验〕
- `src/document/manifest.ts:401-418`（R43-10）：重入命中直接执行 fn 不排队；fn 一旦含 await，同进程同 key 并发按「重入」放行交错，RMW 可静默吞写。当前生产调用方（service/trash/state/finalize/draft-pipeline）经 grep 核实全为同步 fn，防线成立但**靠纪律不靠机制**；跨进程锁仍覆盖、未装断言的原因自记（R35-25 测试用例合法用 async fn）。建议：重入分支同样排队，或拆「同步 fn 专用快道 + async fn 强制走完整互斥」。

**P2-3 quit 路径不落窗口状态：Cmd+Q / 菜单退出 / 切库 relaunch 的窗口几何变更丢失**〔新发现，亲验〕
- `src/desktop/main.ts`：`saveWinState` 全文件仅 :1133（close 拦截）与 :1248（session-end）两个调用点；before-quit 退出链（:1852-1956）收口 `destroy()` 全窗（:1931-1937）——destroy 不触发 'close'，链内无任何 saveWinState。macOS Cmd+Q 是最高频退出方式。内容数据无涉（窗口状态自归类非关键数据），列 P2 低危。

**P2-4 shrink-prompt / switch-provider 失败决策无消费者（A7 未接线）：超窗 400 后会话卡死**〔代码已记档缺口，复核确认〕
- `src/ai/provider/failure.ts:91-96` 自记「A7 接线前无消费者」；`runner.ts:683/716` 消费侧只分 retry/终态两支；`turns.ts:526/566` 注释自认 fail-open 原样发送。小窗模型 + 长历史场景：防线 fail-open 放行 → 持续 400 → 会话卡死，只能人工清历史/换话题。R55-C-1 发送前预算预切已缓解常发路径，残余为兜底无自动恢复。当前最大功能缺口。

**P2-5 统计聚合全量载入 llm/call 行，随书龄线性增长**〔PM-10 台账既有，复核确认〕
- `src/ai/cost-stats.ts:70-73`、`src/ai/trace-stats.ts:82`：每次统计请求全量取行后内存聚合（type 已 SQL 下推，行级 JSON.parse 仍全量；PM-10 注释自记「全量语义必需、无尾读空间」）。2M 字长书累计数万次调用后，统计面板内存峰值与延迟线性上涨。伸缩性风险，非当前缺陷。

**P2-6 四处跨进程锁超时降级裸写/裸跑：条件触发重开并发写窗口**〔代码已记档取舍，抽验 journal 确认〕
- `src/document/journal.ts` appendLineAsync（锁超时降级裸写 + 快照截断收敛，R31-21）、`src/document/analysis.ts` writeAnalysisAsync（同款）、`src/document/words-diary.ts` compact 复核-rename µs 窗、`src/process/lead-update-draft.ts:56`（超时降级无锁「归档+覆写」）。触发条件 = 双进程争锁 >5s（当前单作者桌面形态概率极低），后果均已在代码内如实定性（AI 派生可重跑 / lead-update 有 R74-4 快照兜底）。**已知取舍汇总登记**，列为该域最深残余风险面。

### 5.3 P3×42（分域摘要，均子代理确证）

**AI 链路（5）**：① 码点计量同源双实现（prompts/chat.ts:243 与 compaction.ts:64 互不引用）；② check 域口径「逐字移植」无防漂移约束（rules/setting-rule.ts:147-174，R48-3 同型漂移复发风险）；③ 观测层读侧双实现（cost-stats/trace-stats 同构 readLlmCalls）；④ 遮蔽区间连续性假设隐性依赖 per-book 并发锁（events/chat-bridge.ts:264-277）；⑤ mock driver 与 cc driver 行为分叉（无 execRing/队列上限，测试面与生产差异）。

**服务端（5）**：① 伏笔差分事件读在串行队列外，并发保存重复计窗（documents.ts:149-155，仅审计层冗余）；② 跨进程 PUT 残窗代码自认记档（files.ts:288 B-22）；③ 路由 schema 注册表模块级单例，双实例测试形态自省面漂移（schema.ts:45-58）；④ 两探缓存不对称（analysis.ts:160 vs snapshots.ts:316，R44-9① 只落一侧）；⑤ learn-commit 条目数无逐项上限（knowledge.ts:102-104）+ onboard.ts:173 缩进异常。

**文档与格式（6）**：① 三套「按章号找正文」并存且口径不一（prepare.ts:36 / summary.ts:156 / materials.ts:57）；② 导出在定稿清单缺失时不过滤且成功路径零提示（export/index.ts:281）；③ `正文 #% 批注` 行中形态不剥（export/index.ts:101，已登记待批注语法下线）；④ RAG 召回 offset 时效性跨域依赖 rag 指纹（materials.ts:45）；⑤ TOKEN_COEFFICIENTS 空表恒走 0.6 兜底（prepare.ts:119，R26-106 待语料拟合）；⑥ 同步/异步孪生双实现面多处。

**桌面壳（5）**：① restartPinned 在途 start 一路 reject 逃逸「失败 resolve null」契约（server-manager.ts:687）；② asar 打进冗余 node_modules（electron-builder.yml files 未排除）；③ desktop.d.ts:41 showContextMenu items.key 声明必填、实际可选（类型严于运行）；④ `desktop:set-titlebar-overlay` 失败信封类型面不可见（main.ts:1577 vs desktop.d.ts:31）；⑤ mac/linux 字体枚举超时不杀子进程（font-cache.ts:279-284，PM-12 挂账确认仍成立）。

**前端核心（5）**：① doc.ts:625-628 死代码 + 误导缩进（恒假守卫）；② refresh 脏分支收编服务端基线 → 外部改动被 last-writer-wins 静默覆盖（doc.ts:546-559，已记载权衡）；③ 每击键一次全文 O(n) 物化（CmHost.vue:182，设计下限 R39-20，长线性能债）；④ 书架缓存失效仅 console.warn 无 UI（shelf.ts:96-100）；⑤ 切文档时 void autosave 失败不可见（workspace.ts:237-244）。

**前端组件（7）**：① EditorDocHead.vue:202 `Number(fm章号 || …)` NaN 穿透（仅 fm 已损坏时触发，章号置空非崩溃）；② ContextMenu 浏览器回退面无 roving 导航（桌面原生路径完整）；③ ModelPicker 候选清单无渲染上限（对齐 FontPicker 的 content-visibility 缺失）；④ v-for index key ×3（OverviewView 口癖 tags / AuditGoalTodoPanel:33 / StyleAcceptancePanel:165,169，均静态数组无实害）；⑤ SettingsBookWriting.vue:135 未走统一 parseNumericInput helper；⑥ AuditView doClear catch 无 alive 复检（Vue 3 无实害）；⑦ TabBar 命名残留（标签页功能已移除）。

**知识/RAG/工具链（3）**：① recall 侧去重口径注释漂移（rag/index.ts:901，实现已改注释漏改）；② truncated 标记 warnThreshold+1 边界误报（rag/index.ts:882-890，不丢数据）；③ harvest-corpus.ts:169 章文件 TOCTOU 读失败裸崩（同文件单版快照已有守卫，此处漏配同款）。

**测试与工程（6）**：① 少量固定 sleep（chat-open-store-fail.test.ts:106 等 4 处，与「竞速轮询化」家规不一致）；② 真实 TTL 用真 1.5s sleep ×6 处拖慢全量；③ test/studio 顶层 174 文件回归编号平铺不表意；④ dev 分支 CI 空窗（ci.yml:11-15，本仓恰以 dev 为工作分支）；⑤ e2e 共享 workDir 顺序耦合固有脆弱性（已有 spec-order 快照守卫缓解）；⑥ webnext 聚合桶 lines 43 偏松（stores/api 子桶 89/87 已补关键面）。

## 六、亮点（跨域汇总）

1. **正文资产保护链**：tmp+fsync+rename+目录 fsync 原子写 → journal 三态崩溃恢复 → 分层快照 → 回收站 → 乐观锁 409 双出路 → 非 UTF-8 fail-closed 拒写 → 「归档不删」导出哲学——「数据不丢」红线在写侧系统性闭合，且是全仓测试最密的域。
2. **「模型可见 ⟺ 已记录」工程闭环**：visibleInjectionsFromDigests 单源 → 三形状登记与注入条件镜像 → verifyVisibleRecorded 校验器 → CLW_VERIFY_VISIBLE 生产抽查 → promptFiles 覆盖 overlay/rules/spill/整章正文——AI 供应链可审计性落地为基础设施，非口号。
3. **并发防御纵深两种范式**：服务端/文档域「同步取闸 + await 后复验 + 排水 + 临界段内重验」的 TOCTOU 闭环；前端「入口捕获 + 代数守卫（opGen/bookGen/seedGen/connectGen）丢陈旧响应」纪律——分别治跨进程与 SPA 时序污染，全域无例外贯彻。
4. **测试体系对假绿的四重机器门**：.only/无条件 .skip 拒绝、零断言文件门、e2e pageerror 接线静态门、README 数字对账门——且门本身有 governance 测试防退化；AI 边界 mock 策略「真边界、假外部」（进程内 HTTP stub 吐真 SSE 帧，adapter/runner 全链真跑）。
5. **注释即审计日志**：全仓修改带轮次编号 + 根因 + 量化影响（R26→R77 链条可考古），本轮多条「已记档取舍」正是靠内嵌注释自证——可追溯性为同类项目罕见水平（代价：注释体量本身构成阅读负担，P3 中两条「注释与实现漂移」即该文化的已知成本）。

## 七、处置建议

- **必修（收口条件）**：P1-1（启动直进死代码——判据改 redirectedFrom + 回归测试改真实路由链）；P2-1（chat sync 收尾对齐 chat_error 口径）；P2-2（manifest 重入排队或断言）；P2-3（quit 链补 saveWinState 或统一收口点）。
- **建议随批收**：桌面壳 P3-①④（reject 逃逸契约 + 类型漂移两处）、前端组件 P3-①③（NaN 穿透 + ModelPicker 上限）、知识域 P3-③（harvest TOCTOU 守卫对齐同款）——改动小、方向明确。
- **维持登记（既有台账项不动）**：P2-4（A7 单独立项）、P2-5（PM-10 已登记待拍板）、P2-6（四处已记档取舍）、桌面壳 P3-⑤（PM-12 既有）、测试 P3-④（dev CI 空窗——建议作者拍板是否恢复 dev push 腿）。
- **文档面**：P3-6 存量数字三处口径统一（45/104/77）；「代码有、计划未提」能力清单（关系图/回收站/对话分支/打字机/命令面板）建议随下一批收编根 README。

## 八、收口口径

- ~~本报告**未收口**：P1×1 + P2×6（其中必修 4 条）+ 回归通过后收口；残留 P3 随收口批登记台账 §三。~~（已按此口径收口，见 §九）
- 评审独立性声明：本轮全程未读既有评审/归档文档；与既有报告的结论重合（若有）系独立重评的交叉验证，非沿用。

## 九、收口记（2026-09-09 修复批）

作者指令「开始修复，全部修复」。P1×1 + P2 必修×3 全修 + P3 随批收 22 条，L2 终门全绿，本报告**同日收口**。

### 9.1 执行方式

两波八路文件互斥并发代理 + 主审逐 diff 复核（P1/P2 全文核 + P3 抽核）+ 主审三处直接修正。执行中断如实记档：会话两度换模型 + 两轮限流，波 2 三路（E/F/G）取消后原样重发，E 接手时发现自身前次运行已落盘 2 项（RAG 注释/truncated），核对语义后以测试验证收编、未重做。

- **波 1（必修）**：甲 P1-1 启动直进（App.vue 判据改 `redirectedFrom?.path === '/'` + 兜底；r50 回归测试重写为真实 vue-router 实例 + memory history 走完整 redirect 链——原 mock 钉死死行为的假绿一并拔除）/ 乙 P2-1 chat sync 收尾（对齐 chat_error R-7 口径：`!running && currentIdx>=0` → done + 复位索引，守住 P2-9 恢复前提）/ 丙 P2-2 manifest 锁（重入分支机制化分道：同步 fn 快道零语义变更，async fn 排队到持锁者链尾、释放前循环排空且无插入窗口，真递归死锁边界声明；R43-10 纪律声明废止）/ 丁 P2-3 quit 落窗口状态（quit flush IIFE 链首补 `saveWinState()`，全文件销毁路径三处覆盖核验；uncaughtException 崩溃路径刻意不补——保持与默认崩溃等价语义）。
- **波 2（P3 随批收 22 条）**：戊 AI+RAG+脚本 5（check 口径对拍测试防漂移 / readLlmCalls 单源化 llm-call-read.ts〔mock 面核查后零适配代价〕/ RAG recall 注释对齐 / truncated 边界判定 / harvest TOCTOU catch + 既有测试文件补回归 + 手工三态实跑记档）/ 己 服务端 5（伏笔差分 per-book 串行链〔红绿双向亲验〕/ learn-commit 400 上限 422 信封 / onboard 缩进 / schema 注册表 WeakMap 按表隔离 / analysis 探针 probeTs 节流）/ 庚 前端组件 6（EditorDocHead NaN 守卫 / ModelPicker RENDER_CAP=100 / v-for 复合键×3 / parseNumericInput 统一 / AuditView alive+gen 复检 / ContextMenu roving 键盘导航 8 用例）/ 辛 桌面壳+测试 4（restartPinned 契约收口 / desktop.d.ts 类型漂移×2〔如实标 `| void` 不虚构 ok:true〕/ 固定 sleep 轮询化×4〔含波 1 丁批 main.test×2〕）。

### 9.2 主审复核拦截（三处，均批内修正）

① `r50-d1-app-lastbook-route.test.ts` TS2307——真实 import 裸名 vue-router 从 test/ 目录解析不到包（R61-20 alias 只管运行时），改嵌套路径导入（同包入口同模块实例）；② `main.test.ts` TS18048——按仓内 `M.windows[...]!` 惯例补非空断言；③ **E 批回归拦截**：harvest TOCTOU 修复初版漏挂 `if (finalBody === null)` 守卫，pinned 锚定基准被现行正文无条件覆盖，「定稿后再改不改变判定」失守（全量轮 corpus-domain 用例红暴露）——补回守卫（有锚定章免读现行文件，TOCTOU 面同步收窄），相关面 19/19 复绿。

### 9.3 L2 终门（主审亲跑，官方轮）

tsc 0 错 + vue-tsc 0 错 + eslint 0/0 + 三 check 过〔counts 修账后对账一致〕+ **vitest 999 文件 = 6,488 过 + 4 跳 0 败**〔134.35s〕+ **e2e 43 过 + 2 跳**〔26.4s，含 build:web〕。改动面：36 文件修改 + 10 新增（9 测试文件 + llm-call-read.ts），+901/−269 后含主审修正；根 README 修账 990/6437→999/6488 四处（徽标/注释/门槛行/技术栈行）。

### 9.4 维持登记（不修，台账 §三）

**P2-4 A7 接线**（shrink-prompt/switch-provider 消费者）——功能性立项非缺陷修补，R55-C-1 预切已缓解常发路径；**P2-5** = PM-10 台账既有行不重复登记；**P2-6 四处锁超时降级**——代码已记档取舍，涉崩溃安全语义重设计，维持原状。批内新登记：documents.ts 同型快照-差分接线四处（PATCH fm/新建/软删/copy，:314/:337/:405/:425，己批偏离记档）/ index.ts:79 冗余 resetRouteSchemas（隔离结构下无害）/ preload.ts:76 注解未随 desktop.d.ts 收（正本已修）/ 桌面壳 asar 冗余 node_modules / 前端核心 P3×5 / 文档格式 P3×6 / AI 域 P3-1/4/5 / 测试工程 P3-②③⑤⑥；**dev 分支 CI 空窗待作者拍板**（是否恢复 dev push 腿）。
