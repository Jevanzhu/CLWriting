# Dev Plans

本目录存放本地方案、参考和归档资料，不作为正式项目发布文件。

> **目录组织**（**按完成状态分区**，2026-06-21 整理）：根目录只放**当前活跃**的工单/方案；已完成的里程碑（`M0/`–`M8/`）+ beta 已落地文档进 `已完成/`；方案母本 + 参考进 `参考/`；过时文档进 `archive/`。当前实现进度：**M0–M8 已完成**，beta 体检体系两块已落地，DX 收口与成本采集闭环已完成。M5 完成安装器 + 多书工作目录；M6 自动模式出口达成；M7 导出 / 迁移 / RAG 插件出口达成；M8 短篇轨完成 `kind: short` 分流、短篇集布局、精简态机、按篇定稿、单篇清单、短篇机检、短篇三审、短篇导入、短篇集导出与短篇批量自动连写；审查收口已补短篇 `review run` 清单核对、短篇 `清单.md` 原子归档、`book.volume_size` 配置化和 init 空 `.git` 误拦修复。短篇加强已完成：`init --kind short` 会按题材写入 `book.yaml short` 推荐阈值，`health --report` 会基于已定稿短篇输出阈值回灌与每篇预算校准建议。当前主线本地验证：89 files / 713 tests 全绿，`typecheck` 与 `build:all` 通过，Studio 前端构建无 >500KB chunk warning；短篇 focused 回归 12 files / 95 tests 全绿；ZCode 等价宿主 smoke 出口达成；真 Claude Code 短篇正负向 smoke 已跑通；真 Codex CLI 短篇正向 smoke 已覆盖角色壳加载、写篇、机检、三审回收与 Codex 自身 `finalize` 定稿；Studio GUI 真宿主 smoke 已补 `npm run test:e2e:true-host` 独立入口。

## 交付实现（#1→#38；编号=登记序，非实现序）

> 给实现同事：按此序推进。**#1 M0 → #2 M1（#3–#7）→ #8 M2（#9 + #10–#13）→ #14 M3（#15–#18）→ #19 M4（#20–#24）→ #30 M5（#30–#32）→ #33 M6（#33–#35）→ #36 M7（#36–#38）→ #25 M8（#25–#29）**。先读里程碑工单（#2 #8 #14 #19 #30 #33 #36 #25）知全貌，再按依赖读 spec。
> **编号 = 登记序、非实现序**：M8 早起草占 #25–#29，实现序却排在 M5–M7（#30–#38）之后（依赖 M4 + M5/6/7）；故下方区块按**实现序**排，编号列非单调。**`cli.ts` 命令注册是 M5–M8 共同新增点**（init/update/use/auto/export/import/enable-rag/learn/短篇门面），各加各 case、互不冲突。

### M0 仓库骨架 ✅ 已完成

1. **#1** [M0-仓库骨架.md](已完成/M0/clwriting-v1-M0-仓库骨架.md) — **M0 仓库骨架工单**（格式无关，最先；交付说明 + 出口验收）

### M1 格式层 ✅ 已完成

2. **#2** [M1-格式层工单.md](已完成/M1-格式层/clwriting-v1-M1-格式层工单.md) — **M1 实现工单**（统领 M1：做什么 / 依赖谁 / 怎么验；先读它）
3. **#3** [账本格式-spec.md](已完成/M1-格式层/clwriting-v1-账本格式-spec.md) — **账本格式 spec**（M1 格式契约；#4 的前置）
4. **#4** [缓存表-DDL-spec.md](已完成/M1-格式层/clwriting-v1-缓存表-DDL-spec.md) — **缓存表 DDL spec**（M1 格式契约；依赖 #3）
5. **#5** [文风样章库格式-spec.md](已完成/M1-格式层/clwriting-v1-文风样章库格式-spec.md) — **文风样章库格式 spec**（M1 格式契约；独立，可并行）
6. **#6** [境界枚举格式-spec.md](已完成/M1-格式层/clwriting-v1-境界枚举格式-spec.md) — **境界枚举格式 spec**（M1 格式契约；成长线机检数据源）
7. **#7** [章节元数据格式-spec.md](已完成/M1-格式层/clwriting-v1-章节元数据格式-spec.md) — **章节元数据格式 spec**（M1 格式契约；填 chapters 钩子/情绪列）

