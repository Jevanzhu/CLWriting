# 更新日志

本项目所有重要变更记录于此。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased] - v1.0 重写进行中

v1.0 从零重写（Node + TypeScript），与 v0.2 Python 版无代码继承关系。

### 已完成

- **M0 仓库骨架**：npm 包 + bin 链路、TS 严格、tsup 构建、vitest、Node ≥24 门槛、纯 `node:sqlite` smoke、双平台 CI。
- **M1 格式层与缓存**：账本读写 / 缓存表 / 重建器 / 精准读取 / 文风境界章节 / book.yaml。
- **M2 写章脚本面**：机检规则 / 硬闸 / 输入预算闸 / 自愈打回 / 原子定稿（finalize）/ commit msg 规范。
- **M3 状态机 + git 隐身**（出口验收 9/9 达成）：
  - 状态机单入口（**7 态全落地**：git 体检 / 源文件解析 / 未入账手改 / 工作区未完成 / 卷末 / 体检周期 / 起草新章；判定顺序 + 路由 + 近况复述，含确认复述）；`clwriting enter` 进门体检 → 判态 → 路由。
  - git 隐身层（健康检查 4 异常：半提交 / 合并冲突 / 僵死锁 / 网盘副本残留；命令人话包装；commit msg 规范 + Confirmed trailer）。
  - 回滚「回到第 N 章」（`clwriting revert`）：备份再丢 + reset + 缓存重建 + 工作区清理，**定稿区 / .cache / 工作区三者一致**，可逆。
  - 手改对账：源文件修复确认（补 M1 占位）+ 未入账手改提议补登（已发布正文警示不强制拒）。
  - 影响分析：改设定产「已发布 / 未发布」两份影响清单 + 吃书检测（直接冲突标记）。
  - 体检周期闭环（态 6）：距上次体检 ≥ 30 章则到期提示；`clwriting health` 干净通过即记账消除提示（状态存 `.cache/health-check.json`，独立于 index.db 不受 rebuild 清空）。
  - **确认复述兜底**：进门复述上一章确认留痕；若工作区仍保留细纲则复核哈希并暴露不一致，若细纲已随定稿清理则明确标注「未复核」，不伪装成哈希一致。
  - **159 个测试全绿**（含 7 态端到端、git 异常样本库、三者一致回滚、兜底闭环、体检周期闭环）；运行时零第三方依赖。

### 评审修复（M3 收尾）

- 成长线机检动词错配修正（`跃迁` → 取 `LEAD_VERBS.成长线.resolve`，原硬编码致红项永不触发）。
- finalize 原子性补全：commit 失败时回滚定稿区（`reset` 清暂存 + `ls-tree HEAD` 判跟踪性，已跟踪 checkout / 新建 unlink），落地「失败则定稿区无变化」。
- `addCommit` 路径收窄：finalize 传显式路径避免 `add -A` 误纳工作区无关改动（保证「一 commit = 一章」）。
- `findChapterCommit` 去 `--all` 防备份 ref 误命中；确认哈希复用 `hashFile` 单源；正则与引号覆盖统一；版本号改读 `package.json` 单源；死代码清理。
- 性能基准：200 章 `enter()` 中位 58ms，全量 rebuild 无需优化。

### M4 AI 角色层 + 一级宿主（脚本层 + CC 真模型 smoke + Codex 真宿主加载验证达成）

