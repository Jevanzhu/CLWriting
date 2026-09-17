# 全库源码重评四轮 · 进度与质量评审

- 日期：2026-09-15（纯评审落盘批，零代码改动，L0 纯评审面——根 README 未触、check:counts 计数不涉）。
- 执行模型：GLM-5.3（主审）+ 九路只读子代理（Explore 型，文件互斥分域）。
- 作者指令：「忽略现有的评审文档，重新评审一遍项目源代码，最后告诉我项目完成进度，完成质量，结果形成一个文档给我。」——历史同指令第四轮（09-13 win 适配 / 09-13 二轮 / 09-14 三轮）。
- 基线：win 线 HEAD `2dd2b849`（三轮落盘批 + 处置批两批同树）工作树净。**过程记档**：评审进行中，并行会话将 99 文件处置批以 `2dd2b849` 入库（工作树中途由脏转净）——主审对该批 27 个 src 文件的 diff 亲读先于入库完成、入库零内容变化，评审有效性不受影响；本报告基线即含该批。
- 独立性声明：既有评审报告正文（01-评审/ 与 Archive/）零读取；进度判据仅取总览（开放任务看板）与台账（挂账登记）两类计划面文档。

## 一、范围与方法

三波九路文件互斥只读子代理（单波 ≤4，全回收）+ 主审亲读：

| 波 | 路 | 域 | 实读面 |
|---|---|---|---|
| 波 1 | R1-R4 | 服务端 / 桌面·进程·CI / AI·RAG·机检 / 核心数据 | 四域文件互斥彻查 |
| 波 2 | R5-R8 | RAG·进程·格式 / 存储基础设施（fs/git/install/events/log/shared）/ 前端逻辑（stores/composables/api/shared/editor）/ 前端视图（views/components 118 文件） | R6 34 文件 8308 行全量；R7 88 文件 12967 行全量；R8 118 文件 27840 行全量 |
| 波 3 | R9 | 测试工程（vitest.config/helpers/governance/e2e 盘点/抽样 13 文件 + 全库 mock 纪律 grep） | 配置基建全读 + 高风险样板精读 + 抽样如实记档 |

主审亲读面：①三轮处置批 27 src 文件 diff 全量复核（P2-2 rename 根级特判 / P2-3 setting-rule 单源化 / fs-deny 平台分派等，形态全部正确）；②main.test.ts 负载 OOM 败因链全程调查（4/8/36GB 堆实验 + CI 矩阵核对 + Node 安装时间线核对 + R9 静态复核采信）；③全部子代理发现的逐条亲验（file:line 逐一开读）与台账 §三 去重交叉。

**事故记档**：波 2 首派 R7/R8 于 2026-09-15 约 18:50 撞账户 5 小时用量限额阵亡（限额 19:00:38 重置），重置后重派全回收；两次阵亡均无半成品采信。

**计数记档（如实）**：波 1 nano 明细中有 7 项风格/一致性微瑕随会话内存压缩失传，仅存计数（计数 7 为当时亲验后口径，非估计值）；本报告 §五 锚定 14 项 + 失传 7 项。失传项均为非行为面微瑕，处置价值低，按同族惯例维持登记即可。

## 二、判定总览

**P1×0 / P2×1（测试工程）/ P3×21 / nano×21（锚定 14 + 失传 7 记档）**

| 域 | P1 | P2 | P3 | nano（锚定） |
|---|---|---|---|---|
| 服务端（R1） | 0 | 0 | 3 | — |
| 桌面·进程·CI（R2） | 0 | 0 | — | 1 |
| AI·RAG·机检（R3/R5） | 0 | 0 | 6（含归并在册 1） | 4 |
| 存储基础设施（R6） | 0 | 0 | 5 | 4 |
| 前端逻辑（R7） | 0 | 0 | 3 | 1 |
| 前端视图（R8） | 0 | 0 | 1 | 2 |
| 测试工程（R9+主审） | 0 | 1 | 2 | 2 |
| 核心数据（R4） | 0 | 0 | — | — |

