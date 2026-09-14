# 全库源码优化专项评审（优雅 · 简洁 · 高效）—— 2026-09-14

- 执行模型：GLM-5.3（主审 = 会话模型；两波 8 路文件互斥只读复核子代理同模型，不另列）。
- 作者指令：「忽略现有的评审文档，评审一遍项目源代码，本次重点为优化代码，达到优雅简洁高效！最后告诉我项目完成进度，完成质量，结果形成一个文档给我。」——零增量阅读既有评审报告，全库重新对码。
- 基线：HEAD `2510a1ec` + 工作树未提交改动（= 2026-09-14 mac 适配修复批后形态，该批 L2 终门已全绿）。
- 范围：`src/` 全量 481 文件 / 112,237 行（TS+Vue，排除 web-next/node_modules）。
- 编排：波 1 = R1 核心域（document/state/events/fs）/ R2 AI·处理链（ai/process/driver/rag/cache/metrics/knowledge/learn/review/export/git/log/shared/async）/ R3 studio 服务端（studio/server）/ R4 前端骨架（views/stores/composables/api/shared/types）；波 2 = R5 桌面壳（desktop+构建配置）/ R6 格式·机检·安装（format/check/install）/ R7 前端组件层（components/pages/editor/styles）/ R8 全库横切猎杀（grep 驱动十项量化）。单波 ≤4、文件互斥；主审亲验全部 P1 关键发现 + 实跑质量门。
- 门（主审 2026-09-14 实跑）：vitest 全量 **1123 文件全过 = 7261 过 + 7 跳 0 败**（140.58s）；tsc 0 错；vue-tsc 0 错；eslint `--max-warnings 0` 0/0。coverage / e2e / soak 未复跑，沿最近 L2 口径记档（2026-09-13/14 批：coverage 91.71/87.27/96.23/91.71、e2e 49 过 2 跳）。
- **收口补记（2026-09-14 优化修复批，作者指令「全部修复！」）**：P1×7 + P2 六域（A1–F7）全修 + P3 择收，零 git 提交工作树留作者，收口后随批归档 `Archive/`。编排 = 主审亲建基础件（`log/index.ts` errMsg 单源 / `shared/text.ts` codePointLength / `shared/testable.ts` testableConst 工厂）+ 三波 9 路文件互斥修复代理（在途 ≤4 全回收）+ 主审逐 diff 抽查关键风险点（withSaveLocks 失败路先释已得锁 + finally 逆序 / yaml 白名单 713 行字节级快照**先钉后改** / runFlushConfirm `skipConfirms` 改 thunk 保 R1010b-DSK-P2-1 时序 / F4 扫描数 4→2）+ **主审亲修两件漏派 P2 自纠**（D3 stream.ts chat 四端点 :916-1097 + chatEntryGateError 纯搬移 `api/chat.ts`，`forgetSseCount` 单向依赖无环，r26 测试 buildRoutes 随迁同注册；E7 `useLibraryIpc` 收编 Welcome/Library 双页，取错口径差异〔rawErrorMessage 透原文 vs friendlyError 归类〕与切当前书库 no-op 以 `formatError`/`currentPath` 注入保真）。落地实证（主审逐项 grep 亲验）：P1 = withSaveLocks ×4 调用点 / runGatedGeneration 7 文件（D4 映射随吞）/ createSerialChainMap 4 文件 / drainAndRecheckBookMutation / yaml `SECTION_SPECS` 表驱动 parse+stringify+patch 三面（`CONFIG_PATCH_LEAVES` 改派生，零白名单行为变化）/ locateTopSection ×4 处 / clearEventStores + revertToPrevBook；P2 = A1 errMsg 三目 **210→17 残量**（存量按域分批口径如实记）+ 前端 `rawErrorMessage` 单源 / A2 六处收编 / A3 sigStatFor 单源 rhythm.ts ×4 import / A4 testableConst 8 文件起步（全仓统一仍待作者拍板，如实记）/ A5 API_DEFAULT_TIMEOUT_MS 2→6 文件 / A6+A7 chapterNoFromName 下沉 `format/filename.ts` 宽集统一三源委托 / B1 孪生循环单源 / B2 queryEventRows / B3 死出口清理（appendEvent 等）/ B4 死 export 删 / C1 serializedLockedWrite / C2 fail() 闭包（手抄 11→2）/ C3 persistFinal 闭包组 / C4 死条件删 / C5 rag body 缓存 / C6 turns 共享前置 / C7 decryptConfs 泛型 / D1 createTtlProbeCache 16 壳（+12 用例）/ D2 resolveDraftByDocId / D3 chat.ts（亲修）/ E1 收 payload 版 / E2 PREF_ROWS 表驱动 33 键 / E3 切书守卫 stillIn/failScoped / E4 guardedWrite / E5 dirty-mirror / E6 useStaleGuard 31 文件 / E7 useLibraryIpc（亲修）/ F1 desktop 拆四模块 main.ts 2259→710 / F2 handleTrusted + runFlushConfirm + openSingletonWindow / F3 launchPinned / F4 tree-issues-cache 全局扫描 4→2 / F5 pushDegradedYellow / F6 removeBookEntryLocked + 一次读三 detect / F7 countOccurrences；P3 择收含 capView ×11 组件 / CHAPTER_STATUS 单表 / URL_PARSE_BASE 收编 / raceWithTimeout / CI 冒烟 sleep 25→轮询标记早退 等；**维持项**（WorkbenchView runBookAction、AuditView 对称双子、.cap-hint ×8、dispatch 线性扫描、ContextMenu isMacPlatform、stream-ticket TTL 壳特例、ShelfToolbar 全 prop 化降档、注释密度面）随本报告归档备查。门（修复后终门复跑）：vitest 全量 **1126 文件 = 7282 过 + 7 跳 0 败**（139.99s；净增 3 文件/+21 用例 = yaml-schema-snapshot 7 + r0914-ttl-cache 12 + r0914-gated-actions-audit 2，r26 测试随迁改 2 用例零漂移）+ tsc/vue-tsc 0 + eslint 0 + 三 check 过（根 README 修账 1123/7261→1126/7282 后 check:counts 绿）+ e2e 49 过 2 跳（39.9s）；coverage/soak/出包未复跑（沿最近 L2 记档 + CI 三腿矩阵兜底，如实记档）。