- 脚本层第一批：补齐 `clwriting confirm` / `clwriting check` / `clwriting finalize` 薄门面，复用既有确认记录、机检、定稿原子 commit 硬闸。
- 每章 AI 调用预算闸落地：工作区 `.ai-calls.json` 记录本章已用次数，续跑继承，超限拒绝并给决策提示；定稿清空工作区时一并清理计数。
- 角色单源分发：`.clwriting/roles/*.md` 生成 Claude / Codex / 通用三套壳，写入壳 manifest，支持 source drift / output drift 检查（含壳部署格式硬闸）。
- 三审脚本契约：生成读者审 / 编辑审 / 设定校对三视角任务书，设定校对承接机检账本变动清单；审查档位支持满审 / 顺序审 / 合审的诚实降级；issue 聚合、证据硬闸与 blockers/warnings 归一化落地；`clwriting review plan` 输出档位与任务书。
- 三审执行落地（脚本编排与宿主执行分离）：`review run` 打包执行包供宿主按视角调模型，`review collect` 回收 issues JSON 归一化写审稿单；finalize 前置闸读作者裁决标记（HTML 注释锚定防误命中）；预算闸串联 review 记账。
- SessionStart 注入：新增 `clwriting session-start`，复用 `enter()` 结构化近况生成有界开场上下文。
- 知识层平移：正式 `知识层/` + `_manifest.json` 可复现清单 + `clwriting knowledge check` 校验入口；平移 oh-story MIT 素材精选速查（题材路由、章节钩子、节奏与升级感、反转设计、质量检查、人物与对话技法，共 6 篇速查 + 许可全文，13 条 manifest）。
- **真模型 smoke（CC 侧）达成**：建书 → 写 1 章 → 满审（降级顺序审，诚实声明）→ 定稿全程跑通；**账本造假（声明揭凶手但正文不写）被设定校对逮住 → 审稿单不成立 → 无裁决 finalize 拒绝 → 作者 override 放行**闭环在真模型下复现。
- **仍未声称完成的真模型点**：顺势圆、修复确认、卷复盘 / 体检深度目前有路由与 prompt 契约，尚未形成独立真模型 smoke 证据。

### M4 收尾修复（smoke 暴露并修复）

- **tsup 打包致命 bug 修复**：tsup 默认 `nodeProtocolPlugin` 把 `node:sqlite` 改写成 bare `sqlite`（兼容 Node<14.18，见 tsup#1003），导致 dist 产物运行时崩 `Cannot find package 'sqlite'`。199 测试用 tsx 跑源码未暴露，真模型 smoke 才暴露。修复：`tsup.config.ts` 加 `removeNodeProtocol: false`（本项目门槛 Node≥24，原生支持 `node:` 协议）。
- **review 默认草稿路径 DX 修复**：`review run/collect` 原硬编码 `草稿-1.md`，第 N≠1 章必须显式传草稿路径。改为「显式参数 > 按 `--chapter=N` 推导 `草稿-N.md` > 回落 `草稿-1.md`」。

### Codex smoke 进展（壳格式 + 等价宿主全链路 + 真宿主加载执行已验证）

- **Codex 壳格式 + drift**：建 4 角色源 → `roles generate` 出 11 产物（3 平台 × 角色 + manifest）→ `roles check` drift 绿；Codex 单 agent 壳 `- id:`/`- model:`/`- tools:` 结构合规，与 CC 侧同源同构，证明非 CC 专属。
- **等价宿主全链路复现**：ZCode（CC 等价）充当写稿/三审模型，跑通建书→写2章→三审→定稿；账本造假闭环（设定校对逮 ledger blocking → 审稿单不成立 → finalize 无裁决拒绝 → 作者 override 放行）真模型下复现，与 e2e 桩结果一致。
- **真 Codex 宿主加载执行验证通过**：`codex exec` 在 `/tmp/clwriting-codex-smoke.JESqOf` 读取 `.codex/AGENTS.md` 索引与 4 个 `.codex/agents/*.md`，逐个回报 id / 验证口令；并按 `writer` 壳写入 `codex-writer-role-executed.txt`，证明真 Codex CLI 能读取并执行派生 agent 壳。
- **smoke 新发现 DX bug**：角色源 `tools: Read, Write` 裸逗号写法被 `parseValue` 当字符串致壳 tools 渲染 `none`（P4，**M5 已修**：角色源种子统一方括号语法 + shells.ts 补防误用注释）。

### M5 安装器 + 多本书（出口达成，252 测试全绿）

把 #21 壳生成器接成完整安装器——「一条命令装工作目录 + 建第一本书」，补齐多书登记/换书/升级/接缝。依据 M5 工单 + 子 spec #30/#31/#32。

