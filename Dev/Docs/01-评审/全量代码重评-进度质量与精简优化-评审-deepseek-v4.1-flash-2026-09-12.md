# 全量代码重评-进度质量与精简优化-评审-deepseek-v4.1-flash-2026-09-12

- 日期：2026-09-12
- 执行模型（主审）：deepseek-v4.1-flash
- 子代理：general-purpose ×2（与主审同模型族；作者指令「子agent不要超过2个」，实跑串行、在途 ≤1）
- 评审对象：`win` 分支 HEAD `9342bf2d`（工作树含 2 篇未跟踪游离件，无在途代码改动；本批零代码改动）
- 作者指令：「忽略现有的评审文档，重新评审一遍项目所有代码，注意分析代码的优化和精简问题，最后告诉我项目完成进度，完成质量，结果形成一个文档给我。记得编排下任务，子agent不要超过2个。」
- 独立性：**主审与两个子代理全程未读 `Dev/Docs/**`（含 `01-评审/`、`Archive/`）**，结论一律以代码事实与亲跑实测为依据；与既有登记的重复识别由主审事后完成。
- 状态：**未收口**（处置建议见 §七）

---

## 一、评审对象规模（主审实测）

| 面 | 文件数 | 行数 | 注释率（实测） |
|---|---|---|---|
| `src/` 全部（排除 `node_modules`/`dist`） | 480 | **111,107** | — |
| ├ `ts` | 366 | 83,045 | — |
| ├ `vue` | 109 | 26,286 | — |
| └ `css` | 5 | 1,776 | — |
| `src/studio/web-next/src`（产品前端） | 201 | 40,330 | 15.7% |
| `src/studio/server`（服务端） | 50 | 12,807 | 30.8% |
| 后端与核心域（src 非 web-next 的 ts） | 276 | 71,013 | 33.2% |
| `test/`（全部） | 1,134 | **171,944** | 13.3% |
| └ `*.test.ts` | 1,088 | 168,033 | — |

其他实测事实：

- 注释率口径 = 首个非空白字符为 `//`、`/*`、`*` 的行计数（行尾注释计代码行，故为保守下限）。
- `src` 内 `any` / `as any` / `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`：**全部为 0**。
- `src` 内真实 `TODO` / `FIXME` / `HACK` / 未实装 / 待实现：**0 处**（13 处命中逐条读过，全是历史叙述、模板字面量或「未实现的 driver 退回旧语义」这类现状说明，无真实待办）。
- `>800` 行产品文件 **15 个**（合计 ≈15,800 行）：`desktop/main.ts` 2240、`document/service.ts` 2147、`events/store.ts` 1362、`format/yaml.ts` 1164、`state/state.ts` 1125、`check/count.ts` 1113、`server/api/stream.ts` 1097、`ai/orchestrate/self-heal.ts` 1070、`desktop/server-manager.ts` 1056、`rag/index.ts` 1004、`ai/orchestrate/chat/turns.ts` 957、`server/api/analysis.ts` 879、`stores/prefs.ts` 856、`server/api/books.ts` 848、`stores/doc.ts` 805。
- 计划内阶段 24（章节结构操作）**代码零足迹**：`structure.merge` / `并入` 键解析 / `renumber` 在 `src` 全 0 命中（与既有登记一致，独立复核成立）。

---

## 二、编排与执行

- 波次：**串行两子代理**（作者上限 2）。
  1. 后端与核心域代理（`src` 非 web-next + 根配置/CI/脚本）：实读 15 文件全文 + 约 32 文件逐段深读，自跑局部 vitest 1,424 例、`tsc --noEmit`，用时 ≈28min。
  2. 前端 + 服务端 + 测试面代理：实读 30+ 文件，自跑全量 vitest、两套 typecheck、`check:counts`，用时 ≈37min。
- 过程事故（如实记档）：首次并发派发两代理时 provider 返回 `server error` 双双失败；重试时第二路被取消（作者随后给出 RPM=10 约束）。**改为严格串行、一次一个**后两路均成功完成。
- 主审自跑 L2 九件套全量（§三），未委托子代理。
- 主审对码：对子代理报出的**每条 P1/P2 逐条读码复核**（§四），并对 4 项关键声明做了独立反证（含 2 项证伪/改判）。

---

## 三、客观门实测（主审亲跑，win 本机）

