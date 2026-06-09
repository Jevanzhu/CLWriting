---
description: 写作前只读检查项目类型、章节合同、占位符、上一章验收和推荐入口。
argument-hint: "<chapter|target-file>"
---

# /story-preflight

定位当前故事项目，并读取 `project_type`。短篇不因缺 `volumes/` 阻断；长篇缺 volume/chapter 合同时提示 blocker。

委托到 `story-craft:story-preflight`。该 Skill 负责只读充分性检查和 recommended_skill 输出。

共用命令，适用于 `project_type=short` 与 `project_type=long`。