### M2 写章脚本面 ✅ 已完成

8. **#8** [M2-写章脚本工单.md](已完成/M2-写章脚本/clwriting-v1-M2-写章脚本工单.md) — **M2 写章脚本工单**（脚本面零 AI 全通；统领 #9–#13）
9. **#9** [book-yaml配置-spec.md](已完成/M2-写章脚本/clwriting-v1-book-yaml配置-spec.md) — **book.yaml 配置 spec**（基础配置；M1 亦依赖）
10. **#10** [机检规则-spec.md](已完成/M2-写章脚本/clwriting-v1-机检规则-spec.md) — **机检规则 spec**（M2；阶段 5 机检总规则、红/黄分级）
11. **#11** [确认记录-spec.md](已完成/M2-写章脚本/clwriting-v1-确认记录-spec.md) — **确认记录 spec**（M2；硬闸防伪、哈希绑定）
12. **#12** [输入预算闸-spec.md](已完成/M2-写章脚本/clwriting-v1-输入预算闸-spec.md) — **输入预算闸 spec**（M2；单章输入量 + 裁剪）
13. **#13** [定稿commit-spec.md](已完成/M2-写章脚本/clwriting-v1-定稿commit-spec.md) — **定稿 commit spec**（M2；原子定稿、中断恢复）

### M3 状态机 + git 隐身 ✅ 已完成

14. **#14** [M3-状态机工单.md](已完成/M3-状态机/clwriting-v1-M3-状态机工单.md) — **M3 状态机 + git 隐身工单**（统领 #15–#18；7 态单入口 + git 隐身）
15. **#15** [状态机单入口-spec.md](已完成/M3-状态机/clwriting-v1-状态机单入口-spec.md) — **状态机单入口 spec**（M3 骨架；7 态判定 + 近况复述）
16. **#16** [git隐身层-spec.md](已完成/M3-状态机/clwriting-v1-git隐身层-spec.md) — **git 隐身层 spec**（M3；健康检查 + 人话包装 + 回滚「回到第 N 章」）
17. **#17** [影响分析-spec.md](已完成/M3-状态机/clwriting-v1-影响分析-spec.md) — **影响分析 spec**（M3；已发布顺势圆 + 两份清单 + 避免吃书）
18. **#18** [手改对账-spec.md](已完成/M3-状态机/clwriting-v1-手改对账-spec.md) — **手改对账 spec**（M3；修复确认 + 提议补登）

### M4 AI 角色层 🟢 脚本层 + 双侧一级宿主出口达成

19. **#19** [M4-AI角色层工单.md](已完成/M4-AI角色层/clwriting-v1-M4-AI角色层工单.md) — **M4 AI 角色层 + 一级宿主工单**（统领 #20–#24；接真模型 + 角色单源分发 + 三审规格阶梯）
20. **#20** [三审任务书-spec.md](已完成/M4-AI角色层/clwriting-v1-三审任务书-spec.md) — **三审任务书 spec**（M4 骨架；读者审/编辑审/设定校对 + 账本清单驱动核对 + 顺势圆/修复确认/复盘 prompt 契约）
21. **#21** [角色单源分发-spec.md](已完成/M4-AI角色层/clwriting-v1-角色单源分发-spec.md) — **角色单源 + 三平台壳 spec**（M4 骨架；一份源 → CC/Codex/通用壳 + drift check + SKILL.md 编排）
22. **#22** [审查分级-spec.md](已完成/M4-AI角色层/clwriting-v1-审查分级-spec.md) — **审查规格阶梯 spec**（M4 机制；回归 v7 默认满审三视角各独立 + 按宿主能力降级（顺序审/合审，降级诚实）+ 满审 ×3 聚合）
23. **#23** [每章调用预算闸-spec.md](已完成/M4-AI角色层/clwriting-v1-每章调用预算闸-spec.md) — **每章调用预算闸 spec**（M4 机制；`calls_per_chapter` 计数口径 + best-of-N/满审计入 + 超限停下逼决策 + 续跑继承 + 与输入预算闸正交）
24. **#24** [SessionStart注入-spec.md](已完成/M4-AI角色层/clwriting-v1-SessionStart注入-spec.md) — **SessionStart 注入 spec**（M4 机制；hook → `enter()` → 注入 `Recap`（有界）+ 三平台壳注册接 #21 + 无 hook 等价）