与三轮（P2×3 / P3×14）对比：**产品码 P2 连续清零**（三轮 3 项处置后本轮无新增），唯一 P2 落测试工程；P3 计数升（覆盖面较三轮更宽：存储基础设施域独立成路 34 文件全量 + 测试工程深入 + 前端两域 206 文件全量重读），严重度构成偏轻（潜伏面 / 受限触发边角 / 装置纪律），无一是数据丢失或核心功能不可用级。

## 三、P2 详述：win×Node26 负载下全量测试门不可靠 + 该组合零 CI 信号（测试工程）

**文件**：`test/desktop/main.test.ts`（2755 行 / 19 describe / 92 个顶层 it，收集 93）+ `.github/workflows/ci.yml:49-51`（matrix exclude `windows-latest × node-26`；desktop.yml 仅 node 24）。

**运行期实录（主审，均为同机 win×Node 26.8.1——该版本自 2026-09-02 起即 scoop current）**：

- 全量 `vitest run` 在**并发负载下**（评审子代理在途）4/4 确定性 worker OOM，堆分别给默认 ~4GB / 8GB / 36GB 均在 main.test.ts 约第 42 例完成后耗尽（36GB 全耗尽证明非线性慢漏而是失稳后的无界分配）；机器 64GB / 当时空闲 ~49GB，非物理内存不足。
- **空载可通过**：并行会话 2026-09-15 同树全量实录 1144 文件 = 7285 过 + 70 跳 0 败（370.02s）——同组合、同树、差异仅在并发负载。
- 同负载条件下另有 2 个时序敏感文件失败（re2-manifest-lock-reentry-async:51 锁探针 / r35-search-cache:R35-7 TTL·mtime），**孤立复跑 10/10 全绿销案**（见 §六）——负载脆性不止一处，main.test.ts 是其中最重的一处。

**归因（R9 静态复核后主审采纳，含记正）**：初判「:2065（R0912-3 #35）单用例 mock process.on/exit + forkBehavior='pending' 使重启链失去终止条件 → 无界分配」**不成立，撤回记正**——①该用例真实执行序为第 71/92 位，死于第 42 例时序上不可能由它引爆；②重启链终止条件（`RESTART_MAX_ATTEMPTS=3` 封顶 + backoff + `shutdownStarted` 门 + 假件 kill 即 queueMicrotask exit）全在 manager 闭包态内，mock process.on/exit 不移除它们（R9 逐链追踪 server-manager :424-454/:1005-1127）。**修正归因 = 文件级累积钉死底噪在负载下失稳**：39 次动态重导入 main.js × 每次注册 6 个真实 process 监听器（main.ts:679-681/684/722 共 5 个 + app-instance-guard.ts:57 once('exit') 1 个）≈ 220+ 个永久钉死监听器，整张旧模块图不可 GC（vitest 未开 restoreMocks、无卸载钩子、全树无 process 级 removeAllListeners），叠加 M.windows/forkChildren/logErrors 单调捕获数组与陈旧实例后台链——文件头注 :458-463 自认「陈旧模块的观察窗会在后续用例执行中途触发并 fork 假 child」且仅以 1h env 钉死 session-end 一条路径；forks×4 并发与 rag/check scale GB 级峰值叠加（vitest.config.ts:48-53 记档过 19GB 事故）时 worker 堆失稳耗尽。「空载可过、负载下 4/4 稳定复现」与「累积钉死 + 竞争失稳」形态一致，与「确定性死循环」（空载也该爆）矛盾。台账另有同族前科互证：R0913 win 适配批记档「will-quit 注册与 main.test.ts 假件交互致 worker OOM〔二分定位〕」。引爆的精确分配点未定位，修复时建议 `--heap-prof` 补证。

**后果**：本地 L2 全量门在本机主力环境（win×Node26）负载下不可靠——评审/多代理并行会话正是本项目常态工作形态；且 CI 矩阵排除 win+node26，该组合无任何自动背书（engines 允许 node 26，非不支持）。