- **`clwriting init`**（#30）：混合式建书——非交互 `--name --genre --leads` 一条命令装出工作目录（非 git）+ 第一本书（独立 git 仓库）。题材驱动账本类（O3 内嵌映射：玄幻→设定线+成长线、悬疑→局线、言情→关系债等）；母本 6.2 目录 scaffold（基础三类恒建 + 扩展类按 leads.enabled）；文风冷启动占位（五场景目录 + 铁律骨架）；书仓库初始 commit（让 enter 有 HEAD 可判）；两层 AGENTS.md（工作目录层 #21 派生 + 书仓库层书级指路）。
- **活动书 + bookRoot 解析接缝（#32 R1，M5 核心）**：新增 `resolveBookRoot`（显式参数 > cwd 书仓库 > 活动书 > 人话报错）+ `.clwriting/active` 指针 + `books.jsonl` 登记。**10 个既有命令**（enter/health/revert/confirm/check/finalize/review/knowledge/session-start）的 bookRoot 解析统一接入；工作目录内裸命令经活动书定位，在某书仓库内直接跑则优先操作当前书——M0-M4 从「单书 cwd」走向「工作目录多书」。
- **`clwriting use` / `list`**（#32）：换书（只改 active 单文件）/ 列书（标活动书 + kind 区分）。cwd 优先于 active（在书仓库内直接跑不受 active 影响）。
- **`clwriting repair`**（#32）：自愈门面——books.jsonl 缺失/损坏 → 扫描工作目录直接子目录重建登记；书目录移动 → 标 missing 提示重关联且保留原登记。端到端验证：删 books.jsonl → list 报空 → repair 重建 → list 恢复。
- **自愈 `repairBooks`**（#32）：books.jsonl 缺失/损坏 → 扫描工作目录直接子目录（有 book.yaml+.git）重建；书目录移动 → 标 missing 提示重关联；未知字段保留，便于登记格式演进。
- **`clwriting update`**（#31）：三类文件分治——插件本体 `.clwriting/dist` 同步当前包 dist / 派生物（壳）`generateRoleShells` 重生 / 作者数据（book.yaml/角色源）**只增不覆盖** + 模板哈希差异提示（作者改过的保留、未改的升级）；角色源备份 `.clwriting/roles.bak/`（改坏可回退）。
- **角色源种子（P4 修复）**：`templates/roles/*.md` 4 个默认角色源（writer + 三审）随包分发（package.json files 纳入），init 拷到工作目录并写 `templates.manifest.json` 初装 hash；tools 统一方括号语法，裸逗号写法会报错而不是静默生成无工具壳。
- **空书 enter 兜底**：init 建出的零章空书（初始 commit + book.yaml + 目录骨架），`enter` 干净落态 7「起草新章」，不被 gitHealthCheck/rebuild 绊倒（M5 工单评审 M4 出口）。
- **真模型 smoke 达成**：`clwriting init --name X --genre Y` 一条命令 → 工作目录内裸 `clwriting enter` 经活动书定位到书仓库 → 空书落态 7；建第二本书 → use 换书 → list 列书全程跑通。接缝 R1 闭环真模型复现。

> **测试**：252 个测试全绿（34 文件）；`tsc --noEmit` 通过；`dependencies: {}` 运行时零第三方依赖。

> **M5 收尾修复**：修正 `resolveBookRoot` cwd/active 优先级；`review run` 落盘 `packet.json`，`review collect` 固定读取并校验草稿 hash；合审回写文件名统一为 `issues-combined.json`；`book.yaml` 数字坏值回落默认，避免 NaN 注入。

### M6 自动模式（编排内核 + 待定稿闭环达成，287 测试全绿）

把写章八阶段从「逐章人工驱动」升级为「宿主驱动连写一批」：编排层把产出攒进 `待定稿/`，AI 产出步由宿主经 `produce` 接管，作者回来批量审稿 → 逐章定稿 / 整批回滚。依据 M6 工单 + 子 spec #33/#34/#35。接缝 R1（状态机态 8）+ R2（finalize --from）先于连写编排落地。

