# CLWriting 全量代码审计报告

- 定位：**全量代码审计（2026-10-19 第二轮，独立复核）评审档**——只采源码、配置、测试与提交记录的独立结论（不读既有文档、不参照第一轮）；工作目录随落链撤销，正文即全部交付。不属于本档：修复方案落地（本轮未改代码）；第一轮分域与复核附档在同槽位。
- 执行模型：DeepSeek-V4.1-Flash（`ccats/deepseek-v4.1-flash`）主控；子 agent 派发全部因渠道限流失败，报告由主控独立完成。
- 出口：**有条件通过**。条件：① P1-01 服务端请求链同步 I/O 阻塞——修复或给出可接受性论证（含真实占用场景实测）；② P2-01 注释门盲区收口（补判据 + 存量清理另批）。P2-02~05 与 P3 余面排期（挂账见活账）。
- 落链注：本档原为仓根 `audit-fresh-2026-10-19/` 工作目录（未跟踪），2026-10-19 按文档链规范直接落槽位；口径档与辅助脚本随工作目录撤销。

- 审计基线：`45c48e57`（win / main 同点，2026-10-19 21:40 +08:00），工作树干净（仅未跟踪的审计工作目录）。
- 审计依据：仅当前源码、配置、测试、提交记录。按作者要求**未读取** `docs/`、`README.md`、`Dev/Docs/`、既有审计报告 `audit-2026-10-19/` 与决策记录；`AGENTS.md` 只作纪律约束，不作证据。源码注释可读，但一律先当「宣称」抽查。
- 行为边界：只产报告，**未改任何源码/配置/测试**；未 build、未跑全量测试、未跑 e2e、未联网。
- 方法：全库机械扫描（662 个源档 / 144,094 行）+ 关键链路精读（约 40 档）+ 门禁实跑 + 本机覆盖率工件复算 + 提交史抽样。覆盖缺口与结论强度见 §6。

## 0 规模与门禁基线（实测）

| 项 | 实测值 |
| --- | --- |
| 跟踪文件 / 提交 | 2,427 / 1,186 |
| 源档（ts+vue，不含 node_modules） | 662 档，144,094 行 |
| 代码 / 注释 / 空白行 | 95,021 / 41,470（28.8%） / 7,603 |
| 单测档 / `it`+`test` 块 / `describe` | 1,284 / 9,334 / 2,472 |
| 服务端注册路由 | 116 条（`defineRoute` 口径） |
| web-next `.vue` | 119 档 |
| 覆盖率工件（本机 2026-10-19 19:29 全量跑） | 657 档：lines 92.52% / branches 81.8% / functions 89.46% |

门禁实跑（`node <脚本>` 直跑，绕开沙箱下失效的 npx/bash 启动器）：

| 门 | 结果 |
| --- | --- |
| `tsc --noEmit` | 通过（0 错） |
| `eslint . --max-warnings 0` | 通过（0 warning） |
| `check:comments` | 通过（扫描 690 档）——但判据有系统性盲区，见 P2-01 |
| `check:suppressions` | 通过：315/315（140 档、189 个 file×rule 键，其余为同键 count>1） |
| `check:docs` | 通过 |
| `check:counts` | **未能执行**：`spawnSync … EPERM`（沙箱禁管道，见 §3） |

## 1 总体结论

- **实现完成度：A-**——1.0.0 功能面完整：116 条 REST 路由全部挂载、11 个主视图、桌面/浏览器双形态、多库多窗、AI 辅助链路、导出/审查/机检、更新与安装迁移均在位；未发现 stub、半接线主流程或说明性 TODO 之外的未完成标记（全库 `TODO/FIXME/XXX/HACK` 仅 3 处，均为说明文本）。扣分项集中在「仅 e2e 覆盖的 UI 面」与「无网络/无打包态无法验证的部分」。
- **整体质量：A- / B+**——类型与 lint 双清零、错误信封/错误码/路径脱敏单源、Electron 安全三件套（contextIsolation/sandbox/nodeIntegration:false）且不可被调用方覆盖、token 双闸 + Host 校验 + static realpath 判界、原子写 + fsync + 平台退避、覆盖率分桶门与治理测试体系都达到同类项目上限。扣分项：315 条 ESLint 抑制债、12 个 >800 行巨型档、注释门盲区与 28.8% 注释密度。
- **简洁优雅：B**——单源治理（覆盖率阈值单源、`ERROR_CODES` 单源、契约 conformance 编译期探针、re-export 桥断环）是明显优点；但注释体量接近三成、部分注释是历史叙事而非约束、巨型文件与同构适配器三份实现拉高了阅读成本。
- **最值得先修的 3 条**：**P1-01**（服务端请求链上的同步阻塞）→ **P2-01**（注释门盲区）→ **P2-02**（覆盖率单档空洞）。