**修法建议（R9 三件套 + 主审补）**：①文件级 beforeAll 对 process.on 做「六事件名单过滤」包装（名单内仅捕获、名单外透传——**不可** removeAllListeners，会剥掉 vitest/tinypool 自身通道），afterAll 还原，一处收口整个重导入家族；或 main.ts 暴露 `__testHooks.disposeMain()`（自摘监听器 + stopChild）供 afterEach 调用（r38-exit-guards 静态守卫先例）；②:2065 用例断言后 drain 一拍（等 child2 exit 回执与 stopChild 竞速落定再返回）；③server-manager.test.ts:1416+ 已在单元层覆盖同场景（killNow 直测、无 process spy 栈），main.test.ts 侧可削薄为 wiring 断言；④（披露项）CI 矩阵 win+node26 盲区可择机补腿或 README 披露。

## 四、P3 明细（21 项，全部主审亲验）

**服务端域（3）**
1. `src/studio/server/api/review.ts:284-353`——三审流端点族未挂 bookMovedFailure 复核闸（19 处调用点家族的漏网端点；切书竞窗下旧书写入风险，受限触发）。
2. `src/studio/server/api/documents.ts:338-372`——finalize 无 task-gate 排队（语义级：state.ts 锁内复查使数据面 fail-closed 兜底，实害受限；与 chat.clear/audit.delete 六闸收编后的口径差距）。
3. `src/studio/server/api/books.ts:693-777`——rename RMW 窗（读-改-写 books.jsonl 段无同文件级串行化，双开窗口受限）。

**AI·RAG·机检·进程·格式域（6，含归并 1）**
4. `src/rag/index.ts` buildIndex 未接 in-flight 闸（rebuild 并发窗口）——**台账 §三 D 域 D-P3-5 在册重证，归并不新立**。
5. `src/rag/index.ts:240/:267`——`ctx.workDir!` 非空断言两处（初始化前调用的裸 crash 面）。
6. `src/rag/store.ts:372-377`——SQLite 游标迭代中执行 UPDATE（边迭代边写同库，潜在游标语义依赖实现）。
7. `src/process/draft-pipeline.ts:200-215`——单文档三读盘 vs 注释宣称单读（saveDraft 双读族新角度：次数口径失实 + 无谓 IO）。
8. `src/format/draft.ts:229-231`——slashRelative 以 `.replace(/\\/g,'/')` 归一，posix 宿主字面反斜杠文件名被易帜（与 safe-path「posix 保持字面身份」口径分裂，受限边角）。
9. `src/metrics/short-index.ts:581-585`——UTF-16 `{1,12}` 候选窗 + `slice(0,12)` 双双按 UTF-16 单位，扩展区字符（代理对）窗口减半/截断劈开（与 check 域 codePointLength 口径分裂）。
10. `src/ai/orchestrate/chat/turns.ts:546`——`chapter ?? 0` 兜底将缺失章号静默按 0 章处理（事件形态异常时错桶无痕）。

