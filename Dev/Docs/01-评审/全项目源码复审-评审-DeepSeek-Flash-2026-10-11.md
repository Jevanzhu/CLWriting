# 全项目源码复审报告（独立重读）

- 执行模型：DeepSeek-Flash
- 评审对象：`1.0.0-rc.4` 工作树（commit `8796e0a9`），全库源码
- 评审范围：`src/`（590 文件 / 130,379 行）+ `test/`（1372 文件 / 221,648 行）+ `scripts/` + 工程配置与 CI
- 评审方式：8 个分域独立评审（写作核心 / 桌面运行时 / AI 链路 / 前端状态 / 前端组件 / 支撑域 / 测试工程门 / 架构横切）+ 1 个红队核验（对 P1 逐条证伪）+ 机械面扫描与门脚本实测
- 前置声明：本次评审**不读** `Dev/Docs` 全部既有评审与方案文档（作者要求「忽略现有文档」），结论只依据源码、配置与可执行证据；文内锚点均为 `file:line` 或命令输出
- 修复状态：**已收口**——本报告为「只评审不修复」产出；随后的修复批已按 §四 A/B/D 全量 + §四 C 除 C5 外实施并通过全门验收，逐组处置、全门实录、效力边界与登记未修项见 **§七 收口实录**

---

## 〇、结论速览

**四问直答**

1. **完成进度**：功能面已齐备，不是「骨架 + 半成品」形态。八域评审一致判定**无占位空壳、无假接线模块**；全库 `TODO/FIXME/HACK/未实现` 实质命中 0 条（10 处字符串命中全为业务语义词）。明确「有缺口」的面只有三处：三审进度 SSE（自陈未实现且无排期）、更新链只有检查端（无下载/校验/安装）、以及若干「已建成未通电」件（RAG 默认关闭、`/analyze` 端点无 UI 出口、`host` 契约无运行期消费者、token 校准表空表）。版本已推进至 `1.0.0-rc.4`，1029 次提交 / 5 个月。
2. **完成质量**：**显著高于同类个人项目**。零 `any`、零 `@ts-ignore`、零 `eslint-disable`（src 全库实测）；门禁体系三 OS 矩阵 + 类型/格式/覆盖率/打包/文档五类门全部 fail-closed；测试零空洞档（1304 档零例外）；服务端安全边界（token/Origin/Host 三闸 + 常量时间比较 + 双 realpath 路径闸）成型。但存在 **4 条 P1**，其中「诊断包隐私红线名不副实」与「治理门对 `.vue` 全盲且已有实违规穿门」两条直接影响对外承诺与架构纪律的可信度。
3. **简洁优雅**：**纪律 A 档、简洁 C 档**。抽象层单源收编做得比多数商业项目扎实（表驱动、端口反转、编译期契约钉子），但被两样东西压住了简洁性：① 源码注释占 `src/*.ts` 的 **33.2%**（3.4 万行），其中大量为变更史、批号考古、与评审的辩论记录；② 测试量达源码 **1.71 倍行 / 2.35 倍文件**，1304 档均 6.5 用例，28.6% 用例名带批号。这是「用大量文本对冲复杂度」的工程——可靠，但阅读成本高。
4. **优化点**：可立即动的低风险项 8 条（详见 §四 A），需拍板项 5 条（B），架构级欠账 7 条（C）。按「收益 ÷ 成本」排序，第一优先是**把诊断包的内容面做成真防线**，其次**修治理门盲区**、**把 worker 入口纳入覆盖率视野**。

**一句话总评**：这是一个「可靠性已被工程化到极致、简洁性被工程化牺牲」的代码库。它的风险不在写错，而在**声明的边界与实现的事实在少数几处不一致**（隐私红线、架构方向门、覆盖率可见性、预算闸账目）。

---

## 一、完成进度盘点

### 1.1 客观画像

| 面 | 实测 |
|---|---|
| 源码 | 590 文件 / 130,379 行（`src/`，不含 node_modules） |
| 其中前端 | `src/studio/web-next/src` 223 文件 / 43,992 行（SFC 113 个 / 28.6k 行） |
| 其中后端服务 | `src/studio/server`（含 api/ 58 文件 / 13,512 行） |
| 测试 | 1372 文件 / 221,648 行；1304 单测档 / 8486 用例 / 34 e2e spec / 56 用例 |
| 测试 : 源码 | 1.71× 行 / 2.35× 文件 |
| 开发史 | 1029 提交，2026-05-14 → 2026-10-11（约 5 个月） |
| 类型纪律 | `: any` 0、`as any` 0、`@ts-ignore` 0、`eslint-disable` 0；`as unknown as` 14、非空断言 57（分域计数口径不同，桌面域单独实测 120） |
| eslint 抑制表 | 177 文件 / 531 条（no-base-to-string 88、no-misused-promises 86、no-unnecessary-type-assertion 81、complexity 56、no-unsafe-* 108、max-depth 28） |
| 注释占比 | `src/*.ts` 33.2%（33,894 注释行 / 62,305 代码行）；test 12.6% + 头注释 516KB |
| 复杂度 | 函数 >150 行 58 个、>100 行 101 个；最长 `useRelationGraph` 584 行 |
| 跨文件重复 | 机械扫描 ≥12 行同块簇 130 个（逐簇核实：多为有意镜像 / 契约对账 / CSS 样板） |

### 1.2 分域完成度汇总

| 域 | 判定 | 关键判定依据（锚点见 §五 与各域报告） |
|---|---|---|
| 写作核心（document/format/check，2.2 万行） | **完成** | 保存链五重守卫 + 单读派生 + journal 闭环；结构操作 merge/split 有崩溃不变量与幂等续跑；YAML 三面从一张表派生；46 条 checkId 全有产出点 |
| 桌面运行时（desktop/server/fs/install/driver/update/git，2.9 万行） | **完成** | 子进程显式状态机 + 退避 + 稳定窗；原子写 tmp+fsync+rename；跨进程锁 O_EXCL + 载荷校验；HTTP 鉴权四闸齐备。**唯一范围裁剪 = 更新链只到「检查」** |
| AI 链路（ai/rag/process/knowledge/learn/review，2.3 万行） | **完成** | 三协议适配器接口对等（已知不对称项已前移到探测提示）；重试决策单点（SDK 侧 maxRetries:0）；预算闸三判据 fail-closed；RAG 真接线但默认关闭 |
| 前端状态（stores/composables/api，1.8 万行） | **完成（过度加固型）** | 每条已知边界都有守卫 + 注释记账；跨书串扰在 store 层系统性防住（十面排查无 A 书响应落 B 书路径） |
| 前端组件（components/editor/shared，2.6 万行） | **完成** | 100 个组件 0 孤儿；0 `v-html`；监听与定时器 100% 配对；Beta 面（关系图/文风收割）功能成熟（关系图 a11y 缺角见 §2.3） |
| 支撑域（events/state/metrics/cache/export/log/diagnostics/shared，9.5 千行） | **完成** | 导出零 `rmSync`（不覆盖作者产物）；事件库并发设计有实证（BEGIN IMMEDIATE + 重查 + 墓碑 fail-closed）；诊断包已接线（隐私面见 P1-1） |
| 测试与工程门 | **完成（量超配）** | 零空洞档、断言密度中位 3.0/用例、真磁盘/真 sqlite/真 HTTP 集成、五 check 全 fail-closed |

### 1.3 明确未完成 / 未接线面（穷举）

| # | 面 | 事实 | 锚 |
|---|---|---|---|
| 1 | 三审进度 SSE | 未实现，源码自陈「无排期」 | `web-next/src/stores/review.ts:17` |
| 2 | 更新链下载/校验/安装段 | 只有静默检查 + stable 过滤 + 自实现 semver；无下载、无哈希/签名校验、无安装、无增量 | `src/update/check.ts`、`semver.ts`（域内仅 266 行） |
| 3 | `/api/books/:name/documents/:docId/analyze` | 后端实现完整，**生产零调用**（仅测试驱动）；前端配套数据 `allChapters` 已备齐却 0 调用 | `server/api/analysis.ts:384`、`web-next/src/api/analysis.ts:70` |
| 4 | `readSnapshot`（版本预览） | 前后端双侧实现，`HistoryPanel` 只用 list/restore | `server/api/snapshots.ts:429`、`web-next/src/api/snapshots.ts:25` |
| 5 | `book.yaml` 的 `host: cc\|codex` | 写入/解析/回显全通，**无运行期消费者**（driver 只看 `CLWRITING_DRIVER`）；`POST /api/books` 静默接受 `codex` | `scaffold.ts:62/75`、`format/yaml.ts:243`、`server/driver-port.ts:54`、`server/api/books.ts:147` |
| 6 | RAG 检索链 | 真接线（已配 key → recall → 注入），但默认 `ragEnabled=false`，属「已建成未通电」 | `process/materials.ts:263-278`、`format/global-defaults.ts` |
| 7 | token 校准表 | `TOKEN_COEFFICIENTS` 为空占位表，`estimateTokens` 恒用 0.6 兜底 | `shared/tokens.ts:21-26` |
| 8 | 死导出 7 处 | 域内皮 + 测试面双零引用 | 见 §2.4 P3 摘要 |
| 9 | 测试缝 | 生产码内 `__testHooks`/`__set*ForTest`/`testableConst` 约 14+5 处 | 各域均有分布 |