| 门（L2 九件套） | 结果 |
|---|---|
| `npx vitest run`（全量） | **1,088 文件 = 1,079 过 + 8 跳 + 1 失败**〔325.45s〕；**7,015 用例 = 6,930 过 + 85 跳** |
| 唯一失败 | `test/studio/error-envelope.test.ts` — `TypeError: fetch failed / Caused by: bad port`（环境触发，见 P2-1） |
| `npx tsc --noEmit` | **0 错** |
| `npm run typecheck:web-next`（vue-tsc） | **0 错** |
| `npx eslint . --max-warnings 0` | **0 error / 0 warning** |
| `npm run check:counts` | **过**（实测 1,088 测试文件 / 6,935 单测；29 e2e spec / 45 用例 —— 与 README 一致） |
| `npm run check:knowledge` | **过**（知识层 13 条 manifest 与磁盘一致） |
| `npm run check:packaging` | **过** |
| `npm run test:e2e` | **43 过 + 2 跳**〔54.6s〕 |
| `npm run soak` | **两段 OK**（有界往返 10 万次：8.25MB → 8.23MB，**−0.02MB**；RAG 召回 2 万次：8.76MB → 8.82MB，**+0.06MB**；上界 24MB） |

**跳数口径注记（如实对账）**：`check:counts` 对账的是 `vitest list` 静态枚举值（与 README 声称的 1,088/6,935 一致）；**实跑**时本机有 5 个**运行时能力门**（`canSymlink` / `permsReliable` / `gc`）落跳，故实跑为 6,930 过 + 85 跳，而 README 记为 win 期望 6,935 过 + 80 跳。总数同为 7,015，属文档已载的平台/环境口径差（win 恒差 75 锚的镜像），**非回归**。

---

## 四、对码裁定（子代理声明 vs 主审复核）