**存储基础设施域（5，R6 报 P2×1 经主审亲验降级：prepared 重入为无现行触发面的潜伏面）**
11. `src/events/store.ts:219-234 + :793-828`——R46-42 连接级 prepared 缓存按 SQL 串共享 StatementSync，而 queryEventRows 返回惰性生成器：持有未耗尽迭代器期间再触发同 SQL 变体即两游标落同语句（node:sqlite 单语句不可重入——ERR_INVALID_STATE 或游标错乱）。**当前两个消费方（document/structure.ts:596 / ai/llm-call-read.ts:114）纯同步循环不复入 store，属潜伏面非现行 bug**。修法：iterate 路径绕缓存独立 prepare，或返回生成器处加「语句使用中」守卫。
12. `src/install/migrate-layout-v3.ts:70`——`readdirSync(draftDir)` 裸调：EACCES/竞态删除直接 throw 穿出 `{migrated,errors}` 收集契约（v2 同位置收进 errors），由 server/index.ts:252 逐书 try 兜住降级该书本次启动迁移；持久性权限故障则 v3 永不收敛且无 errors 报告。修法：包 try/catch 收进 errors。
13. `src/install/books.ts:685`——relink 判定裸 `existsSync`：EACCES/EIO（网络盘瞬断）也返回 false → 原书暂时不可读 + 同名书第二处副本时登记 path 被重指（原书恢复后成无登记孤儿）。同文件 purge 路径已有 ENOENT-only 的 isDirConfirmedMissing（R35-28）防线，relink 未同口径。
14. `src/install/migrate-defaults.ts:56-61`——book.yaml 无锁 RMW（读→文本补丁→整写）：双开窗口内他进程保存被旧快照覆盖；启动 pre-listen 窗口 + 原子写保不撕裂，风险低，但对照 manifest 族 withManifestLock 纪律属缺口。
15. `src/install/migrate-finalized-revision.ts:43 + :82`——git status 脏集在 manifest 锁外取得：status 与锁内 computeRevision 之间文件被改时，改动后内容被记为 finalizedRevision（误 final 断写方向，本文件自declare红线）；启动一次性 + 仅 git 时代旧书，窗口毫秒级。修法：锁内对 dirty 命中做哈希复核。

**前端逻辑域（3）**
16. `src/studio/web-next/src/stores/chat.ts:485/:562` + `api/chat.ts`——`data.messages` 裸取两处（同函数族 branches/total/seqs/branchId 均已 `??` 防御，唯独最常访问的 messages 漏网）：200 空对象体（R51-H-2 已认定现实威胁模型）直通 → `data.messages.length` 抛 TypeError，seedHistory 调用点为 `void` 形态 → unhandled rejection，种子化静默中断无反馈。修法：fetchChatHistory 返回前 `messages ?? []` 归一。
17. `src/studio/web-next/src/api/snapshots.ts:20`——`return r.entries` 无 `?? []`（镜像端点 api/documents.ts:343 listTrash 有兜底）：同族信封缺字段漏网，后果较轻（v-for 对 undefined 渲染为空）。一行对齐。
18. `src/studio/web-next/src/composables/useRelationGraph.ts:312`——自动梳理守卫 `ui.aiAvailable === false` 只拦「已确认不可用」，null（探测中）窗口被放行：启动后探测未 settle 期间进关系图且该书自动梳理开启 → 一次注定失败的 POST + 失败 toast，恰是 :309 注释明示要避免的体验。修法：自动路径 `!== true` 才放行（手动按钮不受影响）。

**前端视图域（1）**
19. `src/studio/web-next/src/components/learn/QuoteCardGrid.vue:20`——金句候选网格对 `learn.quotes` 全量 v-for 无渲染帽（M-P3-15 的 line-clamp 只裁视觉不减节点，且注释自认「超长候选正文全量渲染会撑爆网格卡片」）；同视图样章区已配 GROUP_RENDER_CAP=50 + capView 单源双保险，金句区漏配；store/api 层亦无钳制。修法：对齐 capView(learn.quotes, 100) + 按需展开（复用 SampleCandidateList 模式）。

**测试工程域（2）**
20. `test/desktop/main.test.ts`（39 次重导入家族；同族另 8 文件各 1-3 次量级可忽略）——整模块重导入无卸载纪律：每次注册 6 个真实 process 监听器永不移除 + 旧模块图整张不可 GC + 单调捕获数组，构成 §三 P2 的底噪。修法见 §三 三件套（与 P2 同链处置）。
21. `test/desktop/main.test.ts:2065`（R0912-3 #35）用例修法落点——该用例自身 try/finally 纪律完备（:2094-2096 还原），断言无需改；收口 = 名单包装天然简化其局部 process.on spy + 断言后 drain 一拍 + 顺手补 :1280 对称缺口（见 nano-12）。**注**：单用例「无界分配引爆」定性已随 §三 记正撤回，本项按装置收口登记。

