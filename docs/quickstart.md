# 快速开始

本文说明如何从零创建一个 story-craft 故事项目，并完成第一章的基本闭环。

## 推荐链路

在 Claude Code 中使用：

```text
/story-init  →  /story-plan  →  /story-write 1  →  /story-review 1  →  /story-query
```

`/story-write N` 会准备 `.story/workflows/ch_NN/`，并按以下顺序执行：

```text
Agent(context-agent) → draft.md → Agent(reviewer) → repair/polish
→ Agent(data-agent) → write
```

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

`review.json` 存在 blocking issue 时不会进入提交；`data-agent` 只生成 `delta.json`，不直接写 state/memory。

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
```