优先级沿用审计口径：P0=数据丢失/安全/崩溃/静默错误可确证或主流程半接线；P1=高概率缺陷或结构性风险；P2=可维护性/一致性/重复实现/注释与实现不符；P3=微优化与风格。

## 2 问题清单（P0 → P3）

### P0（可确证）

**未发现可确证 P0。** 本次精读覆盖了鉴权/路径判界、原子写、事件库裁剪、离书/关窗保存链等高风险面，未找到「回退即产生数据丢失 / 越权 / 崩溃 / 静默错误」的确定证据。最接近的是 P1-01（阻塞导致的超时/假死风险）与 P2-02（未被测试兜住的回归面）。

### P1

#### [P1-01] 服务端请求链上存在同步 I/O 与同步退避原语，批量操作会整体停摆事件循环 `风险`

- **证据**：
  - `src/fs/atomic.ts:70-72`：`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)`——同步微睡原语；同档 `:66-69` 自述「重试 3 次 × 50/100/200ms = 350ms 同步睡眠/单次操作……期间承载 SSE/心跳/保存的单进程事件循环整体停摆同等时长」。
  - `src/studio/server/**/*.ts` 内 `readFileSync/writeFileSync/existsSync/statSync/readdirSync/realpathSync/mkdirSync/rmSync` 共 **95 处**（grep 实测）。
  - 批量路径按文件循环叠加：`src/studio/server/api/books-lifecycle.ts:224-238`（`for (const ent of entries)` × `SWEEP_RM_ATTEMPTS` 重试）、`:616` 三件套循环；`fs/atomic.ts` 的 `rmWithRetry` 在 `document/analysis.ts:226`、`document/foreshadow.ts:151/157`、`document/lead-finalize.ts:333/345` 等删源路径逐文件调用。
- **为什么是问题**：单进程 Node 服务同时承载全部 HTTP 请求、SSE 心跳与保存；同步 fs 与 `Atomics.wait` 在请求 handler 内执行时，事件循环无法处理其他连接。一次删书/清回收站/批量定稿遇到 Windows 杀软或索引器占用（EPERM/EBUSY 正是该退避存在的理由），最坏每个文件多等 350ms，数百文件即数十秒级停摆，前端表现为请求超时、SSE 心跳断流、保存队列雪崩。
- **影响面**：Windows 大书库删除/迁移/导出、批量定稿、诊断打包；与「200 万字不崩」的稳定性目标直接相关。
- **建议动作**：① 把服务端批量路径的 `rmWithRetry/renameWithRetry/atomicWriteFile` 换成异步孪生（仓内已有 `atomicWrite*Async` 之外的异步先例可循）；② 批量删除/导出挪到 utilityProcess/worker；③ 同步原语只在「读—写之间不得出现 await」的同步 RMW 临界段保留（注释已声明该约束），并给服务端调用面加 eslint 限制（如仅允许 `fs/atomic` 临界段白名单）。

### P2

#### [P2-01] 注释门判据存在系统性盲区：门自称「零批号标签」，实测仍有评审史残形 `确证`

- **证据**：
  - `check:comments` 判据表只覆盖 R 系批号、P 系债 ID、轮次（第 N 轮）、批次括注、日期戳、`复审/重审`、单字母域号；**不含**「阶段 N」「N--①」「全库代码审/全量代码」等本库实际使用的评审史形态（`scripts/check-comments.mjs` 头部判据注释与 `NARRATIVE_PREFIX_ATOMS` 可对照）。
  - 实测仍存在：`src/ai/llm-call-read.ts:2`（`* llm/call 事件读侧单源（2-， GLM-5.3，AI 域 -③）。`）、`src/studio/server/router.ts:69`（`/** 2--③（GLM-5.3）：当前活动路由表只读观测口…`）、`src/studio/server/router.ts:137-139`（`-7（全库代码审）`）、`src/desktop/preload.ts:70`（`/** 阶段 53：用系统浏览器打开外部链接…`）、`src/ai/provider/anthropic-adapter.ts:143`（`阶段 14 §7.2`）。
  - 全文口径计数：`阶段 *[0-9]+` **126 行**、`[0-9]--[①②③④⑤]` **18 行**、`全库代码审` **7 行**、`全量代码` **15 行**、`（低级）/（高级）` **6 行**；而门输出为「零批号标签、零切除残形」。