---

## 一、总判定

**优雅 8 / 10 · 简洁 6.5 / 10 · 高效 8.5 / 10**——防御性工程、留痕纪律与性能意识在同类代码库中属第一梯队；三维中**唯一失守面是「简洁」**：问题不在架构（架构分层极清晰），而在**横切样板靠复制而非抽象维持**——同一套逻辑在 5~210 处逐字重复，且历史注释里「照抄 / 漏补 / 此前漏登」的漂移事故实录，本身就是这些家族必须升为通用件的最好论据。

- 分级总账：**P1×7（结构性高价值）/ P2×26（应修）/ P3×30+（择优）**；全部为「优雅简洁高效」优化向发现，**零新 bug**（8 路子代理一致结论：未撞见任何未登记的生产缺陷；最接近项是一处同职责双实现的行为分叉，见 P2-A6）。
- 量化潜力：P1+P2 全修预计**净减 1,500~2,200 行**（约占 src 的 1.3%~2%），且消除四大家族的未来漂移面。
- 主审亲验实锤：errMsg 三目 **210 处**（grep 实测）；门控 handler 家族 `registerCtrl?.(session, ctrl` **×9**；`service.ts` 保存锁排比实为 **×4**（408/1040/1366/1511——比子代理所报 ×3 还多一处）；`Book.vue` 六 store 清空 **×5**；`codePointLength` ×5 文件；`sigStatFor` ×3 文件；死 export `__setSaveLockTimeoutForTest` 全库零调用方。

---

## 二、P1 —— 结构性高价值（7 项，全部主审对码属实）

### P1-1〔R1·核心域〕service.ts 保存锁+布线锁「acquire→null 检查→finally 逆序 release」排比 ×4

`src/document/service.ts:406-453 / 1038-1065 / 1364-1390 / 1511` 四处各 ~50 行同构（executeSave / updateChapterMetaLocked / updateDocMetaLocked / 结构保存），均为 `acquireCrossProcessLockAsync(\`${journalPath}.save.lock\`, …)` + wiringKey 副锁 + finally 逆序释放。**修法**：抽 `withSaveLocks(docId, relPath, opts, fn)` 高阶函数，四调用点各缩 ~40 行（约 −110 行）。锁语义回归面已厚（`cross-process-lock.ts` 语义逐位不变），中风险可测。