**未完成面之外的「软链」**：三审 verdict 与机检红项**不阻断定稿**（唯一定稿硬闸 = 长篇布线账本两端闭合 `LEAD_GATE`，`document/finalize.ts:203-213`）。这是有意的作者主权设计，但验收口径须写明，否则会被读成「已接线」。

### 1.4 进度判断

1.0 首发所需的功能面已全部落地，剩余是**口径收口**而非功能开发。按源码形态判断，项目当前处在「功能完成 → 打磨期」的交界：加固项（多库多窗、txt 导出、诊断包、知识层注入）在最近 15 个提交内集中入库，说明收尾节奏正常。

---

## 二、质量与风险清单

### 2.1 P1（经红队核验成立）

#### P1-1 诊断包隐私红线名不副实：书库文本随日志入包
- **声明面**：`diagnostics/index.ts:12-18` 模块头注「书稿正文永不入包」；`:159` 包内 `说明.txt` 向作者写「不含书稿正文、设定、大纲等任何书库内容」。
- **事实面**：`collectLogEntries`（`diagnostics/index.ts:284-311`）**无 tag/level 过滤、无内容过滤**，逐行只做目录前缀替换 + `redactSecret`（凭据正则，不涉书稿）；而日志本身就携带书库文本切片：
  - `format/leads.ts:180` 落 40 字**布线履历原文**（生产可达：`document/lead-finalize.ts:272`、`document/foreshadow.ts:94` 消费的 `parseHistoryWithPreamble`）
  - `check/lead-updates.ts:144` 同款账本推进原文
  - `format/yaml.ts:138/147/158/240/249` 落 `book.yaml` 行内容片段（作者手写的 front matter 原文）
  - `state/health.ts:498-503` 落含章文件名的相对路径（即章标题）；`cache/rebuild.ts:555` 落子目录名
- **红队实证**（复刻 scrub 口径后真实输出）：`履历条目格式不符被丢弃（应为「- 第N章 动词：证据」）：- 第7章 揭示：林晚在码头认出顾昭藏在旧钟里的钥匙…` —— 正文原样保留。
- **测试缺口**：`test/diagnostics/bundle.test.ts:173-175` 只断言哨兵字节不在包内，而 fixture 日志不含任何书稿文本 → 该断言不能证明它看起来要证明的事。
- **影响**：作者按产品提示「生成诊断包发给开发者/贴到 issue」时，账本片段、章标题、设定片段随包外流。**这是对外承诺与实现事实直接冲突**，属本报告最应优先处理项。
- **核验**：红队 V1 成立（并发现原报漏列的 5 处切片日志）。

#### P1-2 架构方向门对 `.vue` 全盲，且已有实违规穿门
- **事实面**：三张最重的治理门只收 `.ts` —— `test/governance/dependency-direction.test.ts:64`、`ai-studio-direction.test.ts:74`、`runtime-import-cycles.test.ts:40` 全部 `name.endsWith('.ts')`。前端 113 个 SFC / 28.6k 行（web-next 的 65% 行数）整体在门射程外。
- **实违规**：`web-next/src/components/panels/chat/ChatMessages.vue:32` 直引 `src/ai/contract/tool-meta`；而 `ai-studio-direction.test.ts` 头注明写「web-next 永远零 ai 直连（经 HTTP 访问 server）」。我用该门自己的正则复算，判定为 `true`（若这是 `.ts` 文件就会红）——**规则存在但已失效的实证**。
- **同类面**：web-next 另有 5 个文件跨包直引后端源码（`stores/chat-dispatch.ts:32`→`shared/text`、`shared/words.ts:5/8`→`format/words`+`format/frontmatter-core`、`components/style/StyleEntryPanel.vue:11`、`components/audit/AuditEventList.vue:28`、`api/documents.ts:17/33`→`shared/contract/documents`）。这使「前端只经 HTTP 访问 server」在实现上不成立，且同一文件被两套 tsconfig 各编一次（类型上下文分叉）。
- **影响**：架构约束的唯一执行机构失效；跨包契约与依赖方向在 SFC 面全靠自觉。
- **核验**：架构评审发现，我亲自复核确认（门脚本原文 + 违规行 + 正则复算）。

#### P1-3 覆盖率门池化语义：10 个 0% 文件过门，含 3 个 worker 入口
- **事实面**：`vitest.config.ts` 的 28 桶阈值**无 `perFile`**（`grep perFile` 0 命中）；`coverage/coverage-summary.json` 中 `lines>0` 且 0% 的文件恰 10 个：`studio/server/api/analysis-worker.ts`(12 行)、`cache/rebuild-worker.ts`(4)、`export/export-worker.ts`(4)、`components/relations/RelationDetail.vue`(18)、`RelationGraph.vue`(11)、`composables/useLibraryIpc.ts`(11)、`pages/Library.vue`(36)、`pages/Welcome.vue`(25)、`views/LearnView.vue`(30)、`RelationsView.vue`(18)。
- **关键性**：三个 worker 入口含真实可执行行（`parentPort` 消息循环、读章+统计），恰是单测够不到、运行时才炸的一类；353 档主桶 92% 的均值让它们对门不可见。
- **保留意见**：`coverage/` 是分桶局部跑产物（配置自注），数值需以 CI 全量跑复核；「无 perFile + 池化 + 无桶外文件」是配置级事实。
- **核验**：红队 V6 成立。

#### P1-4 章预算闸存在两处有界开口（欠记账方向）
- **开口 1（闸后花销）**：`ai/orchestrate/self-heal.ts:581` 首稿预算闸 → `:587` 调 `prepareChapterMaterials`，备料会触发内部摘要 LLM 调用（≤2 章摘要 + ≤1 卷摘要，三重门控后才发），这些调用计入**本章**账块（`process/summary.ts:275` → `ai/runner.ts:1143` → `calls.ts:657-685`）。
- **开口 2（check-then-act）**：`ai/calls.ts:352-370` 自陈「锁外快照读，与 consume 的锁内记账构成窗口，超额上界 = 并发写者数」——跨进程双开同书可各自过闸、双双超帽（默认 `callsPerChapter=8`）。
- **方向与上界**：欠记账（花得比账多），有界（≤3 次备料 + 一份并发余量），下一章闸重新对齐。**非闸失效**——损坏账本保守阻断、`limit<=0` fail-closed、SDK 重试关闭、`Retry-After` 超帽转终态均已在位。
- **核验**：红队 V5 成立；两处开口均已在代码内登记（「口径登记不修」/「既定取舍不按 bug 处理」），属**知情取舍**而非隐瞒缺陷。列 P1 的理由：作者对 `callsPerChapter` 的直觉与实际账目不一致。

### 2.2 分域报 P1 但经核验被证伪或收窄（**不要按原结论传播**）

