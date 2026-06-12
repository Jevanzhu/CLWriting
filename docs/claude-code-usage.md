# Claude Code 使用说明

story-craft 的主入口是在 Claude Code 对话中输入 `/story-*` 命令。作者日常写作不需要先打开终端敲 Python 命令。

底层 Python CLI 只负责确定性工具层：项目定位、合同读写、工作台生成、本地审查报告、commit 真源写入、投影重建和只读查询。CLI 不自动调用 Agent，也不伪造 Agent 输出。

## Commands

当前插件定义 13 个 Claude Code commands：

- 共用：`/story-init`、`/story-preflight`、`/story-review`、`/story-query`、`/story-learn`、`/story-deslop`、`/story-repair`、`/story-import`
- 长篇：`/story-long-plan`、`/story-long-write`、`/story-long-analyze`、`/story-long-scan`
- 短篇：`/story-short-write`

短篇分析和扫描仍由 Skill 提供：`/story-short-analyze`、`/story-short-scan`。它们不在 commands 目录中物理注册，后续如需要可在阶段 5 测试重建后补 command。

Python CLI 当前有 20 个 CLI 顶层子命令。CLI、commands 和 Skills 是三套清单，不要求一一映射。

## Skills

当前共有 17 个 Skill：

- 共用：`story-init`、`story-plan`、`story-write`、`story-review`、`story-learn`、`story-query`、`story-preflight`、`story-deslop`、`story-repair`、`story-import`
- 长篇：`story-long-plan`、`story-long-write`、`story-long-analyze`、`story-long-scan`
- 短篇：`story-short-write`、`story-short-analyze`、`story-short-scan`

`story-plan` 和 `story-write` 是旧共用入口，保留用于短中篇/调试口径。新项目日常建议直接使用 `/story-short-write` 或 `/story-long-plan`、`/story-long-write`。

## Agent 编排

当前共有 9 个 Agent：

- `story-architect`：长篇 master、volumes、chapters 合同草案。
- `character-designer`：character_registry、角色档案和关系草案。
- `context-agent`：读取合同、commit 和投影，生成 brief.json。
- `narrative-writer`：根据 brief.json 起草 draft.md。
- `reviewer`：full、lean、solo 三档审查，输出 S1-S4 findings。
- `consistency-checker`：grep-first 一致性复核。
- `data-agent`：从正文提取 accepted_events、dominant_strand、scenes 和 style_fingerprint。
- `story-explorer`：只读查询项目状态、合同、commit 和记忆。
- `story-researcher`：整理资料草案，不污染 canon。

短篇写作默认使用 4 核心 Agent：

```text
context-agent → narrative-writer → reviewer(solo) → data-agent
```

长篇写作链可按场景调用 9 Agent 能力，但单章写作主链仍以 context-agent、narrative-writer、reviewer、data-agent 为核心；规划、研究、一致性和查询 Agent 按需加入。

## 工作台

写作中间产物固定保存到 `.story/workflows/ch_NN/`：

```text
.story/workflows/ch_NN/
├── manifest.json
├── brief.json
├── draft.md
├── review.json
├── repair.json
├── polish.json
├── delta.json
├── review-report.md
└── write-result.json
```

`/story-long-write` 和 `/story-short-write` 都应使用工作台路径。工作台中的 Agent 输出和 CLI 结果要分开记录，Claude Code 端真实调用结果不能标记成本地 pytest 已验证。

## reviewer 契约

`reviewer` 的原始 JSON 使用 `issues`、`summary` 和 `meta`。本地最小消费边界仍以 `issues` / `summary` 为准：

- `issues` 必须是数组。
- `summary` 必须是字符串。
- `S1/S2`、`blocking=true` 或 `severity=critical` 会在本地归一化为阻断项。
- `passed`、`blockers`、`warnings`、`issue_count`、`blocker_count` 不作为 reviewer 原始输入字段。

短篇默认 reviewer `solo` mode；长篇默认 `lean` mode；用户要求深审且预检满足时可用 `full`。

## 写作闭环

长篇 `/story-long-write` 的 8 步 pipeline：

1. 预检合同、上一章 commit、占位符和项目类型。
2. 路由 5 个场景：`daily_continue`、`major_revision`、`new_volume`、`open_book`、`import_external`。
3. 调用 `context-agent` 生成 brief.json。
4. 调用 `narrative-writer` 生成 draft.md。
5. 调用 `reviewer` 生成 review.json。
6. reviewer 阻断时进入 repair loop，再复审。
7. 调用 `data-agent` 生成 delta/commit 草案。
8. 调用 `chapter-commit`，写入 commit 真源并派发 6 投影。

短篇 `/story-short-write` 共用真源链，但执行退化矩阵：不检查 `volumes/`，reviewer 默认 `solo`，`index/vector` 默认 lazy，跳过 Git 备份。

## 只读入口

- `/story-query`：只读回答项目状态、合同、commit、memory、learning（含 `learning-suggestions` 从审查历史自动提炼的经验候选）和 references 口径。
- `/story-preflight`：只读写前检查，输出 blockers、warnings 和 recommended_skill。
- `/story-long-analyze`、`/story-short-analyze`：只读分析，不生成新剧情事实。
- `/story-long-scan`、`/story-short-scan`：扫描占位符、一致性或 AI 味，不直接修复正文。

所有只读入口都不得写 state、memory、commit、合同或正文。