## 五、nano（锚定 14 + 波 1 失传 7 记档）

1. `src/check/leads.ts:189`——死 `??`（左侧永非空，行为等价冗余）。
2. `src/review/contract.ts:355-362`——死条件（分支不可达）。
3. `src/format/style-entry.ts:346-350`——冗余三元（两臂同值）。
4. `src/process/summary.ts:645-650`——同路径双 join（一处可复用变量）。
5. `src/studio/web-next/src/stores/workbench.ts:194`——textOut 超限截断按 UTF-16 slice 可劈代理对（对照 chat.ts clipByCodePoints 口径不一；一次性乱码字符，极受限路径）。
6. `src/git/exec.ts:112`——`timedOut` 判据含 `r.signal === 'SIGTERM'`：被外部 SIGTERM 杀死的 git 也归「操作超时」文案（误归因，仅文案面）。
7. `src/events/store.ts:464-497`——repairOrphanSessions 内层 if 块整体少一层缩进（读感错位）。
8. `src/fs/walk-md.ts:63/:70`——realRoot realpath 后首层 walk 同路径再 realpath 一次（每遍多一次系统调用）。
9. `src/events/store.ts:16`——ulid 经 document/stable-id.js re-export 层导入（正本 fs/id.ts，migrate-layout-v3 已直引，风格不一）。
10. `src/studio/web-next/src/components/shell/TabBar.vue:35-47/:133-138`——新建下拉坐标打开瞬间快照 + fixed Teleport，resize/拖侧栏不重定位不关闭（ContextMenu.vue:197 同域同形）；下次开合自愈，纯边角视觉。
11. `src/studio/web-next/src/components/shell/ChatDock.vue:99 ↔ components/panels/chat/ChatComposer.vue:189-193`——`--composer-h:130px` 与玻璃档 `min-height:70px` 跨文件魔法数耦合，约束只写在单侧注释（维护性风险，非现行 bug）。
12. `test/desktop/main.test.ts:1279-1293`——「时序 2 boot-error」`M.forkBehavior='ready'` 恢复无 try/finally：断言失败时 'boot-error' 泄漏后续全部用例（连锁假红面）；对照 :2094 #35 有 finally，同文件纪律不一。
13. `test/scripts/backlog-dev-port-zero.test.ts:36-48`——直写赋值 `process.exit`/`console.error` + 手工还原（语义正确）绕开 vitest spy 记账；同文件其余用例均用 vi.spyOn。
14. 桌面域 saveDraft 注释精度（波 1 R2，双读族口径失实的注释面；行为无涉）。

**波 1 失传 7 项记档**：R1-R4 四域风格/一致性微瑕，随主监会话内存压缩明细失传、仅存亲验后计数（价值低：非行为面）。处置口径建议：按同族惯例不追补、维持登记即可。

**模式级建议（R7 nano-2 并入记档，不计 数）**：信封兜底防线靠逐端点手写 `?? []` 维持，本轮即见两处漏网（P3-16/17）——可在 apiJson 层提供 apiJsonList/apiJsonObj 辅助封装结构性消除漏网。

## 六、质量门实录（主审独立复跑，2026-09-15）

| 门 | 结果 |
|---|---|
| tsc --noEmit / vue-tsc --noEmit | 0 错 / 0 错 |
| eslint . --max-warnings 0 | 0/0 |
| check:counts / check:packaging / check:knowledge | 过 / 过 / 过 |
| e2e（playwright，31 spec / 51 用例——R9 盘点与 README 口径逐字吻合：常规 49 + 2 跳系 release-smoke 需 CLWRITING_E2E_RELEASE） | **49 过 + 2 跳（1.0m）** |
| soak 两段 | OK（8.35→8.33MB / 8.85→8.91MB，上界 24MB） |
| vitest 全量（除 main.test.ts）· 负载条件 | 1143 文件 = 7190 过 + 70 跳 + **2 败**（re2-manifest-lock-reentry-async:51 / r35-search-cache R35-7）——**孤立复跑 10/10 全绿，判负载时序抖动销案**，非回归 |
| vitest 全量（含 main.test.ts）· 负载条件 | **4/4 worker OOM**（§三 P2；堆 4/8/36GB 均耗尽） |
| vitest 全量 · 空载条件 | 引用并行会话同日同树实录：**1144 文件 = 7285 过 + 70 跳 0 败（370.02s）**——本会话未复跑空载全量（负载 OOM 调查已耗 4 次；如实记档，以实录引用为据） |