| # | 子代理声明 | 裁定 | 主审证据 |
|---|---|---|---|
| 1 | `books.ts` `readBooksStrict` 的 `statSync` catch 恒 `return []`，可与 `atomicWriteFile` 组合击穿 DA-3 防丢闸（P2） | **改判 P3** | `src/fs/atomic.ts:147-165`：tmp 落在 `dirname(filePath)` **同一目录**后 `renameWithRetry`。原声明的前提「EACCES 挡 `readFileSync` 不挡 `atomicWriteFile` 的 tmp+rename」不成立——同目录建 tmp 与 rename 需要同样的目录写权限，EACCES/EIO 场景下写同样失败。真实残留仅是「stat 与 read 两个 catch 的 errno 分流口径不一致」，无独立可利用窗。作者注释（`books.ts:111-113`）已自述此为有意兼容旧口径。 |
| 2 | `events/types.ts` 15 个事件载荷接口全仓零引用（≈85 行死代码） | **实锤** | 逐符号枚举外部引用：`UserMessageData` / `AssistantMessageData` / `ToolCallData` / `ToolResultData` / `TurnEndData` / `StepStartData` / `StepEndData` / `RevisionRefData` / `SettingsSnapshotData` / `SkillsSnapshotData` / `ForeshadowChangeData` / `AuthorSignalData` / `RuleHitData` / `RetryAttemptData` / `CheckReportData` **外部引用数全为 0**（`ChatEvent.data` 是 `Record<string, unknown>`，不引用它们）。**主审首次枚举曾因 win 路径分隔符导致 grep 过滤失效而得出「有 1 处引用」的假象，已纠正**。 |
| 3 | `overview.ts` / `settings.ts` 5 个 `ForTest` 钩子 + 2 组计数器为死代码 | **实锤** | 5 个符号全仓（src+test+scripts）引用数**恰为 1（仅定义行）**；`overviewScanCount += 1`（`overview.ts:119`）与 `settingsScanCount += 1`（`settings.ts:120`）**只写不读**。对照 `__setOverviewCacheTtlForTest` / `__rhythmScanCountForTest` 分别被 `r0912-ttl-write-clock` / `r44-rhythm-cache` 大量消费——确系该族收尾遗漏（缺回归门），而非有意形态。 |
| 4 | 三份 Worker 运行器（`cache/run-rebuild-async.ts`、`export/run-async.ts`、`studio/server/api/style-scan-async.ts`）可抽公共壳回收 70-100 行 | **实锤（估算上调）** | 三文件实测 100 / 86 / 73 = 259 行；两两去空行取交集后**共同行 32-34 行**（三对分别 34 / 32 / 32），重合面确凿。差异仅文案与超时值（120s/120s/60s）+ rebuild 的按 cachePath 单飞合并 + style-scan 的在途跟踪包裹——两处差异语义须保留。70-100 行回收区间成立。 |
| 5 | `DEFAULT_SHORT_CONFIG`（`metrics/short-index.ts:120`）与 `DEFAULT_SHORT_CHECKS`（`install/data.ts:70`）逐字重复 12 行 | **实锤** | 两表 10 个键值逐行比对**完全相同**（含 `profile`/`target_emotions`/`word_min` 等）；消费方已分叉（scaffold 直用 × metrics 展开覆盖）。 |
| 6 | 「裸 `startServer({port:0})` + `fetch`」在 OS 分配受限端口时整文件随机红，全库 13 文件 16 处（P2） | **实锤（本机独立复现）** | ① `netsh int ipv4 show dynamicport tcp` 实测本机动态段 = **1024 起 + 13,977 个**；② `test/helpers/safe-port.ts:21-27` 已内建受限端口黑名单并自述此根因，`startServerSafe` 被全库 122 文件采用；③ `test/studio/error-envelope.test.ts:106-109` 确为裸 `startServer({port:0})` + 紧接 `fetch(api/boot)`，而同文件 `:66` 已用 `startServerSafe` —— 迁移遗漏；④ 主审本轮全量实跑**唯一失败即此文件**，与声明完全吻合。 |
| 7 | `settings.ts` 补全名单端点 `books.completion-names` 无缓存且以整文件读实现 fm-only 抽取（P2） | **实锤** | `settings.ts:146-157` handler **同步**、无任何 cache 键，每次两遍 `readFmNames`；`readFmNames`（`:42-55`）调 `readFile(join(dir,f))` **不带 content 参数** → `src/format/frontmatter.ts:382-391` 走 `readFileSync(filePath,'utf-8')` **整读含角色卡正文**，只用 `fmRaw`。同文件 `getSettingsCached`（`:114-129`）已有「目录指纹 + TTL 5s + FIFO 32」缓存壳，同族端点唯此漏网。前端触发面确凿：`editor/CmHost.vue:398-409` 切书即拉、`:411-429` 5 分钟 TTL 过期后 @ 击键后台补拉。 |
| 8 | `files.ts:157` 是全库最后一处内联 `BOOK_MOVED` 拷贝，与单源口径文案漂移（P3） | **实锤** | `grep "code: 'BOOK_MOVED'"` 全 src 仅两处：单源 `book-context.ts:60/63` 与 `files.ts:157`。其余 7 族（documents/config/knowledge/style/settings/state + documents 的 `bookMovedFailureOk` 包装）均已收敛单源，文案逐字一致；唯 `files.ts` 保留旧文案「书目录刚被改名或删除，保存已取消……」。 |
| 9 | `useSse.ts:225-252` 的 `es.onerror` 读模块级共享 `es` 可能误伤新实例（存疑） | **维持存疑** | 代码形态属实（`es.onerror` 闭包读模块级 `es`，切书后 `es` 可已被新实例覆盖）。但按 HTML 规范 `EventSource.close()` 后不再派发 error，未构造出稳定复现路径。**零风险加固建议成立**（`const self = es` 或 `event.currentTarget`）。 |
| 10 | `OverviewView.vue:88-93` 的 `loadFs` 缺 `loadGen` 代守卫，切书可致跨书数据渗漏（存疑） | **证伪** | `OverviewView.vue:91` 实测**已有** `if (gen !== loadGen) return`；`:90` 头注亦载「R76-33 次级加载器补代守卫」。与 `loadRhythm` 的唯一差异是 catch 分支不置 `null`（有意「失败静默保留旧值」）。**不成立**。 |
| 11 | `snapshots.ts:392` 的 `versions-prune` 未接 `orchestrationBusyFor`（存疑） | **改判 P3·矩阵不对称** | `snapshots.ts:392` 确有 `acquireTaskGate(name,'versions-prune')` 且已入 `KNOWN_ACTIONS` 静态对账门。但 `orchestrationBusyFor` 的 10 个调用点（analysis×4 / outline / onboard / lead-updates / review / rewrite / settings）**不含** prune——即「生成类任务在途时能挡住 prune」这一方向缺失，而反方向（prune 持闸被删书/改名枚举到）已闭环。属单向矩阵不对称，见 P3。 |
| 12 | 前端 CSS 重复规则体 76 组 / 388 冗余份；`.spin` 14 处三档时长 | **实锤** | 主审抽验：`color: var(--text-error)` 单条规则体在 33 个文件出现；`.spin` 声明实测 **14 处**。另核实全局 `settings-shared.css`（797 行，经 `main.ts:13` 全局装载）已迫使两组件改名规避——`AuditDiffPanel.vue:90` `.audit-seg`、`StyleBaselineCard.vue:271` `.sb-seg`（注释自述「与 settings-shared 全局 .seg 同名异形，改名隔离」）。 |

