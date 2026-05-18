# Claude Code 使用说明

`story-craft` 的主入口是在 Claude Code 对话中输入 `/story-*` Skill 命令。作者日常写作不需要先打开终端敲 Python 命令。

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

`/story-write N` 对齐参考项目 `webnovel-writer` 的做法：在 Claude Code 内使用 `Agent` 工具调用：

- `context-agent`
- `reviewer`
- `data-agent`

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

## 章节号

推荐直接把章节号写在命令后：

```text
/story-write 1
/story-review 1
```

当前没有卷号；中篇如需结构层级，后续优先考虑“幕/阶段”，不恢复 `volume`。