### M5 安装器 + 多本书 ✅ 已完成（278 测试全绿，活动书接缝闭环）

30. **#30–#32** [M5-安装器工单.md](已完成/M5-安装器/clwriting-v1-M5-安装器工单.md) — **M5 安装器 + 多本书工单**（统领 #30–#32；`init` 装工作目录 + 建第一本书 + `update` 安全升级 + `books.jsonl`/活动书 + bookRoot 解析接缝。**含 M4 既有代码接缝清单（工单第 7 节，交同事）**）
    - **#30** [安装布局-init-spec.md](已完成/M5-安装器/clwriting-v1-安装布局-init-spec.md) — 工作目录布局（非 git）+ 两层 AGENTS.md 契约 + 书仓库 scaffold（含初始 commit）+ 混合式 init 9 步
    - **#31** [update-模板哈希-spec.md](已完成/M5-安装器/clwriting-v1-update-模板哈希-spec.md) — update 三类分治（插件本体/派生物/作者数据）+ 模板哈希追踪 + 角色源备份
    - **#32** [books-jsonl-活动书-spec.md](已完成/M5-安装器/clwriting-v1-books-jsonl-活动书-spec.md) — `books.jsonl` 登记 + `resolveBookRoot` 解析链（H1）+ `use` 换书 + 自愈

### M6 自动模式 ✅ 已完成（287 测试全绿，接缝 R1/R2 + 连写编排闭环）

33. **#33–#35** [M6-自动模式工单.md](已完成/M6-自动模式/clwriting-v1-M6-自动模式工单.md) — **M6 自动模式工单**（统领 #33–#35；`auto` 连写活动书一批 + 停止四件套（预算/质量/需人/系统）+ 待批量审稿态 + 批量审稿→逐章定稿→整批回滚 + 污染不出批次。**含 M3 状态机/finalize 接缝回修清单（工单第 8 节，交同事）**）
    - **#33** [待定稿批次-自动流程-spec.md](已完成/M6-自动模式/clwriting-v1-待定稿批次-自动流程-spec.md) — 连写编排（阶段 1–6 自动）+ `待定稿/` 结构（每章 = 单章工作区快照）+ `.auto-batch.json` 批次进度 + 章号自管 + 搬运复用（confirm/calls 零改落点）
    - **#34** [状态机接入-停止四件套-spec.md](已完成/M6-自动模式/clwriting-v1-状态机接入-停止四件套-spec.md) — 待批量审稿态（态 8，接缝 R1）+ 停止四件套 + 连写暂停元状态 + 坏章隔离（不出批次）
    - **#35** [批量审稿-逐章定稿-spec.md](已完成/M6-自动模式/clwriting-v1-批量审稿-逐章定稿-spec.md) — 批量审稿（账实两层恒跑）+ 逐章定稿（finalize 待定稿适配 R2：workDir 参数化）+ 整批回滚 + 单章打回

### M7 导出 + 迁移 + RAG ✅ 已完成（327 测试全绿，RAG 宿主编排接入）