| 原报 | 核验结论 | 事实 |
|---|---|---|
| 前端 409 恢复链 GET-merge-PUT 会**静默吞掉他窗写入** | **不成立** | 重试 PUT 带刚取的 `revision`，服务端逐请求比对 `expectedRevision`（`server/api/prefs.ts:220`、`revision-guard.ts:14-20`）→ GET 与 PUT 之间他窗写入会让重试收 409 + error toast，不是静默覆盖。三态告知有测试钉（`test/studio/webnext/dom/prefs-409-recovery.test.ts:203-231`）。**残留真缺陷更窄**：恢复链 `await getGlobalPrefs()` 期间本窗新编辑不在 `localCache`，会被 `applyPrefs(merged)` 回退且基线记为回退态（毫秒级窗口）；另 `stores/prefs.ts:268` 迁移 PUT 不带 expectedRevision，是唯一可无条件覆盖他窗同键的写 |
| 自动保存对**已不可见文档**静默失效、屏幕与磁盘分叉 | **不成立** | `views/EditorView.vue:321-323` 顶层 `<EmptyState v-if="!entry">`，`docs` 为响应式 Map，delete 触发编辑器卸载，不存在持续分叉态。**残留真缺陷**：外部删除到 404 判定之间键入的内容随 `docs.delete + mirror.clearDirtyMirror` 一并丢弃且无提示（`test/.../flush-deleted-doc-not-failed.test.ts:2-4` 显式接受该前提） |
| 短篇字数口径偏高导致**假红阻断定稿** | **部分成立**（阻断腿证伪） | 口径偏高属实：`format/words.ts:8-13` 自陈「对白密集章系统性偏高（实测可 +38%）」，红队独立算例实测 **+34% / +55%**（对白与标点密集样本）；`piece-word-*` 在短篇严格模式升红属实（`check/runner.ts:394-437`、默认区间 8000–20000）。但**「阻断定稿」不成立**：唯一定稿硬闸是长篇账本闭合（`document/finalize.ts:203-213`）。真实拦截面 = **AI 自愈循环**（`process/retry.ts:41-58`：红项 → 重写 → 3 次后升级）。即伪红打回的是 AI 自动写章，不是人工定稿 |
| win 腿重跑兜底会**洗白真 flake** | **部分成立 → 降为 P2** | 机制属实（`.github/actions/win-vitest-retry/action.yml:26-39`：首跑任何非零退出都重跑一次，区分逻辑只喂 warning 文案）。但存在正式台账（`03-设计/win腿间歇红台账-现行规范`）与 release 前「同 commit CI 全绿门」（`desktop.yml:473-525` fail-closed）制衡。**遗留缺口**：无计数器/无失效期（重跑成常态也不会红）；action 注释把成因写成 tinypool teardown，而现装 vitest 5.0.1 依赖树**已无 tinypool**（`package.json`/`package-lock.json` 0 命中），注记与 HEAD 不符 |

### 2.3 P2（值得修，按域）

**支撑/安全**
1. **日志密钥掩码对 JSON 形态失效**：规则要求 `?`/`&` 前导或 `x-api-key[:\s]+`（`log/index.ts:255-258`、`log/redact.ts:29-30`），但执行点是**序列化后的 JSON 行**——`{"api_key":"..."}`、`{"x-api-key":"..."}` 全不命中，仅厂商前缀族与智谱/Gemini 形态能命中。自建网关 token、会话 token 会裸进日志并被诊断包带走（与 P1-1 同源放大）。
2. **onboard 覆盖写 fail-open**：`server/api/onboard.ts:168-182`、`:231-247` 快照留底失败一律 warn 后继续落盘；同仓 `api/files.ts:210-226` 已就同类情形裁定 fail-closed（`NonUtf8TargetError` → 400）。非 UTF-8 存量书稿的覆盖写会静默丢手改。
3. **事件库无保留/归档策略 + 存储层无版本阶梯**：append-only + compaction 遮蔽，唯一删减出口是用户显式清空（`events/store.ts:806-823`）；`llm/call`、`tool/call` 高载荷事件无限增长；库落 userData（跨机同步丢失且无导出通道）。且全仓 **0 处 `user_version`**，三处 sqlite（events/rag/cache）靠 `PRAGMA table_info` 探列 + `ALTER TABLE ADD COLUMN`——加列可行，改名/改型/回滚无路径。

**桌面/运行时**
4. **`.删书墓地` 无清扫兜底**：热路径只做 rename，rm 交后台且失败仅留痕，启动/健康检查均不扫（`api/books-lifecycle.ts:187-195`）→ 清理失败的大书目录（含 `.git`）永久驻留。
5. **`lifecycle.ts` 五旗退出编排**：5 个模块级可变旗 + 私有标记表达退出链（`:392-516`），与本仓 `server-manager.ts:232` 的显式状态机先例相背；正确性只能靠通读整文件保证。
6. **`fs/atomic.ts:37-57` 有界同步阻塞**：rename 的 EPERM/EBUSY 退避 = 3 次 × 50/100/200ms 同步 `Atomics.wait`，最坏在承载 SSE 的单进程事件循环上停 ~350ms。
7. **缓存失效靠人手清单**：`forgetBookKeyedCaches` 一个函数里 22 条 `forget` 调用（`api/books-lifecycle.ts`），全仓 27 个 `forget*` 导出；新增书级缓存漏加一行即跨书陈旧数据串味，无编译期/运行时兜底。

**前端**
8. **跨窗无任何主动通知通道**：全前端 grep 0 处 `BroadcastChannel`/`storage` 事件监听；三窗同源、localStorage 物理共享，但每渲染进程各持内存副本 → 一致性只能靠写时探测（心跳、TTL、409）。对此产品是多窗形态，属能力缺位而非实现疏忽。
9. **provider store 双域共用 revision**：AI providers 与 RAG providers 写同一个 ref（`stores/provider.ts:112`/`134`），`refreshAll` 并发跑两者、后到者覆盖；跨域写会发出失配的 expectedRevision（推断服务端两类资源各自计数，需核对）→ 伪 409 与误导提示。
10. **chat 消息无体积上限**：只按条数裁剪（`stores/chat-dispatch.ts:61`），assistant 正文无闸（单条可含整章正文）→ 长会话内存膨胀；workbench 侧有对称防线（`MAX_TEXT_OUT`），chat 侧缺位。
11. **关系图无键盘路径**：节点 `<g>` 无 `tabindex`/`role`，根 `<svg role="img">` 把交互树声明为图片，键盘/读屏用户无法选节点看详情（`components/relations/RelationGraph.vue:17-114`、`RelationDetail.vue:42-53`）；图例是 `span @click`。与全域其余交互面（tree/菜单/palette 全量 roving）落差明显。
12. **ContextMenu 的 Tab 关闭路径不还焦**：`components/ui/ContextMenu.vue:312-314` 只 `emit('close')`，而 Esc 路径显式还焦来源（`:249-259`）→ 同一组件两条关闭路径焦点语义不一致。
13. **`stores/prefs.ts` 表驱动五处联动**：新增一个偏好键要改五处（DEFAULTS / PrefValueMap / PREF_ROWS / api 接口 / 承载 ref，文件 `:36-41` 自列），且 apply 守卫的边界数字（`gt/gte/lte/round`）与行上的 `set:{min,max,round2}` 是两套平行定义 → 改一处漏一处编译器不报。

**AI**
14. **`openai-adapter.ts` 复杂度债最重**：单文件 20 条 eslint 压制（`max-depth` 15、`complexity` 2），是三条协议线里唯一需要 15 层嵌套的地方；也是「探测参数与生产参数不一致 → 400」的历史高发面（`probe.ts:8-9` 自陈）。
15. **usage 估算与扣减的两个低估面**：`openai-adapter.ts:272-281` 的 `Math.max(0, prompt_tokens - cached_tokens)` 在非规范网关下会二次扣减（低估 inputTokens）；无 usage 时全走字符估算（`estimated` 有粘性标记，可信但非精确）。
16. **chat 历史净化无记录通道**：`sanitizeHistory` 替换掉的模型消息只留确定性占位符（`prompts/chat.ts:380-400`），不产生「哪条被替换」的事件记录 → 与「模型可见 ⟺ 已记录」纪律有缝。

**写作核心**
17. **回收站孤儿条目**：`doTrash` 先写登记再落位，落位连续失败或重试链内再登记失败时直接返回错误，**已写入的条目无人撤销**（`document/service.ts:909-949`）；尾段清单删除失败同样留「条目指向不存在路径」（`:1012-1018`）。当前无数据损失，但与 `structure-merge.ts:326` 的 `alreadyTrashed` 判据耦合，人工放回文件后合并续跑会二次软删空转。
18. **`structure-merge.ts:415` 事件载荷裸断言**：同循环内 `merge-undo` 流走 `Record<string, unknown>` + `typeof` 校验，`merge` 流走 `as unknown as StructureMergeData` 后直接取 `targetDocId`/`planHash` 用于 undo 定位——事件库是持久化可改写面，脏载荷会让 undo 定位错选源章。
19. **`metrics/style.ts` 三处口径瑕疵**：`kind` 形参零使用（`:211-283`）；`SHORT_TREND_MIN` 注释称「短篇不做趋势判定」实际同时闸长篇（`:229`）；同域两套字数口径（`codePointLength` 含空白 vs `countWords` 剥空白码位）。

