# Openwrite —— 可借鉴机制与本仓对照（外部调研）

- 定位：外部写作类 AI 产品 `dsh-Openwrite`（`https://github.com/LiPu-jpg/Openwrite`，本地副本 `Dev/参考项目/Openwrite`，HEAD `c662440` / 2026-10-19 / v0.2.23）的机制盘点与对本仓的可行性判断。调研范围 = 顶层文档全量 + 五个模块的定向源码阅读（bridge 工具面与契约层、托管运行时与评审交付、工作台前端状态、预设与技能体系）；**未运行该项目、未安装依赖、未调用模型**。不属于本档：任何实施决策与批次排期（建议见 §五，均未排期）；本仓现有机制的认定以仓库实文为准。
- 阅读边界声明：本报告是机制层对照，不是逐行代码审计；对方自述的测试数字与性能数字只作其文档记录转述，不作本仓基线。

## 一、它是什么，以及为什么值得看

`dsh-Openwrite` 是 DeepSeek Harness（dsh）的第三方插件，把长篇小说创作拆成四个可独立演进的层：

| 层 | 形态 | 职责 |
|---|---|---|
| 领域后端 | Python `OpenWrite Studio`，本地 HTTP 动作面（`:4567`） | 大纲、正文、资产、伏笔、场景、评审、修订、导入导出；单一事实来源是磁盘上的 `data/novels/{id}/` |
| 桥接插件 | TS，`packages/openwrite-bridge`（约 7.2k 行） | 90 个 `novel_*` 工具 → `fetch` → 领域 HTTP 接口；含工具策略、契约校验、运行时托管 |
| 原生工作台 | TS/React，`packages/studio-panel`（约 6.7k 行，含 3.2k 行文案） | dsh web 内的创作/资料/任务三视图；不嵌 iframe，不使用对方 UI |
| Agent 预设 + 技能 | `presets/openwrite/`（`agent.cordis.yml` + 24 个 `SKILL.md`） | persona、工具面、技能目录；技能分入口/编排/方法/查询四层 |

它的三条设计原则值得先记住：**领域逻辑零搬迁**（桥接只跟 HTTP 契约，领域升级不牵动宿主）、**agent 唯一归属宿主**（不自建第二套 ReAct 循环）、**单一事实来源**（所有读写回到同一份正文，评审与修订只作用于同一份文件）。规模约 2.3 万行自研 TS + 103 个 Markdown；其 `GOAL.md` 记录的最近一次全量回归为 1224 passed / 31 skipped。

它与本仓**形态不同**：本仓是 Electron 单体（主进程 + 内嵌 Node server + Vue 3 前端 + 自带 agent 工具面），对方是"插件 + 外部 Python 后端 + React 工作台"。因此本报告只借**机制与判据**，不借其分层与运行时。

## 二、它正面解决的六类失效

把它所有机制按"防住什么失败"归并，只有六类。这也是判断某条机制是否值得迁移的唯一标准：

1. **AI 改稿覆盖作者新改动**——模型基于过期上下文写回，作者刚输入的内容被静默冲掉。
2. **评审结论过期或被误判通过**——改完稿仍拿旧评审宣称合格；缺证据被当成零缺陷。
3. **长生成被 HTTP 生命周期切断**——写一章数分钟，客户端超时即任务孤儿化，服务端仍占着写锁。
4. **后端进程孤儿、僵死、端口冲突**——自管子进程最常见的四种死法。
5. **多项目/多窗口状态串扰**——切项目后旧请求晚到，污染新项目视图。
6. **工具面膨胀后治理失控**——工具近百个时，只读/写入边界、确认、幂等、输出体积全部失守。

## 三、可借鉴机制清单

### A. 变更安全（对应失效 1）

**A1 修订门（CAS）是写操作的默认参数。** 每个写工具强制携带 `revision` / `expected_*_revision` / `version`，服务端比对后才落盘（`packages/openwrite-bridge/src/tools.ts:564-626`、`:862-884`）。这不是"可选乐观锁"，而是写入口的必填项；过期即失败，由调用方重新读取后再写。