- **接缝 R1 状态机态 8「待批量审稿」**（#34）：`detectState` 新增态 8（插态 4 后、态 5 前），扫 `工作区/待定稿/` 完成章 → 路由 `pending-batch-review`（不落兜底态 7）；`StatusRecap` 加 `batchPause` 元状态（读 `.auto-batch.json` paused，叠加在态 4/8 之上提示「连写暂停在第 K 章」）；`.isolated/` 隔离章不计入待审；态 4 优先于态 8（半截章先续完）。3 处 TS 强制校验（BookState 联合/STATE_NAMES Record/routeState 无 default）作安全网。
- **接缝 R2 finalize --from**（#35）：`finalize --from <待定稿章目录>` 支持从待定稿定稿，workDir 来源参数化，`doFinalize` 内核零改动（前置闸/原子 commit/clearWorkDir 全复用）；未裁决章被前置闸拦；直连 `--from` 成功后清理该章待定稿目录并更新 `.auto-batch.json`。
- **连写编排 `clwriting auto`**（#33）：`doAutoBatch` 串联单章八阶段，工作区根复用（当前在写章）+ 搬入 `待定稿/<章号-标题>/` + 清空工作区根；**章号自管**（只认 `.auto-batch.json` next_chapter，不靠 detectState，防章号重复）；从既有定稿续算起始章。AI 步是接缝——编排层串联脚本步 + 搬运 + 游标，真模型产出由宿主经 `produce` 回调填入。
- **停止四件套 + 坏章隔离**（#34）：① 预算（调用触顶）② 质量（机检红/账实失败，**隔离该章**）③ 需人（高风险禁降级）④ 系统（git 健康失败，**隔离**）；任一触发 → 记 `.auto-batch.json` paused → 停下问人（不崩、不静默跳过）；② ④ 坏章移到 `待定稿/.isolated/`，completed 不含、章号游标照推；① ③ 停在触发章，不推进游标；干净章不受连累。
- **`auto --resume`**：读 `.auto-batch.json` 续跑，进度/计数继承不重置（不接受重置参数，防绕过预算/重复写）；预算/需人暂停续写同章，隔离章不重跑（跳过续写）。
- **批量审稿 + 逐章定稿 CLI**（#35）：新增 `clwriting review batch` 入口：`list` 列待审章 + 识别裁决状态；`finalize [--chapter=N]` 定稿全部已通过章或指定章；`reject --chapter=N` 单章打回归 `.isolated/`；`rollback --yes` 整批回滚清暂存不涉 git。批量定稿复用 `readChapter`，保留草稿章元数据。
- **卷纲硬闸**：连写前查 `大纲/卷纲/` 非空（简化版，真·卷纲确认 schema 待补），空则拒绝启动。
- **端到端 smoke 达成**：连写 2 章（桩 produce）→ `enter` 落态 8 → 批量审稿 approved → 逐章 `finalize --from` → `enter` 落态 7；暂停 → `--resume` 续完 → 态 8 全链路复现。

> **M6 相关测试**：287 个测试全绿（40 文件，M6 新增 45 个：finalize-from 4 + pending-batch 7 + batch 8 + stop 7 + review-batch 7 + e2e 2 + 状态机回归）；`dependencies: {}` 运行时零第三方依赖。

> **M6 收尾留点**：`auto` CLI 门面的 AI 步是占位（需宿主 Claude Code/Codex 在编排点接管 produce 产出真模型细纲/正文）；卷纲确认仅查目录非空（真 schema 待补）；真宿主续跑待 smoke；M8 #26 共改协调（detectState kind 分流 + finalize pc: 前缀）预留。

### M7 导出 + 迁移指引 + RAG 插件（出口达成，321 测试全绿）

v1 进入 beta 前的收尾里程碑。把成稿干净导出、给 v0.2 轻量迁移、留 RAG 可选插件口子、文风样章从定稿持续 learn 收割。依据 M7 工单 + 子 spec #36/#37/#38。