### P1-2〔R3·服务端〕长任务门控 handler 十段复制 ×9

`analysis.ts:425-507/520-590/604-667/702-845`、`rewrite.ts:103-188`、`outline.ts:69-150`、`settings.ts:257-328`、`lead-updates.ts`、`onboard.ts`（×2）——`orchestrationBusyFor → acquireTaskGate → getDriver → ensureSession → new AbortController → registerCtrl → finally{unregister+release}` 整段复制。**漂移实证**：注释自认「接法照抄 stream.ts」，R0912-P2-① 曾一次补 6 个端点的漏配。**修法**：`runGatedGeneration(name, action, workDir, fn)` 高阶包装（含 ctrl 注册/ABORTED→499 映射），~200 行收敛为 ~60。

### P1-3〔R3·服务端〕per-book 串行 Promise 链机制四胞胎

`documents.ts:176-190`（runInForeshadowSaveChain）/ `documents.ts:229-238`（enqueueStructureOp）/ `files.ts:239-248`（enqueueFilePut）/ `draft.ts:53-62`（enqueueDraftSave）——`prev.then(unit,unit)` + settled 吞错 + 身份校验自清理，另配三份几乎逐字相同的 ~25 行 `drainXxxUnder`。**修法**：`createSerialChainMap(key)` 通用件（enqueue/drainUnder/forget/keysForTest 四件套），~180 行 → ~60。

### P1-4〔R3·服务端〕books.ts 删书/改名排水段 55 行双拷贝

`books.ts:397-451`（delete）与 `:645-706`（rename）——abort → awaitOrchestrationsSettled → 5 连 drain → 复查 → busyGate，两段注释互写「同删书段口径」。第 6 个 drain 出现时须双处改（阶段 24 批 A 已真实加过第 5 个）。**修法**：抽 `drainAndRecheckBookMutation(ctx, name, verb)`，两 handler 各 1 行（~60 行净减）。

### P1-5〔R6·格式〕yaml.ts book.yaml 键知识三面平行维护——已两次实证漂移事故

`src/format/yaml.ts`：同一份键清单在 `sectionsToConfig`（172-566，逐段 findChild+parse+warn 手写 ~390 行）、`stringifyBookConfig`（657-822，逐键条件落行）、`CONFIG_PATCH_LEAVES`（1060-1111，50 条登记表）三处各写一遍。**漂移实证**：:1068 自注「D3 + C1 + A3 此前漏登白名单，PUT /config 改这些键会静默不落盘」、:1096 自注「R52-E-2：机检阈值五键此前漏登」——两次真实事故。**修法**：单一 schema 表（section/key/类型/校验器）驱动 parse+stringify+patch 三面（~250 行净减）；文件头 :10-12 已登记「随 rc 后重构批评估」，本轮建议落实。红线 = 返回形状与写入字节序不变（快照测试钉死）。

### P1-6〔R6·格式〕yaml.ts 补丁族三函数复制「段定位」骨架 + migrate-defaults 第四份

`patchTopSection`（871-877）/ `setTopSectionKey`（918-925）/ `setSectionKeyBlock`（987-994）各自重复段尾扫描与 childIndent 最小缩进循环（三处逐字相同）；`install/migrate-defaults.ts:117-145` 又抄第四份——R71-4 的 CRLF 修复因此被迫多处同改。**修法**：yaml.ts 导出 `locateTopSection(lines, section)` 单源，四处共用（~50 行，行为不变）。

### P1-7〔R7·前端〕Book.vue 切书守卫三连块 + Shelf↔ShelfModal 工具栏大面积重复

- `pages/Book.vue:133-252`：Z-8/F1/R37-1 三段「确认丢弃→取消回滚」守卫近乎逐字三连；6-store 清空列表（check/review/learn/style/rewrite/chat.clear()）文件内 **5 次**（112/152/205/239/256，主审亲验）。**修法**：抽 `clearEventStores()` + `revertToPrevBook()` 两个本地 helper（净删 ~70 行），后续加 store 不必改 5 处。
- `pages/Shelf.vue:103-168` 与 `components/ui/ShelfModal.vue:140-209`：搜索框/排序/视图切换/管理/主题/新建/批量操作条模板两份同构，`.btn` 9 规则块 ×2、`.toggle-btn` 5 块 ×2。**修法**：抽 `ShelfToolbar.vue` + `openBook` 并入 `useShelf`（净删 ~150 行，两处交互差异 prop 化）。