- **为什么是问题**：这是「门自述与事实不符」的确证形态——清理器留下的残形没有被判据接住，历史清理成果会随新增改动回弹；更实际的是，注释里保留模型名/阶段号/评审批次，读者无法判断该注释是约束还是过期叙事，与 `AGENTS.md` 注释纪律直接冲突。
- **影响面**：全库注释可信度、review 成本；门禁的可信度（一个「声称零」的检查实际不零）。
- **建议动作**：把「阶段 + 数字」「数字--圈号」「全库代码审」「全量代码」「低级/高级」加入标签族或残形族；用上述 5 个真实反例做负例回归（当前门只有正例语料）；清理存量 126+ 处后重跑并核对计数。

#### [P2-02] 覆盖率门按桶聚合，单文件空洞不会被拦；UI 主面实际只有 e2e 兜底 `确证数据`

- **证据**：
  - `vitest.coverage-buckets.ts:71-75`：`views/pages` 桶显式登记 `{ lines: 0, branches: 0 }`（「e2e 自管」）；组件聚合桶只要求 lines 80 / branches 66。
  - 本机覆盖率工件（`coverage/coverage-summary.json`，2026-10-19 19:29）中被聚合稀释的单档：`SettingsEditor.vue` lines **15.21%** / branches **0%**、`ShelfModal.vue` lines 47.69% / branches **11.01%**、`SidebarLeft.vue` lines **7.14%** / branches 0%。
  - e2e 量级：提交 `144ea1e1` 记「e2e 36 specs / 60 用例」，而 web-next 有 119 个 `.vue`。
- **为什么是问题**：聚合桶让「新加一个大档、只要总量不掉」就能过门；设置编辑、书架弹窗这类高频交互面的逻辑分支基本无单测，回归只能靠 60 条 e2e 用例或人眼。覆盖率数字看起来很高（总 lines 92.52%），但与「关键交互被守住」不是一回事。
- **影响面**：设置/书架/侧栏等 UI 的单点回归；与「完成度 A-」中扣分的「仅 e2e 覆盖」同源。
- **建议动作**：① 对 `components/**` 增加 per-file 底线（如 lines<50 且语句数>40 必须进显式白名单，白名单带理由）；② 把 `SettingsEditor/ShelfModal/SidebarLeft` 的关键分支补成 dom 单测；③ views/pages 的 0/0 登记保留，但要求每个 view 至少在 e2e 有 1 条「可交互断言」并登记映射表。

#### [P2-03] ESLint 抑制台账 315 条冻结：复杂度与不安全字符串化是主要构成，属于长期债 `确证`

- **证据**：`eslint-suppressions.json` 共 140 档 / 315 条（`check:suppressions` 上限同为 315，只减不增）。按规则聚合（文件数）：`complexity` **49**、`@typescript-eslint/no-unnecessary-type-assertion` **41**、`@typescript-eslint/no-base-to-string` **28**、`require-await` 12、`no-misused-promises` 8、`prefer-promise-reject-errors` 7、`no-unsafe-assignment` 7、`max-depth` 7、`max-lines-per-function` 6。
- **为什么是问题**：抑制是冻结而非清零，规则对新代码有效，但存量永久豁免；其中 `no-base-to-string` 28 档意味着日志/文案存在 `[object Object]` 的静默错文本面，`complexity` 49 档说明高复杂度函数是常态而非例外。这些是「质量看起来高」与「实际可维护性」之间的主要折扣。
- **影响面**：日志排障、后续改动风险、代码审查成本。
- **建议动作**：按规则分批清（先 `no-base-to-string`/`require-await`，成本低收益直接）；`complexity` 与 `max-depth` 档优先拆函数而不是继续冻结；每批同步下调 `SUPPRESSION_BASELINE`，让「只减不增」真正递减。