**综合裁定：子代理报 P1×0、P2×3（声明）→ 主审实锤 P2×2 + 改判 P3×2（P2-1 与 P2-2 实锤、books 防丢闸与 versions-prune 降 P3）+ 存疑维持 1 + 存疑证伪 1。**

---

## 五、缺陷清单（主审裁定后）

### P1

**无。** 未发现任何可致数据丢失/安全越权/崩溃的必修缺陷；本批零代码改动，未在评审中新增代码。

### P2（2 条，均可一次提交修完）

**P2-1 · 测试装置端口抖动致全量假红（13 文件 / 16 处）**

- 位置：`test/studio/error-envelope.test.ts:106-109`（本轮实跑唯一红）；同族 13 文件（纯裸 6：`boot-token` / `r27-batch-c` / `r36-24-book-prefs-revision` / `server-reentrant` / `source-hash-race` / `startup-notices`；混用 7：`api-error-branches` / `api-integration` / `chat-branches` / `cov-server-config-draft-branches` / `cov-server-io-gate` / `error-envelope` / `stream-ticket`）。
- 证据：`error-envelope.test.ts:106` 裸 `startServer({ port: 0, workDir })` + `:109` 立即 `fetch(api/boot)`；同文件 `:66` 已用 `startServerSafe`。`safe-port.ts:21-27` 黑名单 + `:29-38` 重绑逻辑早已存在，被 122 文件采用。`netsh` 实测本机动态段 1024–15000（Windows 默认 49152–65535），与 fetch 受限端口表相交概率约 17/13,977 ≈ 0.12%/处，全库单次全量至少一红的期望概率 ≈1.9%。
- 影响：**本地/合并门偶发假红，CI 腿（默认动态段）不复现**——假红被当噪声、真回归被淹没；`check:counts` 与提交门可被阻塞。不影响产品运行时。
- 修法：13 文件的裸 `startServer({port:0})` 一律换 `await startServerSafe(...)`，并把「两行式 listen」合并为一行 await（`safe-port.ts:10-13` 已说明 listening 已发射、再挂 `once` 永不触发）；顺带在 `safe-port.ts` 加 `startServerSafeWithUrl()` 收敛 14 文件 17 处「listen + address + 拼 baseUrl」样板。约 +40 行改写（净 0 行）。

**P2-2 · 补全名单端点无缓存 + 整文件读（事件循环阻塞）**

- 位置：`src/studio/server/api/settings.ts:146-157`（路由）+ `:42-55`（`readFmNames`）。
- 证据：见 §四 #7。同步 handler，每次两遍整目录整文件读，只用 fm 段；同文件已有可复用的缓存壳范式（`:113-129`）。
- 影响：长篇书库（数百角色/物品，角色卡为自由正文 1–5KB）下每次调用同步阻塞事件循环 ≈80–200ms（子代理实测 800 个 3.6KB 文件仅整读 78ms，未含解析）；该窗口内 SSE 心跳、写稿事件推送与其他请求全部停顿。触发面 = 切书 + @ 键 5 分钟 TTL 补拉，属**用户可感知抖动**而非数据错误。
- 修法（推荐方案一）：复用同文件「目录指纹 + TTL 5s + FIFO 32」缓存壳，`readFmNames` 改 async + `fs/promises`（≈25 行新增 + 8 行改）；或方案二：`readFmNames` 只读到 fm 段结束即停（≈15 行）。**争议注记**：若按「无数据错误」口径可降 P3；主审因「核心写作流程用户可感知停顿 + 修法现成」维持 P2（低）。