36. **#36–#38** [M7-导出迁移RAG工单.md](已完成/M7-导出迁移RAG/clwriting-v1-M7-导出迁移RAG工单.md) — **M7 导出+迁移指引+RAG 插件工单**（统领 #36–#38；干净导出多形态 + 轻量 `import` 迁移 + RAG 可选插件（外部 embedding + per-book node:sqlite + 纯 JS 余弦，key 不进 git、零依赖守住）+ 文风样章 learn 收割（独立命令、候选制）。RAG 召回已接入 `prepareMaterials` 宿主编排，未配 key / 端点异常诚实降级。）
    - **#36** [干净导出-迁移指引-spec.md](已完成/M7-导出迁移RAG/clwriting-v1-干净导出-迁移指引-spec.md) — `export` 多形态+净化（复用 `readChapterDir`）+ `import` 统一入口/length-routing 分流（与 M8 #29）+ v0.2 迁移指引
    - **#37** [RAG插件-spec.md](已完成/M7-导出迁移RAG/clwriting-v1-RAG插件-spec.md) — `enable-rag`（key 不进 git）+ per-book `.rag.db`（零依赖 fetch+sqlite+纯JS余弦）+ 接备料 R1（prepare 保持同步、flexibleRank 5）+ 降级回落
    - **#38** [文风learn收割-spec.md](已完成/M7-导出迁移RAG/clwriting-v1-文风learn收割-spec.md) — 独立命令（不挂 finalize）+ 句式体检打分候选 + 作者审入 #5 样章/金句库 + 冷启动替换闭环

### M8 短篇轨 ✅ 已完成（短篇 focused 95 测试全绿，真 CC 正负向 + Codex 正向 smoke 已验证）

25. **#25–#29** [M8-短篇轨工单.md](已完成/M8-短篇轨/clwriting-v1-M8-短篇轨工单.md) — **M8 短篇轨工单**（双轨第二轨；独立轻轨 + 一仓库一短篇集 + 账本降级单篇清单 + 短篇满审三视角 + 导入分流。ZCode 等价宿主已跑通正反向闭环；真 Claude Code 短篇正负向 smoke 已跑通；真 Codex CLI 短篇正向 smoke 已覆盖角色壳加载、写篇、机检、三审回收与 Codex 自身 finalize 定稿。）
    - **#25** [短篇集布局-入口分流-spec.md](已完成/M8-短篇轨/clwriting-v1-短篇集布局-入口分流-spec.md) — `kind` 入 #9 + `篇/NNN-标题/` + 整集共享 + `init --kind short` + `enter` 顶层 kind 分叉骨架（与 M6 合并 H2）
    - **#26** [短篇精简态机-按篇定稿-spec.md](已完成/M8-短篇轨/clwriting-v1-短篇精简态机-按篇定稿-spec.md) — 态 1–4 + 写作主态（删 5/6/8）+ 按篇 `pc:` 定稿/回滚 + 与 M6 `detectState`/`finalize` 合并（H2）
    - **#27** [单篇流程-清单-spec.md](已完成/M8-短篇轨/clwriting-v1-单篇流程-清单-spec.md) — P1–P4 + 五段大纲 + `清单.md`（反转线索/伏笔）+ 短篇机检选项集 + 专属项新增
    - **#28** [短篇三审任务书-spec.md](已完成/M8-短篇轨/clwriting-v1-短篇三审任务书-spec.md) — 钩子/情绪反转/设定收尾三视角（重写 #20）+ 清单驱动核对 + 满审 ×3（复用 #22）
    - **#29** [短篇导入-spec.md](已完成/M8-短篇轨/clwriting-v1-短篇导入-spec.md) — M7 `import` 统一入口短篇分支（H1）+ length-routing 分流 + 按篇落 `篇/` + 不臆造清单

## Beta 化工作（M0–M8 出口达成后）