#### [P2-04] 巨型档与注释体量：阅读/审查成本显著偏高 `结构信号`

- **证据**：12 个 >800 行源档：`document/service.ts` 1283、`ai/runner.ts` 1220、`events/store.ts` 1137、`desktop/server-manager.ts` 1132、`ai/orchestrate/self-heal.ts` 913、`desktop/main.ts` 906、`ai/orchestrate/chat/turns-phases.ts` 879、`ai/provider/store.ts` 867、`state/health.ts` 863、`format/yaml-spec.ts` 845、`document/structure-merge.ts` 830、`web-next/src/stores/doc.ts` 819。`eslint.config.js:78` 的 `max-lines-per-function` 上限 200 行，但 6 档抑制。注释密度 28.8%（41,470 / 144,094），平均每档 ≈63 行注释。
- **为什么是问题**：核心域主档同时是提交热点（近三月 `document/service.ts` 93 次、`ai/runner.ts` 75 次、`server-manager.ts` 50 次改动），大档 + 大注释叠加导致每次改动需要重建大量上下文；注释中相当比例是「为什么这么修」的历史叙事而非约束，随时间腐烂（P2-01/P3-01 即证据）。
- **影响面**：维护速度、合并冲突、新 agent/新人上手成本；与「简洁优雅」维度直接相关。
- **建议动作**：按职责拆分 `service.ts`/`runner.ts`/`server-manager.ts`（纯函数段先出）；注释只保留约束/不变量/平台差/语义，叙事段改由 git 历史承载；给单档注释密度设观察阈值（不强制门）。

#### [P2-05] 测试面与 flake 兜底：数量充足，但平台/时序类回归依赖“重跑一次” `风险`

- **证据**：
  - `.skip(` **25 处**（部分为 `test/scripts/check-counts.test.ts` 的合成语料）、`.skipIf(` **94 处**（多数为平台守卫）、`.todo(` 1 处；真实 `.only` **0 处**（`git grep` 命中的 11 处均为 `check-counts` 治理档内的字面量语料；AST 门覆盖该形态）。
  - CI win 腿：首跑「非零退出且零 FAIL 行」时同命令重跑一次（`.github/workflows/ci.yml:164-181`，`win-vitest-retry` action）；重跑绿只写 step summary。
  - 本次受限沙箱未能复跑全量（见 §3），无法验证「9438 单测全绿」。
- **为什么是问题**：重跑兜底把「进程收尾竞态」从红变绿，真实 flake 只能靠 summary 统计发现；114 处 skip 中若有无条件或环境永假守卫，会长期零守护（仓内已有 `--expose-gc` 防「只能 skip」的先例，说明团队对此敏感）。
- **影响面**：发布前信心、跨平台回归。
- **建议动作**：定期统计 win 腿重跑命中率并作为指标；把 25 处 `.skip(` 逐条标注理由/回归条件；`skipIf(win32)` 类守卫补「非 win 平台必须跑到」的断言或单列 Linux 腿覆盖。

### P3

#### [P3-01] 注释中的过时数字与悬空路径（注释不能当事实） `确证`

- **证据**：
  - `vitest.config.ts:138` 注释称「全仓 110 个 .vue 均在此」，实测 `src/studio/web-next/src/**/*.vue` 为 **119** 档。
  - `src/shared/words.ts:27` 注释称等价性由 `test/format/pm2-count-words-equivalence.test.ts` 钉死；该档不存在，git 历史（`119d9523`）显示实际档名为 `test/format/count-words-equivalence.test.ts`。
- **为什么是问题**：注释是「宣称」，但被当作文档/审计依据时会产生错误结论；这类悬空路径正是注释门声称要防的「腐烂」。
- **建议动作**：修正两处；若要把「注释里的路径/数字」纳入门，需像 `check-counts` 一样做「宣称值对账」，否则至少人工巡检高频注释档。

#### [P3-02] `console.*` 与 `log` 混用（57 处，多数在入口/烟测路径）