**测试与工程门**
20. **测试量超配 ~1.7–2.2×**：1304 档均 6.5 用例（中位 4）；分档固定开销占本地全量墙钟约 40–50%（单档 40–155ms）；`tree-issues-*` 9 档 / `store-*` 14 档 / `chat*` 36 档；79 档重定义 `function makeBook`、`LIVE_FOREIGN_PID` 常量逐字复制两份；参数化仅 38 处（0.4%）——**该有 `it.each` 的地方在按键手抄新档**。
21. **测试锚错两类**：19 档直接 `readFileSync(src)` 断言源码文本（如 `api-layer-single-source.test.ts:26-29` 断言行签名逐字相等 → 行为等价重构即红）；83 档 spy log + 2,512 处 `toContain('中文…')`（文案耦合）。
22. **`check:counts` 与测试规模的耦合反向激励膨胀**：README 徽章/技术栈/门槛句与 CLAUDE.md 档数要求逐字对账（`check-counts.mjs:589-637`）→ 加一档要改 3–4 处散文，**删一档冗余测试同样要改 3–4 处**，制度性把摩擦加在简化一侧。
23. **散文门的性价比**：`check:docs` 的 16 条禁语表一句改写即绕（实测 `阶段 39 收口`/`第五次全库评审` 全过），真实防线只有字节/行长上限且只覆盖 4 个文件；`check:comments` 只扫 595 档 src，**最大注释沉积面 test/（10,302 处批号标签 / 28,176 注释行）被豁免**——修复史没有消失，它搬进了测试头注释。
24. **用例命名承载变更史**：10,908 条 it/describe 中 3,117 条（28.6%）带批号域号（`describe('R67-2 开口标记生命周期')`）→ 失败输出告诉你「哪一批」，不告诉你「什么行为」。

### 2.4 P3（摘要，可选优化）

- **死导出 7 处**（域内双向零引用）：`desktop/windows.ts setDevProxyApplied`、`desktop/server-manager.ts ManagerStateSnapshot`、`desktop/server-utility.ts ParentPortLike`、`desktop/startup-instance.ts StartupLibraryResolution`、`desktop/signal-hard-exit.ts RepeatedSignalExitDeps`、`desktop/os-kek.ts RosettaProbeDeps/OsKekDeps`。注意：机械面报的另 5 个候选（`SaveLocksArgs`/`Capabilities`/`ChapterNoMismatch`/`RestoreResult`/`OutlineLocate`）经核验为**假阳性**（签名类型经推断消费）。
- **常量/数字三处漂移**：`playwright.config.ts:22`「现 33 spec」、`test/e2e/spec-order.guard.test.ts:1-3`「31 specs」、实测 **34**；`vitest.config.ts` 两处桶注释阈值与数值已脱钩（api 桶注释称 87/93 实际 91/88；metrics 注释称 96/98 实际 91/80）且无机器校验。
- **测试缝与观察口**：生产码内 `__testHooks`/`__set*ForTest`/`debugLogQueueForTest`/`yield-stats` 全局计数器约 14+5 处；`shared/yield-stats.ts` 5 个计数器「生产只增不读」。
- **非空断言集中**：桌面域 api 层 108 处多为 `params['name']!`/`ctx.workDir!`（路由/装配保证非空）——安全但把证明留给读者。
- **CI 冗余**：约 12 步平台无关门 × 5 腿 ≈ 每次 CI 60 次冗余执行，含 10 次全量类型感知 lint；两个 perf 界值门最大放水 48× 实测（`check/scale.test.ts:38-45`）。
- **其他**：`test/fs/atomic-rename-retry.test.ts` 唯一一档 `mkdtempSync` 无清理；`check-packaging.mjs:379` 有一行 env 可跳过 darwin dist 门（CI 未设）；`test/studio/webnext/node_modules/.vite/` 缓存落在测试树内。
- **可接受但需知情的取舍**：三审/机检不阻断定稿（作者主权）；`book.yaml` 导出带 `#%` 批注形态与正文字面无法区分故不剥（`export/index.ts:136-137`）；`STEP_PATH` 前后端逐行同构重复且无漂移守卫；`prefs.ts:903` 域内唯一类型逃逸（表驱动必然代价）。

### 2.5 质量强项（值得保留的资产）

1. **类型纪律硬**：src 全库 `any` 0 / `as any` 0 / `@ts-ignore` 0 / `eslint-disable` 0；14 处 `as unknown as` 集中在真边界（node:sqlite 迭代返回、动态键遍历）。前端状态域与 AI 最复杂两文件（`runner.ts`、`turns-phases.ts`）**零 eslint 压制**。
2. **门禁体系上游**：三 OS 矩阵、抑制表 prune 后 diff 空门、覆盖率 28 桶（全部桶实测全绿、与「阈值=实测−2pp」自洽）、五 check 全 fail-closed、打包/asar 冒烟/soak 内存门（SKIP→OK 行数不符即红）。
3. **测试是真验证**：零断言档 = 0（AST 级检查）；断言密度中位 3.0；607 档真 `mkdtemp` 集成；带阴性对照的定量断言（如 gc 门控 2500 次开关堆增长 <0.5MB）；`.only`/无条件 `.skip` 由 AST 拒绝。
4. **契约镜像有编译期钉子**：`shared/contract/documents.conformance.ts` 用双向 `SameShape` 断言在 `typecheck` 上钉死前后端镜像漂移——本报告见过的最优雅设计之一（机械重复扫描在此为假阳性）。
5. **安全边界成型**：本地 HTTP 四闸（token/Origin/Host/回环绑定）+ 常量时间比较 + 双 realpath 路径闸 + IPC `senderFrame` 主帧校验 + 外链白名单精确边界；token 落盘 0o600、仅经 env 传子进程。
6. **失败面产品化**：降级不打哑谜——结构化 note/旗标（`ragUsed/ragNote/ragTruncated`）、可诊断文案 + 事实字段、阻断级 issue 代替空 `passed`。
7. **不覆盖作者产物**：导出全文件零 `rmSync`，同名先归档、归档失败改序号名；回收站登记先于移文件、死书弃写回、续跑补录。
8. **诚实降级**：`os-kek` 自陈「仅混淆级、非加密」（`OS_KEK_SHELVED=true`）；vault-key 自陈「碎片异或不是密码学秘密」；`short-index.ts:5-8` 头注主动纠正自己早期的假声明。

---

## 三、简洁优雅评估

### 3.1 直接回答

**这个域整体算「可靠但不简洁」**：抽象层单源做得扎实（表驱动、端口反转、组合根注入），复杂度主要的敌人不是失控的抽象，而是**文本量**——注释 33.2%、测试 1.71×、用例名 28.6% 带批号。读这个代码库的体验是「读一份带完整审计轨迹的工程日志」。

**优雅成立的部分**：`SECTION_SPECS` 一张表派生 parse/emit/get 三面（新增键只触一行）；`createTtlProbeCache` 把 17 份同构缓存收成一个工厂；`DocContext` 组装根 + private 可变状态；服务端 `RouteOverrides`/`RouteDeps` 显式注入；契约 `SameShape` 钉子；`export/` 按阶段拆纯函数（`ExportRun/ExportPlan/StageResult`）。

**不优雅成立的部分**：巨型 `register*` 函数（`stream.ts:237` 517 行 / `providers.ts:58` 448 行 / `createStudioServer` 383 行 / `analysis.ts:345` 382 行）；`executeSave` 372 行 + 三层嵌套 try；`doTrash` 250 行（内层 try 160 行）；`useRelationGraph` 584 行单函数返回 50+ 字段；`ChatMessages.vue` 735 行；CSS 半抽象（`btn-shared.css` 只收 3 条基属性，6 个文件各自重复 11–15 行 → 9 簇真重复）；跨包 99 个手抄 interface（82 处注释明写「镜像后端」）。

### 3.2 注释评估（本次评审的重点项）

**总判**：主流是**约束型注释**（不变量/根因/代价/方向/红线锚）——这类是资产，密度虽高但「删掉就会有人写错」。问题在混入的**流程/自证/元评论型**噪音，且在文件头集中出现（读者第一屏是辩论史而非用法）。

