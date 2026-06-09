---
description: 长篇项目单章写作或修订入口，执行 5 场景路由和 8 步 commit pipeline。
argument-hint: "<chapter> [场景/修订要求]"
---

# /story-long-write

先定位当前故事项目，并读取 `master.project_type` 或通过 `story_craft.py where` 确认项目根。

若当前 `project_type=short`，提示“当前为短篇项目，应使用 `/story-short-write`”，不要把命令物理隐藏，也不要伪装成长篇流程已执行。若 `project_type=long`，继续委托。

委托到 `story-craft:story-long-write`。该 Skill 负责 5 场景路由、8 步 pipeline、Agent 编排和 chapter-commit。