---

## 三、P2 —— 应修（26 项，按域归组）

### A. 跨域横切（最大收益面）

| # | 发现 | 证据 | 修法 / 量化 |
|---|---|---|---|
| A1 | **errMsg 三目 210 处无单源**（全库最大横切重复；热点 service.ts×11、summary.ts×10、self-heal.ts×10、main.ts×10） | grep 实测 210；`errMsg` 3 处私有互不引用；前端另有 errText/friendlyError 两套方言 | `src/log/` 落 `errMsg(e)` 单源，新代码强制 + 存量按域分批（82 处起步先收 AI 域） |
| A2 | codePointLength ×5 文件独立实现（summary.ts:68 已 export 却无人复用；chat.ts:61 / learn:152 / compaction.ts:65 / count.ts:243 各自私有） | grep 实测 | 收编 `src/shared/` 单源五处委托（~20 行） |
| A3 | sigStatFor ×3 同体（analysis.ts:132 / rhythm.ts:65 / snapshots.ts:191，statSync 包装逐字相同） | grep 实测 | studio/server 域内单源（~15 行） |
| A4 | 测试常量三件套样板：`export const X` + `let x = X` + `__setXForTest()` 全库 **46 处定义 + 22 处调用**（R1 报 48 与 R8 报 68 系口径差，实测定义 46） | `__set.*ForTest` grep | `testableConstant(name, def)` 工厂收口（R30-18 约定级，需作者拍板全仓统一；~90 行起步） |
| A5 | 魔数散写：`30_000` ×20（`API_DEFAULT_TIMEOUT_MS` 常量在 client.ts 却仅 2 处引用，api/chat.ts:22 等 6+ 处手写旁路）、`15_000` ×11（chat.ts 单文件 5 处） | grep 实测 | api 域常量集中命名（~30 行） |
| A6 | **章号定位双实现且容忍集分叉**（最接近 bug 的一致性缺陷）：`process/prepare.ts:40-77` 用宽集 `chapterNoFromName`（认 `5—开局.md`），`format/chapter-lookup.ts:61` 用 `chapterNamePrefixes`（不认 `—`/空格分隔）——同一本 `5—开局.md` 备料命中、摘要状态判定 miss；summary.ts 已于 2026-09-13 收编单源，prepare 侧漏收编 | 两文件对读 | 统一容忍集或直接委托（~30 行 + 回归） |
| A7 | 章号解析三源手写：`state/state.ts:923-931` 与 `document/manifest.ts:227-242` 均手抄 `split('/').pop() → /^(\d+)-/`，注释自认「对齐 format/words.ts 口径」靠人工抄写维持 | 对读 | 下沉 format 单源三处委托（~20 行） |

### B. 核心域（document/state/events/fs）

- B1 `foreshadow.ts:372-400 vs 491-521` sync/async 孪生内层循环逐字重复（buildKeywordIndex 正则建索引体 ~28 行 ×2、collectChapterTexts ×2）——核心循环单源参数化，−45 行。
- B2 `events/store.ts:901-939 vs 940-1010` listEvents/iterateEvents SQL 装配近重复 ~70 行两份——`queryEvents(db, cond, onRow)` 单源 + 两薄壳，−40 行。
- B3 生产零调用出口群（grep 零外部消费、注释自记待清理）：`store.ts:898` appendEvent、`:1012` latestSession、`analysis.ts:153` writeAnalysis sync、`finalize.ts:277` finalizeRevision sync（与 :308 async 孪生并存）——按注释既定方向清偿，−60 行。
- B4 死 export ×1（937 符号抽查唯一确凿）：`service.ts:139 __setSaveLockTimeoutForTest`——2026-09-13 批按 R30-18 惯例新增的钩子，全库零调用方；建议补一个使用它的回归或删除。

### C. AI 链 / 处理链 / 导出