**A2 `preview → apply/reject/retry/undo` 是不可变令牌的两阶段变更。** 预览返回 `preview_token` 与 before/after；令牌绑定源版本与预测结果，一次性消费；`undo` 用独立的结果绑定令牌（`tools.ts:886-957`，跨域计划见 `agent.cordis.yml:56-66`）。关键点是**令牌在服务端**，模型无法通过"重新生成"绕过门控。

**A3 破坏性操作的确认串与目标强绑定。** 删除项目要求 `confirm === true` 且能精确指认目标；批量删章要求字面量 `DELETE_AFTER:<keep_through>`（`tools.ts:1594-1660`）。泛化的 `true` 不足以表达"我知道自己在删哪一章"。

**A4 评审与正文的 stale 绑定。** 评审记录 `source_revision`（正文 SHA）；当前正文 SHA 不一致即 `stale=true`，并强制 `verdict=inconclusive`、`deliveryStatus='stale'`（`packages/openwrite-bridge/src/dog-review.ts:389-398`）。改稿后旧评审自动失效，不靠调用方自觉。

### B. 评审可信（对应失效 2）

**B1 加法评分，问题不扣分。** 质量分只累加"带可定位正文证据的 evaluated 准则"；`not_applicable` 移出分母，`inconclusive` 降低覆盖率但不变成零分（`GOAL.md:282-310`）。这避免了旧式"扁平扣分"把"没审到"和"写得差"混为一谈。

**B2 五个状态分离，禁止一个 `passed` 承载全部语义。** `execution_status`、`quality_score`、`coverage`、`gate_status`、`delivery_status` 各自独立；交付要求质量分、覆盖率、门禁、正文新鲜度**同时**满足（`GOAL.md:312-327`）。这是本报告认为最值得迁移的一条判据。

**B3 三值判定：pass / fail / inconclusive。** 所有阶段（评审、修订、交付）只有这三种；缺评审、缺证据、非当前版本一律 `inconclusive`（`dog-delivery.ts:236-241`、`:311-317`）。"缺证据"永远不等于"通过"。

**B4 评审物化为可验收文件 + 固定拓扑 DAG。** 一次评审写出 `review.json`、`gate.json`、`aggregate.json`、6 个域文件、37 个叶子文件与 `dog-graph.json`；蓝图带版本与 SHA-256 修订号，历史评审可追溯到当时的框架（`docs/REVIEW_DAG_FRAMEWORK.md`）。查询侧只读这些确定性产物，**不再调用模型**。

**B5 「提案已应用」≠「通过」。** 有 applied 修订但正文已变时，交付图记 `application=applied`、`rereview=required`、`closure=rereview_required`；只有复评通过才 `closure=closed`（`dog-delivery.ts:258-310`）。这堵住了"改完就宣布合格"的捷径。

### C. 任务与进程生命周期（对应失效 3、4）

**C1 长任务一律异步化。** 模型生成走 `POST /api/tasks` 立即返回 `task_id`，配 `tasks_list / task_get / task_cancel / task_retry / task_confirm`；同步端点只保留为诊断用途（`tools.ts:720-753`、`:1348-1503`）。理由在 `DESIGN.md:165-170`：同步端点把执行期耦合进 HTTP 请求生命周期，客户端超时即孤儿化任务并占住写锁。

**C2 握手式随机端口启动。** 父进程把 `{token, state_dir}` 写进子进程 stdin，子进程 `listen(0)` 后从 stdout 回一行 `{port}`；随后带 Bearer 拉 `/api/health`，比对 `core_version` / `contract_version` 才置 ready（`packages/openwrite-bridge/src/managed-runtime.ts:559-611`）。这同时解决了端口冲突、端口已开但服务未就绪、版本漂移三个问题。