## 七、正向质量亮点（六域各摘）

- **存储基础设施（R6）**：fs/atomic 原子写全档位（fsync 文件+父目录、tmp 内嵌 pid+uuid、EPERM/EBUSY 退避单源、硬链接独占 + exFAT/SMB 降级留痕）；cross-process-lock（O_EXCL + pid+bootTime 指纹 + 500ms 空锁宽限 + 接管前 jitter 二次复核 + release 逐字节校验）proper-lockfile 同级且残余风险如实记档；events/store 书库迁移（WAL checkpoint 折叠 + 失败逆序回滚 + 墓碑前置 fail-closed + bookHash 排序双锁防 ABBA + INSERT RETURNING 真实 seq）——P1 级数据丢失/损坏面未发现。
- **前端逻辑（R7）**：useStaleGuard 代守卫单源全仓复用；apiJson 防御链完整（30s 超时/abort 直通/401 重放去重）；doc store 竞态纵深（inflight 台账 + LRU + post-save dirty 复检 + treeRev 对账）；注释即缺陷记忆库（轮次锚 + 机制一句）。
- **前端视图（R8）**：全域竞态防御体系（40+ 异步动作点无一漏配）；IME/Esc 让渡链单源；WAI-ARIA tree 完整模式 + focus-visible 同权显形；RENDER_CAP/capView 渲染面内存纪律成体系（金句区为本轮唯一漏配）；巨石拆分「纯结构零行为变更」可复制。
- **测试工程（R9）**：helpers 单源纪律（waitFor 收编 28+ 克隆 / bootStudio 收编 ~119 文件样板 / mkdtempTracked 251 文件）；fs-deny 平台分派（win 臂 vi.mock 命名空间注入原生信封 EACCES、缺包装拒注入不假绿）；governance 反向守卫成体系（coverage 桶 glob 双向锁 / 依赖白名单防僵尸 / mock 快路零计费对账）；计数对账机器门（README 数字失配即红）；CI 内存闸与竞态兜底有事故背书。
- **服务端（R1）**：bookMovedFailure 复核闸 19 处调用点家族仅 1 端点漏网（三轮 nano 修后口径高度收敛）；六闸收编后清库族防线完整。
- **核心数据（R4/R5）**：manifest 族 withManifestLock RMW 纪律、saveDraft 快照语义、乐观锁贯穿。

## 八、进度结论

- **功能进度：24/24 阶段全量收口（100%）**——阶段 24 章节结构操作 2026-09-13 全三批（A/B/C）各批独立 L2 收口；总览开放任务看板空；**真开放待拍板：无**；残留挂账 = 阶段 24 三项登记（inline 裸标题建章章号盲区【待拍板·批 B】/ 树显示序跨卷分组语义【按实测钉·批 C】/ undo 回收站同章号反查歧义【待拍板·批 B】）+ 台账 §三 各域维持项。
- **版本态势：1.0.0-rc.1，RC 打磨期**。本轮四项质量门（静态三件 + e2e + soak）独立复跑全绿；产品码 P1×0/P2×0。
- **综合完成度估算：≈98%**（功能 100%；扣项 = RC 打磨项：测试工程负载脆性 P2×1 + P3 边角族 + 阶段 24 三项挂账登记）。

## 九、质量结论