- C1 `ai/calls.ts:279-312` 与 `ai/provider/store.ts:337-372` 写链队列 + 跨进程锁快慢双路 + cleanup 机械双份——`serializedLockedWrite` 单源，−60 行。
- C2 `export/index.ts` 错误信封字面量手抄 9~11 处（`chapterCount:0, unit:'章', …` 同构，grep `chapterCount: 0` = 11）——历史修复 R74-2/重审-09 反复在此补字段正是病灶——局部 `fail()` 闭包，−60 行。
- C3 `self-heal.ts:943-957 vs 971-988` usage 计价块近重复 + `:734-740/:772-778` persistFinal 同构——闭包提取，−30 行。
- C4 `self-heal.ts:538/547/656` 死条件死兜底 ×3（`maxAttempts !== undefined` 恒真、`opts.userDataPath ?? undefined` 恒非空两处）——删 3 行。
- C5 `rag/index.ts:495/520` 重索引章双读盘（指纹 readFile 全文 + 收集段再读一次）——body 顺手缓存，~10 行。
- C6 `turns.ts:272-299` check_chapter/read_chapter 共享 ~8 行 prelude——局部 helper。
- C7 `provider/store.ts:206-222 vs 232-245` providers/ragProviders 解密迁移循环近重复——泛型助手 −15 行。

### D. studio 服务端（承接 P1-2/3/4）

- D1 **TTL+探针+FIFO 缓存壳 ×13~20 份**：20 个 `CACHE_TTL/CACHE_MAX` 常量、14 文件含 `keys().next().value` FIFO 逐出（search/settings×2/analysis×2/snapshots/rhythm/foreshadows/health/overview/state/check/knowledge/books/progress）——时序语义（ts vs probeTs，R42-16/R44-9）系逐份各自打补丁——`createTtlProbeCache({probe, compute, ttl, max})` 通用件，~500 行 → ~180。
- D2 docId→正文解析链 ×8 + 同一错误文案 5 处（`analysis.ts:470/551/633`、`review.ts:145/324`，另 check×2/rewrite）——`resolveDraftByDocId` 单源，每端点省 ~10 行。
- D3 `stream.ts` 1097 行五种职责（SSE 记账/spawn 编排/watchdog/interrupt/auto-write/chat 四端点）——chat 段（:920-1096）与 SSE 零共享可独立 `chat.ts`（~180 行纯搬移）。
- D4 ABORTED→499 / NO_*→400 三行映射 ×8——随 P1-2 包装吞掉。

### E. 前端（承接 P1-7）

- E1 `api/documents.ts:4-35` 同一 GET 端点三包装（getContent/getContentPayload/getContentRevisioned 仅取用字段不同）——只留 payload 版调用方解构，−25 行。
- E2 `stores/prefs.ts`（856 行）每新增偏好键触 **6 处**（DEFAULTS/ref 声明/applyPrefs 守卫/buildCache/setter 工厂/return 名单 80 行）——键描述表驱动读/写/setter 三面，−180~250 行、触点 6→1。
- E3 `useChapterTreeActions.ts`（876 行）「书名守卫 + catch 落错」样板 ×12 + 复检 20+ 处——历史 R34D-21/R71-28 均是漏补此样板导致——`bookScoped(book, run)` 包装器，−40 行 + 防回归。
- E4 `stores/provider.ts:160-333` 九写函数重复 409 恢复骨架（`if (await recover409(e))` ×9）——`guardedWrite(fn, okMsg)` 收口，−50 行。
- E5 `stores/doc.ts:79-230` 崩溃镜像子系统 ~150 行内嵌（与文档缓存主职责正交，是 813 行主膨胀源）——抽 `shared/dirty-mirror.ts` 独立模块（搬移为主）。
- E6 gen 代守卫样板 ×14 文件（`let loadGen = 0` / `++loadGen` / await 后复检）——`useStaleGuard()` composable 归一，−60 行 + 新面板不再复制。
- E7 `Welcome.vue:36-59` 与 `Library.vue:45-70` chooseLibrary/switchTo 近逐字重复（连修复注释都同批同文）——`useLibraryIpc` 单源，−35 行。

### F. 桌面壳 / 格式·机检·安装