**C3 单飞 + 代际守卫 + 主动探活 + 有限退避。** 并发 `ensure()` 共享同一个 pending promise；每次启动递增 `generation`，旧进程 exit 回调先比对代际/child 身份再动作；交出缓存连接前 1.5s 探活并检查 `exitCode`，失败即强杀重来；重启上限 5 次、退避 1/2/4/8/16s，超限置 error 要求手动重试（`managed-runtime.ts:195-253`、`:301-339`、`:620-624`）。"进程活着"与"连接可用"被明确解耦。

**C4 只杀自己的进程树 + 安装锁 + 内容寻址环境目录。** POSIX 用 `detached` + `process.kill(-pid)`，Windows 用 `taskkill /T /F`；跨进程安装锁用 `proper-lockfile`；环境目录名 = manifest 内容 SHA-256 前 24 位，`.complete` 标记 + 原子 rename 写 `active.json`（`managed-runtime.ts:148-165`、`:486-547`）。半装环境不会被复用。

### D. 契约与工具面（对应失效 6）

**D1 单一 JSON Schema 源 → 双语言生成。** `packages/openwrite-bridge/src/contracts-generated.ts:1-11` 文件头写明生成器、9 个上游 schema 的 `$id` 与内容 SHA-256，并标注 do not edit；生成物同时含 TS 接口、内嵌 schema 与校验器。手写类型与 schema 双轨漂移在这里被结构性消灭。

**D2 跨语言 parity oracle + 凭据字段硬禁。** `schema-lint.mjs` 镜像 Python 侧实现，对同一份坏数据给出相同判决；除标准关键字外增加非标 `disallowed`，专门禁止 `api_key` 类字段出现在契约里（`scripts/schema-lint.mjs:1-6`、`:51-53`）。凭据泄漏是硬规则，不是约定。

**D3 `tool-policy` 按效果三分，未知默认按 write。** `read` / `write` / `generate` 三个集合；未登记工具一律按 `write` 处理；无 agent 会话、plan mode、只读沙箱均拒绝（`tool-policy.ts:6-57`）。这是**fail-closed**：新工具忘记登记不会被放行，只会被拒。多动作工具按 `action` 动态判定（`readActions`）。

**D4 参数归一化先于校验。** 工具执行前先把 JSON 字符串形态的对象参数解析回对象，再跑 schema 校验（`tools.ts:80-103`、`:148`）。模型把对象序列化成字符串是高频行为，先归一化再校验能避免大量假失败。

**D5 错误结构化，让模型能自纠。** HTTP 失败统一成 `StudioError(status, code, details, requestId)`，工具层再把 `code / status / details / recovery` 写进 message（`packages/openwrite-bridge/src/client.ts:50-63`、`tools.ts:149-158`）。`NETWORK_ERROR` 的 recovery 明确要求"先查任务再重提"，不盲目重试（不自动重试是刻意设计，避免重复生成与重复扣费）。

**D6 输出体积在边界夹取，不做事后截断。** 统一 `JSON_OUTPUT_SCHEMA`；边界读取用 `before/after/limit` 并在客户端 clamp；长任务列表另有压缩 DTO（`tools.ts:38-46`、`:380-449`；`domain.ts:128`）。

### E. 前端一致性（对应失效 5）

**E1 上下文屏障 + 代际提交校验。** `setContext` 比对 `(workspaceId, root, sessionId)` 四元组，变化时 `generation += 1`、abort 在途请求、关 SSE/轮询、基线清零、同步 patch 回初始态，再用新上下文重启（`packages/studio-panel/src/client/WorkbenchStore.ts:231-256`）。**响应落地前二次比对 generation**——仅靠 `AbortController` 不能保证响应不落地。

**E2 资源 epoch 失效表（纯函数）。** 把"数据变了"降维成每个资源一个整数；`nextEpochs(resource, epochs)` 命中资源 +1，并让 `assets/manuscript/outline/workspace` 派生 bump `graph`；`triggersRefresh` 只对四类资源触发全量拉取（`workbench-epochs.ts:14-36`）。终态任务另按类型 bump 对应视图（`terminalTransitionResources`）。纯函数便于直测，派生关系集中一处不会漏刷新。