**高（A− 量级维持）**。依据：①产品码连续第二轮 P2 清零、P1 四轮连续为零，本轮 8308+12967+27840 行三域全量精读 + 四域彻查的缺陷密度与严重度构成（潜伏面/边角/装置纪律为主）显著优于同规模项目基线；②存储/竞态/内存三大风险面防线经数十轮加固后呈结构性单源（非补丁堆叠），注释即审计记录；③质量门机器化程度高（计数对账门/governance 反向守卫/内存闸）。未上调至 A 的扣项：本地主力环境负载下全量门不可靠（P2×1，测试工程）+ 波 1 记账完整性缺口（nano 失传 7 项，本报告如实记档）。

## 十、处置建议（待作者指令；报告完成≠收口）

- **P2×1（必修）**：§三 三件套（文件级六事件名单包装或 __testHooks.disposeMain + drain + 削薄 #35 mock 面）+ CI win+node26 盲区披露或补腿；修复时以单文件孤立跑 + --heap-prof 补引爆点证据。
- **P3 择收建议**：优先 16/17（一行级信封兜底对齐）、13（relink ENOENT-only 一行）、12（try/catch 收 errors）、18（守卫 `!== true`）、19（capView 对齐）；11/15 维持登记（潜伏面/毫秒窗，补守卫成本高于风险）；其余按域择收。
- **nano**：12（finally 一行）与 13（spy 记账）随 P2 同批顺手；其余维持。
- **归并项 4**：随台账 D 域 D-P3-5 既有登记处置，不新立。

## 十一、遗留与记正

1. **记正（主审自纠）**：OOM 初判「#35 单用例引爆」经 R9 静态复核撤回（时序矛盾 + 重启链封顶实锤），修正为「文件级累积钉死底噪负载失稳」——两版归因的运行期现象记录（4/4 负载复现、堆无关、空载绿实录）均不变，仅机制归因更正。
2. **过程记档**：并行会话评审中入库 2dd2b849（99 文件处置批）；波 2 首派 R7/R8 撞账户限额阵亡后重派；波 1 nano 明细 7 项随会话内存压缩失传（仅存计数）。
3. 本报告为纯评审落盘；两批处置已落地（2026-09-15 批一 / 2026-09-16 批二维持项反转），处置记 = §十二。报告完成≠收口，归档待作者指令。

## 十二、处置记（两批补记，2026-09-16）

**批一（2026-09-15 四轮处置批，并行会话执行；处置明细正本 = 台账 §一 首行，此处摘要）**：P2×1 修——main.test.ts 文件级 process.on/once 六事件名单包装透传 + afterEach 逐用例拆除 + afterAll 兜底还原（注册行为逐字节不变、监听器寿命收敛单用例；P3-20/21 与 nano-12/13 同链销账）+ CI win×node26 盲区 README 披露行。P3×21 = 修 13（P3-1/2/3/5/7/9/10/12/13/16/17/18/19）+ 随 P2 链销 2（P3-20/21）+ 已过时 1（P3-4，cc89d2f8 已改）+ 维持登记 5（P3-6/8/11/14/15）。nano×14 锚定 = 修 6（nano-1/4/7/12/13/14）+ 维持 8（nano-2/3/5/6/8/9/10/11）；失传 7 项不追补。批一 L2 终门全绿 1149 文件 = 7303 过 + 70 跳 0 败（干净重跑一次全绿 324.81s，前三跑败项均系在册收尾竞态族孤立复跑销案）。

**批二（2026-09-16 维持项反转修复批；作者指令「全部修复。」——批一维持裁定 13 项全数反转，主审亲修零代理）**：

