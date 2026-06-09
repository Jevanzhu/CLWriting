---
description: 短篇项目正文写作入口，使用 4 核心 Agent 和简化 8 步 pipeline。
argument-hint: "[chapter|短篇段落目标]"
---

# /story-short-write

先定位当前故事项目，并读取 `master.project_type` 或通过 `story_craft.py where` 确认项目根。

若当前 `project_type=long`，提示“当前为长篇项目，应使用 `/story-long-write` 或 `/story-long-plan`”，不要把命令物理隐藏，也不要伪装成短篇流程已执行。若 `project_type=short`，继续委托。

委托到 `story-craft:story-short-write`。该 Skill 负责短篇退化矩阵、4 核心 Agent、solo reviewer 和 chapter-commit。