**正例（应保留为范式）**
1. `ai/gen.ts:101-110` —— Node `timer.refresh()` 在 `clearTimeout()` 后是 no-op 的**实测勘误**，钉住「每个 chunk 都要新建 timer」，带版本号。防未来「顺手优化掉」。
2. `ai/calls.ts:89-93` —— 「已在记账写锁内时不得嵌套 serializedWrite」+ 后果（`Atomics.wait` 自锁至超时 → 丢账 + 谎报损坏）。一句话封住一类死锁。
3. `document/trash.ts:318-334` —— 两道放大器机制（锁原语 `mkdirSync` 复活死书目录树 + 「文件缺失按合法空」的读口径让写回「成功」）+ 实证结果（孤儿清单 + 0b 空清单）。不变量型范本。
4. `events/store.ts:168-174` —— `ORPHAN_GRACE_MS = 32min = AGENT_DEADLINE_MS + 2min` 并说明为何不能 import 该常量（会成环）。真正的不变量锚。
5. `export/index.ts:246-260` —— 文件名 255 字节预算必须扣掉 `atomicWriteFile` 的 tmp 后缀 52B，否则三平台 ENAMETOOLONG。极具体可验证。
6. `log/index.ts:396-401` —— 日期文件在 flush 时重取而非入队时取（避免跨零点写进前一天文件）。

**反例（建议成批清理）**
1. `composables/useScopedAction.ts:56` 起 **56 行连续头注**（占该文件 54%），其中约 40% 是「此前谁在哪写过什么」的流水账，另有 20 行解释「为什么这些点**不**换装」——「把 PR 描述写在源码里」。
2. `events/store.ts:10-29` + `store-rows.ts:7-16` + `store-migrate.ts:10-23` + `store-open-markers.ts:8-19` —— 四个文件头各写一段「拆分波 3 / 缝 A/B/C / 侦察口径收窄为 98 行」的重构流水账；更严重的是 `store.ts:13-16` 明说**被测试文件按源文本正则钉死**，即注释在为「测试反噬实现」背书。
3. `log/index.ts:236-254` —— 同一段修复说明出现两次，且第二段从「注释却宣称」处断句后接 `（c ）：…`，留下**不可解析的残缺文本**（两次注释改写的坏合并）。
4. `stores/prefs.ts:256-264` —— 与评审意见的辩论记录（「评审曾建议移到 PUT 落定后置位，二阶分析后维持先行…」），其中还有已损坏的交叉引用标记。
5. 批次/域编号密文：`（2-：）`、`（E 域）`、`清偿批`、`（⑤④产品巨件拆分波4）`、`hh §八-18`、`nano-7`、`IR-10`、`R26-20` —— 仓库内无字典可查，新维护者读到的是一串不存在的密文。
6. 自指型元注释：「注释如实化：旧注释『同步实现』是异步化之前的过时口径」「原『内部可变生效值 + 测试注入钩子』形态随精简批退役」「零语义变更/行为逐位不变/逐键行为等价是红线」——这类自我断言在下次改动后即成谎言，且无法被测试保护。
7. `state/health.ts:586` 注释写「回收站清单读失败」对的是 manifest 分支（复制粘贴串味）；`diagnostics/index.ts:117-118` 称 apiKey「一概不读入内存」而 `:133` 正在读——**注释宣称比代码做的强**。

**判据建议**：留下「为什么必须如此」，删掉「以前不是如此」；一条注释成立的检验 = 后人能否把它当约束使用。

### 3.3 复杂度热点与可拆性

| 热点 | 现状 | 可拆性判定 |
|---|---|---|
| `studio/server/api/stream.ts:237`（517）/`providers.ts:58`（448）/`analysis.ts:345`（382）/`createStudioServer`（383） | 扁平且顺序清晰，单函数承载 10+ 路由 | **可拆（中收益）**：按「路由声明 / 校验 / 执行」三段，每段 ≤120 行 |
| `document/service.ts:228 executeSave`（372） | 自带步骤编号 2/4/4.5/5…/10 | **可拆**：`verifyGuards` / `persistAtomically` / `settle`；必须共享同一次 `diskBytes` 单读，拆错会退化成二次读盘 |
| `document/service.ts:777 doTrash`（250） | 三层 try，内层 160 行 | **可拆**：「登记+落位」与「删源+回滚+清单 RMW」两段 |
| `format/yaml-spec.ts`（869） | 550 行为声明式数据表 | **不该拆**：机械判据在此误导，拆表即拆散「三面单源」核心价值 |
| `composables/useRelationGraph.ts:136`（584） | 拖拽/平移/缩放 130 行纯指针交互无业务耦合 | **最值得拆**：抽 `useGraphViewport`，主体降 ~450 行，并对 `onNodeMove` 做 rAF 合并（对齐 `useShelf.ts:123-148` 既有手法） |
| `components/panels/chat/ChatMessages.vue`（735） | 消息行 / 工具卡（~150 行独立语义）/ 提示区 | **应拆 3 件**；`variantGroups` 预处理可迁 `shared/` 并单测 |
| `editor/CmHost.vue`（695） | CM6 生命周期约束构成 | **不建议拆**：拆开会把跨模块不变量变成跨文件隐式约定 |
| `events/store.ts migrateBookSession`（218）/`state/health.ts healthCheck`（~210） | 已自带 ①②③④⑤⑥ 分区 | **可拆，零语义风险**（注意 ③ 与 ①②④ 的顺序不变量） |

### 3.4 测试与工程门的简繁

- **量**：1.71× 行 / 2.35× 文件，均 6.5 用例/档——**超配**。分档有技术理由（模块级 `vi.mock` 与进程级单例逼出分档，`log-backpressure.test.ts:10-12` 自述），但夹具重声明与参数化缺失（0.4%）是纯浪费。
- **质**：真验证为主，装饰性为零。锚错两类（源码文本 19 档、日志文案耦合）是主要瑕疵。
- **门**：17 个 CI 门里约 5 个（counts 数字对账、docs、comments、suppression-prune、pack）用于防守文档/注释/清单而非产品缺陷；其中 `check:counts` 的数字对账与测试规模耦合，形成了**惩罚简化**的制度性摩擦。
- **反噬评估**：`check:docs` 机械上**不会**逼出注水（只做上限），但 6000 字节的 CLAUDE.md 上限使规则增长必须压缩或外移；`check:comments` 只拦 src，导致修复史迁入 test 头注释（10,302 处批号标签）——**纪律不对称**。
- **win 重跑**：作用域宽于诊断因（首跑任何非零都重跑），但有台账 + release 全绿门制衡，列 P2。

---

## 四、优化建议（按收益 ÷ 成本分层）

### A. 可立即做（低风险，建议下一批集中处理）

| # | 问题 | 做法 | 收益 | 风险 |
|---|---|---|---|---|
| A1 | 诊断包隐私（P1-1） | 二选一：① `collectLogEntries` 改白名单化输出（`{ts,level,tag,msg:截断 N 字}`，msg 过内容占位）；② 日志层对书库文本类 tag 限长/占位。同步把 `说明.txt` 的措辞改为事实陈述 | 隐私红线名副其实，诊断包可作为对外件发放 | 日志可读性下降；需回归 `test/diagnostics/bundle.test.ts` 并补一条「含书稿文本的日志不入包」正向断言 |
| A2 | 治理门 `.vue` 盲区（P1-2） | 三张门的 walker 扩 `.vue`（剥 SFC script 块后归一），把 web-next 纳入禁向集合；同时修 `ChatMessages.vue:32` 直引 | 架构约束恢复有效；113 SFC 进入射程 | 扩面后可能一次暴露多条既有违规（预算清理） |
| A3 | 覆盖率池化（P1-3） | 对「小文件（≤80 可执行行）+ `*-worker.ts`/`main.ts` 入口」加 `perFile` 或单列窄桶，阈值按 CI 全量实测 −2pp | 3 个 worker 入口 + ~10 档从不可见变可见 | 窄桶定高会在小改上红；须先以全量 coverage 定基线 |
| A4 | 日志 JSON 形态密钥掩码（P2-1） | 键值分隔符扩 `["']?\s*[:=]\s*`，或在**序列化前**对对象值掩码；加一条「序列化对象形态」回归用例（`mask-redact-reconciliation` 可直接扩展） | 封掉已实测的绕过 | 良性文本（`{"key":"value"}` 文档摘录）多掩，方向安全 |
| A5 | win 重跑判据（P2） | composite action 加判据：首跑日志含 `FAIL ` 行（真用例失败）→ 立即 exit 1 不重跑；仅无 FAIL 行（teardown 竞态形态）才重跑。再加重跑计数器写 step summary | 真失败首报；保留对已知竞态的兜底 | 若竞态伴随 FAIL 行输出会把竞态变红，需一轮观察 |
| A6 | 回收站孤儿（P2-17） | 失败早退前 best-effort `removeTrashEntryAsync` 撤销本次登记；或 `TrashEntry` 增 `landed` 位，读侧把未落位条目视为「未在回收站」 | 消除「条目在、文件在原位」的长期不一致；去掉 `structure-merge.ts:326` 判据的隐藏前提 | 低（同 id 至多一条，移除按 id 精确） |
| A7 | 可访问性三处（P2-11/12） | 关系图节点补 `tabindex`+roving+Enter 选中（或加可聚焦「角色列表」平行入口）、图例改 `<button>`；`ContextMenu` 的 Tab 路径补还焦 | Beta 面 a11y 与全库基线对齐 | 极低 |
| A8 | 注释治理（分批） | 按关键词（批号/专项/「收编·清偿·nano」/「此前…原…」）筛出**不能被当约束使用**的整段删除；保留不变量/根因/代价/方向/红线锚五类；头注压到 ≤6 行 | 可读性收益最大的一刀（估计可减 1.5–3k 注释行） | 低，但须逐条核对（有些沿革段落里藏着唯一根因解释）；先确认没有测试按注释文本断言 |

