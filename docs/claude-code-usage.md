# Claude Code 使用说明

`story-craft` 的主入口是在 Claude Code 对话中输入 `/story-*` Skill 命令。作者日常写作不需要先打开终端敲 Python 命令。
底层 Python CLI 只负责确定性工具层，不自动调用 Agent，也不伪造 Agent 输出。

## Skill 命令

```text
/story-init
/story-plan
/story-write 1
/story-review 1
/story-learn
/story-query
```

## 入口职责

- `/story-init`：创建故事项目和初始 `.story/` 状态。
- `/story-plan`：生成或刷新故事总纲。
- `/story-write N`：写第 N 章，调用 Agent 并在通过后提交章节。
- `/story-review N`：独立审查第 N 章。
- `/story-learn`：记录后续章节可复用的写作经验。
- `/story-query`：查询状态、上下文、记忆、实体关系和质量趋势。

## Agent 编排

`/story-write N` 在 Claude Code 内固定使用 `Agent` 工具调用三个专职 Agent：

| Agent | 职责 |
|-------|------|
| `context-agent` | 搜集项目上下文（大纲、记忆、设定），输出本章创作任务书 |
| `reviewer` | 审查正文，检查设定一致性、时间线、角色动机、逻辑因果和 AI 味 |
| `data-agent` | 从已写正文中提取角色、伏笔、时间线等事实，生成章节增量数据 |

`deconstruction-agent` 用于 `/story-init` 或写前参考拆解，不是 `/story-write`
固定提交流程的一部分。

中间产物固定保存到：

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

CLI 不自动调用 Agent，只负责确定性校验、报告、修复计划、兜底抽取和提交。

## reviewer 契约

`reviewer` 的原始 JSON 只以 `issues` / `summary` 为输入契约：

- `issues` 必须是数组。
- `summary` 必须是字符串。
- `blocking=true` 或 `severity=critical` 会在本地归一化为阻断项。
- `passed`、`blockers`、`warnings`、`issue_count`、`blocker_count` 不作为 reviewer 原始输入字段。

## 写作闭环保障

- **字数闸门**：低于规划字数 60% 阻断提交，低于 80% 或超出 135% 发出警告。使用 `--strict-warnings` 可把警告也视为阻断。
- **审查闸门**：reviewer 发现 blocking issue 时章节 commit 为 rejected，不写入最终 `正文/`，不更新记忆。
- **经验积累**：每章写完后用 `/story-learn` 记录写作经验，后续章节自动参考。
- **中篇模式**：超过 5 万字的项目自动启用 SQLite 索引、备份快照、质量趋势分析和上下文裁剪。

## 章节号

推荐直接把章节号写在命令后：

```text
/story-write 1
/story-review 1
```

当前没有卷号；中篇如需结构层级，后续优先考虑“幕/阶段”，不恢复 `volume`。