- F1 `desktop/main.ts` god-file（2259 行 10+ 职责；头注自定位「纯壳层」未达标）——拆 ipc/lifecycle/workdir-controller/windows 四模块（~1200 行移动零逻辑变化）。
- F2 main.ts 四组样板双写：三 IPC 守卫链（1610-1650/1726-1741，错误文案逐字 ×3）+ `isTrustedSender` 手工 guard ×14（新增 handler 漏写即纵深缺口）+ close/quit 链流程双写（1332-1407 vs 2172-2299）+ openShelfWindow/openLibraryWindow 骨架双写（913-959 vs 962-1010）——`handleTrusted` 包装 + `runFlushConfirm` + `openSingletonWindow` 三助手，合计 −250 行。
- F3 `server-manager.ts:795-819 vs 456-496` restartPinned/doRestart 同构（onRestarted 钩子隔离块逐字相同）——`launchPinned` 内部函数，−30 行。
- F4 `check/tree-issues-cache.ts:146-148` + `check/run.ts:503-506` 一次树聚合对同批全局目录 **4 遍递归 stat 扫描**（:647-650 注释宣称「首尾各一遍」与实现不符）——leadsFp 改拼接 epochFp0，省 2 遍（~6 行）。
- F5 `check/run.ts:114-131/344-359/363-378` 降级黄项三连复制——`pushDegradedYellow` 助手，30→10 行。
- F6 `install/books.ts:379-409 vs 418-443` removeBookEntry sync/async 孪生（append 族已示范 `appendBookLocked` 正解，remove 对漏拆）——照拆，−25 行；`:658-660+795-811` repair 扫盘每书 readBookConfig 两次——一次读三 detect 传参（~8 行）。
- F7 `check/count.ts:506-513 vs 920-927` 计数 while 双份 + `:714-730` 排比前缀复算——`countOccurrences()` + StyleStats 内部字段复用，−25 行。

---

## 四、P3 —— 择优（30+ 项摘要，明细备查）

前端：RENDER_CAP 三件套样板 ×12 组件（`capView(arr, cap)` 单源 ~40 行）/ 章节六态「标签+色」映射散落 3 处（单表 ~15 行）/ `.cap-hint` 样式 ×8 / `WorkbenchView` 六函数共享骨架（`runBookAction` 助手 150→90 行）/ `prefs.ts` 双写「重 GET 对齐」块 / `AuditView` 对称双子 / `OverviewView` 三次级加载器工厂化 / 两个 bookName watch 可并一 / `provider.ts errText` 纯转发别名 / `chat.ts` seedHistory/switchBranch 共核 ~15 行 / `tree.ts groupTree` 每次全树深克隆 + 四 computed 独立遍历（千章大书可并单趟复合 computed）/ `useSse.ts` base 双写。核心域：structure.ts resumed 字面量 ×2 / service.ts 三元两臂重复求值 + 过时注释 / state.ts `_bookRoot` unused 参数 / trash.ts out-param 改返回 / 平凡转发包装 ×2 / analysis.ts 缩进归位。AI·导出：`export/index.ts:668` 纯别名（R0912 批同款漏网）+ writeSplit 两分支重复 / mkChain 双实现共享底层 / learn·compaction·count codePointLength（已列 A2）。服务端：`static.ts:56` 裸 `new URL` 未引 `URL_PARSE_BASE` 单源（http.ts:106 宣称单源化此处漏网）/ dispatch 线性扫描（~110 路由逐条 regex，本地单用户无感，可选分桶）。桌面：`raceWithTimeout` 三处同型 / `msgBox/openDir` 三元 ×3 / 类型引用不一致 1 处 / `bootstrap-runner.ts:21` 生产恒 no-op 接口成员（R48-75 同族残留）/ readStore 双 IO / dev 态主窗二次 setProxy / **CI 冒烟三处固定 `sleep 25`（≥75s/构建，改轮询标记早退省 40-60s 且更早发现启动失败）** / runSmokeWindowCycle 50 行测试驱动住生产入口 / server-manager 三旗状态机可收敛。格式·安装：run.ts 单章/树聚合前奏双份 + manifest 双读 + 章循环内 existsSync / init.ts 悬空 JSDoc ×2。

---

## 五、横切面量化总账（R8，全部 grep 实测）

