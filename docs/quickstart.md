# 快速开始

本文说明如何从零创建一个 story-craft 故事项目，并完成第一章的基本闭环。
日常入口是 Claude Code 中的 `/story-*` 命令；文中的 Python CLI 只作为调试和验证示例。

## 推荐链路

在 Claude Code 中使用：

```text
/story-init  →  /story-plan  →  /story-write 1  →  /story-review 1  →  /story-learn  →  /story-query
```

`/story-write N` 会准备 `.story/workflows/ch_NN/`，由三个专职 Agent 分工完成：

```text
Agent(context-agent) → draft.md → Agent(reviewer) → repair/polish
→ Agent(data-agent) → write
```

`Agent(deconstruction-agent)` 可在写作前单独调用，拆解参考短篇、提取可迁移的创作模式，不污染故事数据。

`/story-write` 的工作台固定保存到 `.story/workflows/ch_NN/`，便于中断后从缺失步骤继续。

## 创建故事

在 Claude Code 中输入：

```text
/story-init
```

按提示填写：

- 书名
- 题材
- 目标字数
- 故事梗概
- 主角
- 独特优势
- 世界观

## 生成总纲

在 Claude Code 中输入：

```text
/story-plan
```

底层调试命令示例：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo plan --chapter-count 8
```

## 写第一章

在 Claude Code 中输入：

```text
/story-write 1
```

`review.json` 必须是 reviewer 原始 schema：顶层只要求 `issues` 和 `summary`。`issues[]` 中有 `blocking=true` 或 `severity=critical` 时不会进入提交，rejected 章节不写入最终 `正文/`。`data-agent` 只生成 `delta.json`，不直接写 state/memory。`write-result.json` 会记录本次提交的阶段、状态、字数检查、报告路径和 commit 路径。

## 记录经验

在 Claude Code 中输入：

```text
/story-learn
```

记录本次写作中可复用的经验模式，后续 `/story-write` 会自动参考。

## 查询状态

在 Claude Code 中输入：

```text
/story-query
```

底层调试命令示例：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo query status
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo query context --chapter 2
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo query entity-graph
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo query learning
```

## 下一步验证

完成第一章后，建议继续验证：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo maintain health
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo query quality
```
