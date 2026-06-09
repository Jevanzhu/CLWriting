# 快速开始

本文说明如何用 story-craft 从零创建故事项目，并按短篇或长篇轨道进入第一轮写作闭环。

日常入口是 Claude Code 中的 `/story-*` 命令；Python CLI 只作为确定性工具层，用于初始化项目本体、校验、写入真源、重建投影和本地冒烟。

## 选择轨道

story-craft 使用 `project_type` 区分两条写作轨道：

- `short`：短篇项目，默认使用 4 核心 Agent，跳过 `volumes/`，`index/vector` 默认 lazy。
- `long`：长篇项目，使用 9 Agent 能力，包含 master、volume、chapter 合同和 5 个写作场景。

先在 Claude Code 中执行：

```text
/story-init
```

初始化时确认书名、题材、目标字数、主角、核心卖点、硬约束和 `project_type=short|long`。底层调试命令示例：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py init /tmp/story-demo 暗室来信 悬疑 \
  --project-type short \
  --word-count-target 30000 \
  --synopsis "法医收到亡友留下的空白来信，追查旧楼暗室真相。" \
  --protagonist-name 林墨 \
  --protagonist-desire "查清亡友死因"
```

`/story-init` 会先调用底层 `init` CLI 写入 `.story/contracts/master.json` 和项目基础文件，再由 Skill 自部署 Claude Code 运行时资产：17 个 Skill、13 个 commands、按轨道选择的 Agent、hooks、references 和 `.story/contracts/deployment.json`。单独调用 `init` CLI 只初始化项目本体，不部署 `.claude/` 运行时资产。

## 短篇上手

短篇轨道推荐链路：

```text
/story-init  →  /story-preflight 1  →  /story-short-write 1
```

短篇写作使用 4 核心 Agent：

```text
context-agent → narrative-writer → reviewer(solo) → data-agent
```

`/story-short-write 1` 会准备 `.story/workflows/ch_01/`，执行简化 8 步 pipeline，最后通过 `chapter-commit` 写入 `.story/commits/chapter_001.commit.json`。短篇不会因为缺少 `volumes/` 阻断，`style_fingerprint` 可选，`index/vector` 可等首次查询或重建时补建。

短篇常用后续入口：

```text
/story-short-analyze
/story-short-scan
/story-review 1
/story-deslop draft.md
/story-repair review.json
/story-query status
```

## 长篇上手

长篇轨道推荐链路：

```text
/story-init  →  /story-long-plan  →  /story-preflight 1  →  /story-long-write 1
```

`/story-long-plan` 调用：

- `story-architect`：生成 master、volumes、chapters 合同草案。
- `character-designer`：生成 character_registry、角色档案和关系草案。

`/story-long-write 1` 根据 `tools.scenario_router.detect_scenario` 路由到 5 个场景：

- `daily_continue`
- `major_revision`
- `new_volume`
- `open_book`
- `import_external`

长篇写作链使用 8 步 commit pipeline：预检、路由、context-agent、narrative-writer、reviewer、repair/polish、data-agent、chapter-commit + 6 投影。

## 工作台

写作中间产物固定保存到：

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

工作台便于中断后从缺失步骤恢复。真实正文验收成功后，`chapter-commit` 写入 commit 真源，并触发 6 个投影：

- `state`
- `memory`
- `summary`
- `index`
- `vector`
- `markdown_view`

## 查询与复盘

常用 Claude Code 入口：

```text
/story-query status
/story-query memory
/story-query context 2
/story-review 1
/story-learn
```

底层调试命令示例：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo query status
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo query context --chapter 2
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo query entity-graph
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo query ranked-context --chapter 2 --budget 20
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo rebuild-views
```

## 下一步验证

完成第一章后，建议继续验证：

```bash
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo health
python3 -X utf8 story-craft/scripts/story_craft.py --project-root /tmp/story-demo query quality
```

如写作前不确定是否满足条件，先运行：

```text
/story-preflight 2
```
