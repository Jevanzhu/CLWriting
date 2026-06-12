---
name: story-import
description: 外部既有作品导入 Skill，解析 txt/md/docx 章节，经 chapter-extractor 和 data-agent 重建合同，再调用 rebuild-views 重建投影。
allowed-tools: Read Write Grep Bash Agent
---

# story-import

## 目标

导入外部既有作品，支持 `txt`、`md`、`docx`。本 Skill 不是 v1 migrate，属于非 v1 迁移；不读取旧版 story-craft 私有状态，也不做历史工程迁移。它只把外部文本解析为当前 v2 合同、章节和投影。

参考拆解只保留：

- `narrative_techniques`：可学习的叙事技巧。
- `do_not_copy`：禁止复刻的人设、桥段、专名和表达。
- `differentiation`：本项目必须做出的差异化要求。

## 充分性闸门

开始前必须满足：

- `project_root` 明确。
- 导入源文件存在，扩展名为 `txt`、`md` 或 `docx`。
- 用户确认这是外部既有作品导入，不是 v1 migrate。
- 目标项目已 `/story-init`，或用户明确允许本流程补建基础合同。
- 导入前明确 `project_type=short` 或 `project_type=long`。

## 流程

1. 解析章节：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" import \
  --source "${SOURCE_FILE}" \
  --output-file "${IMPORT_WORK_DIR}/parsed-import.json"
```

解析输出必须包含章节序号、标题、正文、源文件位置和异常列表。

2. 调用 `chapter-extractor` / `data-agent` 抽取结构化事实：

```text
Agent(
  subagent_type: "story-craft:data-agent",
  prompt: "project_root=${PROJECT_ROOT}; project_type=${PROJECT_TYPE}; import_dir=${IMPORT_WORK_DIR}; mode=chapter-extractor; output_file=${EXTRACTED_JSON}。抽取章节事件、场景、角色状态、线索和风格指纹候选。"
)
```

3. 重建合同：

- 写入或更新 `.story/contracts/master.json`。
- 长篇按需重建 `.story/contracts/volumes/volume_NNN.json`。
- 重建 `.story/contracts/chapters/chapter_NNN.json`。
- 参考拆解写入 `narrative_techniques`、`do_not_copy`、`differentiation`，不迁移旧 `deconstruction-agent`。
- 其中 `narrative_techniques`（可迁移写作技法）经用户逐条确认后，用 `learn --source import` 写入 `.story/project_learning.json`，自动进入后续 `/story-short-write`、`/story-long-write` 的写作 checklist 生效；`do_not_copy`、`differentiation` 仍仅作 init/canon 约束，不入写作 checklist。

4. 写入导入章节草稿或正文候选，等待用户确认是否进入验收。
5. 用户确认后调用 `rebuild-views` 重建 6 投影：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" rebuild-views
```

6. 输出导入摘要、异常章节、合同重建摘要和投影重建结果。

## 写入边界

- 允许写 `.story/imports/` 中间产物。
- 允许写当前 v2 合同文件。
- 允许写导入后的章节候选文件。
- 允许在用户确认后调用 `rebuild-views`。
- 不读取或迁移 v1 私有状态。
- 不复制参考作品的专名、人设、桥段或原文表达到新项目设定。
- 不直接执行写作链，不调用 reviewer 验收为通过。

## 失败处理

- 文件格式不支持：停止并提示支持 `txt`、`md`、`docx`。
- 章节边界无法解析：输出异常列表，要求用户指定分章规则。
- `docx` 解析失败：提示转为 `md` 或 `txt` 后重试。
- `data-agent` 抽取失败：保留解析结果，不写合同。
- 合同重建冲突：停止，列出冲突项，等待用户确认覆盖、合并或取消。
- `rebuild-views` 失败：保留合同和章节候选，提示重新构建投影。

## CC 验证清单

- [ ] Claude Code 中 `/story-import` 能读取 `txt`、`md`、`docx`。
- [ ] 章节解析异常能返回给用户确认。
- [ ] `chapter-extractor` / `data-agent` 能产出结构化事实。
- [ ] 合同重建后能调用 `rebuild-views`。
- [ ] 参考拆解只保留 `narrative_techniques`、`do_not_copy`、`differentiation`。
- [ ] 流程不会被误用于 v1 migrate。

## 完成条件

输出章节解析结果、导入异常列表、合同重建摘要、参考拆解摘要和 `rebuild-views` 结果；明确下一步是人工检查、复审、还是进入写作链。

## 参考加载表

- 状态追踪：`references/long/state-tracking.md`
- 格式结构：`references/long/format-and-structure.md`
- 工件协议：`references/long/artifact-protocols.md`
- 题材画像：`references/shared/genre-profiles.md`
- 题材调性：`references/shared/csv/题材与调性推理.csv`
- 裁决规则：`references/shared/csv/裁决规则.csv`