### B. 需拍板（产品 / 口径决策）

| # | 事项 | 待决内容 |
|---|---|---|
| B1 | 更新链边界 | 补齐下载/哈希校验/安装（含 UI），还是把文案固定为「前往下载」型提示 |
| B2 | 事件库保留策略 | 是否对 `llm/call`/`tool/call` 加时间/条数上限的滚动归档——直接触「模型可见 ⟺ 已记录」契约，须走登记与迁移 |
| B3 | 三审进度 SSE | 做，还是从 `stores/review.ts:17` 的「无排期」状态改为明确不做 |
| B4 | `host` 契约（P2/架构） | 接到 driver 选择，或 API 层拒绝非 `cc` 值给人话 |
| B5 | vault v1 出路 | 无 OS 凭据通道环境（CLI-only）的迁移路径，或把「本机等价明文」写进用户可见文案 |
| B6 | 短篇字数口径（P2-17 相关） | 先只读标定：取 20 篇真实短篇同时算 `countWords` 与「汉字+数字」，据偏差分布决定「调区间」还是「`piece-word-*` 专用汉字口径」（后者需曲线迁移）。**禁止直接改 `countWords`** |

### C. 架构级欠账（需设计决策）

1. **跨包契约无单一事实源**（D1）：前端手抄 99 个 interface + SSE 事件名 + 跨包常量（`MAX_TEXT_OUT` ↔ `SSE_BACKPRESSURE_LIMIT` 等）全靠人抄，且无门。方向：把 HTTP 请求/响应与 SSE 事件抽成第三产物（扩 `src/shared/contract` 或引入类型生成），web-next 只许 import 该产物；加「web-next 不得 import 契约包以外后端源码」门。量级中、风险低（类型面为主），但门一加上会立刻暴露 A2 的现存违规。
2. **跨窗一致性无通道**（D3）：定一条跨窗失效通道（BroadcastChannel 或服务端事件回流），至少覆盖 prefs / 书库列表 / 树红点；并把「整份 PUT + 客户端 merge」改成「按字段 PATCH 或服务端 merge」，让原子性回到已有服务端跨进程锁内。
3. **缓存注册表**（D4）：书键缓存创建即登记，生命周期事件一次广播；TTL 降为兜底。替代 22 条手工 forget。
4. **存储层契约**（D6）：引入 `user_version` 迁移阶梯（现有探列式迁移作为 v1 兼容臂）；事件库加保留/归档（与 B2 合流）。
5. **并发互斥三套机制并存**（D5）：busyReason 矩阵 + 内存闸 + 74 处跨进程锁文件表达同一概念「这本书上正在发生什么」。统一为活动信号注册表——**量级大、风险高，建议只在新意图加入时渐进收口，不做大重构**。
6. **治理门第二类守护缺失**（H2）：路由 ↔ 前端调用、SSE 事件名、手抄 interface 三处跨包契约都无机器门。与 C1 合流后补一条对账门。
7. **`ai-studio-direction` 的形状锁是目录全豁免**（H3）：`COMB_ROOT_PREFIXES = ['src/studio/server/api/']` 前缀白名单使任何新 api 文件直连 ai 自动放行，与「例外须逐文件登记」的文案不一致。

### D. 局部重构（分域可做）

- `document/service.ts` 拆 `executeSave`/`doTrash`；`withSaveLocks` 失败三件套 + 清单路径字面量（域内 12 处）走单源；`splitFrontMatter` 返回值改 `Readonly<>`（把 grep 约定升级为编译期约束）。
- `stores/prefs.ts` 统一边界数字来源（apply 守卫与 setter 从同一 range 描述派生），删 `as Record<…>` + `value as never`——逐键对拍。
- `useChapterTreeActions.ts` 抽 `mutateAndReload(book, fn)` 骨架：一次收掉 6 处重复 + 3 处 `entry.path` 直写（绕过 store 出口声明）+ 嵌套三元。
- CheckPanel/ReviewPanel 抽 `<IssueGroup>`（-120 行）；CSS 三族收敛（`.btn` 全套、`.close-btn`、`.sec/.sec-title`）。
- 测试侧：`makeBook`/`LIVE_FOREIGN_PID`/`tmpRoot` 等 5 个重复最多的夹具上提 `test/helpers/`；同族分档保留（vi.mock 隔离是硬约束），夹具单源；把 `tree-issues-*`/`store-*`/`chat*` 的参数化补成 `it.each`。
- `openai-adapter.ts` 拆 `toParams` 与流消费两段，`max-depth` 从 15 降到 ≤6。
- 事件库 `try{db.exec('ROLLBACK')}catch{}` 样板出现 6 次 → `rollbackQuietly(db)` 单点。

---

## 五、方法与证据

### 5.1 评审域划分与预算

| 域 | 覆盖 | 读透量 |
|---|---|---|
| 写作核心 | document / format / check | 27 文件（executeSave、structure-merge/split、yaml-spec、run-single-doc、run-tree-issues 等） |
| 桌面运行时 | desktop / studio-server+api / fs / install / driver / update / git | 55 文件（server-manager、lifecycle、ipc、survey of api/） |
| AI 链路 | ai / rag / process / knowledge / learn / review | 51 文件（runner、calls、三适配器、self-heal、turns-phases、rag/build） |
| 前端状态 | web-next stores/composables/api/views/pages | 48 文件（prefs、doc、workspace、useSse、chat-dispatch） |
| 前端组件 | web-next components/editor/shared | 46 文件完整 + 30 文件节读 |
| 支撑域 | events / state / metrics / cache / export / log / diagnostics / shared | 38/38 文件全文 |
| 测试工程门 | test / scripts / 配置 / CI | 31 测试档 + 全部门脚本 + 配置全文 + 覆盖率数据重算 |
| 架构横切 | 入口链 / 契约 / 治理门 / E2E 双链 | 装配与契约层，2 条主链逐跳对账 |
| 红队核验 | 7 条 P1 逐条证伪 | 仅读断言面 |

### 5.2 门脚本实测（本机）

`check:counts` 通过（1304 测试文件 / 8486 单测 / 34 e2e spec / 56 用例 / Archive 4 篇）；五个 check 全过（0.11–3.88s）。测试域实测分域墙钟合计 ~153s（4 worker），与自述 ~310s 的差异推断来自 CI 覆盖率腿 2-worker 钳制。内存实测：dom 域峰值 607MB、rag/scale 单档 305MB、check/scale 156MB——与配置注释的「各自 GB 级 / 19GB」相差 3–6×，该钳制的依据不可复现（建议带 coverage 形态重测后再定）。

### 5.3 未覆盖面与不确定项（诚实声明）