> M0–M8 全部出口达成后转入 beta 化。首批工作项：**体检报告**——落地母本第 11 节 beta 判据「文风/审查/token 指标进体检报告」。统一挂 `health`，按数据范式分两块（文风重扫 + 成本/审查落账），合并为一个体检体系。
>
> **进展（2026-06-24）**：两块已落地（提交 `4344d10`），V3 文风对齐 smoke 真宿主首跑**过线**；4 个 DX 收口、outline/draft `record-call` 成本采集闭环、token 字段预留通道与参数边界补强均已完成。5 章正向探针、对抗检测、短篇轨探针及相关 P1/DX 修复已归档。`health --metrics` 已新增宿主漏记软提示与预算校准提示；auto 待定稿 `.ai-calls.json` 搬运与 `finalizePendingChapters` 落账已补回归；`record-call --set-tokens` 已支持 token 真值事后回填且不增加 calls。观微 50 章规模验证已完成，暴露 D9/D9'/E1 并已回写修复：finalize 自动同步成长线当前境界、精确校验境界枚举值、卷末自动生成卷摘要。短篇集导出、短篇批量自动连写、短篇机检阈值配置、按篇调用预算文案与宿主写作指引已补齐；短篇真实多题材校准已补题材推荐阈值、`health --report` 阈值回灌和每篇预算候选；RC 中文路径专项已补 `test:rc-path` 并挂入 Windows CI matrix；Studio driver resume 假会话已修、GUI 真宿主 smoke 独立入口已落地、前端大 chunk warning 已清零；最新本地验证：`typecheck` 通过，89 files / 713 tests 全绿，`build:all` 成功。

### 当前活跃项

- [clwriting-beta-规模探针-方案.md](clwriting-beta-规模探针-方案.md) — **50 章规模验证入口 / 判据索引**：5 章探针与观微 50 章验证均已完成；本文件保留观测仪表盘、验收口径与证据链接。
- [clwriting-观微-50章验证-日志.md](clwriting-观微-50章验证-日志.md) — **观微 50 章规模验证日志（已完成）**：50 章 / 5 卷 / 50 commits；账本两端闭合全程 0 红项，三审 0 阻断；D9/D9'/E1 已回写修复。

- [clwriting-gui-方案.md](clwriting-gui-方案.md) — **Studio 工作台（Beta 集成收口）**：GUI 作为 CC/Codex 的壳（本地 server + 浏览器，非 Electron），四大功能区（建书/工作/统计/设定）全落地；Step1 壳 + Step2 工作台/改写/建书段2 + 短篇轨 + 设定台 P1/P2（角色卡/境界/关系图/RAG）已完成；driver 走 CLI headless；安全边界（CORS Origin 白名单）+ 发布链（CI build:all + prepack）已收口；真宿主端到端 smoke 已补独立脚本 `npm run test:e2e:true-host`（默认 e2e 仍 mock，发布前在有 Claude Code 认证环境执行并归档结果）。`studio-2.1`–`studio-2.5` 实施记录已按 2026-06-24 主线回写为已完成；当前不再视为活跃功能工单。