### P3（择要；完整清单 = §六 分域登记）

| 编号 | 位置 | 结论 | 估行数 |
|---|---|---|---|
| P3-1 | `src/events/types.ts` 15 个零引用事件载荷接口 | 死代码（`ChatEvent.data` 为 `Record<string,unknown>`，不需这些形状）；可删或降为块注释 | −85 |
| P3-2 | `overview.ts:71-78`/`:119`、`settings.ts:76-79`/`:84-92`/`:120` | 5 个零引用 `ForTest` 钩子 + 2 组只写不读计数器（该族收尾遗漏：settings/overview 的 TTL 语义缺注入式回归门） | −24 |
| P3-3 | `src/ai/provider/tool-choice.ts:13`、`src/document/journal.ts:68` | 零引用类型别名 `ToolChoiceAction` / `JournalEntry` | −2 |
| P3-4 | `src/studio/web-next/src/api/foreshadows.ts:5-6` | 零引用类型 `ForeshadowStatus` / `ForeshadowPriority` | −2 |
| P3-5 | 三份 Worker 运行器（259 行，两两共同行 32-34） | 抽公共壳（须保 rebuild 单飞 / style-scan 在途跟踪两处差异） | −70~100 |
| P3-6 | `metrics/short-index.ts:120-130` ↔ `install/data.ts:70-81` | 12 行逐字相同的默认表并单源（须定依赖方向） | −12 |
| P3-7 | `src/install/books.ts:116-122` | `statSync` catch 恒返 `[]`（与下方 read 失败的 `null` 口径不一致）；作者已注为兼容旧行为，实际不可利用 | 4-6 |
| P3-8 | `src/studio/server/api/files.ts:157` | 全库最后一处内联 `BOOK_MOVED`，文案与单源漂移 | ~5 |
| P3-9 | `src/studio/server/api/snapshots.ts:392` | `versions-prune` 持闸但不查生成类在途闸（矩阵单向不对称；注释自述已修方向仅覆盖删除/改名枚举面） | ~5 |
| P3-10 | 前端 CSS 重复规则体 76 组（Σ(n−1)=388 份）+ `.spin` 14 处三档不统一 + `.sec-title` 5 处 + `.head-actions` 5 处 | 可抽 `utilities.css`；须动 60+ 文件与视觉回归 | −400~900 |
| P3-11 | `settings-shared.css`（797 行全局装载）通用短名越界 | 已迫使 2 组件改名规避；建议收 `#settings-root` 前缀收敛命名空间 | — |
| P3-12 | `src/studio/web-next/src/composables/useSse.ts:225-252` | `es.onerror` 读模块级 `es` 而非实例捕获（零风险加固 2 行） | 2 |
| P3-13 | 89 处「仅本文件内使用」的冗余导出（服务端 24 + 前端 63 + 其余） | 去 `export` 收窄公开面；0 行收益，可维护性收益 | 0 |
| P3-14 | 测试侧：本地 `sleep` 定义 28 份 / `await sleep(` 84 处 / 12 份本地 `waitFor` 未收敛 `helpers/wait-for.ts` | 时序债务；建议按既有口径轮询化 | ~40-60 |
| P3-15 | 15 个 >800 行产品文件 | **全部属「纯移动拆分」，净减 ≈0 行**（逐项复核：如 `service.ts` 五处 save 锁块仅 4 行共同样板，属结构性相似非字面重复，抽取反降可读性）；仅建议为可读性做纯移动，收益记 0 | 0 |
| P3-16 | 根 `README.md:116` win 期望口径 | 记「win 1088 文件 / **6935 过 + 80 跳**」，而主审本轮 win 实跑为「**6930 过 + 85 跳**」（总数同为 7,015）。差 5 = 运行时能力门（`canSymlink` / `permsReliable` / `gc`）未计入 README 的「实测差 75」模型（75 只建模 `skipIf(win32)` 平台门）。`check:counts` 校验静态枚举口径（1,088 / 6,935）故仍绿，**属文档口径微失准非回归** | ~1 |

---

## 六、精简总账（全域）

### 6.1 可直接回收（零行为变更，机械删除）