- **证据**：`git grep console.` 在 `src/` 命中 57 行；集中在 `desktop/main.ts:315/572/871`（`[CLW_SMOKE]` 标记）、`desktop/server-boot.ts:62/66/118`、`desktop/server-utility.ts:208/213`；`format/piece-list-core.ts:55` 是「不可引 log 模块（零 Node 依赖）」的合理例外。
- **影响面**：打包态 `mirrorConsole=false` 时 console 输出不落 JSONL，排障缺失（`main.ts` 已在部分路径改走 logger，存在混用）。
- **建议动作**：入口/烟测保留并加「仅烟测」注释；其余统一 `log.*`。

#### [P3-03] `Math.random()` 生成 ID（9 处，含保存幂等键）

- **证据**：`src/studio/web-next/src/shared/revision.ts:25`（`op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`）、`src/ai/provider/store.ts:910/915`、`src/studio/web-next/src/shared/cross-window.ts:81` 等。
- **为什么是问题**：非安全用途，但 `op-*` 是保存幂等键，同毫秒 + 有限随机位存在理论碰撞；`crypto.randomUUID()` 零成本且可读性一致。
- **建议动作**：统一换 `crypto.randomUUID()`（浏览器/Node 均可用），去掉 `Date.now` 拼接。

#### [P3-04] re-export 桥档带来双 import 路径（设计有意，长期收敛项）

- **证据**：`src/check/run.ts`、`src/export/index.ts`、`src/format/words.ts`、`src/ai/provider/redact.ts` 均为纯 re-export 桥（覆盖率 0 语句），头注明确「只许 re-export」以断环。
- **影响**：同名符号存在「实现件 / 桥档」两条 import 路径，新代码选择面增加；但这是为断 import 环付出的合理代价，非缺陷。
- **建议动作**：作为架构债登记；若未来做包边界（shared/log 分层已就绪），可批量收敛到实现件 import。

#### [P3-05] `check-counts` 在受限沙箱不可用（环境问题，非仓缺陷）

- **证据**：`check:counts` 以 `spawnSync(node, …)` 调 `vitest list`，本会话沙箱（workspace-write）下返回 `EPERM`。CI 侧正常。
- **影响**：本次无法核对 README 声称的单测数（9,438）与实际账实；列入 §3。

## 3 无法判断项

| 项 | 为什么代码面判不了 | 需要谁/什么信息 |
| --- | --- | --- |
| 真实 200 万字/大书库下的性能与内存 | 未跑 soak/大库基准；覆盖率高不等于规模达标 | 本机/CI 跑 `npm run soak` 与 `test/check|rag/scale` |
| Electron 打包态行为（asar、更新安装、便携包） | 未 build、未跑 `build:desktop:dir`/release-smoke | 打包机 + `electron-smoke`/release 冒烟 |
| 多平台差异（mac/Linux） | 本会话仅 Windows 沙箱 | CI 三腿实跑日志 |
| 上游 AI provider 契约（流式/用量/错误形状） | 未联网、未打真实端点 | 真实 key 的 provider 探测与回放 |
| 知识层语料语义正确性 | 按审计口径未读 `resources/knowledge/` 与 `知识层/` | 知识层维护者/语料抽查门 |
| 文档与实现一致性 | 作者要求忽略现有文档 | 另开文档审计 |
| e2e 实际动线（36 specs/60 用例） | 未运行 e2e（需 build:web + playwright） | CI e2e 腿产物 |
| README 数字对账（9,438 单测等） | `check:counts` 在沙箱 EPERM；grep 近似 9,334 只覆盖行首 `it(`/`test(` | CI 上 `npm run check:counts` |
| AI 生成质量（文风/审查结论正确性） | 属模型行为，非代码面可判 | 语料评测/作者验收 |
| Git 远端状态与分支保护 | 只读本地仓库 | 远端仓库设置 |

## 4 分域快照（基于精读 + 结构信号，非逐档通读）