- [clwriting-beta-体检报告-实现工单.md](已完成/clwriting-beta-体检报告-实现工单.md) — **实现工单（交同事施工，先读）**：统领两块；文件落点 + TS 接口签名 + 落账点 + 施工序 + 出口验收。
- [clwriting-beta-指标体检报告-方案.md](已完成/clwriting-beta-指标体检报告-方案.md) — **块 A 成本/审查**：`.cache/metrics.jsonl` 定稿落账 + `health --metrics`（token/调用 + 审查 tier·降级·blockers）。
- [clwriting-文风对齐验证方案.md](已完成/clwriting-文风对齐验证方案.md) — **块 B 文风**：`health --style` 按需重扫 + `文风/基线.json` 冻结 + 漂移判定（宽松口径：贴近笔感、不刷检测器）。
- [clwriting-文风对齐-smoke清单.md](已完成/clwriting-文风对齐-smoke清单.md) — **V3 人工 smoke 清单**：真宿主写段 + 作者读「像不像」+ `health --style` 兜底。2026-06-20 真宿主首跑**已过线**（执行记录在文末）。
- [clwriting-beta-体检报告-修复工单.md](已完成/clwriting-beta-体检报告-修复工单.md) — **DX 收口工单（已完成）**：复审 + smoke 攒的 4 个非阻断小瑕疵（`--last` 口径 / `width()` 全角括号 / metric 泛化 / 损坏留痕）。
- [clwriting-beta-成本采集闭环-方案.md](已完成/clwriting-beta-成本采集闭环-方案.md) — **token 维度前置（已完成）**：补 outline/draft 调用记账闭环（`record-call` 命令）+ token 字段预留通道 + 参数边界补强。OQ1 落地第一步。
- [beta-探针/clwriting-探针运行日志.md](已完成/beta-探针/clwriting-探针运行日志.md) — **5 章正向探针（已完成）**：八阶段、账本、health、DX 发现与后续修复回写。
- [beta-探针/clwriting-对抗检测测试.md](已完成/beta-探针/clwriting-对抗检测测试.md) — **检测有效性对抗测试（已完成）**：12 向量验证防吃书与 AI 味防御。
- [beta-探针/clwriting-短篇轨探针.md](已完成/beta-探针/clwriting-短篇轨探针.md) — **短篇轨探针（已完成）**：短篇起草、清单、五段结构 DX 证据。
- [beta-探针/clwriting-账本CLI接缝-修复方案.md](已完成/beta-探针/clwriting-账本CLI接缝-修复方案.md) — **账本 CLI 接缝（已完成）**：CLI 端到账本履历闭环。
- [beta-探针/clwriting-检测盲区-修复方案.md](已完成/beta-探针/clwriting-检测盲区-修复方案.md) — **检测盲区修复（已完成）**：F1/F3/F5/S1/S2 等 P1/DX 缺口已回写归档。

> 归档：[archive/clwriting-文风对齐补强方案.md](archive/clwriting-文风对齐补强方案.md) — 文风 G1–G5 补强（已实施落地、使命完成；文风**验证**转入上方块 B）。

### RC 后留点

- **短篇真实样本校准**：短篇主链、短篇批量自动连写、短篇集导出和按篇预算口径均已落地；题材推荐阈值已沉淀到 `init --kind short`，真实样本阈值回灌与每篇预算候选已接入 `health --report`。后续只需持续用真实多题材短篇集复核推荐值，不再是功能缺口。
- **缓存增量优化**：`enter()` 仍以全量 `rebuild` 保证正确性；50 章和 200 章探针均未构成发布阻断。若后续 500+ / 1000+ 章实书出现体感延迟，再评估 mtime 或文件指纹跳过重建。
- **状态快照 DB 连接收口**：`state/state.ts` 中重复打开同一 SQLite 缓存属于轻量资源优化，等后续状态快照或缓存性能工作一起处理。
- **CLI 出口与时间注入重构**：`process.exit(1)` 收口、Clock 注入等属于维护性重构，RC 前不扩大改动面。

## 方案母本与参考

- [clwriting-v1-迁移方案.md](参考/clwriting-v1-迁移方案.md) — **v1.0 方案母本**：架构定位 + M0-M8 路线图（三分歧 D1/D2/D3 已定调）
- [clwriting-v1-参考项目吸收点.md](参考/clwriting-v1-参考项目吸收点.md) — **参考项目吸收清单**：从 character-arc / oh-story-claudecode 深读出的可吸收工程机制，按"直接/批判性/已规划/不吸收"四层分级并映射到各 spec
- `../Reviews/`：当前和历史项目审阅报告。
- 参考仓库（活参考，不归档）：`../character-arc/`、`../oh-story-claudecode/`、`../webnovel-writer/`。