- `studio/server/api/` 58 文件中约 43 个仅做「文件名 + grep 级」检查（路由表全量装配、无空壳命名、域内无 TODO 为支持证据）——其「完成」判定属**部分推断**。
- `ai/tools/*`、`ai/rules/*` 未逐读；`install/migrate-*` 与 `fs/` 工具族为消费点 grep 级。
- 前端组件域对 `pages/views` 只做 grep 定位；DOM 交互未在浏览器实测（a11y 结论基于代码，未经读屏验证）。
- `coverage/` 数值为分桶局部跑产物，需 CI 全量复核。
- P1-1 的隐私影响面评估基于「作者会把包发给开发者/贴 issue」这一产品提示；实际分发行为未验证。
- 覆盖率 28 桶的「阈值 = 实测 −2pp」规则不可机检（配置注释与数值已脱钩），其长期不腐性无守护。

### 5.4 红队修正记录（本报告已采纳）

| 分域原报 | 修正 |
|---|---|
| 409 恢复链静默吞写（P1） | 证伪：`expectedRevision` 闸挡住，失败会 409 + toast；残留更窄缺陷（GET 期间新编辑被回退 + 迁移 PUT 无 revision） |
| 自动保存静默失效（P1） | 证伪：`EmptyState` 截断 + 编辑器卸载；残留 404 判定前键入内容随清理丢弃（零提示） |
| 短篇字数假红阻断定稿（P1） | 收窄：口径偏高与升红成立（实测 +34%/+55%），「阻断定稿」证伪（真实拦截面 = AI 自愈循环） |
| win 重跑洗白（P1） | 降级 P2：有台账纪律 + release 全绿门制衡；遗留无计数器与成因注记过期 |
| 诊断包隐私（P1） | 强化：成立且实漏面大于原报（另发现 5 处切片日志） |
| 预算闸开口（P1） | 确认：成立，两处开口均代码内登记、有上界 |
| 覆盖率池化（P1） | 确认：成立（10 个 0% 文件含 3 worker 入口） |

---

## 六、待决项（供作者拍板，本报告不预设结论）

1. §四 A 组 8 项是否成批开工（建议 A1/A2/A3 优先）。
2. §四 B 组 6 项的产品口径。
3. §四 C 组 7 项架构欠账的取舍顺序（建议 C1/C2 先做，C5 只做渐进收口）。
4. 本报告 P1×4 的收口判据建议：修复 + 回归通过（A1/A2/A3 各带一条新断言：含书稿文本的日志不入包；`.vue` 违规必红；worker 入口 0% 必红）。

---

## 七、收口实录（修复实施与验收）

> 作者口令「全部修复，开始吧」→ 报告 §四 A/B/D 全量 + §四 C 除 C5 外全部实施（C5 按报告自身建议不做大重构），B 组按「口径 → 维持现状 + 登记」处置。以下为逐组实录与全门验收；改动明细见代码本身，此处只记处置与证据。

### 7.1 逐组处置

**A 组（可立即做，8/8 办结）**

| # | 处置 | 回归锚 |
|---|---|---|
| A1 | 诊断包日志段加**内容门**：承载书库文本的来源（履历/账本/book.yaml/front matter/技法指令/判态重建）只留事件标签与长度，正文片段与 err 载荷一律不入包；不可解析半行只留长度占位符；`说明.txt` 与头注改事实陈述（apiKey 含密文与 baseUrl 概不读入，原「一概不读入内存」的失实说法同步订正） | `test/diagnostics/bundle.test.ts` 新增「内容门」「半行只留长度标记」两例；另加**分类完备性门**：扫描 src 内全部「日志实参带 `slice(` 载荷」调用点，tag 未列内容门即红（防新来源静默入包），含空转地板 |
| A2 | 治理门扫面扩 `.vue`（SFC 取 `<script>` 块）+ web-next 纳入跨包禁向集合；`ChatMessages.vue` 直引 ai 收编 | `test/governance/dependency-direction.test.ts`（`.vue` 在射程、web-next 跨包只许 `src/shared/**`）全绿 |
| A3 | 覆盖率新增 3 个**窄桶**：`src/**/*-worker.ts`（含 3 个 worker 入口）、`relations/*.vue`、`useLibraryIpc.ts`——原池化下 0% 不可见变可见 | `vitest.config.ts` 桶阈值 = 全量实测 −2pp；门面全绿 |
| A4 | 日志密钥掩码补 **JSON 形态**（`"api_key":"…"`，含 emit 后序列化行的 `\"` 转义形）：两词表（maskKeys 形貌保留 + redactSecret 全掩）同批补，键名尾词断言排除 `monkey` 类普通词 | `test/log/mask-keys.test.ts`（+4 例）、`mask-redact-reconciliation.test.ts`（+JSON 样本 + 结构不破断言） |
| A5 | win 重跑判据：首跑非零退出**先判形态**——含 `FAIL … .test.ts` 行 = 真失败首报 exit 1 **不重跑**；零 FAIL 行（收尾竞态形态）才重跑一次，重跑计数器写 step summary | `.github/actions/win-vitest-retry/action.yml` 重写；win 台账 §二 同步改写（去掉 tinypool 归因） |
| A6 | 回收站孤儿条目：`doTrash` 三处「未落位即中止」出口（重试落名越界/重试登记失败/落位重试耗尽）统一 `dropTrashEntryOnAbort` 撤销登记（按 id 精确移除；回滚自身失败只 warn） | `test/document/trash-registry-fail.test.ts` 新增落位耗尽用例（占满全部落位链目标名 → 断言回收站清单零残留 + 源文件与主清单原地未动） |
| A7 | 可访问性：关系图节点改 roving tabindex + `role="group"`（原 `role="img"` 把交互树声明为图片）；`ContextMenu` 的 Tab 关闭路径补还焦 | `test/studio/webnext/dom/**` 相关档全绿 |
| A8 | 注释治理**第一批**：筛除流程史/自证/元评论/重复四类噪声，保留不变量/根因/代价/红线/单源指针五类；共 175 档、注释净 −703 行（头注净 −357 行） | `npm run check:comments` 通过；改动文件全部「只注释行变化」自检（非注释行变化 0） |

**B 组（需拍板，6/6 处置：5 维持 + 1 收紧）**

| # | 裁定 |
|---|---|
| B1 更新链边界 | **维持**「只检查 + 文案指向下载」（补下载/校验/安装需另立产品面） |
| B2 事件库保留策略 | **维持**（现口径 = 全量保留 + 用户显式清空；滚动归档触「模型可见 ⟺ 已记录」契约，须走登记与迁移） |
| B3 三审进度 SSE | **维持**（自陈未排期；状态标注不改） |
| B4 `host` 契约 | **收紧**：`POST /api/books` 非 `cc` 值 fail-loud 400 + 人话（原静默归一成 cc 是把未落地值谎报成已接受）；driver 接线未做（登记） |
| B5 vault v1 出路 | **维持**（「仅混淆级」已在文案披露） |
| B6 短篇字数口径 | **只做注释如实化**（`countWords` 口径备案改写为「有意选择 + 偏差随标点密度浮动 + 待标定」；计数语义与阈值不动，标定需真实短篇语料） |

**C 组（架构级，7 项：5 办结 / 1 窄面办结 / 1 维持）**

| # | 处置 |
|---|---|
| C1 跨包契约无单一事实源 | **窄面办结**：`src/shared/contract/studio.ts` 单源（背压上限/文本上限别名/码点上限/dev 端口/SSE 事件名清单）+ `studio.conformance.ts` 编译期钉子（`DriverEvent` 联合 ↔ 事件名清单双向 `Exhaustive`）；两端改 import 单源，零第二处字面量。**99 个手抄 interface 未动**（需构建期产物设计，登记） |
| C2 跨窗一致性无通道 | **办结**：`shared/cross-window.ts` + `useCrossWindowInvalidation`——BroadcastChannel 失效通知（**信号非数据**），覆盖 prefs / 书架 / 树红点三条线；来源标记防回环、同 tick 合并、特性探测 no-op 降级；prefs 线只对非脏键推进基线（防跨窗反向覆盖），本窗脏键永不被静默覆盖 |
| C3 缓存注册表 | **办结**：`src/studio/server/cache-registry.ts` 登记表 + 22 条手工 forget 改模块顶层自登记（ai 侧两条因方向锁由聚合入口代登记）；**登记完整性机器门**：src 全部 `forget*` 导出与登记表双向对账 + 逐项豁免（7 项含理由）+ 僵尸检查 |
| C4 存储层契约 | **办结**：`src/shared/sqlite-migrate.ts` 版本化阶梯（events/rag/cache 三库 target=v1，v1 步 = 原探列迁移逐位搬入；空库直达目标版本；版本超前拒绝打开；步失败不推进版本可重试；阶梯缺号配置即抛） |
| C5 并发互斥三套机制并存 | **维持**（报告自身建议：量级大、风险高，只在新意图加入时渐进收口） |
| C6 治理门第二类守护缺失 | **办结**：新增三条对账门——**路由 ↔ 前端调用**（116 路由 × 119 调用点，前端请求不存在路由即红；服务端未被消费项逐条白名单 + 僵尸校验）、**SSE 事件名**（正本读单源清单；前端多即红 / 服务端多须登记）、**跨包常量**（单源正本 + 别名必须引用正本名 + 消费端不得再有字面量副本） |
| C7 形状锁目录全豁免 | **办结**：`COMB_ROOT_PREFIXES` 目录前缀豁免撤除，改 `API_LAYER_REGISTERED` **逐文件登记**（22 条含理由）+ 双向自校验（僵尸项/错位项即红）；对旧豁免覆盖面机器核对**漏放 0 / 多登 0** |