| 猎杀项 | 实测 | 判定 |
|---|---|---|
| errMsg 三目 | **210 处**，无单源（3 处私有互不引用） | **是债（最大横切债）** → A1 |
| 未使用 export | 937 符号抽查仅 **1** 死（`__setSaveLockTimeoutForTest`） | 非系统性债（出口卫生极佳） |
| TODO/FIXME/HACK | 真债务 **0**（3 处匹配全为转义撞词/prompt 文案） | 强项——债务走台账制非行内标记 |
| `any` 类型 | **0 处**（含测试，2026-08-30 已机械清偿 + eslint 门钉死） | 强项 |
| 同步 IO | 请求路径 studio/server 151 + document 206（vs 启动路径 install 104 可容忍）；worker 化与 PM-10 专项在持续推进 | 半债（方向正确、未收完） |
| 超长文件 | 800+ 行 **19 个**（双 2000+ 巨石 main.ts/service.ts） | 债（F1/D3/P1-1 部分处置） |
| 魔数 | 30_000 ×20 / 15_000 ×11（常量在位但被旁路） | 轻债 → A5 |
| console.* 直用 | 后端 34（9 处系 logger 本体，其余皆有注释例外理由）vs logger 398 处主导 | 非债 |
| 近似复制函数 | codePointLength ×5 / errMsg ×3 / sigStatFor ×3 / chapterNo 双名 4 组确凿 | 债 → A2/A3/A7 |
| 测试常量样板 | `__set.*ForTest` 68 行 = 46 定义 + 22 调用 | 债 → A4 |

---

## 六、亮点（8 路子代理共识，优雅与高效的支撑证据）

1. **单读派生纪律**贯穿保存链（一次 Buffer 读 → revision+UTF-8 闸+字数+快照四产物同源）；`fs/md-text-cache.ts` 指纹缓存 + 条数/字节双预算闸；`fs/cross-process-lock.ts` 完整失败分类学（stale 接管/pid 短写/释放前校验/mtime 续期），残余竞态全部注释记档而非掩盖。
2. **事件溯源纯函数投影层**零 DB 依赖可直接喂数组测试；`branch-tree.ts:204-231` 把 O(events×slots) 保活判定收敛为排序+前缀最大值+二分。
3. **runner.ts runTask 统一执行器**（mock 快路/中断归因/退避重试/四路口径入账）收敛单一封套；rag 流式召回两段式开库 + prepared WeakMap 断 ephemeron 环；`cache/rebuild.ts` 五元组增量基准 + FIFO 指纹缓存。
4. **studio/server 错误信封单一出口** + `readJson` 工程完备（Buffer 防 UTF-8 切割/413/408 unref/clientAbort 降级）+ 两级探针缓存（O(1) 目录指纹 → stat 签名 → TTL，3s 轮询零 syscall 命中）+ 事件循环友好（逐 25 项让出/worker 下沉/导出并发槽）。
5. **前端全库零 deep watch**（grep 0 命中）；大状态全部显式有限缓冲；竞态纪律全库模式化（书名快照+复检 67 处、gen 代守卫 21 处、in-flight 台账去重跨 7+ 文件一致）；`api/client.ts` 单点封装完整，api 层 28 文件全退化为一行薄壳。
6. **渲染上限纪律**：12+ 大列表组件一致执行「数据全量、渲染 cap+省略提示」；分帧挂载/光晕静态化/150ms 防抖共享源近乎满配。
7. **desktop server-manager 生命周期工程化**（kill→SIGKILL 升级单源、starting 互斥通道防双 fork、身份校验防跨 child 误清）；安全纵深成体系（IPC sender 白名单、context-menu 载荷净化、CSP/Host/Origin/token 四闸）。
8. **迁移脚本分层幂等**（v2/v3/defaults：moved 子树登记→清单精确改写，孤儿留痕）；`parseHistoryWithPreamble` 三槽保真。

---

## 七、模块评分与规模

| 域 | 规模 | 职责 | 优雅 | 简洁 | 高效 |
|---|---|---|---|---|---|
| document/state/events/fs | 37 文件 ≈14.3k | 持久化协议/状态机/事件溯源/FS 原语 | 8.5 | 7 | 8.5 |
| ai/process/driver/rag/cache/metrics/knowledge/learn/review/export/git/log/shared | 137 文件 ≈35k | AI 编排·三协议适配·备料摘要·RAG·导出 | 9 | 7.5 | 9 |
| studio/server | 50 文件 ≈13.3k | HTTP 服务端（闸/路由/API 域分文件） | 8 | **6** | 9 |
| 前端骨架（views/stores/composables/api/shared） | 88 文件 ≈15.6k | 页面/状态/组合式/端点薄封装 | 8 | 7 | 9 |
| 前端组件层（components/pages/editor/styles） | 109 文件 ≈25.5k | 组件域分层/编辑器/样式收敛 | 8 | 6.5 | 9 |
| desktop + 构建配置 | 15 文件 ≈4.9k | Electron 主进程/生命周期/IPC | 7 | **6** | 7.5 |
| format/check/install | 48 文件 ≈13.2k | 解析回写/机检/书库安装迁移 | 7 | 6.5 | 8 |