- **`clwriting export`（#36）**：定稿正文干净导出多形态——单文件合并（`工作区/导出/全本-<书名>.md`）+ 分章（`工作区/导出/分章/0001-标题.md` 4 位补零）。复用 M1 `readChapterDir` 遍历 + `readFile` 取正文；按章号数值排序（不依赖文件名字符串序）；净化剥所有 front matter（只出 `# 标题\n\n正文`），不含账本/大纲/工作区/摘要。作用于活动书。
- **`clwriting import`（#36）**：v0.2 正文轻量导入。length-routing 判长短（`--kind` > 章节数≥5 > 字数≥30000；短篇分流 M8）。**复用 scaffoldBookRepo 建书**（从 init.ts 提取的共享 `install/scaffold.ts`，6.2 目录完整 + 文风铁律模板 + git + AGENTS.md 一致）；落正文复用 `writeChapter`，钩子/情绪填占位默认 + `_raw` 标「导入: 待标注」（不伪装）；第二次 commit。CLI 层 `findWorkDir` 定位工作目录，逻辑层不碰 `process.cwd`。
- **scaffold 共享模块提取（#36 前置）**：把 init.ts 的 `scaffoldBookRepo`/`scaffoldDirectories`/`findGitAncestor`/`renderStyleRules`/`renderBookAgentsMd` 提到 `install/scaffold.ts` 并 export。init 重构复用，行为逐字节不变（init.test.ts 8 测试全绿作回归）。
- **v0.2→v1 迁移指引文档**：5 步手动流程（导出 v0.2 → import → 补账本/设定 → 补元数据 → enter 体检）+ 数据对照表（只搬正文、不搬投影）。
- **`clwriting learn`（#38）**：文风样章/金句收割。**独立命令、不挂 finalize**（定稿仍零 token 原子）。打分**复用 #10 机检**（`checkStyleMetrics` + `checkRepeat` + `parseIronRules`，yellow 项扣分，口径归机检而非硬编码关键词）；场景预归类启发式（作者审核确认/改归）；候选制落 `工作区/learn候选/`。
- **`clwriting learn commit`（#38）**：交互式挑选候选入库（readline，参考 init.ts 交互模式；非 TTY 报错）。入库复用 #5 `writeSample`（`来源: 作者原作` + 序号 3 位补零递增 `nextSampleSeq`）+ 金句追加到 `文风/金句库/<场景>.md`。**作者审核才入库**（品味归人）。
- **`clwriting enable-rag`（#37）**：启用 RAG 可选插件。非密配置（enabled/endpoint/model）入 book.yaml rag 段；**api_key 绝不进 git**（红线 H1）——落 `.clwriting/rag.secret`（非 git）或环境变量 `CLWRITING_RAG_API_KEY`，优先级环境变量 > 文件。
- **RAG 向量库（#37，per-book，零依赖）**：`.rag.db` 落书仓库内、gitignore、**独立 `.cache`**（红线 M1，删缓存不连带删向量）。schema：`chunks`（章号+偏移+embedding BLOB+model）+ `rag_meta`（维度/模型/已索引章号）。向量 `Float32Array` ↔ `Buffer` BLOB 往返。**纯 node:sqlite + 纯 JS 余弦**（不引向量索引库）。
- **RAG 建索引 + 召回（#37）**：定稿正文分块（按段落/双空行记偏移）→ 外部 embed（内置 `fetch`，OpenAI 兼容，零依赖）→ 存向量（增量：`rag_meta` 记已索引章号，新章增量 embed）。召回：query embed → 全表余弦 topK → 返回位置（章号+偏移，原文交精准读取）。**账本永走精准读取不走 RAG**。降级诚实：端点挂/未配 key → 召回空 → 不崩主路径。
- **R1 接缝（#37 第 6 节）**：`prepare()` 加第 5 可选入参 `ragRecallText?: string`（保持同步，召回在 prepare 外异步 await 完成后传入）。非空 push 弹性段 `flexibleRank: 5`（比非本章预警 rank 4 还先砍——召回是锦上添花）。**不传 → 无此段 → 行为逐字节不变**（现有 prepare 测试全绿 + 新增 R1 测试 3 项验证）。
- **BookConfig 扩展**：`#9` schema 加 `rag?` 可选段（enabled/endpoint/model），yaml 解析+回写支持。

> **测试**：321 个测试全绿（46 文件，M7 新增 36 个：export 4 + import 5 + learn 6 + rag config/store 9 + rag index 7 + R1 接缝 3 + scaffold 回归隐含在 init 8）；`tsc --noEmit` 通过；`dependencies: {}` 运行时零第三方依赖（RAG 用内置 fetch + node:sqlite + 纯 JS）。

> **M7 收尾留点**：RAG 建索引的宿主编排接入（写章编排层在备料前 await recall）待真宿主 smoke；分块粒度/embedding 模型/召回 K 默认值待 beta 校准；v0.2 真实格式解析需用自有 v0.2 项目验证（当前支持「第N章」标记 + 分隔符兜底）；短篇 import 分支归 M8 #29。

> v0.2 Python 版（GPL-3.0）冻结为遗产，仅留在 `main` 分支修致命 bug。v1 在 `v1` 分支以 MIT 重新起步。

## [0.2.0] - 2026-06-13

首个公开发布（Python 版，GPL-3.0）。详见 `main` 分支历史。

[Unreleased]: https://github.com/Jevanzhu/CLWriting/tree/v1
[0.2.0]: https://github.com/Jevanzhu/CLWriting/releases/tag/v0.2.0