**E3 双层同步：轮询兜底 + SSE 加速。** 每 5s 拉 `invalidation.json`，每 4 次（约 20s）强制全量 `refresh()`；SSE 仅作加速层，两通道共用同一个 `consumeMutation`，构造上保证语义一致；revision 单调比较去重，首见只作基线（`WorkbenchStore.ts:295-398`）。**不把实时通道当唯一依赖**，断线也能自愈。

**E4 草稿带 `baseRevision` 与冲突态。** IndexedDB 键 = `[workspaceId, novelId, path]`，缺一不可；加载时对比服务端内容与草稿，不一致弹"恢复/丢弃"；恢复时 `baseRevision !== 当前 revision` 标 `conflict` 且不自动保存；`removeIfContent` 仅当存储内容仍等于预期值才删（`draft-store.ts:37-43`、`:154-166`）。最后一条专防"慢保存/卸载后的旧异步删除吃掉新草稿"。

**E5 编辑器无关的锚点三态。** 选区/标注/标记/提及全部是纯字符串偏移函数，不碰 DOM 或编辑器模型。引用锚三态：`attached`（hint 命中）→ `relocated`（全文唯一）→ `detached`（歧义或缺失）；**歧义时不猜**（`manuscript-selection.ts:78-118`）。重复文本必须给 `occurrence` 才绑定。这套东西可以原样移植到任何编辑器。

### F. 技能与治理

**F1 预设是声明式装配单。** `preset.yml` 只写名称/描述/排序；`agent.cordis.yml` 逐行声明插件与配置，persona、技能目录、压缩阈值全在一个可版本化文件里（`presets/openwrite/agent.cordis.yml:14-205`）。换 Agent 不改运行时代码。

**F2 技能分四层，作者入口白名单。** 24 个技能中只有 8 个（progress / write-next / review-chapter / revise-span / foreshadow / canon / learn / export-book）可被作者直接调用，其余显式 `user-invocable: false`（`presets/README.md:19-23`）。层为：入口薄壳 → 编排（novel-creator / workflow-manager）→ 方法（oh-story-*）→ 数据查询（dog-*-query，只读已物化结果）。入口只保留作者会说的动作词。

**F3 SKILL.md 的固定模板。** `description` 写"触发词 + 一句话职责"；正文四段：执行流程、工具表、错误处理、与其他技能；长方法下沉 `references/method.md`，并声明预算（指令字数/参考字数/工具调用次数，如 `oh-story-long-write/SKILL.md:6-16`）。错误处理表把失败路径也变成可执行规则。

**F4 persona 承载机器可读契约。** 系统提示里直接写死三种高频输出格式：四级大纲、内联批注 `//**人物[维]：旧 -> 新**`、角色卡 TOML front matter，并规定冲突优先级（正文事实 > 大纲计划）（`agent.cordis.yml:82-160`）。模型输出可直接喂解析器，不靠二次清洗。

**F5 `GOAL.md` 是目标账本，不是 README。** 状态表（done / partial / todo / external）+ 逐日验证日志（命令、计数、产物路径）+ 维护协议（每次运行先读、每完成一项立即更新、失败与残余风险同等记录、绝不把聚焦测试说成全量）（`GOAL.md:1-13`、`:153-181`）。末尾一句判据很硬：**"不得凭意图或文件存在勾选完成；每个勾必须对应验证日志里的当前证据。"**

**F6 自评用"优势矩阵 + 缺口清单 + 阶段验收"。** `docs/FRAMEWORK_ADVANTAGES.md` 用"问题 → 最强参考 → 优势来源 → 自身位置"对照，不给总分；`docs/IMPROVEMENT_PLAN.md` 明写自己的保存竞态、计量口径不一致、改稿后事实不联动（后在 S1–S6 修复）。承认缺口比罗列功能更能指导取舍。

## 四、与本仓对照

