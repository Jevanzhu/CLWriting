---
name: story-long-plan
description: 长篇规划 Skill，编排 story-architect 与 character-designer，生成 master、volumes、chapters 写前合同和角色注册表草案。
allowed-tools: Read Write Edit Grep Bash Agent
---

# story-long-plan

## 目标

把长篇项目的创意、题材、主线、卷章结构和角色关系整理成可执行写前合同。核心产物是 `master.json`、`volumes/`、`chapters/` 和 `character_registry` 草案。

本 Skill 编排 `story-architect` 与 `character-designer`；CLI 只做确定性初始化、规划兜底和文件校验。

## 充分性闸门

开始前必须满足：

- 已执行 `/story-init`，且 `master.project_type=long`。
- 书名、题材、主线、目标字数、核心卖点和硬约束完整。
- 至少有主角欲望、主角缺陷、主要对抗面和结局约束。
- 若已有旧规划，必须先说明是刷新、扩写还是增量补卷。

缺信息时先补问，不调用 Agent。

## 流程

1. 预检项目状态：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" query status
```

2. 调用 `story-architect` 生成长篇结构合同草案：

```text
Agent(
  subagent_type: "story-craft:story-architect",
  prompt: "project_root=${PROJECT_ROOT}; project_type=long; title=${TITLE}; genre=${GENRE}; target_chapters=${TARGET_CHAPTERS}; target_volumes=${TARGET_VOLUMES}; output_file=${ARCHITECT_JSON}。生成 master、volumes、chapters 合同草案。"
)
```

3. 调用 `character-designer` 生成角色注册表和角色档案草案：

```text
Agent(
  subagent_type: "story-craft:character-designer",
  prompt: "project_root=${PROJECT_ROOT}; project_type=long; master_contract=${MASTER_CONTRACT}; volume_contracts=${VOLUME_CONTRACTS}; output_file=${CHARACTER_JSON}。生成 character_registry、设定/角色 草案和 relationships。"
)
```

4. 核对 `master/volumes/chapters`：

- 章号连续。
- 卷范围不重叠。
- 每章 `must_cover` 不为空。
- 每章 `expected_strand` 只使用 `quest/fire/constellation`。
- `forbidden_zones` 与 master 约束一致。

5. 写入或交由主流程写入合同：

- `.story/contracts/master.json`
- `.story/contracts/volumes/volume_NNN.json`
- `.story/contracts/chapters/chapter_NNN.json`
- 角色注册表和 `设定/角色/*.md` 投影草案

6. 验证规划结果可被 `story-long-write` 读取。

## 写入边界

- Agent 输出只写工作台 JSON 草案。
- 最终合同写入必须由主流程确认后执行。
- `总纲.md` 是投影，不是真源。
- 不写正文，不调用 `narrative-writer`。

## 失败处理

- `story-architect` 输出缺少 master/volumes/chapters：重跑 architect，不继续角色设计。
- `character_registry` 缺主角或对抗面：重跑 character-designer。
- 章节合同不连续：停止并列出缺口。
- 用户要求开新卷且引入新设定：先补 master/volume 合同，再进入 `story-long-write` 的 `new_volume` 场景。

## CC 验证清单

- [ ] `story-architect` 能生成 master、volumes、chapters 草案。
- [ ] `character-designer` 能生成 character_registry、设定/角色和 relationships。
- [ ] 主流程能将草案写入 `.story/contracts/`。
- [ ] `story-long-write` 能读取生成的章节合同。

## 完成条件

输出：

- `master.json` 草案。
- `volumes/volume_NNN.json` 草案。
- `chapters/chapter_NNN.json` 草案。
- `character_registry` 与角色关系草案。
- 下一步建议 `/story-long-write`。