| 分档 | 内容 | 估行数 |
|---|---|---|
| 后端死代码 | 15 个零引用事件载荷接口（85）+ 5 个死钩子与 2 组空转计数器（24，含注释）+ 2 个零引用类型（2） | **≈106-115** |
| 前端/服务端死代码 | `ForeshadowStatus`/`ForeshadowPriority`（2）+ 冗余导出 89 处去 `export`（0 行） | **≈2** |
| 小计 | | **≈110-120 行** |

### 6.2 需小重构后回收（低风险）

| 项 | 估行数 |
|---|---|
| 三份 Worker 运行器抽公共壳（保两处差异语义） | 70-100 |
| `DEFAULT_SHORT_CONFIG` ↔ `DEFAULT_SHORT_CHECKS` 并单源 | 12 |
| 4 份 `errMsg`/`errStr` 局部助手收敛（`trash.ts:548` / `service.ts:2083` / `migrate-layout-v2.ts:253` / `rag/index.ts:154`） | ~9 |
| 测试侧时序 helper 收敛 + 本地 `waitFor` 归并 | 40-60 |
| **小计** | **≈130-180 行** |

### 6.3 需独立重构批（收益大但牵动面广）

| 项 | 规模 | 阻塞原因 |
|---|---|---|
| 前端 CSS 重复规则体合并（388 冗余份） | **400-900 行** | 需同步改 60+ 文件模板类名与 scoped 边界；e2e 29 spec 不覆盖全部面板，需视觉回归 |
| `settings-shared.css` 命名空间收敛 | 0 行（结构收益） | 需同步 2 处规避改名与消费方 |
| `server/api/*` 端点三元组样板、TTL 缓存壳泛型、`resolveBook` 双行样板 | 视批规模 0.6-0.8k | 项目已多次收敛，剩余为「形态相似但语义各异」，机械抽取降可读性 |
| 15 个 >800 行文件拆分 | **净减 0** | 纯移动 |

### 6.4 理论可剪但应走冻结件（**不建议直删**）

- 注释考古：后端 33.2%（23,543 行）/ 服务端 30.8% / 前端 15.7% / 测试面 13.3%（20,899 行，含 4,358 处 `R##` 轮次标记）。抽样核对结论：**多数注释承载现行不变量**（如 `preparedByDb` 先 delete 再 close 的 ephemeron 纪律、迁移前 checkpoint 的 WAL 侧车理由、DA-3 威胁模型、win `FlushFileBuffers` 需写权限故用 `'r+'`），**不可剪**。纯批次叙述部分需逐条判定「是否约束当前代码」，属项目级决策而非机械批处理——按 `CLAUDE.md` 纪律应剪出 `Archive/主题历史明细-归档-*.md` 冻结而非直删。上界估计 ~1,000-2,000 行，**[存疑]**（未逐行通读定量）。
- 结论：**本轮不建议任何注释批量删除动作**。

### 6.5 不建议动 / 有意保留

- `src/driver/mock.ts` ↔ `cc.ts` 约 146 行重合：头注自述「抽共享总线是大重构，另立项」；测试替身复用真实实现会失去独立判据（自证式测试）。
- `events/store.ts` 的 `Atomics.wait` 同步 WAL 退避（≤1.8s）：`PRAGMA busy_timeout=5000` 本身即同步等待，双轨化只增 DDL 漂移面。
- `KNOWN_ACTIONS`(17) / `CONFIG_PATCH_LEAVES`(46) 两张手工注册表：**有机器门守护**（`known-actions-audit` 集合+次数双对账；CONFIG_PATCH_LEAVES 4 测试）且零漂移，改自动发现反而丢失「新增必须显式登记」的强制评审点。
- 生产零调用但测试大量消费的入口（`openSessionStore` / `appendEvent` / `latestSession` / `readAllChunks` / `recordAiVersion` 同步版等）：**测试资产**，非死代码。
- `CheckPanel`/`ReviewPanel` 分文件 v-for 化、`useSse` ticket 回退通道、`settings-shared.css` 全局装载：均有文件内明确记档的有意取舍。

### 6.6 精简结论

产品侧可**立即**回收约 **110-120 行**（机械死码），低风险小重构再 **130-180 行**，CSS 族另有 **400-900 行**需独立批。**该库已处于「被多轮清偿过」的状态**——真实 `TODO` 为 0、`any` 为 0、门禁完备、死码仅剩收尾遗漏，剩余空间集中在 CSS 规则体重复与注释考古（后者按纪律走冻结件）。

