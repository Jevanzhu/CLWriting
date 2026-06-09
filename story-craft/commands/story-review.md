---
description: 对当前故事项目或章节执行 reviewer 审查，支持 full、lean、solo 模式。
argument-hint: "[chapter] [full|lean|solo]"
---

# /story-review

先定位当前故事项目，并读取 `project_type` 用于选择审查口径。缺少项目根或合同信息时，提示先运行 `/story-init`。

委托到 `story-craft:story-review`。该 Skill 负责 reviewer 模式选择、审查报告生成和短篇/长篇双轨边界。

共用命令，适用于 `project_type=short` 与 `project_type=long`。