### 4.1 已具备，只需对齐口径（不建议重建）

| 能力 | 本仓现状 | 对方做法 | 结论 |
|---|---|---|---|
| 切书/切项目屏障 | `src/studio/web-next/src/composables/useBookSwitchGuard.ts`：路由提交前守卫 + 提交后 watch 兜底 + 书会话 abort；比对方 `setContext` 更细 | `WorkbenchStore.setContext` 四元组 + generation | **本仓更强**，不迁移；可借"响应落地前二次校验代次"这一条补强 |
| 跨窗失效 | `useCrossWindowInvalidation.ts` + `shared/cross-window.ts`：主题化广播、只走既有刷新链、广播不带值、降级 no-op | SSE + 轮询 + `consumeMutation` | 机制同源；若将来出现"局部刷新粒度不足"，可借 epoch 纯函数表 |
| 长任务并发闸 | `src/studio/server/api/task-gate.ts`：per book+action、BUSY_MATRIX 单源、跨进程 lockfile + stale 接管 | 异步任务记录 | **本仓并发控制更细**；缺的是"任务作为一等对象对外暴露"（见 4.2） |
| 保存队列 | `src/document/queue.ts` | 串行保存 + 请求快照 | 已具备 |
| 书级隔离 | `src/studio/server/book-context.ts`、`bookRoot` 统一 realpath 别名族 | Workspace root 唯一身份 | 已具备 |
| 草稿恢复 | `src/document/draft-path.ts` 等 | IndexedDB + baseRevision + conflict | 视现实现补 `baseRevision` 冲突态与条件删除 |
| 契约一致性 | `src/shared/contract/*.conformance.ts` | 单一 Schema + codegen + parity 测试 | 本仓是手写契约 + 一致性测试；是否升级属取舍（见 §五 批 3 可选） |
| 文档治理 | 活账 + 文档操作链 + 门禁 | `GOAL.md` 状态表 + 验证日志 | 本仓治理更完整；可借"每个勾必须对应当前证据"作为评审话术 |

### 4.2 真实缺口，建议逐批补

| # | 缺口 | 对方的现成判据 | 为什么值得补 |
|---|---|---|---|
| 1 | **工具面无效果分级**：`src/ai/tools/index.ts` 只按名分派，没有 read/write/generate 分类，也没有"未登记默认拒绝" | `tool-policy.ts:6-57` | 新增工具不会被自动纳入只读保护；plan/只读语义无处落地 |
| 2 | **评审缺"质量分/覆盖率/门禁/交付"分层**：`src/review/contract.ts` 有 lens、severity、category，但没有 additive score 与 coverage 分离 | `GOAL.md:282-327` | 当前无法区分"没审到"与"写得差"；无法表达"证据缺失" |
| 3 | **评审与正文版本未硬绑定**（未见 source_revision / stale 强制 inconclusive 的等价物） | `dog-review.ts:389-398` | 改稿后旧评审仍可能被当作有效结论 |
| 4 | **结构化变更缺不可变 preview token + undo**：`src/ai/tools/rewrite.ts` 有 preview，但未见服务端一次性令牌与结果绑定撤销 | `tools.ts:886-957` | 模型可通过重新生成绕过"先看后写"；无法审计与回滚 |
| 5 | **破坏性操作缺目标绑定确认串** | `tools.ts:1594-1660` | 误删一章/一批章的成本极高，且难以恢复 |
| 6 | **长任务未作为一等对象暴露给模型**：有 `background.ts` 与 `task-gate`，但工具面不返回 `task_id` | `tools.ts:720-753` | 模型只能同步等待或收到 409，无法"提交—查询—取消—重试" |
| 7 | **工具参数未做"先归一化后校验"** | `tools.ts:80-103` | 模型把对象序列化成字符串时会产生假失败 |
| 8 | **错误未见面向模型的 code/recovery 契约** | `client.ts:50-63`、`tools.ts:149-158` | 模型无法据错误码自纠，只能重试同一动作 |

### 4.3 不建议照搬