---

## 七、进度与质量结论

### 7.1 完成进度：**≈97%**

| 面 | 完成度 | 判断依据 |
|---|---|---|
| 后端与核心域 | **96%** | 类型/静态层零妥协（`any`=0、`tsc` 0 错）；三侧布线锁键逐位一致；`prepared` 缓存仅两库且唯一关闭出口先 delete 再 close；崩溃恢复链（journal pending/settled/aborted + 移动 pending + trash 清单 + 迁移墓碑 + 开口标记续期）齐备；无未实装功能。扣分 = 死码收尾遗漏 + 注释密度 + 15 个巨型文件 |
| 服务端 | **97%** | 统一错误信封单出口；路径安全 fail-closed（`resolveWithinRoot` 双侧 realpath / Host 白名单防 DNS rebinding / 写闸 Origin+token 双闸 / 常量时间 token 比较）；闸矩阵有机器门守护；8 处 TTL 缓存全部 `ts: Date.now()` 写入当刻（前批修复零遗留）；`bookMovedFailure` 单源 + 7 消费者 |
| 前端 | **95%** | 生成代计数器体系完整（`bookGen`/`stateGen`/`connectGen`/`loadGen`/`compReqId`）；崩溃恢复闭环（镜像节流分档 + 指纹跳过 + 基线时效门 + LRU 命中重排）；乐观锁协议闭环（快照+基线+operationId，409→conflict，404→清镜像）；a11y 无 P1（`role="dialog"` 10 处 + `aria-modal` 9 处 + 焦点陷阱 9 件配对完整）；零裸空 catch |
| 测试工程 | **92%** | 1,088 测试文件 vs 276 src 文件 = 3.9:1；门禁强于常规（`.only`/无条件 skip 检出、零断言文件检出、e2e spec 顺序快照、pageerror 接线门、README 数字对账、覆盖阈值反向守卫）；soak 两段有界；真实 `.only` 0 处、`TODO` 0 处。扣分 = 端口抖动面 + 时序债务 + 5 个 >800 行测试文件 |
| 计划完成度 | **阶段 1-23 收口，阶段 24 未实施** | 阶段 24（章节结构操作）设计方案 + 执行方案已落盘待开工，**代码零足迹**（`structure.merge`/`并入`/`renumber` 全 0 命中，独立复核成立） |

**为何不是 100%**：① 阶段 24 这一唯一计划内开放任务尚未动工（方案齐备，等作者指令）；② P2×2 未修；③ 精简总账余量（CSS 族 + 低风险小重构）未回收；④ 若干「待拍板/单立」项（卷复盘产品语义、GUI 交互 e2e、DMG 打包态实机复验等）在册。

### 7.2 完成质量：**A−**

**加分项（本轮亲验）**：
- **零 P1**、零安全漏洞、零数据丢失路径；`any`/`@ts-ignore`/`@ts-nocheck` 全 0；
- 客观门九件套中八件全绿，唯一红为环境性测试装置抖动且根因已定位到 `file:line`；
- 崩溃/并发/持久化三面防线对称且成闭环（锁序 save→布线→清单、先 delete 再 close、EACCES 威胁模型、NFC/大小写归一三侧同口径）；
- R0912 中断语义族修复**在位零回归**（7 端点 `registerCtrl` owner 登记 + `/interrupt` 如实附 `interrupted` 字段，主审逐点复核）；
- 治理门禁的**真实性**经核验（`KNOWN_ACTIONS` 静态对账、`.only` 检出、spec 顺序快照、覆盖阈值反向守卫均为真门而非摆设）；
- 注释纪律：658 个 catch 中 123 个空体**全部带解释性注释**，无裸吞。

**扣分项**：
- P2×2（测试装置端口抖动致全量假红；补全名单端点同步整文件读阻塞事件循环）；
- 死码收尾遗漏（5 个死钩子 + 15 个死接口 + 冗余导出 89 处）——按「该族本有测试消费范式」判断属收尾欠账；
- 前端 CSS 重复 388 冗余份 + 全局样式表短名越界（已致 2 处改名规避）；
- 注释率偏高（后端 33.2%），轮次考古叙述抬高维护成本；
- 15 个 >800 行产品文件（其中 3 个超 1,300 行）；
- 测试时序债务（84 处 `await sleep(` + 12 份未收敛 `waitFor`）。

