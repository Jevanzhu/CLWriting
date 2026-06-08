---
name: story-plan
description: 为已初始化的 story-craft 项目生成或补全故事级总纲。用于把 state、memory、设定集整理成分段结构、故事时间线、每章目标/冲突/钩子，并更新大纲和项目进度时。
---

# story-plan

## 目标

把初始化设定转成可执行的短篇/中篇章纲，补齐故事时间线和必要设定基线。

## 充分性闸门

开始前必须满足：

- `.story/state.json` 和 `.story/memory.json` 存在。
- `设定集/世界观.md`、`设定集/主角卡.md`、`设定集/独特优势.md` 存在。
- `state.project.title/genre/word_count_target` 非空。

不满足时返回 `/story-init` 补全。

## 流程

1. 执行规划入口：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" plan
```

如需人工指定章数：

```bash
python -X utf8 "${SCRIPTS_DIR}/story_craft.py" --project-root "${PROJECT_ROOT}" plan --chapter-count 12
```

2. 检查设定基线，按需补齐：

- `反派设计.md`：有反派镜像时必须存在。
- `金手指.md`：仅外挂型能力存在时生成。
- `力量体系.md`：仅修仙、玄幻、高武、系统等相关流派生成。
- `主角组.md`、`女主卡.md`、`复合题材-融合逻辑.md`：只在设定需要时生成。

3. 根据目标字数分配章节：

- 1-3 万字：8-12 章。
- 3-5 万字：12-18 章。
- 5-10 万字：18-30 章。

4. 生成故事时间线主干：开篇时间锚点、中点转折、高潮、结尾。
5. 重写或补全 `大纲/总纲.md`，并同步生成 `.story/contracts/chapters/chapter_NNN.json` 章节合同。`总纲.md` 是人类可读投影，章节合同才是后续写作校验真源。每章至少包含：

- 本章目标。
- 核心冲突。
- 角色出场。
- 时间锚点。
- 伏笔埋设或回收。
- 章末钩子类型。

6. CLI 会更新 `memory.json` 中 timeline/world_rules 骨架，更新 `state.progress.phase=plan` 并标记 outline 已生成。

## 写入边界

- 允许写：`大纲/总纲.md`、`.story/contracts/chapters/*.json`、必要的 `设定集/*.md`、`.story/state.json`、`.story/memory.json`。
- 不允许写正文。
- 不调用 Agent，story-plan 是纯流程 Skill。

## 验证

验证总纲包含：

- 分段结构。
- 每章大纲。
- 时间线主干。
- 每章目标、冲突、钩子。
- 字数分配不超过目标字数 110%。

## 失败处理

- 设定缺失：停止并列出缺失项。
- 章数超出目标：压缩章节或降低每章字数。
- 伏笔无回收计划：补回收章或删除该伏笔。

## 完成条件

输出章数、总字数分配、关键时间线、下一步建议 `/story-write`。