**D 组（局部重构，全量办结）**

- `document/service.ts`：`executeSave` 372→69 行（拆锁外守卫/锁内复核/基线与覆写闸/锁内落盘/编排）、`doTrash` 250→26 行（拆 5 段）；锁进出边界、锁序、错误码与文案逐字不变。
- `withSaveLocks` 失败回调收敛为 `saveLockFailures(intent)` 工厂（6 个调用面，18 处文案静态抽取比对无丢失）；清单路径单源 `manifestPathOf(bookRoot)`（document 域 12 处）+ `TRASH_DIR_REL`；`splitFrontMatter` 返回 `Readonly<>`（memo 返回同一对象，改写会污染缓存——grep 约定升编译期约束）。
- `stores/prefs.ts`：边界数字单源（守卫窗与夹取窗各自如实登记，不拉平行为）+ 类型逃逸 14→3 处（保留处就地注明不可消除理由）；409 恢复链 GET 在途窗新编辑不再被回退、基线不再记回退态；迁移 PUT 带 `expectedRevision`。`stores/provider.ts`：两域共用 revision 改「只前进 + 409 权威重读」（先核服务端事实：两族共用一个计数）。`stores/doc.ts`：外部删除判定前键入内容丢弃补提示（failed 语义不变）。
- `useChapterTreeActions.ts`：抽 `mutateAndReload(book, run, hooks)` 收 6 处重复；3 处 `entry.path` 直写改经 doc store 出口 `adoptRenamed`；嵌套三元展开。
- `CheckPanel`/`ReviewPanel` 抽 `<IssueGroup>`（两面板 −157 行；抽件前后 8 状态 DOM 逐字节对账零差异）；CSS 三族收敛**部分完成**（`.btn.primary` 的 color/border 上收单源；`.btn` 基体/`:disabled`/`:hover`/`.close-btn`/`.sec` 等簇按**特异性等价性**论证保留原状——上收会引入顺序依赖或放宽作用域，逐簇理由在代码注释内）。
- `openai-adapter.ts` 拆分 + 压制清零（20 条 eslint 压制 → 0，`max-depth` 15→0、`complexity` 2→0）；`rollbackQuietly(db)` 单点（6 处 `try{ROLLBACK}catch{}` 样板收编）。
- 测试侧：5 个高重复夹具上提 `test/helpers/`（约 100 档收敛）+ `it.each` 参数化 3 族（输入集合与断言强度零减损）；同名异体（77 处 `makeBook` 的 76 组差异）按「非复制」如实保留。
- 另办结报告未列但同源的项：onboard 覆盖留底失败 **fail-open → fail-closed**（对齐 `files.ts` PUT /file 裁定，「无需留底」两态不设闸）、`structure-merge` merge 流载荷裸断言改逐字段校验（脏载荷不用作 undo 定位、不抛穿、必留痕）、chat 消息体积上限 + `chat/sanitize` 记录通道（载荷不含正文）、`.删书墓地` 启动侧兜底清扫（不阻塞启动、幂等）、`lifecycle.ts` 退出编排五旗改显式状态机（相位 × 停机面，转移表即契约）、`fs/atomic.ts` 同步退避**评估后维持**（同步性是既有契约：多处同步 RMW 临界区读→写间不得 await；最坏 350ms 量化入注释）。

### 7.2 全门实录（mac 本机，收口终态）

```
npm run typecheck（tsc --noEmit）                     exit 0
npm run typecheck:web-next（vue-tsc --noEmit）         exit 0
npm run lint（eslint . --max-warnings 0）             exit 0（抑制表已 prune：12 行失效条目删除）
npx vitest run                                        1304 文件全绿 / 9090 通过 + 8 跳过（9098），144.1s，exit 0
npm run check:counts                                  exit 0（1304 文件 / 8618 单测；34 spec / 56 用例；Archive 4 篇）
check:docs / check:comments / check:packaging / check:knowledge    exit 0
npx prettier --check .                                exit 0
```

计数同步：README 三处 8486 → **8618**（`check:counts` 实测对账）；档数 1304 未变（本批未新增测试档，新门并入既有多档）。

### 7.3 效力边界（如实声明）

- **未跑**：Playwright e2e（需 `build:web` + 起服务/浏览器）、覆盖率 28 桶全量、packaging/asar 冒烟、soak、win 腿 CI（本机无 win 环境）。对应单测面全绿，但打包态与三 OS 矩阵需 CI 复核。
- **跨窗通道**：单测用注入假通道（含降级路径），**真机多窗实际投递未验**——需人工开两窗比对 prefs/书架/红点即时性。
- **树红点跨窗**：服务端 `/tree-issues` 有 5s TTL 结果缓存，他窗机检后本窗重取可能读到 ≤5s 陈旧聚合（修法需服务端写侧 forget，已登记）。
- **注释治理为第一批**：175 档、净 −703 行；仍有多数头注 >7 行（超出行全部是红线/不变量，按「不许为行数删约束」保留）；长尾（web-next 组件/页面、部分 api 行内注）未清。

### 7.4 登记未修项（逐条 + 理由）

1. **C5 并发互斥统一**：报告自身建议不做大重构（量级大、风险高）——维持，只在新意图加入时渐进收口。
2. **C1 主体的 99 个手抄 interface**：需构建期类型产物（扩展 `src/shared/contract` 或引入生成），属设计决策——本轮只办结常量与 SSE 事件名窄面；`documents.conformance.ts` 的 `SameShape` 钉子继续兜已镜像的文档面。
3. **存储层「改名/改型/回滚」路径**：`user_version` 阶梯已就位（3 库 v1），真需要改名/改型的迁移步等真实需求出现时按步新增（现在加空步是负债）。
4. **测试锚错 19 档源码文本断言**：与治理门「形状锁」同族、属刻意形态（按源码文本钉单一来源/签名）——未改，判为可接受成本。
5. **测试量超配 1.7×**：本轮做夹具单源 + 3 族参数化；`store-*`/`tree-issues-*`/`chat*` 的进一步合并会造「伪表驱动」（每例变更步骤互不相同）——按报告口径只并在同断言体处，不做大删。
6. **用例名批号（28.6%）**：`check:comments` 只扫 src 面；test/ 面批号标签清理量大且零功能影响——登记，未做。
7. **check:counts 反向激励（P2-22）与散文门性价比（P2-23）**：属工程门再设计——登记，未做。
8. **P3 残留**：`mkdtempSync` 无清理档、`test/studio/webnext/node_modules/.vite` 缓存落测试树、两个 perf 界值门放水 48×、`check-packaging.mjs:379` env 可跳过 darwin dist 门——未做（低风险/需成本核算）。
9. **`host` 接 driver 选择**：B4 只做 API 层拒绝；运行期第二驱动接线未做。
10. **e2e/打包/soak/win 腿**：见 7.3 效力边界。

### 7.5 索引与台账同步

- `Dev/Docs/README.md`：本报告状态 〔未收口〕→〔已收口〕。
- `Dev/Docs/00-总览与实施路线`：§1.3 指针状态同步（本批修复已入库）。
- `README.md`：单测数 8486 → 8618（徽章/技术栈/合入门槛三处）。
- `Dev/Docs/03-设计/win腿间歇红台账`：§二 吸收机制改写为「首跑 FAIL 行判真失败不重跑 / 零 FAIL 行才重跑」，并去掉 tinypool 归因（依赖树已不装该包）。
- `CLAUDE.md`：全量 1304 档未变，无需改动。