- **Python 领域后端 + 90 个工具面**：本仓是单体，拆出第二个后端会引入跨进程契约与部署成本，收益不成立。
- **dsh 插件/预设/React/Zustand 形态**：与本仓 Vue 3 + Pinia 不是同一运行时；只借技能分层与 persona 契约的**思路**。
- **47 节点评审 DAG 的具体拓扑**：拓扑服务于它的 37 项历史检查编号；本仓没有这套遗产，直接复制会制造无意义复杂度。可借的是"固定拓扑 + 版本指纹 + 只读物化产物"三件事。
- **conductor 无人值守流水线、模型横评沙箱**：属于产品扩展能力，不是当前质量瓶颈。
- **它的阈值（70 分 / 80% 覆盖率）**：对方自己标注 `uncalibrated` 且生产门禁 `disabled`，阈值不可作为基准。

## 五、建议的落地批次（均未排期）

按"防毁稿 > 防误判 > 工程化"排序；每批给出可判红的验收判据，符合本仓"一条改动 = 一条回退即变红的用例"纪律。

### 批 1：变更安全（最高优先）

- 破坏性操作确认串与目标强绑定（缺口 5）。
- 结构化变更的 preview token 不可变、一次性、可撤销（缺口 4）。
- 评审记录 `source_revision`，正文 SHA 不一致即 stale（缺口 3）。
- **验收判据**：回退任一实现，必须有一条用例变红——删除未带目标确认串必须 409；同一 preview token 二次 apply 必须失败；改稿后旧评审的交付判定必须从 pass 变为 inconclusive。

### 批 2：评审可信

- 引入 additive `quality_score` 与独立 `coverage`；`not_applicable` 出分母、`inconclusive` 降覆盖不降分（缺口 2）。
- 五状态分离：执行、质量、覆盖、门禁、交付；禁止单一 `passed` 承载全部语义。
- 三值判定：缺证据一律 `inconclusive`，不得默认为通过。
- **验收判据**：构造"一半准则无法评估"的评审，`quality_score` 不低于同质量全量评审，而 `coverage` 必须下降；构造"有 applied 修订但正文已变"的交付，`closure` 必须是 `rereview_required` 而非 `closed`。

### 批 3：工具面工程化

- `tool-policy` 三分与 fail-closed（缺口 1）：未登记工具按 write 处理，plan/只读面拒绝写与生成。
- 参数先归一化后校验（缺口 7）。
- 错误带 `code + recovery` 面向模型（缺口 8）。
- 长任务对外暴露 `task_id` 与查询/取消/重试（缺口 6）——若判定当前同步模型已够用，可单独降级为"仅在超过阈值时转异步"。
- **验收判据**：新增一个未登记工具，在只读模式下必须被拒；传入字符串化 JSON 对象必须成功解析一次而非报错；`NETWORK_ERROR` 的返回必须包含"先查询再重提"的可执行指令。

**可选、按需评估**：单一 JSON Schema 源 + 双语言 codegen。本仓已有 `*.conformance.ts` 一致性测试，收益取决于契约数量增长速度；若三个月内契约文件数不再增长，不建议引入生成器。

## 六、风险与诚实边界

- **对方的测试数字不等于质量结论**：1224 passed/31 skipped 是其 `GOAL.md` 的历史记录，最新提交（2026-10-19）之后的测试数未复核；其 `IMPROVEMENT_PLAN.md` 自述的保存竞态等问题在 S1–S6 已修，引用旧缺口会失真。
- **其评审阈值未校准**：生产门禁明确关闭，不能把它的分数当验收基准。
- **其性能与成本数据来自特定机器与 provider**：免费模型超时、截断、推理 token 缺失均被它归类为可靠性失败而非质量分，这个分类口径值得学，但具体数字不可迁移。
- **本报告未运行对象项目**：所有机制结论来自源码与文档阅读；若后续要落地某条机制，仍需在其源码里复核实现细节（尤其是并发与撤销路径）。