---

## 八、完成进度（截至 2026-09-14）

- **实施路线 24 个阶段全部实施收口**：总览第三节开放任务看板当前为空（「阶段 24 章节结构操作」2026-09-13 全三批 A/B/C 收口后看板清空）；**版本 `1.0.0-rc.1`（发布候选期）**。
- 双线（win/mac）已并树：win 线四提交 2026-09-13 合入 mac（`0b312a97`），mac 侧复审-0913 两报告同日收口（`f7c2a633`/`2510a1ec`）；2026-09-14 mac 适配修复批 L2 全绿（工作树待提交态）。
- 剩余开放项（台账 §三，标记计数）：**待拍板 19 处 / 单立 19 处 / 维持备案 54 处**——其中阶段 24 残留三项（inline 裸标题建章章号盲区 / 树显示序跨卷分组语义 / undo 回收站同章号反查歧义，均【待拍板】）+ 各域挂账（catalog 三件套去留、事件读链 O(N) 立项、win32 74 处 skipIf 补腿、Electron GUI e2e 缺位等）。
- 01-评审/ 在库：专项精简优化（收口条件已满足、归档时点待作者定）+ 本篇。

## 九、完成质量（主审 2026-09-14 实跑 + 台账口径）

- **全量 vitest：1123 测试文件全过 = 7261 过 + 7 跳、0 败**（140.58s，主审实跑）；与根 README 合入门槛口径一致（CI check:counts 自动对账）。
- **tsc 0 错 / vue-tsc 0 错 / eslint --max-warnings 0 全绿**（主审实跑）。
- 未复跑项沿最近 L2 口径（如实记档）：coverage 91.71/87.27/96.23/91.71（2026-09-13 批实测，CI 三腿矩阵 + 阈值门兜底）、e2e 31 specs 49 过 2 跳、soak 两段 OK、electron-builder --dir 出包实锤。
- 静态卫生：`any` 0、真 TODO 0、937 抽查死 export 仅 1、logger 主导（398 vs console 34 且例外皆有因）。
- 质量结论：**测试资产 7,268 例全绿 + 类型/静态门全过 + 覆盖率 ~92%（行）的 RC 级成熟度**；本评审零新 bug 发现与历轮评审收敛趋势一致——缺陷面已从「行为 bug」转移到「重复样板可收敛」的纯优化面，这正是 RC 期代码库的健康形态。

## 十、修复编排建议（供作者拍板，未动任何代码）

1. **批 1 机械横切**（零行为变化、低风险）：A1 errMsg 单源 + A2/A3 复制函数收编 + A5 魔数集中 + C4 死条件 + B4 死 export 处置 ≈ 净 −350 行。
2. **批 2 服务端四家族**（P1-2/3/4 + D1/D2/D4）：`runGatedGeneration` + `createSerialChainMap` + `drainAndRecheck` + `createTtlProbeCache` ≈ 净 −700 行，回归面 = 既有 API 测试全覆盖。
3. **批 3 核心域与前端骨架**（P1-1/P1-7 + B1/B2 + E1-E7）：锁排比 / 守卫包装 / prefs 表驱动 / 409 骨架 ≈ 净 −600 行。
4. **批 4 结构性**（P1-5/6 + F1 + D3）：yaml schema 表驱动（红线 = 字节序不变快照）+ main.ts 拆分 + stream.ts 搬移 ≈ 净 −400 行 + 纯移动。
5. 与在库挂账的关系：D1/D3/F1/A4 等与台账 §三 H 域「精简总账」三档高度重叠，若拍板可并批执行、避免双批改同文件。

---

*本报告为零代码改动纯评审落盘（L0 文档面）；评审完成≠收口，P1/P2 修复+回归通过后按链归档。*