- **P3-6**（rag/store ensureNormColumn）：游标迭代中 UPDATE 改键集分页物化——`WHERE norm IS NULL AND id > ? ORDER BY id LIMIT ?` 批 512（NORM_BACKFILL_BATCH）+ 每批 BEGIN IMMEDIATE/COMMIT，同连接「查询中 DML」非定义行为面消除；catch 语义（rollback + 上抛）保持。用例 = norm-null-index 新增 1200 NULL 行跨三批回填断言。
- **P3-8**（format/draft slashRelative）：`relative()` 结果过 normalizeWinSeparators（safe-path 单源，同族第 9 站）；win 归一照旧、posix 字面反斜杠文件名身份保持。用例 = draft.test 新增 posix 腿（skipIf(win32)）保字面断言。
- **P3-11**（events/store queryEventRows）：iterateEvents（书级 + session 过滤两条返回惰性迭代器的腿）改每调用 db.prepare 新语句，listEvents（同步耗尽）保留 prepared 缓存。用例 = iterate-events 新增双层嵌套重入断言（两腿各自完整 6/6）。
- **P3-14**（install/migrate-defaults）：每书 book.yaml RMW 上跨进程锁（acquireCrossProcessLockWithTimeout；5s 档经 testableConst 工厂注入，A4 解构导出形态不进 ForTest 守卫正则——天花板 71 不变）；锁超时 fail-closed 跳过本书（failed++ + warn），幂等下次启动重试。用例 = 预持锁停走窗（超时跳过且文件不动 → 放锁补迁 → 三跑幂等）。
- **P3-15**（install/migrate-finalized-revision）：statusPorcelain + 脏集计算移入 withManifestLock 回调内（幂等复查之后、条目循环之前）；R64-23「git 状态在锁外取」注记记正——无依赖不等于无新鲜度要求，锁持有期含一次 git status 可接受。用例 = 新文件 r0916-migrate-finalized-status-in-lock（vi.hoisted 偏序断言 lock-in → status → lock-out；修前序 status-first 即红）。
- **nano-2**（review/contract）：去重键含 issue.trim() 使「空补非空」赋值分支不可达，死码删除（fix 补全行保留）。
- **nano-3**（format/style-entry）：`words.length > 0 ? words : []` 冗余三元改 filter 直返。
- **nano-5**（workbench textOut 截断）：截断点落代理对内时孤儿低位代理（0xDC00-0xDFFF）剔除。**记正**：初版判据取高位 0xD800——node 复现实证切点落对内时孤儿系低位段，判据已正、用例边界同步重建。
- **nano-6**（git/exec）：timedOut 判据收紧为 errCode === 'ETIMEDOUT'；外部 SIGTERM 单立文案臂（不再误归「操作超时」）。
- **nano-8**（fs/walk-md）：dirReal 可选参递归传递——首层 realpath 结果不再每子目录重做。
- **nano-9**（events/store ulid）：改直连 fs/id.ts（垫片消费面收敛 document 域、垫片保留；批一维持裁定「有意耦合」随作者指令一并反转，新调用点直连口径落注）。
- **nano-10**（TabBar/ContextMenu）：下拉坐标与翻位量系打开瞬间快照 + fixed Teleport，不随窗口 resize 重算——补 resize 监听重算（TabBar syncDropPos / ContextMenu measureFlip + resize 臂 recomputeFlip）。**记正**：ContextMenu watch 体初版将测量收进 async 函数再 await——多一跳微任务使 re2-context-menu-roving 焦点断言（单 nextTick 预算）假红——热路径保持原内联同步形态，仅 resize 监听臂走异步包装。
- **nano-11**（ChatDock/ChatComposer）：`--composer-min-h: 70px` 变量化 + 玻璃档 min-height 改消费该变量（跨文件魔法数单源）。

**范围记档**：作者指令系对批一维持 13 项清单的反转处置；波 1 失传 7 项明细不可恢复（仅存计数），不在可处置清单内，维持原登记口径不追补。

**批二 L2 终门（全绿）**：vitest 全量 1171 文件 = 7311 过 + 71 跳 0 败（一次全绿 343.91s）；tsc 0 / vue-tsc 0 / eslint 0-0（--max-warnings 0）；三 check 过（check:counts 修账后复跑一致——README 门槛行 1171 文件 / 7392 单测，win 差值锚 80→81）；e2e 51 过 + 2 跳（1.0m）；soak 五段 5 OK。测试账 = 净 +1 文件（r0916-migrate-finalized-status-in-lock）/+6 用例声明（5 中性 + 1 posix 门）。