| 域 | 完成度 | 质量 | 依据与缺口 |
| --- | --- | --- | --- |
| 服务端 HTTP/路由/SSE（`src/studio/server`） | A- | A- | 精读 `http.ts` 全文、`index.ts` 鉴权/静态段、`router.ts`、`static.ts` 判界；66 个 api 档未逐档读 |
| 桌面壳（`src/desktop`） | A- | B+ | 精读 `preload.ts`、`windows.ts` 安全段、`lifecycle.ts` flush 链；`server-manager.ts`(1132) 未通读 |
| 文档/格式/机检（`src/document|format|check`） | B+ | B+ | 结构 + 写路径精读（atomic/trash/version 相关）；`service.ts` 未通读 |
| 事件库/文件系统/状态（`src/events|fs|state`） | A- | A- | 精读 `store-retention.ts`、`atomic.ts`、`cross-process-lock`；覆盖率高、不变量注释密 |
| AI/RAG（`src/ai|rag|learn`） | B+ | B+ | 仅机械扫描 + 局部（provider/store 适配器、turns 结构）；**本域缺口最大** |
| 前端（`src/studio/web-next`） | B | B | 精读 `stores/doc.ts` 保存链、`useAutoload`/卸载链；108 个组件未逐档 |
| 脚本/配置/门禁（`scripts`+根配置） | A- | B+ | 通读 CI/门禁脚本与覆盖率配置；门禁盲区见 P2-01 |
| 测试资产 | A- | B+ | 量级与分层清晰；skip/flake 兜底见 P2-05 |

## 5 亮点（与扣分项对照）

1. **安全基线扎实**：`contextIsolation:true / sandbox:true / nodeIntegration:false` 放在 `...opts.webPreferences` 之后不可让渡（`desktop/windows.ts:391-398`），并禁外部导航/新窗。
2. **鉴权链完整**：写端点 Origin+token、GET/HEAD token 闸、Host 精确匹配防 DNS rebinding、`apiPathname` 先规范化再判前缀（`server/index.ts:644-733`），token 常量时间比较 + 错误出口脱敏。
3. **原子写与平台适配**：fsync 文件+父目录、win EPERM/EBUSY 退避、临时文件权限 0o600、`.bak` 兜底（`fs/atomic.ts`）。
4. **单源治理**：覆盖率阈值/入口单一数据源（`vitest.coverage-buckets.ts`）、错误码双向对账、契约 conformance 编译期探针、契约方向治理测试。
5. **注释即不变量（正面）**：重要原语（`atomic.ts`、`http.ts`、`store-retention.ts`）的注释把不变量/失败模式/平台差异写清，这在同类项目中少见——问题不在“写注释”，而在“叙事与约束混写 + 门禁盲区”。
6. **测试体量与分层**：1,284 档、9,334 用例块、分桶覆盖率门、soak 门、e2e/Electron 冒烟、治理测试（token 豁免表同步、可见即记录、依赖方向、导入环）。
7. **发布链**：CI 五件套（typecheck/lint/format/build/test+coverage）三平台矩阵、npm audit ≥high、asar 打包冒烟、依赖 SHA 钉版、update 校验清单编译期派生。

## 6 覆盖声明与结论强度（诚实边界）

- **已扫描**：662 个源档全部经过至少一次 `git grep` 机械扫描（空 catch、console、sync fs、spawn、路径前缀、整数/时间、跳测、注释形态等）；根配置与 CI 已通读。
- **已精读**（约 40 档，全档或关键段）：`studio/server/http.ts`、`index.ts`(鉴权/静态/监听)、`router.ts`、`static.ts`、`fs/atomic.ts`、`fs/cross-process-lock` 相关、`events/store-retention.ts`、`desktop/preload.ts`、`windows.ts`(安全段)、`lifecycle.ts`(flush 段)、`web-next/stores/doc.ts`(保存链)、`shared/words.ts`、`vitest.config.ts`、`coverage-buckets.ts`、`check-comments.mjs`、`check-suppressions.mjs`、CI workflow 等。
- **未通读**：>600 档；AI/RAG 适配器与 orchestrate、document/service 全档、studio/server 的 66 个 api、web-next 的 108 个组件是最大缺口。
- **结论强度分级**：P2-01/P2-03/P2-04/P3-01 来自可复现实测（强）；P1-01 为结构性风险（中，未做真实 AV 占用压测）；分域评级为结构信号 + 抽读（中）；P0「未发现」只代表**本次可读证据面**未发现，不等于证明了不存在。
- 若要把本报告升级为逐档全量审计，建议按域另开 4 个专项（AI/RAG、文档写路径、桌面生命周期、web-next 组件），每域以「8~15 条可复现问题 + 单档定向测试」为验收，而不是一次性通读。

---

审计口径：本轮派发书（预算、证据规则、优先级定义）随工作目录撤销、不入链；优先级定义保留在 §1 末段。本报告未修改任何仓库源码或配置。