### 7.3 与既有登记的交叉（主审事后比对）

本批 2 条 P2 中：**P2-1（端口抖动）为全新发现**（既有登记载 `skipIf(win32)` 74 处、CI 四族等，但无「裸 startServer + fetch 端口黑名单」条目）；**P2-2（补全名单无缓存）为全新发现**（既有登记载 `settings GET MISS 全同步扫描` 一条，方向相近但对象不同——本条指 `completion-names` 端点，且已定位到「整文件读 + 无缓存 + 缓存壳范式就在同文件」三层证据）。P3 中 `events/types.ts` 死接口与「5 个死钩子」为全新；其余多为既有登记族的重证或新切面。

---

## 八、处置建议

> **范围裁定（2026-09-12 作者指令，本批落盘后追加）**：作者指示「同事正在精简测试，所以测试的部分我们先不管」——**凡落点在 `test/` 或为测试面服务的项一律暂缓**：P2-1（端口迁移，纯 `test/` 面）、P3-14（测试时序 helper 收敛）、5 个零引用 `ForTest` 钩子（`src` 内但删除或补回归门均与测试面耦合，留待与同事测试精简批协同决定）、P3-16（README win 期望口径——数字模型由测试面能力门构成，待同事批落地后一次性重同步）、以及 5 个 >800 行测试文件与 `.only`/skip 相关观察。**下文批 A 至批 D 的测试侧成分据此剔除**，产品侧条目维持原优先级：批 A 缩为「P2-2 + 产品侧机械死码」、批 B 缩为「Worker 运行器抽壳 + 默认表并单源 + 冗余导出收窄」。

| 批次 | 内容 | 规模 |
|---|---|---|
| **批 A（可立即开工，低风险）** | ~~P2-1 端口迁移~~〔**测试侧·已暂缓**（作者指令）〕+ P2-2 补全名单缓存壳（复用同文件范式）+ P3 机械死码（15 死接口 / 2 类型〔前端 2 型 + 后端 2 别名〕/ files.ts BOOK_MOVED 收敛 / books.ts errno 分流 / versions-prune 闸补向）；5 死钩子剔除待协同 | 产品侧 ≈6 文件；净 −115 行左右 |
| **批 B（低风险小重构）** | 三份 Worker 运行器抽公共壳 + 默认表并单源 + 冗余导出收窄 + 4 份 errMsg/errStr 收敛 + `useSse` 实例捕获加固；~~测试时序 helper 收敛~~〔**测试侧·已暂缓**〕 | ≈125-165 行 |
| **批 C（独立重构批）** | 前端 CSS `utilities.css` 抽取 + `settings-shared.css` 命名空间收敛 | 400-900 行；需视觉回归 |
| **批 D（不随批）** | 15 个巨型文件拆分（净减 0，仅可读性，含 5 个测试文件〔测试侧见上〕）+ 注释冻结（按纪律剪出 `Archive/` 冻结件，非直删） | 需作者拍板 |

---

## 九、附：本轮实测命令与产物

- `npx vitest run --reporter=basic`（全量，325.45s）
- `npx tsc --noEmit` / `npm run typecheck:web-next` / `npx eslint . --max-warnings 0`
- `npm run check:counts` / `npm run check:knowledge` / `npm run check:packaging`
- `npm run test:e2e`（43 过 2 跳，54.6s）/ `npm run soak`（两段 OK）
- `netsh int ipv4 show dynamicport tcp`（动态段 1024 + 13977）
- 全域死导出扫描（`export function` 全量枚举 + 跨 `src`/`test`/`scripts` 引用计数）、死类型/死接口逐符号枚举、CSS 重复规则体统计、`>800` 行文件清单

**本批零代码改动**：仅本报告落盘 + 文档链同步（`Dev/Docs/README.md` 计数、总览 §1.3、台账 §一、`Archive/README.md` 批记行）。工作树原有 2 篇未跟踪游离件（`01-评审/全量代码重审与进度质量评估-评审-deepseek-flash-2026-09-10.md`、`Archive/全量代码重审与进度质量评估-评审-deepseek-v4-flash-2026-09-09.md`）维持不动，处置仍待作者定夺。
